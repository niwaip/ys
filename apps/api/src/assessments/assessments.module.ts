import { componentIdentitySchema } from "../../../../packages/contracts/finding-context";
import { assessmentRuntime } from "./runtime-context";
import { originalFindingEvidence } from "./scanner-match";
import { findingContext } from "./finding-context";
import {
  packLinuxAssessment,
  linuxReportContent,
  type StoredAssessment,
} from "./linux-artifact";
import {
  CollectionsModule,
  CollectionsService,
} from "../collections/collections.module";
import { linuxInput } from "./linux-input";
import { requireActiveAsset } from "../assets/asset-state";
import {
  CollectionLinksModule,
  CollectionLinksService,
} from "../collections/links.module";
import {
  ContainersModule,
  ContainerService,
} from "../containers/containers.module";
import {
  BadRequestException,
  ConflictException,
  Controller,
  DynamicModule,
  Get,
  HttpCode,
  StreamableFile,
  Res,
  Inject,
  Module,
  NotFoundException,
  Post,
  Req,
} from "@nestjs/common";
import type { Request, Response } from "express";
import { randomUUID, createHash } from "node:crypto";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
const compress = promisify(gzip);
import { z } from "zod";
import { DATABASE, type Database } from "../persistence/database";
import { SoftwareModule, SoftwareService } from "../software/software.module";
import { ImportsModule, ImportsService } from "../imports/imports.module";
import type { AuthorizedRequest } from "../auth/auth";
import type {
  Assessment,
  AnyAssessment,
  AnyAssessmentPage,
  AnyAssessmentSummary,
  AssessmentResult,
} from "../../../../packages/contracts/assessments";
import type { SoftwareComponent } from "../../../../packages/contracts/software";
import { ProcessTrivyExecutor, type TrivyExecutor } from "./trivy";
import { normalizeTrivy } from "./normalize";
import {
  WindowsAssessmentsModule,
  WindowsAssessmentService,
  windowsSubmitSchema,
} from "../windows-assessments/windows-assessments.module";
const EXECUTOR = Symbol("TRIVY_EXECUTOR");
const submitSchema = z.union([
  z
    .object({
      assetId: z.uuid(),
      snapshotId: z.uuid(),
      idempotencyKey: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      softwareId: z.uuid(),
      versionId: z.uuid(),
      linkId: z.uuid().optional(),
      idempotencyKey: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      containerId: z.uuid(),
      versionId: z.uuid(),
      containerSourceId: z.uuid().optional(),
      linkId: z.uuid().optional(),
      idempotencyKey: z.string().trim().min(1).max(200),
    })
    .strict(),
]);
type Submission = z.infer<typeof submitSchema>;
// Unresolved records stay separate rather than merging potentially different architectures.
const componentIdentitySql =
  "jsonb_build_array(value->>'componentId',value->>'packageName',value->>'installedVersion',value->>'ecosystem',value->>'target',CASE WHEN value->>'componentId' IS NULL THEN value->>'id' ELSE NULL END)";
