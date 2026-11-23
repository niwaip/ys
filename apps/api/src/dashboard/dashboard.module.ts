import { matchesDashboardObject } from "../../../../packages/contracts/dashboard-filter";
import {
  BadRequestException,
  Controller,
  DynamicModule,
  Get,
  HttpCode,
  Inject,
  Module,
  NotFoundException,
  Post,
  Req,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
const compress = promisify(gzip),
  decompress = promisify(gunzip);
import { z } from "zod";
import { DATABASE, type Database } from "../persistence/database";
import type { AuthorizedRequest } from "../auth/auth";
import { SoftwareModule, SoftwareService } from "../software/software.module";
import {
  ContainersModule,
  ContainerService,
} from "../containers/containers.module";
import { WindowsModule, WindowsService } from "../windows/windows.module";
import {
  LifecycleModule,
  LifecycleService,
} from "../lifecycle/lifecycle.module";
import { AssessmentService } from "../assessments/assessments.module";
import { SoftwareHistoryService } from "../software-history/software-history.module";
import type { AnyAssessment } from "../../../../packages/contracts/assessments";
import type {
  DashboardKind,
  DashboardObject,
  DashboardRequest,
  DashboardView,
  DashboardCatalog,
} from "../../../../packages/contracts/dashboard";
import { aggregateDashboard, trendPoints } from "./metrics";
const inputSchema = z
  .object({
    hardwareType: z.enum(["server", "network", "unknown"]).optional(),
    selectionMode: z.enum(["explicit", "current"]).default("explicit"),
    trendMode: z
      .enum(["selected_inputs", "object_history"])
      .default("selected_inputs"),
    assessmentRefs: z.array(z.uuid()).max(100000).default([]),
    lifecycleAssessmentId: z.uuid().optional(),
    object: z
      .object({ kind: z.enum(["host", "software", "container"]), id: z.uuid() })
      .strict()
      .optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
const identity = (a: AnyAssessment) =>
  a.target.kind === "windows" || a.target.kind === "linux"
    ? {
        kind: "host" as const,
        id: a.target.assetId,
        inputId: a.target.snapshotId,
      }
    : a.target.kind === "container"
      ? {
          kind: "container" as const,
          id: a.target.containerId,
          inputId: a.target.versionId,
        }
      : {
          kind: "software" as const,
          id: a.target.softwareId,
          inputId: a.target.versionId,
        };
export class DashboardService {
  constructor(
    private db: Database,
    private assessments: AssessmentService,
    private history: SoftwareHistoryService,
    private software: SoftwareService,
    private containers: ContainerService,
    private windows: WindowsService,
    private lifecycle: LifecycleService,
  ) {}
  private async objects(
    customer: string,
    filter?: DashboardRequest["object"],
    hardwareType?: string,
  ) {
    const r = await this.db.query(
      `SELECT * FROM (SELECT 'host' AS kind,id,name,hardware_type AS "hardwareType" FROM assets WHERE customer_id=$1 AND deleted_at IS NULL UNION ALL SELECT 'software' AS kind,id,name,NULL AS "hardwareType" FROM software_objects WHERE customer_id=$1 UNION ALL SELECT 'container' AS kind,id,name,NULL AS "hardwareType" FROM container_images WHERE customer_id=$1) inventory WHERE ($2::text IS NULL OR (kind=$2 AND id=$3)) AND ($4::text IS NULL OR (kind='host' AND "hardwareType"=$4)) ORDER BY kind,id`,
      [
        customer,
        filter?.kind ?? null,
        filter?.id ?? null,
        hardwareType ?? null,
      ],
    );
    if (filter && !r.rows.length)
      throw new NotFoundException("该客户下未找到所选对象");

    return r.rows as { kind: DashboardKind; id: string; name: string }[];
  }
  async catalog(
    customer: string,
    limit = 100,
    offset = 0,
  ): Promise<DashboardCatalog> {
    const counts = await this.db.query(
      `SELECT (SELECT count(*)::int FROM assets WHERE customer_id=$1 AND deleted_at IS NULL) AS host,(SELECT count(*)::int FROM software_objects WHERE customer_id=$1) AS software,(SELECT count(*)::int FROM container_images WHERE customer_id=$1) AS container`,
      [customer],
    );
    const page = await this.db.query(
      `SELECT * FROM (SELECT 'host' AS kind,id,name,hardware_type AS "hardwareType" FROM assets WHERE customer_id=$1 AND deleted_at IS NULL UNION ALL SELECT 'software' AS kind,id,name,NULL AS "hardwareType" FROM software_objects WHERE customer_id=$1 UNION ALL SELECT 'container' AS kind,id,name,NULL AS "hardwareType" FROM container_images WHERE customer_id=$1) inventory ORDER BY kind,id LIMIT $2 OFFSET $3`,
      [customer, limit, offset],
    );
    const a = await this.db.query(
      `SELECT id,status,details->'target' AS target,details->>'createdAt' AS "createdAt" FROM vulnerability_jobs WHERE customer_id=$1 ORDER BY created_at DESC,id LIMIT 1001`,
      [customer],
    );
    const l = await this.lifecycle.assessments(customer);
    const inventory = counts.rows[0] as {
      host: number;
      software: number;
      container: number;
    };
    return {
      objects: page.rows as DashboardCatalog["objects"],
      inventory,
      objectTotal: inventory.host + inventory.software + inventory.container,
      objectLimit: limit,
      objectOffset: offset,
      assessments: a.rows.slice(0, 1000) as DashboardCatalog["assessments"],
      lifecycleAssessments: l.items.map((x) => ({
        id: x.id,
        evaluatedAt: x.evaluatedAt,
        batchId: x.batchId,
        itemCount: x.items.length,
      })),
      truncated: a.rows.length > 1000,
    };
  }
  async overview(customer: string) {
    const view = await this.view(customer, {
      selectionMode: "current",
      assessmentRefs: [],
    });
    const id = randomUUID(),
      content = JSON.stringify(view);
    await this.db.query(
      "INSERT INTO dashboard_scopes(id,customer_id,content_gzip,content_hash) VALUES($1,$2,$3,$4)",
      [
        id,
        customer,
        (await compress(content)).toString("base64"),
        createHash("sha256").update(content).digest("hex"),
      ],
    );
    return { id, generatedAt: view.generatedAt, metrics: view.metrics };
  }
  async fixedView(customer: string, id: string): Promise<DashboardView> {
    if (!z.uuid().safeParse(id).success)
      throw new BadRequestException("概览范围编号无效");
    const r = await this.db.query(
      "SELECT content_gzip,content_hash FROM dashboard_scopes WHERE customer_id=$1 AND id=$2",
      [customer, id],
    );
    if (!r.rows.length) throw new NotFoundException("概览范围不存在或无权访问");
    const content = (
      await decompress(Buffer.from(String(r.rows[0].content_gzip), "base64"))
    ).toString("utf8");
    if (
      createHash("sha256").update(content).digest("hex") !==
      r.rows[0].content_hash
    )
      throw new Error("概览范围完整性校验失败");
    return JSON.parse(content);
  }
  async findings(
    customer: string,
    input: DashboardRequest & {
      limit: number;
      offset: number;
      scopeId?: string;
      severity?: string;
      state?: string;
    },
  ) {
    // Use the same object ownership, current-input and time-range resolution as the overview.
    if (
      input.scopeId &&
      (input.object ||
        input.from ||
        input.to ||
        input.assessmentRefs?.length ||
        input.lifecycleAssessmentId ||
        input.selectionMode === "current" ||
        input.trendMode === "object_history")
    )
      throw new BadRequestException("固定概览范围不能与其他统计范围混用");
    const view = input.scopeId
      ? await this.fixedView(customer, input.scopeId)
      : await this.view(customer, input);
    const objects = view.objects.filter((o) =>
      matchesDashboardObject(o, input),
    );
    const rows = objects
      .flatMap((object) => object.findings)
      .filter(
        (f) => !input.severity || f.severity.toLowerCase() === input.severity,
      );
    return {
      items: rows.slice(input.offset, input.offset + input.limit),
      total: rows.length,
      limit: input.limit,
      offset: input.offset,
      assessmentRefs: view.scope.assessmentRefs,
      from: view.scope.from,
      to: view.scope.to,
    };
  }
  async view(
    customer: string,
    input: DashboardRequest,
  ): Promise<DashboardView> {
    if (input.from && input.to && Date.parse(input.from) > Date.parse(input.to))
      throw new BadRequestException("开始时间不能晚于结束时间");
    if (
      new Set(input.assessmentRefs).size !== (input.assessmentRefs ?? []).length
    )
      throw new BadRequestException("评估批次不能重复");
    const objects = await this.objects(
        customer,
        input.object,
        input.hardwareType,
      ),
      selected = new Map<string, AnyAssessment>();
    for (const id of input.assessmentRefs ?? []) {
      const a = await this.assessments.get(customer, id),
        target = identity(a),
        key = `${target.kind}:${target.id}`;
      if (
        input.object &&
        (target.kind !== input.object.kind || target.id !== input.object.id)
      )
        throw new BadRequestException("所选评估不属于当前对象范围");
      if (selected.has(key))
        throw new BadRequestException(
          "同一对象只能选择一个固定评估版本；历史请查看趋势",
        );
      selected.set(key, a);
    }
    const rows: DashboardObject[] = [];
    for (const object of objects) {
      const row: DashboardObject = {
        ...object,
        inputId: null,
        inputLabel: null,
        assessmentId: null,
        selection: "unselected",
        status: "unselected",
        componentCount: null,
        installedSoftwareCount: null,
        collectedAt: null,
        createdAt: null,
        findings: [],
        coverage: null,
        database: null,
        toolVersion: null,
        inputHash: null,
        issues: [],
        lifecycle: null,
      };
      let job = selected.get(`${object.kind}:${object.id}`);
      if (job) {
        row.selection = "explicit_assessment";
        row.inputId = identity(job).inputId;
      } else if (object.kind === "software") {
        const current = await this.history.current(customer, object.id);
        if (current) {
          row.selection = "software_current";
          row.inputId = current.versionId;
          if (current.assessmentId)
            job = await this.assessments.get(customer, current.assessmentId);
        }
      }
      if (!job && input.selectionMode === "current") {
        if (!row.inputId && object.kind !== "host") {
          const table =
            object.kind === "software"
              ? "software_versions"
              : "container_versions";
          const column =
            object.kind === "software" ? "software_id" : "container_id";
          const latest = (
            await this.db.query(
              `SELECT id FROM ${table} WHERE customer_id=$1 AND ${column}=$2 ORDER BY created_at DESC,id DESC LIMIT 1`,
              [customer, object.id],
            )
          ).rows[0];
          if (latest) row.inputId = String(latest.id);
        }
        const candidate = (
          await this.db.query(
            `SELECT details - 'execution' || jsonb_build_object('execution',(details->'execution') - 'rawReport') AS details FROM vulnerability_jobs WHERE customer_id=$1 AND COALESCE(details#>>'{target,softwareId}',details#>>'{target,containerId}',details#>>'{target,assetId}')=$2 AND ($3::text IS NULL OR COALESCE(details#>>'{target,versionId}',details#>>'{target,snapshotId}')=$3) ORDER BY created_at DESC,id DESC LIMIT 1`,
            [customer, object.id, row.inputId],
          )
        ).rows[0];
        if (candidate) {
          job = candidate.details as AnyAssessment;
          row.selection = "latest_attempt";
          row.inputId = identity(job).inputId;
        }
      }
      if (row.inputId) {
        if (object.kind === "software") {
          const v = await this.software.getVersion(
            customer,
            object.id,
            row.inputId,
          );
          row.inputLabel = v.version;
          row.componentCount = v.components.length;
          row.collectedAt = v.collectedAt;
          row.createdAt = v.createdAt;
          row.issues.push(...v.issues);
        } else if (object.kind === "container") {
          const v = await this.containers.getVersion(
            customer,
            object.id,
            row.inputId,
          );
          row.inputLabel = v.identity.digest ?? v.version;
          row.componentCount = v.components.length;
          row.collectedAt = v.collectedAt;
          row.createdAt = v.createdAt;
          row.issues.push(...v.issues);
        } else if (job?.target.kind === "linux") {
          const v = (
            await this.db.query(
              "SELECT normalized,created_at FROM collection_snapshots WHERE customer_id=$1 AND id=$2 AND asset_id=$3",
              [customer, row.inputId, object.id],
            )
          ).rows[0];
          if (!v) throw new NotFoundException("该客户下未找到Linux快照");
          const data =
            v.normalized as import("../../../../packages/contracts/collections").HostCollection;
          const os = data.sections.os?.data as {
            id?: string;
            version?: string;
          };
          row.inputLabel = `${os.id ?? "未知"} ${os.version ?? "未知"}`;
          row.installedSoftwareCount = Array.isArray(
            data.sections.packages?.data,
          )
            ? data.sections.packages.data.length
            : null;
          row.collectedAt = data.collectedAt;
          row.createdAt = new Date(v.created_at as string).toISOString();
        } else {
          const v = await this.windows.getSnapshot(customer, row.inputId);
          const s =
            v.snapshot as import("../../../../packages/contracts/windows").WindowsSnapshot;
          row.inputLabel = `${s.os ?? "未知 OS"} ${s.osBuild ?? "?"} / ${s.ubr ?? "?"}`;
          row.installedSoftwareCount = s.software?.length ?? null;
          row.collectedAt = s.collectedAt;
        }
      }
      if (job) {
        row.assessmentId = job.id;
        row.assessmentKind = job.target.kind;
        row.inputHash = job.input.contentHash;
        row.toolVersion = job.execution?.toolVersion ?? null;
        const time = Date.parse(job.createdAt);
        if (
          (input.from && time < Date.parse(input.from)) ||
          (input.to && time > Date.parse(input.to))
        ) {
          row.status = "outside_time_range";
          row.issues.push("所选批次不在时间范围；没有回退其他历史批次");
        } else {
          row.status = job.status;
          if (job.status === "succeeded" && job.result) {
            row.coverage = job.result.coverage;
            row.database = job.result.database;
            row.issues.push(...job.result.coverage.issues);
            row.findings = job.result.findings.map((f) => ({
              assessmentId: job.id,
              findingId: f.id,
              cve: f.vulnerabilityId,
              severity: f.severity,
              applicability: f.applicability,
              packageName: f.packageName,
              installedVersion: f.installedVersion,
              fixedVersion: f.fixedVersion,
            }));
          } else
            row.issues.push(job.error ?? "所选批次尚无可用结果；不代表零发现");
        }
      }
      if (!row.assessmentId)
        row.issues.push(
          object.kind === "software"
            ? "未明确选择当前评估批次"
            : "此对象暂无当前指针，请明确选择固定评估批次",
        );
      rows.push(row);
    }
    const lifecycle = input.lifecycleAssessmentId
      ? await this.lifecycle.getAssessment(
          customer,
          input.lifecycleAssessmentId,
        )
      : null;
    const lifecycleOutside =
      !!lifecycle &&
      ((!!input.from &&
        Date.parse(lifecycle.evaluatedAt) < Date.parse(input.from)) ||
        (!!input.to &&
          Date.parse(lifecycle.evaluatedAt) > Date.parse(input.to)));
    const applicableLifecycle = lifecycleOutside ? null : lifecycle;
    for (const row of rows) {
      let rowLifecycle = applicableLifecycle;
      if (!input.lifecycleAssessmentId && input.selectionMode === "current") {
        const latest = (
          await this.db.query(
            `SELECT result FROM lifecycle_assessments WHERE customer_id=$1 AND EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') item WHERE item->>'assetId'=$2 AND ($3::text IS NULL OR item->>'versionId'=$3)) ORDER BY evaluated_at DESC,id DESC LIMIT 1`,
            [customer, row.id, row.kind === "software" ? row.inputId : null],
          )
        ).rows[0];
        rowLifecycle = (latest?.result as typeof applicableLifecycle) ?? null;
        if (
          rowLifecycle &&
          ((input.from && rowLifecycle.evaluatedAt < input.from) ||
            (input.to && rowLifecycle.evaluatedAt > input.to))
        )
          rowLifecycle = null;
      }
      const match = rowLifecycle?.items.find(
        (x) =>
          x.assetId === row.id &&
          (row.kind !== "software" || x.versionId === row.inputId),
      );
      if (
        row.kind === "host" &&
        row.inputId &&
        match &&
        match.versionId !== row.inputId
      ) {
        row.lifecycle = null;
        row.issues.push(
          "生命周期资产属性输入未绑定所选 Windows 快照，不能计入此快照生命周期状态",
        );
      } else {
        row.lifecycle = match ?? null;
        if (match && rowLifecycle) row.lifecycleAssessmentId = rowLifecycle.id;
      }
    }
    const historyWhere = `customer_id=$1 AND COALESCE(details#>>'{target,softwareId}',details#>>'{target,containerId}',details#>>'{target,assetId}')=ANY($2::text[]) AND ($5::boolean OR COALESCE(details#>>'{target,versionId}',details#>>'{target,snapshotId}')=ANY($6::text[])) AND ($3::timestamptz IS NULL OR (details->>'createdAt')::timestamptz >= $3::timestamptz) AND ($4::timestamptz IS NULL OR (details->>'createdAt')::timestamptz <= $4::timestamptz)`;
    const historyParams = [
      customer,
      rows.map((r) => r.id),
      input.from ?? null,
      input.to ?? null,
      input.trendMode === "object_history",
      rows.map((r) => r.inputId).filter(Boolean),
    ];
    const historical = await this.db.query(
        `SELECT details - 'execution' || jsonb_build_object('toolVersion',details#>'{execution,toolVersion}') AS details FROM vulnerability_jobs WHERE ${historyWhere} ORDER BY created_at DESC,id LIMIT 200`,
        historyParams,
      ),
      historyCount = await this.db.query(
        `SELECT count(*)::int AS total FROM vulnerability_jobs WHERE ${historyWhere}`,
        historyParams,
      );
    const scoped = historical.rows
      .reverse()
      .map((x) => x.details as AnyAssessment & { toolVersion: string | null });
    const historyTotal = Number(historyCount.rows[0].total);
    const scope = {
      object: input.object ?? null,
      hardwareType: input.hardwareType ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
      assessmentRefs: rows
        .map((x) => x.assessmentId)
        .filter((x): x is string => !!x),
      lifecycleAssessmentId: input.lifecycleAssessmentId ?? null,
      trendMode: input.trendMode ?? "selected_inputs",
      selectionPolicy:
        input.selectionMode === "current"
          ? "软件current指针优先；其余按对象及固定输入取最近一次尝试（含失败），生命周期按对象匹配最近固定评估；不累计历史"
          : "software explicit current; container/Windows explicit assessment; no historical accumulation",
      lifecycleAssessmentRefs: [
        ...new Set(
          rows
            .map((r) => r.lifecycleAssessmentId)
            .filter((id): id is string => !!id),
        ),
      ],
    };
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          customer,
          scope,
          inputs: rows.map((r) => [r.kind, r.id, r.inputId]),
        }),
      )
      .digest("hex");
    const metrics = aggregateDashboard(
      rows,
      applicableLifecycle,
      input.selectionMode === "current" &&
        !input.lifecycleAssessmentId &&
        rows.some((r) => !!r.lifecycle),
    );
    if (lifecycleOutside && lifecycle) {
      metrics.lifecycle = {
        ...metrics.lifecycle,
        status: "outside_time_range",
        assessmentId: lifecycle.id,
        evaluatedAt: lifecycle.evaluatedAt,
        batchId: lifecycle.batchId,
        sourceHash: lifecycle.contentHash,
      };
    }
    return {
      customerId: customer,
      generatedAt: new Date().toISOString(),
      scope: { hash, ...scope },
      metrics,
      objects: rows,
      trend: {
        items: trendPoints(scoped.slice(-200)),
        total: historyTotal,
        truncated: historyTotal > 200,
        warning:
          "各点是独立历史批次，不累计。输入、范围、规则或覆盖变化时不将下降解释为修复。",
      },
      warnings: [
        "只统计所选固定输入/批次；未知、失败、未选择不表示零风险",
        "已删除资产不计入当前纳管范围；软件及镜像为独立对象，删除主机不删除共享SBOM",
        "Trivy tool_reported不自动等同确认受影响；Windows仅affected计确认影响",
        "容器发现不证明任何运行实例使用该镜像",
        ...(!lifecycle && input.selectionMode !== "current"
          ? ["未选择生命周期评估版本；EOS/EOL未知"]
          : []),
        ...(lifecycleOutside
          ? ["所选生命周期评估在时间范围外；不计状态、未换用其他评估"]
          : []),
      ],
    };
  }
}
@Controller("api/customers/:customerId/dashboard")
class DashboardController {
  constructor(private service: DashboardService) {}
  @Get("catalog") catalog(req: AuthorizedRequest) {
    const page = z
      .object({
        limit: z.coerce.number().int().min(1).max(1000).default(100),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .strict()
      .safeParse(req.query);
    if (!page.success) throw new BadRequestException("目录分页无效");
    return this.service.catalog(
      req.params.customerId,
      page.data.limit,
      page.data.offset,
    );
  }
  @Post("overview") overview(req: AuthorizedRequest) {
    if (!z.object({}).strict().safeParse(req.body).success)
      throw new BadRequestException("概览参数无效");
    return this.service.overview(req.params.customerId);
  }
  @Get("scopes/:scopeId") scope(req: AuthorizedRequest) {
    return this.service.fixedView(req.params.customerId, req.params.scopeId);
  }
  @Post("findings") @HttpCode(200) findings(req: AuthorizedRequest) {
    const r = inputSchema
      .extend({
        scopeId: z.uuid().optional(),
        severity: z
          .enum(["critical", "high", "medium", "low", "unknown"])
          .optional(),
        state: z
          .enum([
            "unselected",
            "succeeded",
            "failed",
            "stale",
            "coverage_unknown",
            "freshness_unknown",
          ])
          .optional(),
        limit: z.number().int().min(1).max(100).default(20),
        offset: z.number().int().min(0).max(1000000).default(0),
      })
      .safeParse(req.body);
    if (!r.success) throw new BadRequestException("明细范围/分页无效");
    return this.service.findings(req.params.customerId, r.data);
  }
  @Post("view") @HttpCode(200) view(req: AuthorizedRequest) {
    const r = inputSchema.safeParse(req.body);
    if (!r.success) throw new BadRequestException("概览范围无效");
    return this.service.view(req.params.customerId, r.data);
  }
}
for (const method of [
  "catalog",
  "view",
  "findings",
  "overview",
  "scope",
] as const)
  Req()(DashboardController.prototype, method, 0);
Inject(DashboardService)(DashboardController, undefined, 0);
@Module({})
export class DashboardModule {
  static register(
    assessments: DynamicModule,
    history: DynamicModule,
  ): DynamicModule {
    return {
      module: DashboardModule,
      imports: [
        assessments,
        history,
        SoftwareModule,
        ContainersModule,
        WindowsModule,
        LifecycleModule,
      ],
      controllers: [DashboardController],
      providers: [
        {
          provide: DashboardService,
          inject: [
            DATABASE,
            AssessmentService,
            SoftwareHistoryService,
            SoftwareService,
            ContainerService,
            WindowsService,
            LifecycleService,
          ],
          useFactory: (
            db: Database,
            a: AssessmentService,
            h: SoftwareHistoryService,
            s: SoftwareService,
            c: ContainerService,
            w: WindowsService,
            l: LifecycleService,
          ) => new DashboardService(db, a, h, s, c, w, l),
        },
      ],
      exports: [DashboardService],
    };
  }
}
