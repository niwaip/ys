import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Post,
  Req,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  reportTaskInput,
  type ReportTask,
  type ReportHost,
  type ReportPreflight,
  type ReportResultChoice,
} from "../../../../packages/contracts/report-center";
import type { AuthorizedRequest, Operator } from "../auth/auth";
import type { Database } from "../persistence/database";
import { hashJson } from "../persistence/hash-json";
import { categoryExpression } from "../assets/assets.service";
import { requireActiveAsset } from "../assets/asset-state";
import type { ReportsService } from "./reports.module";
import { ReportTaskRunner } from "./task-runner";
import { linkedScope } from "./linked-scope";
import type { LifecycleRiskService } from "../lifecycle-risk/lifecycle-risk.module";

import { freshness } from "./freshness";

export class ReportCenterService {
  constructor(
    private readonly db: Database,
    private readonly reports: ReportsService,
    private readonly lifecycle: LifecycleRiskService,
    private readonly runner: ReportTaskRunner,
  ) {}
  async create(customer: string, operator: Operator, value: unknown) {
    const parsed = reportTaskInput.safeParse(value);
    if (!parsed.success)
      throw new BadRequestException("请选择明确服务器范围和报告配置");
    const input = parsed.data,
      inputHash = hashJson(input);
    const checkedAt = new Date().toISOString();
    const previous = (
      await this.db.query(
        "SELECT details,input_hash FROM report_tasks WHERE customer_id=$1 AND idempotency_key=$2",
        [customer, input.idempotencyKey],
      )
    ).rows[0];
    if (previous) {
      if (previous.input_hash !== inputHash)
        throw new ConflictException("幂等键已用于其他报告配置");
      return previous.details as ReportTask;
    }
    const { hosts, assetIds, objects, lifecycle } = await this.resolve(
      customer,
      input,
      checkedAt,
    );
    const task: ReportTask = {
      id: randomUUID(),
      customerId: customer,
      name: input.name,
      createdAt: checkedAt,
      createdBy: operator.name,
      status: "queued",
      hosts,
      input,
    };
    task.frozenScope = {
      name: task.name,
      taskId: task.id,
      hosts,
      checkedAt: task.createdAt,
      freshnessDays: input.freshnessDays,
      objects,
      lifecycle,
    };
    if (input.sourceReportId) {
      const source = await this.reports.get(customer, input.sourceReportId);
      task.frozenScope.sourceReport = {
        reportId: source.id,
        revisionId: source.revision.id,
        factHash: source.revision.factHash,
      };
    }
    if (input.comparisonReportId) {
      const baseline = await this.reports.get(
        customer,
        input.comparisonReportId,
      );
      task.comparisonBase = {
        reportId: baseline.id,
        revisionId: baseline.revision.id,
        factHash: baseline.revision.factHash,
        hostIds:
          baseline.revision.facts.center?.hosts.map((h) => h.assetId) ?? [],
        facts: {
          scope: baseline.revision.facts.scope,
          assessmentSnapshots: baseline.revision.facts.assessmentSnapshots,
        },
      };
    }
    if (input.mode !== "existing") await this.runner.plan(task);
    const saved = await this.db.transaction(async (tx) => {
      for (const id of assetIds) await requireActiveAsset(tx, customer, id);
      const inserted = await tx.query(
        "INSERT INTO report_tasks(id,customer_id,idempotency_key,input_hash,actor_key,status,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(customer_id,idempotency_key) DO NOTHING RETURNING details",
        [
          task.id,
          customer,
          input.idempotencyKey,
          inputHash,
          createHash("sha256").update(operator.token).digest("hex"),
          task.status,
          JSON.stringify(task),
        ],
      );
      if (inserted.rows.length) return task;
      const old = (
        await tx.query(
          "SELECT details,input_hash FROM report_tasks WHERE customer_id=$1 AND idempotency_key=$2",
          [customer, input.idempotencyKey],
        )
      ).rows[0];
      if (old.input_hash !== inputHash)
        throw new ConflictException("幂等键已用于其他报告配置");
      return old.details as ReportTask;
    });
    if (saved.id !== task.id) return saved;
    if (input.mode !== "existing") {
      this.runner.start(customer, task.id);
      return task;
    }
    const report = await this.reports.create(
      customer,
      operator.name,
      {
        assessmentRefs: [...new Set(hosts.flatMap((h) => h.assessmentRefs))],
        lifecycleRefs: [
          ...new Set(hosts.flatMap((host) => host.lifecycleRefs)),
        ],
      },
      task.frozenScope,
      input.presentation,
      task,
    );
    task.reportId = report.id;
    task.status = "completed";
    await this.runner.package(task);
    return task;
  }
  private async resolve(
    customer: string,
    input: ReportTask["input"],
    checkedAt: string,
  ) {
    const hosts: ReportHost[] = [];
    const assetIds =
      input.scope.kind === "selected"
        ? input.scope.assetIds
        : (
            await this.db.query(
              `SELECT id FROM assets WHERE customer_id=$1 AND deleted_at IS NULL AND (${categoryExpression}) IN ('server','vm') AND (source<>'netbox' OR EXISTS (SELECT 1 FROM netbox_assets n WHERE n.customer_id=assets.customer_id AND n.asset_id=assets.id AND n.active)) ORDER BY id`,
              [customer],
            )
          ).rows.map((row) => String(row.id));
    if (!assetIds.length)
      throw new BadRequestException("当前范围没有在管服务器");
    for (const id of assetIds) {
      const asset = (
        await this.db.query(
          `SELECT id,name,attributes,(${categoryExpression}) AS category FROM assets WHERE customer_id=$1 AND id=$2 AND deleted_at IS NULL AND (source<>'netbox' OR EXISTS (SELECT 1 FROM netbox_assets n WHERE n.customer_id=assets.customer_id AND n.asset_id=assets.id AND n.active))`,
          [customer, id],
        )
      ).rows[0];
      if (!asset) throw new NotFoundException("该客户下未找到在管服务器");
      if (asset.category !== "server" && asset.category !== "vm")
        throw new ConflictException(
          "首期报告范围仅支持物理服务器和虚拟机，请先确认资产分类",
        );
      const baseline = (
        await this.db.query(
          "SELECT snapshot_id,plan FROM asset_baselines WHERE customer_id=$1 AND asset_id=$2 AND status='confirmed' ORDER BY sequence DESC LIMIT 1",
          [customer, id],
        )
      ).rows[0];
      // A hardware-only adoption does not replace the current OS/package input.
      // A mixed baseline cannot be represented by an arbitrary single snapshot.
      const confirmedInput = baseline
        ? (
            await this.db.query(
              `SELECT c.id FROM collection_snapshots c WHERE c.customer_id=$1 AND c.asset_id=$2
         AND c.normalized#>'{sections,os,data}'=$3::jsonb
         AND c.normalized#>'{sections,packages,data}'=$4::jsonb
         AND EXISTS (SELECT 1 FROM asset_baselines b WHERE b.customer_id=c.customer_id AND b.asset_id=c.asset_id AND b.snapshot_id=c.id AND b.status='confirmed'
           AND b.plan#>'{selection,sections}' @> '["os","packages"]'::jsonb
           AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(COALESCE(b.plan#>'{selection,excludeFields}','[]'::jsonb)) field WHERE field LIKE 'os.%' OR field LIKE 'packages.%'))
         ORDER BY c.created_at DESC,c.id DESC LIMIT 1`,
              [
                customer,
                id,
                JSON.stringify(
                  (baseline.plan as { values?: { os?: unknown } }).values?.os ??
                    null,
                ),
                JSON.stringify(
                  (baseline.plan as { values?: { packages?: unknown } }).values
                    ?.packages ?? null,
                ),
              ],
            )
          ).rows[0]
        : undefined;
      const windows = (
        await this.db.query(
          `SELECT w.id FROM windows_snapshots w JOIN import_materials m ON m.customer_id=w.customer_id AND m.id=w.import_id WHERE w.customer_id=$1 AND w.asset_id=$2 AND ($3::uuid IS NULL OR m.content_hash=(SELECT content_hash FROM collection_snapshots WHERE customer_id=$1 AND id=$3)) ORDER BY m.imported_at DESC,w.id DESC LIMIT 1`,
          [
            customer,
            id,
            confirmedInput?.id ?? (baseline ? baseline.snapshot_id : null),
          ],
        )
      ).rows[0];
      const snapshotId = windows
        ? String(windows.id)
        : confirmedInput
          ? String(confirmedInput.id)
          : null;
      const attributes = asset.attributes as Record<string, unknown>;
      const lifecycle = (
        await this.db.query(
          `SELECT id FROM lifecycle_assessments WHERE customer_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(result->'items') item WHERE item->>'assetId'=$2 AND item->>'kind'='host' AND COALESCE(item->>'product','')=COALESCE($3::text,'') AND COALESCE(item->>'version','')=COALESCE($4::text,'')) ORDER BY evaluated_at DESC,id DESC LIMIT 1`,
          [
            customer,
            id,
            typeof attributes.product === "string"
              ? attributes.product.trim()
              : null,
            typeof attributes.version === "string"
              ? attributes.version.trim()
              : null,
          ],
        )
      ).rows[0];
      let assessment = snapshotId
        ? (
            await this.db.query(
              "SELECT id,status,target_input_id,details->>'finishedAt' AS \"finishedAt\" FROM vulnerability_jobs WHERE customer_id=$1 AND target_object_id=$2 AND target_input_id=$3 AND status='succeeded' ORDER BY created_at DESC,id DESC LIMIT 1",
              [customer, id, snapshotId],
            )
          ).rows[0]
        : undefined;
      const issues: string[] = [];
      const override = input.overrides.find((item) => item.objectId === id);
      if (override) {
        const chosen = (
          await this.db.query(
            "SELECT id,status,target_input_id,details->>'finishedAt' AS \"finishedAt\" FROM vulnerability_jobs WHERE customer_id=$1 AND id=$2 AND target_object_id=$3 AND details#>>'{target,kind}' IN ('linux','windows')",
            [customer, override.assessmentId, id],
          )
        ).rows[0];
        if (!chosen)
          throw new NotFoundException("该客户服务器下未找到所选历史评估");
        if (chosen.status === "queued" || chosen.status === "running")
          throw new ConflictException("评估仍在执行，请选择终态结果");
        if (override.versionId && override.versionId !== chosen.target_input_id)
          throw new ConflictException("所选历史评估与指定输入版本不一致");
        assessment = chosen;
        if (chosen.target_input_id !== snapshotId)
          issues.push("用户明确采用历史资料版本的评估；不能代表当前资料版本");
      }
      const latest = (
        await this.db.query(
          "SELECT id,status,details->>'error' AS error FROM vulnerability_jobs WHERE customer_id=$1 AND target_object_id=$2 ORDER BY created_at DESC,id DESC LIMIT 1",
          [customer, id],
        )
      ).rows[0];
      if (latest && latest.status !== "succeeded")
        issues.push(
          `最近评估 ${String(latest.id)} 状态 ${String(latest.status)}：${String(latest.error ?? "无可用完成结果")}`,
        );
      if (!assessment || assessment.status !== "succeeded")
        issues.push("未取得当前已确认资料对应的可用评估结果，不代表零风险");
      const sourceId = assessment?.target_input_id ?? snapshotId;
      const source = sourceId
        ? (
            await this.db.query(
              "SELECT normalized->>'collectedAt' AS collected FROM collection_snapshots WHERE customer_id=$1 AND id=$2 UNION ALL SELECT snapshot->>'collectedAt' AS collected FROM windows_snapshots WHERE customer_id=$1 AND id=$2",
              [customer, sourceId],
            )
          ).rows[0]
        : undefined;
      const collectedAt =
        typeof source?.collected === "string" ? source.collected : null;
      const assessedAt =
        typeof assessment?.finishedAt === "string"
          ? assessment.finishedAt
          : null;
      const age = {
        collection: freshness(collectedAt, checkedAt, input.freshnessDays),
        assessment:
          assessment?.status === "succeeded"
            ? freshness(assessedAt, checkedAt, input.freshnessDays)
            : ("missing" as const),
      };
      if (age.collection === "stale")
        issues.push(
          `采集资料超过 ${input.freshnessDays} 天；采用旧资料不会因重新评估而变新`,
        );
      if (age.assessment === "stale")
        issues.push(
          `漏洞评估超过 ${input.freshnessDays} 天；用户选择采用并披露`,
        );
      hosts.push({
        assetId: id,
        name: String(asset.name),
        attributes,
        snapshotId,
        collectedAt,
        assessedAt,
        freshness: age,
        assessmentRefs: assessment ? [String(assessment.id)] : [],
        lifecycleRefs: lifecycle ? [String(lifecycle.id)] : [],
        status:
          assessment?.status === "succeeded" || lifecycle
            ? "available"
            : "unassessed",
        issues,
      });
    }
    const objects = await linkedScope(
      this.db,
      customer,
      hosts,
      input.overrides,
      checkedAt,
      input.freshnessDays,
    );
    const allowed = new Set([
      ...assetIds,
      ...objects.map((object) => object.objectId),
    ]);
    if (input.overrides.some((item) => !allowed.has(item.objectId)))
      throw new BadRequestException("历史选择必须属于报告范围");
    for (const object of objects)
      for (const host of hosts.filter((host) =>
        object.hostIds.includes(host.assetId),
      )) {
        if (
          object.assessmentId &&
          !host.assessmentRefs.includes(object.assessmentId)
        )
          host.assessmentRefs.push(object.assessmentId);
        host.lifecycleRefs.push(
          ...object.lifecycleRefs.filter(
            (id) => !host.lifecycleRefs.includes(id),
          ),
        );
        host.issues.push(
          ...object.issues.map((issue) => `${object.name}：${issue}`),
        );
        if (object.status === "available") host.status = "available";
      }
    const view = await this.lifecycle.current(customer);
    const lifecycle = {
      id: view.id,
      calculatedAt: view.calculatedAt,
      localDate: view.localDate,
      config: view.config,
      items: view.items.filter((item) => assetIds.includes(item.assetId)),
    };
    return { hosts, assetIds, objects, lifecycle };
  }
  async preflight(customer: string, value: unknown): Promise<ReportPreflight> {
    const parsed = reportTaskInput.safeParse(value);
    if (!parsed.success)
      throw new BadRequestException("请选择明确服务器范围和报告配置");
    const checkedAt = new Date().toISOString();
    const resolved = await this.resolve(customer, parsed.data, checkedAt);
    const candidates = (
      await this.db.query(
        `SELECT id,status,target_object_id AS "objectId",target_input_id AS "versionId",details#>>'{target,kind}' AS kind,details->>'createdAt' AS "createdAt" FROM vulnerability_jobs WHERE customer_id=$1 AND target_object_id=ANY($2::text[]) ORDER BY created_at DESC,id DESC`,
        [
          customer,
          [
            ...resolved.assetIds,
            ...resolved.objects.map((object) => object.objectId),
          ],
        ],
      )
    ).rows as (ReportResultChoice["items"][number] & { objectId: string })[];
    const resultChoices: ReportResultChoice[] = [
      ...resolved.hosts.map((host) => ({
        objectId: host.assetId,
        name: host.name,
        items: candidates.filter(
          (job) =>
            job.objectId === host.assetId &&
            ["linux", "windows"].includes(job.kind),
        ),
      })),
      ...resolved.objects.map((object) => ({
        objectId: object.objectId,
        versionId: object.versionId,
        name: object.name,
        items: candidates.filter(
          (job) =>
            job.objectId === object.objectId &&
            job.kind === object.kind &&
            job.versionId === object.versionId,
        ),
      })),
    ];
    return {
      checkedAt,
      resultChoices,
      hosts: resolved.hosts,
      objects: resolved.objects,
      available: resolved.hosts.filter((host) => host.status === "available")
        .length,
      total: resolved.hosts.length,
    };
  }
  async get(customer: string, id: string) {
    if (!z.uuid().safeParse(id).success)
      throw new BadRequestException("报告任务编号无效");
    const row = (
      await this.db.query(
        "SELECT details FROM report_tasks WHERE customer_id=$1 AND id=$2",
        [customer, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("该客户下未找到报告任务");
    return row.details as ReportTask;
  }
  async retry(customer: string, id: string, body: unknown) {
    const parsed = z
      .object({
        itemIds: z
          .array(z.uuid())
          .min(1)
          .refine((ids) => new Set(ids).size === ids.length),
      })
      .strict()
      .safeParse(body);
    if (!parsed.success || !z.uuid().safeParse(id).success)
      throw new BadRequestException("请选择本任务需要重试的分项");
    return this.runner.retry(customer, id, parsed.data.itemIds);
  }
  async action(
    customer: string,
    id: string,
    body: unknown,
    action: "cancel" | "finish" | "resume",
  ) {
    if (
      !z.uuid().safeParse(id).success ||
      !z
        .object({})
        .strict()
        .safeParse(body ?? {}).success
    )
      throw new BadRequestException("任务操作无效");
    return this.runner[action](customer, id);
  }
  async choices(customer: string, assetId: string) {
    if (!z.uuid().safeParse(assetId).success)
      throw new BadRequestException("服务器编号无效");
    const target = await this.db.query(
      "SELECT id FROM assets WHERE customer_id=$1 AND id=$2 AND deleted_at IS NULL",
      [customer, assetId],
    );
    if (!target.rows.length)
      throw new NotFoundException("该客户下未找到在管服务器");
    return {
      items: (
        await this.db.query(
          "SELECT id,status,target_input_id AS \"versionId\",details->>'createdAt' AS \"createdAt\",details->>'error' AS error FROM vulnerability_jobs WHERE customer_id=$1 AND target_object_id=$2 AND details#>>'{target,kind}' IN ('linux','windows') ORDER BY created_at DESC,id DESC",
          [customer, assetId],
        )
      ).rows,
    };
  }
  async list(customer: string) {
    return {
      items: (
        await this.db.query(
          "SELECT details - 'frozenScope' - 'comparisonBase' AS details FROM report_tasks WHERE customer_id=$1 ORDER BY created_at DESC,id DESC LIMIT 100",
          [customer],
        )
      ).rows.map((r) => r.details as ReportTask),
    };
  }
}
@Controller("api/customers/:customerId/report-center")
export class ReportCenterController {
  constructor(private readonly service: ReportCenterService) {}
  @Post("preflight") preflight(req: AuthorizedRequest) {
    return this.service.preflight(req.params.customerId, req.body);
  }
  @Post("tasks") @HttpCode(202) create(req: AuthorizedRequest) {
    return this.service.create(req.params.customerId, req.operator, req.body);
  }
  @Post("tasks/:taskId/retry") retry(req: AuthorizedRequest) {
    return this.service.retry(
      req.params.customerId,
      req.params.taskId,
      req.body,
    );
  }
  @Post("tasks/:taskId/resume") resume(req: AuthorizedRequest) {
    return this.service.action(
      req.params.customerId,
      req.params.taskId,
      req.body,
      "resume",
    );
  }
  @Post("tasks/:taskId/cancel") cancel(req: AuthorizedRequest) {
    return this.service.action(
      req.params.customerId,
      req.params.taskId,
      req.body,
      "cancel",
    );
  }
  @Post("tasks/:taskId/finish") finish(req: AuthorizedRequest) {
    return this.service.action(
      req.params.customerId,
      req.params.taskId,
      req.body,
      "finish",
    );
  }
  @Get("tasks") list(req: AuthorizedRequest) {
    return this.service.list(req.params.customerId);
  }
  @Get("tasks/:taskId") get(req: AuthorizedRequest) {
    return this.service.get(req.params.customerId, req.params.taskId);
  }
  @Get("hosts/:assetId/assessments") choices(req: AuthorizedRequest) {
    return this.service.choices(req.params.customerId, req.params.assetId);
  }
}
for (const method of [
  "create",
  "preflight",
  "list",
  "get",
  "choices",
  "retry",
  "resume",
  "cancel",
  "finish",
] as const)
  Req()(ReportCenterController.prototype, method, 0);
Inject(ReportCenterService)(ReportCenterController, undefined, 0);