const cols = `id,customer_id AS "customerId",status,details`;
function serialize(row: Record<string, unknown>): AnyAssessment {
  const { artifact, ...details } = row.details as StoredAssessment;
  return {
    ...details,
    id: String(row.id),
    customerId: String(row.customerId),
    status: row.status as Assessment["status"],
  };
}
export class AssessmentService {
  private active?: Promise<void>;
  private stopping = false;
  private wakeAgain = false;
  private abort?: AbortController;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private readonly db: Database,
    private readonly software: SoftwareService,
    private readonly containers: ContainerService,
    private readonly imports: ImportsService,
    private readonly executor: TrivyExecutor,
    private readonly links: CollectionLinksService,
    private readonly collections: CollectionsService,
  ) {}
  async onModuleInit() {
    await this.db.query(
      `UPDATE vulnerability_jobs SET status='interrupted',details=details || $1::jsonb WHERE status='running' AND details#>>'{target,kind}' IN ('software','container','linux')`,
      [
        JSON.stringify({
          error: "后端重启，执行结果无法确认；未自动重试",
          finishedAt: new Date().toISOString(),
        }),
      ],
    );
    // Compact older Linux records without changing findings, identities or report bytes.
    while (true) {
      const old = await this.db.query(
        `SELECT ${cols} FROM vulnerability_jobs WHERE details#>>'{target,kind}'='linux' AND details#>>'{execution,rawReport}' IS NOT NULL LIMIT 1`,
      );
      if (!old.rows.length) break;
      const job = serialize(old.rows[0]) as Assessment;
      await this.save(job);
    }
    this.wake();
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.abort?.abort();
    await this.active;
  }
  private wake() {
    if (this.stopping || this.timer) return;
    if (this.active) {
      this.wakeAgain = true;
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.active = this.drain().finally(() => {
        this.active = undefined;
        if (this.wakeAgain) {
          this.wakeAgain = false;
          this.wake();
        }
      });
    }, 10);
  }
  async submit(customer: string, input: Submission) {
    const target: Assessment["target"] =
      "assetId" in input
        ? {
            kind: "linux",
            assetId: input.assetId,
            snapshotId: input.snapshotId,
            versionId: input.snapshotId,
          }
        : "containerId" in input
          ? {
              kind: "container",
              containerId: input.containerId,
              versionId: input.versionId,
            }
          : {
              kind: "software",
              softwareId: input.softwareId,
              versionId: input.versionId,
            };
    const snapshot = await this.snapshot(customer, target);
    const material =
      target.kind === "linux"
        ? (snapshot as ReturnType<typeof linuxInput>)
        : await this.imports.get(customer, snapshot.importId);
    if (
      target.kind !== "linux" &&
      (!("format" in material) ||
        material.format !==
          (target.kind === "container"
            ? "container-cyclonedx-json"
            : "cyclonedx-json") ||
        material.content === undefined)
    )
      throw new BadRequestException("该输入不是可评估的软件 SBOM");
    const provenance =
      "linkId" in input && input.linkId
        ? await this.links.forVersion(
            customer,
            input.linkId,
            target.kind,
            "containerId" in target
              ? target.containerId
              : "softwareId" in target
                ? target.softwareId
                : target.assetId,
            target.versionId,
          )
        : undefined;
    let containerSource:
      | import("../../../../packages/contracts/container-runtime").ContainerSource
      | undefined;
    if ("containerSourceId" in input && input.containerSourceId) {
      const source = (
        await this.db.query(
          "SELECT details FROM container_sources WHERE customer_id=$1 AND id=$2 AND container_id=$3 AND version_id=$4",
          [
            customer,
            input.containerSourceId,
            "containerId" in input ? input.containerId : null,
            input.versionId,
          ],
        )
      ).rows[0];
      if (!source) throw new NotFoundException("该客户版本下未找到镜像来源");
      containerSource = source.details as typeof containerSource;
      if (containerSource?.assetId)
        await this.collections.assertTarget(customer, containerSource.assetId);
    }
    const record: Assessment = {
      id: randomUUID(),
      customerId: customer,
      status: "queued",
      idempotencyKey: input.idempotencyKey,
      target,
      input: {
        ...(containerSource ? { containerSource } : {}),
        importId: snapshot.importId,
        contentHash: material.contentHash,
        version: snapshot.version,
        ...(target.kind === "linux"
          ? {
              snapshotHash: (material as ReturnType<typeof linuxInput>)
                .snapshotHash,
              runtime: (material as ReturnType<typeof linuxInput>).runtime,
              scope:
                "已安装dpkg系统包；不含应用依赖、容器、挂载卷和运行内核适用性验证",
            }
          : {}),
        ...(provenance ? { provenance } : {}),
      },
      createdAt: new Date().toISOString(),
    };
    const saved = await this.db.transaction(async (session) => {
      if (target.kind === "linux")
        await requireActiveAsset(session, customer, target.assetId);
      if (provenance)
        await requireActiveAsset(session, customer, provenance.assetId);
      const insert = await session.query(
        `INSERT INTO vulnerability_jobs(id,customer_id,idempotency_key,status,details) VALUES($1,$2,$3,'queued',$4::jsonb) ON CONFLICT(customer_id,idempotency_key) DO NOTHING RETURNING ${cols}`,
        [record.id, customer, input.idempotencyKey, JSON.stringify(record)],
      );
      if (insert.rows.length) return serialize(insert.rows[0]);
      const existing = await session.query(
        `SELECT ${cols} FROM vulnerability_jobs WHERE customer_id=$1 AND idempotency_key=$2`,
        [customer, input.idempotencyKey],
      );
      const old = serialize(existing.rows[0]);
      if (
        (old.input as Assessment["input"]).provenance?.id !== provenance?.id ||
        old.target.kind !== target.kind ||
        old.target.versionId !== target.versionId ||
        ("containerId" in old.target
          ? old.target.containerId
          : "softwareId" in old.target
            ? old.target.softwareId
            : old.target.assetId) !==
          ("containerId" in target
            ? target.containerId
            : "softwareId" in target
              ? target.softwareId
              : target.assetId)
      )
        throw new ConflictException("幂等键已用于其他输入版本");
      return { ...old, replayed: true };
    });
    this.wake();
    return saved;
  }
  async linuxInputs(customer: string, assetId: string, offset: number) {
    await requireActiveAsset(this.db, customer, assetId);
    const page = await this.collections.list(customer, {
      assetId,
      limit: 20,
      offset,
    });
    const items = [];
    for (const item of page.items) {
      try {
        const input = linuxInput(
          await this.collections.row(customer, item.id),
          assetId,
        );
        items.push({
          id: item.id,
          importedAt: item.importedAt,
          os: input.os,
          packages: input.components.length,
          supported: true,
          reason: null,
        });
      } catch (e) {
        items.push({
          id: item.id,
          importedAt: item.importedAt,
          supported: false,
          reason: (e as Error).message,
        });
      }
    }
    return { items, total: page.total, offset };
  }
  async progress(customer: string, id: string) {
    const result = await this.db.query(
      `SELECT id,status,created_at AS "createdAt",details->>'startedAt' AS "startedAt",details->>'finishedAt' AS "finishedAt",details->>'error' AS error FROM vulnerability_jobs WHERE customer_id=$1 AND id=$2`,
      [customer, id],
    );
    if (!result.rows.length)
      throw new NotFoundException("该客户下未找到漏洞评估任务");
    return result.rows[0];
  }
  async get(
    customer: string,
    id: string,
    options: { includeRawReport?: boolean } = {},
  ) {
    const r = await this.db.query(
      `SELECT id,customer_id AS "customerId",status,${options.includeRawReport === false ? "details - 'artifact'" : "details"} AS details FROM vulnerability_jobs WHERE customer_id=$1 AND id=$2`,
      [customer, id],
    );
    if (!r.rows.length)
      throw new NotFoundException("该客户下未找到漏洞评估任务");
    const job = serialize(r.rows[0]);
    if (job.target.kind === "linux" && options.includeRawReport !== false) {
      const rawReport = await linuxReportContent(
        r.rows[0].details as StoredAssessment,
      );
      if (rawReport !== undefined && job.execution)
        job.execution = { ...job.execution, rawReport };
    }
    if (
      job.target.kind === "linux" &&
      options.includeRawReport === false &&
      job.execution
    ) {
      job.execution = { ...job.execution, rawReport: undefined };
    }
    return job;
  }
  async report(customer: string, id: string) {
    const rows = await this.db.query(
      `SELECT details->'artifact' AS artifact,details#>>'{execution,rawReport}' AS content,details#>>'{execution,outputHash}' AS "contentHash" FROM vulnerability_jobs WHERE customer_id=$1 AND id=$2`,
      [customer, id],
    );
    if (!rows.rows.length)
      throw new NotFoundException("该客户下未找到漏洞评估任务");
    const row = rows.rows[0];
    const content =
      typeof row.content === "string"
        ? row.content
        : await linuxReportContent({
            artifact: row.artifact,
          } as StoredAssessment);
    if (content === undefined)
      throw new ConflictException("本任务没有可下载的原始报告");
    return compress(JSON.stringify({ content, contentHash: row.contentHash }));
  }
  async evidence(customer: string, id: string, findingId: string) {
    const rows = await this.db.query(
      `SELECT details->'target' AS target,details->'input' AS input,details->'artifact' AS artifact,details#>>'{execution,rawReport}' AS content,
       (SELECT value FROM jsonb_array_elements(COALESCE(details#>'{result,findings}','[]'::jsonb)) WHERE value->>'id'=$3 LIMIT 1) AS finding
       FROM vulnerability_jobs WHERE customer_id=$1 AND id=$2`,
      [customer, id, findingId],
    );
    const row = rows.rows[0];
    if (!row?.finding) throw new NotFoundException("该扫描下未找到漏洞记录");
    const job = { target: row.target, input: row.input } as Assessment;
    if (!["linux", "software", "container"].includes(job.target.kind))
      throw new BadRequestException("Windows 使用独立的证据结果");
    const finding =
      row.finding as import("../../../../packages/contracts/assessments").VulnerabilityFinding;
    const content =
      job.target.kind === "linux"
        ? typeof row.content === "string"
          ? row.content
          : await linuxReportContent({
              artifact: row.artifact,
            } as StoredAssessment)
        : undefined;
    const raw = originalFindingEvidence(finding, content);
    const runtime = await assessmentRuntime(
      this.db,
      customer,
      job.target,
      job.input,
    );
    return findingContext(finding, { ...job.input, runtime }, raw);
  }
  async page(
    customer: string,
    id: string,
    offset: number,
    severities?: string[],
    search = "",
    component = "",
  ) {
    const rows = await this.db.query(
      `WITH scoped AS (SELECT * FROM vulnerability_jobs WHERE customer_id=$1 AND id=$2),
       filtered AS (SELECT *, CASE WHEN $4::text[] IS NULL AND $5::text='' THEN details#>'{result,findings}' ELSE
         (SELECT COALESCE(jsonb_agg(value ORDER BY ordinal),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(details#>'{result,findings}','[]'::jsonb)) WITH ORDINALITY AS entries(value,ordinal) WHERE ($4::text[] IS NULL OR upper(value->>'severity')=ANY($4::text[])) AND ($5::text='' OR strpos(lower(concat_ws(' ',value->>'vulnerabilityId',value->>'packageName',value->>'installedVersion')),lower($5::text))>0)) END AS visible FROM scoped),
       selected AS (SELECT *, CASE WHEN $6::text='' THEN visible ELSE
         (SELECT COALESCE(jsonb_agg(value ORDER BY ordinal),'[]'::jsonb) FROM jsonb_array_elements(COALESCE(visible,'[]'::jsonb)) WITH ORDINALITY AS entries(value,ordinal)
          WHERE ${componentIdentitySql}=NULLIF($6::text,'')::jsonb) END AS shown FROM filtered)
       SELECT id,customer_id AS "customerId",status,
       jsonb_build_object(
          'findingStats', (SELECT jsonb_build_object('records',count(*),'uniqueCves',count(DISTINCT value->>'vulnerabilityId'),'components',count(DISTINCT ${componentIdentitySql})) FROM jsonb_array_elements(COALESCE(details#>'{result,findings}','[]'::jsonb))),
         'componentGroups', (SELECT COALESCE(jsonb_agg(g ORDER BY g->>'packageName',g->>'installedVersion',g->>'key'),'[]'::jsonb) FROM (
           SELECT jsonb_build_object('key',identity::text,'componentId',identity->0,'packageName',identity->1,'installedVersion',identity->2,'ecosystem',identity->3,'target',identity->4,'records',count(*),'uniqueCves',count(DISTINCT cve),'severities',jsonb_build_object('CRITICAL',count(*) FILTER (WHERE severity='CRITICAL'),'HIGH',count(*) FILTER (WHERE severity='HIGH'),'MEDIUM',count(*) FILTER (WHERE severity='MEDIUM'),'LOW',count(*) FILTER (WHERE severity='LOW'),'UNKNOWN',count(*) FILTER (WHERE severity NOT IN ('CRITICAL','HIGH','MEDIUM','LOW')))) AS g FROM (
             SELECT ${componentIdentitySql} AS identity,value->>'vulnerabilityId' AS cve,upper(value->>'severity') AS severity FROM jsonb_array_elements(COALESCE(visible,'[]'::jsonb))
           ) AS entries GROUP BY identity
         ) AS groups),
         'idempotencyKey',details->'idempotencyKey' ,'target',details->'target','input',details->'input',
         'createdAt',details->'createdAt','startedAt',details->'startedAt','finishedAt',details->'finishedAt','error',details->'error',
         'execution',CASE WHEN details ? 'execution' THEN jsonb_build_object(
           'status',details#>'{execution,status}','toolVersion',details#>'{execution,toolVersion}',
           'argv',details#>'{execution,argv}','startedAt',details#>'{execution,startedAt}','finishedAt',details#>'{execution,finishedAt}',
           'exitCode',details#>'{execution,exitCode}','signal',details#>'{execution,signal}','stderr',details#>'{execution,stderr}',
           'databaseBefore',details#>'{execution,databaseBefore}','databaseAfter',details#>'{execution,databaseAfter}',
           'outputHash',details#>'{execution,outputHash}','error',details#>'{execution,error}'
         ) ELSE NULL END,
         'result',CASE WHEN details ? 'result' THEN jsonb_build_object(
           'outcome',details#>'{result,outcome}','coverage',details#>'{result,coverage}','database',details#>'{result,database}',
           'parserVersion',details#>'{result,parserVersion}',
           'findings',COALESCE(jsonb_path_query_array(shown, ('$[' || $3::int || ' to ' || ($3::int+49) || ']')::jsonpath),'[]'::jsonb)
         ) ELSE NULL END,
         'findingsPage',jsonb_build_object('total',COALESCE(jsonb_array_length(shown),0),'offset',$3::int,'limit',50) || CASE WHEN $6::text='' THEN '{}'::jsonb ELSE jsonb_build_object('component',$6::text) END || CASE WHEN $5::text='' THEN '{}'::jsonb ELSE jsonb_build_object('search',$5::text) END || CASE WHEN $4::text[] IS NULL AND $5::text='' AND $6::text='' THEN '{}'::jsonb ELSE jsonb_build_object('unfilteredTotal',COALESCE(jsonb_array_length(details#>'{result,findings}'),0),'severities',to_jsonb($4::text[])) END
       ) AS details FROM selected`,
      [customer, id, offset, severities ?? null, search, component],
    );
    if (!rows.rows.length)
      throw new NotFoundException("该客户下未找到漏洞评估任务");
    const job = serialize(rows.rows[0]);
    if (job.target.kind !== "linux")
      throw new BadRequestException("此分页用于Linux扫描结果");
    const linux = job as Assessment;
    const runtime = await assessmentRuntime(
      this.db,
      customer,
      linux.target,
      linux.input,
    );
    if (linux.result)
      linux.result.findings = linux.result.findings.map((f) => ({
        ...f,
        runtimeApplicability: findingContext(f, { ...linux.input, runtime })
          .applicability,
      }));
    return linux;
  }
  async list(
    customer: string,
    page: {
      limit?: number;
      offset?: number;
      targetKind?: "software" | "container" | "windows" | "linux";
      targetId?: string;
      versionId?: string;
      assetId?: string;
    } = {},
  ): Promise<AnyAssessmentPage> {
    const limit = page.limit ?? 50,
      offset = page.offset ?? 0;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 1000000
    )
      throw new BadRequestException("分页无效");
    const params: unknown[] = [customer];
    let where = "customer_id=$1";
    if (page.targetKind) {
      params.push(page.targetKind);
      where += ` AND details#>>'{target,kind}'=$${params.length}`;
    }
    for (const [name, expression] of [
      [
        "assetId",
        "COALESCE(details#>>'{target,assetId}',details#>>'{input,provenance,assetId}')",
      ],
      [
        "targetId",
        "COALESCE(details#>>'{target,softwareId}',details#>>'{target,containerId}',details#>>'{target,assetId}')",
      ],
      [
        "versionId",
        "COALESCE(details#>>'{target,versionId}',details#>>'{target,snapshotId}')",
      ],
    ] as const) {
      if (page[name]) {
        if (!z.uuid().safeParse(page[name]).success)
          throw new BadRequestException("目标筛选编号无效");
        params.push(page[name]);
        where += ` AND ${expression}=$${params.length}`;
      }
    }
    const r = await this.db.query(
      `SELECT id,customer_id AS "customerId",status,jsonb_build_object('idempotencyKey',details->'idempotencyKey','target',details->'target','input',details->'input','createdAt',details->'createdAt','startedAt',details->'startedAt','finishedAt',details->'finishedAt','error',details->'error') AS details,details#>'{result,coverage}' AS coverage,details#>'{result,database}' AS database,jsonb_array_length(details#>'{result,findings}') AS "findingCount" FROM vulnerability_jobs WHERE ${where} ORDER BY created_at DESC,id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const count = await this.db.query(
      `SELECT count(*)::int AS total FROM vulnerability_jobs WHERE ${where}`,
      params,
    );
    return {
      items: r.rows.map((row) => {
        const { execution, result, ...item } = serialize(row);
        return {
          ...item,
          findingCount:
            row.findingCount == null ? null : Number(row.findingCount),
          coverage: (row.coverage ?? undefined) as
            AssessmentResult["coverage"] | undefined,
          database: (row.database ?? undefined) as
            AssessmentResult["database"] | undefined,
        } as AnyAssessmentSummary;
      }),
      total: Number(count.rows[0].total),
      limit,
      offset,
    };
  }
  private async snapshot(customer: string, target: Assessment["target"]) {
    if (target.kind === "linux")
      return linuxInput(
        await this.collections.row(customer, target.snapshotId),
        target.assetId,
      );
    return target.kind === "container"
      ? this.containers.getVersion(
          customer,
          target.containerId,
          target.versionId,
        )
      : this.software.getVersion(customer, target.softwareId, target.versionId);
  }
  private async save(record: Assessment) {
    const stored = await packLinuxAssessment(record);
    await this.db.query(
      `UPDATE vulnerability_jobs SET status=$3,details=$4::jsonb WHERE customer_id=$1 AND id=$2`,
      [record.customerId, record.id, record.status, JSON.stringify(stored)],
    );
  }
  private async drain() {
    while (!this.stopping) {
      const rows = await this.db.query(
        `UPDATE vulnerability_jobs SET status='running' WHERE id=(SELECT id FROM vulnerability_jobs WHERE status='queued' AND details#>>'{target,kind}' IN ('software','container','linux') ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) AND status='queued' RETURNING ${cols}`,
      );
      if (!rows.rows.length) return;
      const selected = serialize(rows.rows[0]);
      // Ownership is enforced by the claim query; retain a runtime guard for future target additions.
      if (selected.target.kind === "windows")
        throw Error("Windows task cannot be executed by Trivy");
      const job = selected as Assessment;
      job.startedAt = new Date().toISOString();
      await this.save(job);
      this.abort = new AbortController();
      try {
        const snapshot = await this.snapshot(job.customerId, job.target);
        const material =
          job.target.kind === "linux"
            ? (snapshot as ReturnType<typeof linuxInput>)
            : await this.imports.get(job.customerId, job.input.importId);
        if (
          material.content === undefined ||
          createHash("sha256").update(material.content).digest("hex") !==
            job.input.contentHash
        )
          throw Error("输入资料内容校验失败");
        const execution = await this.executor.execute(
          {
            content: material.content,
            contentHash: job.input.contentHash,
            ...(job.target.kind === "linux" ? { kind: "linux" as const } : {}),
          },
          this.abort.signal,
        );
        if (execution.rawReport !== undefined)
          execution.outputHash = createHash("sha256")
            .update(execution.rawReport)
            .digest("hex");
        job.execution = execution;
        job.status = execution.status;
        job.error = execution.error;
        if (execution.status === "succeeded")
          job.result = normalizeTrivy(
            execution,
            snapshot.components as SoftwareComponent[],
            job.target.kind === "linux"
              ? (material as ReturnType<typeof linuxInput>).os
              : undefined,
          );
      } catch (error) {
        job.status = this.stopping ? "interrupted" : "failed";
        job.error = (error as Error).message;
      }
      job.finishedAt = new Date().toISOString();
      await this.save(job);
      this.abort = undefined;
    }
  }
}
@Controller("api/customers/:customerId/assessments")
class AssessmentsController {
  constructor(
    private readonly assessments: AssessmentService,
    private readonly windows: WindowsAssessmentService,
  ) {}
  @Post() @HttpCode(202) submit(req: AuthorizedRequest) {
    if (
      req.body &&
      typeof req.body === "object" &&
      "ruleImportId" in req.body
    ) {
      const windows = windowsSubmitSchema.safeParse(req.body);
      if (!windows.success)
        throw new BadRequestException("需固定快照、规则资料 UUID 和幂等键");
      return this.windows.submit(req.params.customerId, windows.data);
    }
    const input = submitSchema.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException("需软件/输入版本 UUID 和幂等键");
    return this.assessments.submit(req.params.customerId, input.data);
  }
  @Get() list(req: AuthorizedRequest) {
    const page = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        targetKind: z
          .enum(["software", "container", "windows", "linux"])
          .optional(),
        targetId: z.uuid().optional(),
        assetId: z.uuid().optional(),
        versionId: z.uuid().optional(),
        offset: z.coerce.number().int().min(0).max(1000000).optional(),
      })
      .strict()
      .safeParse(req.query);
    if (!page.success) throw new BadRequestException("分页无效");
    return this.assessments.list(req.params.customerId, page.data);
  }
  @Get("linux-inputs") linuxInputs(req: AuthorizedRequest) {
    const query = z
      .object({
        assetId: z.uuid(),
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
      })
      .strict()
      .safeParse(req.query);
    if (!query.success)
      throw new BadRequestException("需目标资产编号与有效分页");
    return this.assessments.linuxInputs(
      req.params.customerId,
      query.data.assetId,
      query.data.offset,
    );
  }
  @Get(":assessmentId/events")
  async events(req: AuthorizedRequest & Request, response: Response) {
    if (!z.uuid().safeParse(req.params.assessmentId).success)
      throw new BadRequestException("任务编号无效");
    const read = () =>
      this.assessments.progress(req.params.customerId, req.params.assessmentId);
    const initial = await read(); // Authorize the specific customer/task before streaming headers.
    if (response.destroyed) return;
    response.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    let closed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const close = () => {
      closed = true;
      if (timer) clearTimeout(timer);
    };
    response.on("close", close);
    const send = async (state: Record<string, unknown>) => {
      if (closed) return;
      response.write(`event: progress\ndata: ${JSON.stringify(state)}\n\n`);
      if (!["queued", "running"].includes(String(state.status))) {
        close();
        response.end();
        return;
      }
      timer = setTimeout(async () => {
        try {
          await send(await read());
        } catch {
          if (!closed) {
            response.write("event: unavailable\ndata: {}\n\n");
            close();
            response.end();
          }
        }
      }, 1000);
    };
    await send(initial);
  }
  @Get(":assessmentId/findings/:findingId/evidence")
  evidence(req: AuthorizedRequest) {
    if (
      !z.uuid().safeParse(req.params.assessmentId).success ||
      !z.uuid().safeParse(req.params.findingId).success
    )
      throw new BadRequestException("漏洞记录编号无效");
    return this.assessments.evidence(
      req.params.customerId,
      req.params.assessmentId,
      req.params.findingId,
    );
  }
  @Get(":assessmentId/report")
  async report(req: AuthorizedRequest, response: Response) {
    if (!z.uuid().safeParse(req.params.assessmentId).success)
      throw new BadRequestException("任务编号无效");
    const content = await this.assessments.report(
      req.params.customerId,
      req.params.assessmentId,
    );
    response.setHeader("Content-Encoding", "gzip");
    return new StreamableFile(content, { type: "application/json" });
  }
  @Get(":assessmentId") async get(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.assessmentId).success)
      throw new BadRequestException("任务编号无效");
    const query = z
      .object({
        findingsOffset: z.coerce.number().int().min(0).max(1000000).optional(),
        search: z.string().trim().max(200).optional(),
        component: z
          .string()
          .max(4000)
          .refine((value) => {
            try {
              return componentIdentitySchema.safeParse(JSON.parse(value))
                .success;
            } catch {
              return false;
            }
          })
          .optional(),
        severities: z
          .string()
          .transform((v) => (v ? v.split(",") : []))
          .pipe(
            z
              .array(z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]))
              .max(5),
          )
          .optional(),
      })
      .strict()
      .safeParse(req.query);
    if (!query.success) throw new BadRequestException("结果分页无效");
    if (
      (query.data.severities !== undefined ||
        query.data.search !== undefined ||
        query.data.component !== undefined) &&
      query.data.findingsOffset === undefined
    )
      throw new BadRequestException("等级筛选需指定结果分页");
    if (query.data.findingsOffset !== undefined)
      return this.assessments.page(
        req.params.customerId,
        req.params.assessmentId,
        query.data.findingsOffset,
        query.data.severities,
        query.data.search,
        query.data.component,
      );
    return this.assessments.get(req.params.customerId, req.params.assessmentId);
  }
}
for (const method of [
  "submit",
  "list",
  "get",
  "linuxInputs",
  "report",
  "events",
  "evidence",
] as const)
  Req()(AssessmentsController.prototype, method, 0);
