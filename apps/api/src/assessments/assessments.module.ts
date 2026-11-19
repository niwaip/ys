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
  Inject,
  Module,
  NotFoundException,
  Post,
  Req,
} from "@nestjs/common";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { DATABASE, type Database } from "../persistence/database";
import { SoftwareModule, SoftwareService } from "../software/software.module";
import { ImportsModule, ImportsService } from "../imports/imports.module";
import type { AuthorizedRequest } from "../auth/auth";
import type {
  Assessment,
  AssessmentPage,
  AssessmentResult,
} from "../../../../packages/contracts/assessments";
import type { SoftwareComponent } from "../../../../packages/contracts/software";
import { ProcessTrivyExecutor, type TrivyExecutor } from "./trivy";
import { normalizeTrivy } from "./normalize";
const EXECUTOR = Symbol("TRIVY_EXECUTOR");
const submitSchema = z.union([
  z
    .object({
      softwareId: z.uuid(),
      versionId: z.uuid(),
      idempotencyKey: z.string().trim().min(1).max(200),
    })
    .strict(),
  z
    .object({
      containerId: z.uuid(),
      versionId: z.uuid(),
      idempotencyKey: z.string().trim().min(1).max(200),
    })
    .strict(),
]);
type Submission = z.infer<typeof submitSchema>;
const cols = `id,customer_id AS "customerId",status,details`;
function serialize(row: Record<string, unknown>): Assessment {
  return {
    ...(row.details as Assessment),
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
  ) {}
  async onModuleInit() {
    await this.db.query(
      `UPDATE vulnerability_jobs SET status='interrupted',details=details || $1::jsonb WHERE status='running' AND details#>>'{target,kind}' IN ('software','container')`,
      [
        JSON.stringify({
          error: "后端重启，执行结果无法确认；未自动重试",
          finishedAt: new Date().toISOString(),
        }),
      ],
    );
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
      "containerId" in input
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
    const material = await this.imports.get(customer, snapshot.importId);
    if (
      material.format !==
        (target.kind === "container"
          ? "container-cyclonedx-json"
          : "cyclonedx-json") ||
      material.content === undefined
    )
      throw new BadRequestException("该输入不是可评估的软件 SBOM");
    const record: Assessment = {
      id: randomUUID(),
      customerId: customer,
      status: "queued",
      idempotencyKey: input.idempotencyKey,
      target,
      input: {
        importId: snapshot.importId,
        contentHash: material.contentHash,
        version: snapshot.version,
      },
      createdAt: new Date().toISOString(),
    };
    const saved = await this.db.transaction(async (session) => {
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
        old.target.kind !== target.kind ||
        old.target.versionId !== target.versionId ||
        ("containerId" in old.target
          ? old.target.containerId
          : old.target.softwareId) !==
          ("containerId" in target ? target.containerId : target.softwareId)
      )
        throw new ConflictException("幂等键已用于其他输入版本");
      return { ...old, replayed: true };
    });
    this.wake();
    return saved;
  }
  async get(customer: string, id: string) {
    const r = await this.db.query(
      `SELECT ${cols} FROM vulnerability_jobs WHERE customer_id=$1 AND id=$2`,
      [customer, id],
    );
    if (!r.rows.length)
      throw new NotFoundException("该客户下未找到漏洞评估任务");
    return serialize(r.rows[0]);
  }
  async list(
    customer: string,
    page: {
      limit?: number;
      offset?: number;
      targetKind?: "software" | "container" | "windows";
      targetId?: string;
      versionId?: string;
    } = {},
  ): Promise<AssessmentPage> {
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
      `SELECT id,customer_id AS "customerId",status,details - 'execution' - 'result' AS details,details#>'{result,coverage}' AS coverage,details#>'{result,database}' AS database,jsonb_array_length(details#>'{result,findings}') AS "findingCount" FROM vulnerability_jobs WHERE ${where} ORDER BY created_at DESC,id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
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
        };
      }),
      total: Number(count.rows[0].total),
      limit,
      offset,
    };
  }
  private snapshot(customer: string, target: Assessment["target"]) {
    return target.kind === "container"
      ? this.containers.getVersion(
          customer,
          target.containerId,
          target.versionId,
        )
      : this.software.getVersion(customer, target.softwareId, target.versionId);
  }
  private async save(record: Assessment) {
    await this.db.query(
      `UPDATE vulnerability_jobs SET status=$3,details=$4::jsonb WHERE customer_id=$1 AND id=$2`,
      [record.customerId, record.id, record.status, JSON.stringify(record)],
    );
  }
  private async drain() {
    while (!this.stopping) {
      const rows = await this.db.query(
        `UPDATE vulnerability_jobs SET status='running' WHERE id=(SELECT id FROM vulnerability_jobs WHERE status='queued' AND details#>>'{target,kind}' IN ('software','container') ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) AND status='queued' RETURNING ${cols}`,
      );
      if (!rows.rows.length) return;
      const job = serialize(rows.rows[0]);
      job.startedAt = new Date().toISOString();
      await this.save(job);
      this.abort = new AbortController();
      try {
        const snapshot = await this.snapshot(job.customerId, job.target);
        const material = await this.imports.get(
          job.customerId,
          job.input.importId,
        );
        if (
          material.content === undefined ||
          createHash("sha256").update(material.content).digest("hex") !==
            job.input.contentHash
        )
          throw Error("输入资料内容校验失败");
        const execution = await this.executor.execute(
          { content: material.content, contentHash: job.input.contentHash },
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
  constructor(private readonly assessments: AssessmentService) {}
  @Post() @HttpCode(202) submit(req: AuthorizedRequest) {
    const input = submitSchema.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException("需软件/输入版本 UUID 和幂等键");
    return this.assessments.submit(req.params.customerId, input.data);
  }
  @Get() list(req: AuthorizedRequest) {
    const page = z
      .object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
        targetKind: z.enum(["software", "container", "windows"]).optional(),
        targetId: z.uuid().optional(),
        versionId: z.uuid().optional(),
        offset: z.coerce.number().int().min(0).max(1000000).optional(),
      })
      .strict()
      .safeParse(req.query);
    if (!page.success) throw new BadRequestException("分页无效");
    return this.assessments.list(req.params.customerId, page.data);
  }
  @Get(":assessmentId") get(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.assessmentId).success)
      throw new BadRequestException("任务编号无效");
    return this.assessments.get(req.params.customerId, req.params.assessmentId);
  }
}
for (const method of ["submit", "list", "get"] as const)
  Req()(AssessmentsController.prototype, method, 0);
Inject(AssessmentService)(AssessmentsController, undefined, 0);
@Module({})
export class AssessmentsModule {
  static register(
    executor: TrivyExecutor = new ProcessTrivyExecutor(),
  ): DynamicModule {
    return {
      module: AssessmentsModule,
      imports: [SoftwareModule, ContainersModule, ImportsModule],
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
          ],
          useFactory: (
            db: Database,
            software: SoftwareService,
            containers: ContainerService,
            imports: ImportsService,
            runner: TrivyExecutor,
          ) => new AssessmentService(db, software, containers, imports, runner),
        },
      ],
      exports: [AssessmentService],
    };
  }
}
