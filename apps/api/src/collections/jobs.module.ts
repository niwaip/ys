import {
  BadRequestException,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Module,
  NotFoundException,
  Post,
  Req,
  type DynamicModule,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { DATABASE, type Database } from "../persistence/database";
import type { AppConfig } from "../config";
import type { AuthorizedRequest } from "../auth/auth";
import { AgentExecutionError } from "../agent/errors";
import { CollectionsModule, CollectionsService } from "./collections.module";
import {
  PiCollectionExecutor,
  type CollectionExecutor,
  type CollectionTaskInput,
} from "./pi-collection";
const submit = z
  .object({
    assetId: z.uuid(),
    idempotencyKey: z.string().min(1).max(100),
    profileId: z.string().min(1).max(80),
    scope: z.enum(["basic", "container-inventory"]),
    message: z.string().trim().min(1).max(4000),
  })
  .strict();
type Job = CollectionTaskInput & {
  status: string;
  snapshotId: string | null;
  error: string | null;
  events: { type: string; message: string; at: string }[];
  createdAt: string;
};
export class CollectionJobsService {
  private draining: Promise<void> | undefined;
  private stopping = false;
  private wakeAgain = false;
  private controller: AbortController | undefined;
  constructor(
    private readonly db: Database,
    private readonly collections: CollectionsService,
    private readonly config: AppConfig,
    private readonly executor: CollectionExecutor,
  ) {}
  async onModuleInit() {
    const running = await this.db.query(
      "SELECT id,customer_id,details FROM collection_jobs WHERE status='running'",
    );
    for (const row of running.rows) {
      const job = row.details as Job;
      job.status = "interrupted";
      job.error = "服务重启中断，未自动重连；重试请提交新请求";
      await this.persist(job);
    }
    void this.drain();
  }
  async onModuleDestroy() {
    this.stopping = true;
    this.controller?.abort();
    await this.draining;
  }
  profiles(customerId: string) {
    return {
      piConfigured: Boolean(this.config.pi?.executable),
      items: (this.config.collection?.profiles ?? [])
        .filter((p) => p.customerId === customerId)
        .map((p) => ({
          id: p.id,
          label: p.label,
          assetId: p.assetId,
          scopes: p.allowDocker ? ["basic", "container-inventory"] : ["basic"],
        })),
    };
  }
  private profile(job: CollectionTaskInput) {
    const profile = this.config.collection?.profiles.find(
      (p) =>
        p.id === job.profileId &&
        p.customerId === job.customerId &&
        p.assetId === job.assetId,
    );
    if (
      !profile ||
      (job.scope === "container-inventory" && !profile.allowDocker)
    )
      throw new ForbiddenException("连接引用未授权当前客户、目标或采集范围");
    return profile;
  }
  private async persist(job: Job) {
    await this.db.query(
      "UPDATE collection_jobs SET status=$3,details=$4::jsonb WHERE customer_id=$1 AND id=$2",
      [job.customerId, job.id, job.status, JSON.stringify(job)],
    );
  }
  async submit(
    customerId: string,
    input: z.infer<typeof submit>,
  ): Promise<unknown> {
    const asset = (
      await this.db.query(
        "SELECT id FROM assets WHERE customer_id=$1 AND id=$2",
        [customerId, input.assetId],
      )
    ).rows[0];
    if (!asset) throw new NotFoundException("该客户下未找到目标资产");
    await this.collections.assertTarget(customerId, input.assetId);
    const hash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const old = (
      await this.db.query(
        "SELECT input_hash,details FROM collection_jobs WHERE customer_id=$1 AND idempotency_key=$2",
        [customerId, input.idempotencyKey],
      )
    ).rows[0];
    if (old) {
      if (old.input_hash !== hash)
        throw new ConflictException("幂等键对应不同目标、连接、范围或需求");
      return old.details;
    }
    const job: Job = {
      id: randomUUID(),
      customerId,
      assetId: input.assetId,
      profileId: input.profileId,
      scope: input.scope,
      message: input.message,
      status: this.config.pi?.executable ? "queued" : "unavailable",
      snapshotId: null,
      error: this.config.pi?.executable
        ? null
        : "Pi未配置；未连接目标，可使用手工或上传入口",
      events: [],
      createdAt: new Date().toISOString(),
    };
    if (job.status === "queued") this.profile(job);
    const saved = await this.db.query(
      "INSERT INTO collection_jobs(id,customer_id,asset_id,idempotency_key,input_hash,status,details) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) ON CONFLICT(customer_id,idempotency_key) DO NOTHING RETURNING id",
      [
        job.id,
        customerId,
        input.assetId,
        input.idempotencyKey,
        hash,
        job.status,
        JSON.stringify(job),
      ],
    );
    if (!saved.rows.length) return this.submit(customerId, input);
    if (job.status === "queued") queueMicrotask(() => void this.drain());
    return job;
  }
  private drain() {
    if (this.stopping) return this.draining;
    if (this.draining) {
      this.wakeAgain = true;
      return this.draining;
    }
    this.draining = this.work().finally(() => {
      this.draining = undefined;
      if (this.wakeAgain && !this.stopping) {
        this.wakeAgain = false;
        void this.drain();
      }
    });
    return this.draining;
  }
  private async work() {
    while (!this.stopping) {
      const row = (
        await this.db.query(
          "SELECT details FROM collection_jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1",
        )
      ).rows[0];
      if (!row) return;
      const job = row.details as Job;
      job.status = "running";
      await this.persist(job);
      this.controller = new AbortController();
      const timer = setTimeout(
        () => this.controller?.abort(),
        this.config.pi?.timeoutMs ?? 120000,
      );
      try {
        await this.collections.assertTarget(job.customerId, job.assetId);
        const profile = this.profile(job);
        const data = await this.executor.execute(
          job,
          profile,
          async (type, message) => {
            if (job.events.length < 100)
              job.events.push({ type, message, at: new Date().toISOString() });
            await this.persist(job);
          },
          this.controller.signal,
        );
        if (this.controller.signal.aborted)
          throw new AgentExecutionError("timed_out", "采集超时或已中止");
        const snapshot = await this.collections.save(
          job.customerId,
          job.assetId,
          "pi",
          `${job.id}.json`,
          JSON.stringify(data),
        );
        job.snapshotId = snapshot.id;
        job.status = Object.values(data.sections).some(
          (s) => s.status !== "acquired",
        )
          ? "partial"
          : "succeeded";
      } catch (error) {
        job.status = this.stopping
          ? "interrupted"
          : error instanceof AgentExecutionError
            ? error.status
            : error instanceof ForbiddenException
              ? "unavailable"
              : "failed";
        job.error =
          error instanceof AgentExecutionError ||
          error instanceof ForbiddenException
            ? error.message
            : "固定采集工具失败或产物与目标冲突，未保存成功快照";
      } finally {
        clearTimeout(timer);
        this.controller = undefined;
        await this.persist(job);
      }
    }
  }
  async get(customerId: string, id: string) {
    const row = (
      await this.db.query(
        "SELECT details FROM collection_jobs WHERE customer_id=$1 AND id=$2",
        [customerId, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("该客户下未找到采集任务");
    return row.details;
  }
  async list(customerId: string) {
    return {
      items: (
        await this.db.query(
          "SELECT details FROM collection_jobs WHERE customer_id=$1 ORDER BY created_at DESC,id LIMIT 100",
          [customerId],
        )
      ).rows.map((row) => row.details),
    };
  }
}
@Controller("api/customers/:customerId/collections")
class JobsController {
  constructor(private readonly service: CollectionJobsService) {}
  @Get("profiles") profiles(req: AuthorizedRequest) {
    return this.service.profiles(req.params.customerId);
  }
  @Post("jobs") submit(req: AuthorizedRequest) {
    const input = submit.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException("目标、连接引用、范围、需求和幂等键无效");
    return this.service.submit(req.params.customerId, input.data);
  }
  @Get("jobs") list(req: AuthorizedRequest) {
    return this.service.list(req.params.customerId);
  }
  @Get("jobs/:jobId") get(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.jobId).success)
      throw new BadRequestException("任务编号无效");
    return this.service.get(req.params.customerId, req.params.jobId);
  }
}
for (const method of ["profiles", "submit", "list", "get"] as const)
  Req()(JobsController.prototype, method, 0);
Inject(CollectionJobsService)(JobsController, undefined, 0);
@Module({})
export class CollectionJobsModule {
  static register(
    config: AppConfig,
    executor?: CollectionExecutor,
  ): DynamicModule {
    return {
      module: CollectionJobsModule,
      imports: [CollectionsModule],
      controllers: [JobsController],
      providers: [
        {
          provide: CollectionJobsService,
          inject: [DATABASE, CollectionsService],
          useFactory: (db: Database, collections: CollectionsService) =>
            new CollectionJobsService(
              db,
              collections,
              config,
              executor ?? new PiCollectionExecutor(config.pi ?? {}),
            ),
        },
      ],
    };
  }
}