Res({ passthrough: true })(AssessmentsController.prototype, "report", 1);
Res()(AssessmentsController.prototype, "events", 1);
Inject(AssessmentService)(AssessmentsController, undefined, 0);
Inject(WindowsAssessmentService)(AssessmentsController, undefined, 1);
@Module({})
export class AssessmentsModule {
  static register(
    executor: TrivyExecutor = new ProcessTrivyExecutor(),
  ): DynamicModule {
    return {
      module: AssessmentsModule,
      imports: [
        CollectionLinksModule,
        CollectionsModule,
        SoftwareModule,
        ContainersModule,
        ImportsModule,
        WindowsAssessmentsModule,
      ],
      controllers: [AssessmentsController],
      providers: [
        { provide: EXECUTOR, useValue: executor },
        {
          provide: AssessmentService,
          inject: [
            DATABASE,
            SoftwareService,
            ContainerService,
            ImportsService,
            EXECUTOR,
            CollectionLinksService,
            CollectionsService,
          ],
          useFactory: (
            db: Database,
            software: SoftwareService,
            containers: ContainerService,
            imports: ImportsService,
            runner: TrivyExecutor,
            links: CollectionLinksService,
            collections: CollectionsService,
          ) =>
            new AssessmentService(
              db,
              software,
              containers,
              imports,
              runner,
              links,
              collections,
            ),
        },
      ],
      exports: [AssessmentService],
    };
  }
}
