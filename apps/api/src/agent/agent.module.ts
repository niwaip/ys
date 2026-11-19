import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpCode,
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
import type { AuthorizedRequest } from "../auth/auth";
import type {
  AgentEvent,
  AgentQuery,
  PublicIntelligenceResult,
} from "../../../../packages/contracts/agent";
import { configuredPublicExecutor } from "./pi-process";
export interface PublicQueryExecutor {
  execute(
    input: { id: string; message: string },
    emit: (type: string, message: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<PublicIntelligenceResult>;
}
export { AgentExecutionError } from "./errors";
import { AgentExecutionError } from "./errors";
const inputSchema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
export class AgentService {
  private pending = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private stopping = false;
  constructor(
    private db: Database,
    private executor: PublicQueryExecutor,
  ) {}
  async onModuleInit() {
    await this.db.query(
      "UPDATE agent_queries SET status='interrupted', error='服务重启中断；未自动重试',finished_at=now() WHERE status='running'",
    );
    const queued = await this.db.query(
      "SELECT id FROM agent_queries WHERE status='queued'",
    );
    for (const row of queued.rows) this.schedule(String(row.id));
  }
  async onApplicationShutdown() {
    this.stopping = true;
    for (const controller of this.controllers.values()) controller.abort();
    await Promise.allSettled(this.pending.values());
  }
  private schedule(id: string) {
    if (this.pending.has(id) || this.stopping) return;
    const work = this.run(id)
      .catch(() => {})
      .finally(() => {
        this.pending.delete(id);
        this.controllers.delete(id);
      });
    this.pending.set(id, work);
  }
  private async run(id: string) {
    const claimed = await this.db.query(
      "UPDATE agent_queries SET status='running' WHERE id=$1 AND status='queued' RETURNING original_message",
      [id],
    );
    if (!claimed.rows.length) return;
    const controller = new AbortController();
    this.controllers.set(id, controller);
    const emit = async (type: string, message: string) => {
      const event: AgentEvent = {
        at: new Date().toISOString(),
        type,
        message: message.slice(0, 2000),
      };
      await this.db.query(
        "UPDATE agent_queries SET events=events || $2::jsonb WHERE id=$1",
        [id, JSON.stringify([event])],
      );
    };
    try {
      await emit("started", "Pi 公开情报任务开始");
      const result = await this.executor.execute(
        { id, message: String(claimed.rows[0].original_message) },
        emit,
        controller.signal,
      );
      const status =
        result.status === "complete_for_declared_sources"
          ? "succeeded"
          : result.status;
      await this.db.query(
        "UPDATE agent_queries SET status=$2,result=$3::jsonb,finished_at=now() WHERE id=$1",
        [id, status, JSON.stringify(result)],
      );
    } catch (error) {
      const status = this.stopping
        ? "interrupted"
        : error instanceof AgentExecutionError
          ? error.status
          : "failed";
      const message = this.stopping
        ? "服务停止；任务未自动重试"
        : error instanceof AgentExecutionError
          ? error.message
          : "Pi 执行失败，未取得可验证的工具结果";
      await this.db.query(
        "UPDATE agent_queries SET status=$2,error=$3,finished_at=now() WHERE id=$1",
        [id, status, message],
      );
    }
  }
  async submit(owner: string, input: z.infer<typeof inputSchema>) {
    const id = await this.db.transaction(async (db) => {
      const previous = await db.query(
        "SELECT id,original_message FROM agent_queries WHERE owner_key=$1 AND idempotency_key=$2",
        [owner, input.idempotencyKey],
      );
      if (previous.rows.length) {
        if (previous.rows[0].original_message !== input.message)
          throw new ConflictException("幂等编号已用于其他问题");
        return String(previous.rows[0].id);
      }
      const id = randomUUID();
      await db.query(
        "INSERT INTO agent_queries(id,owner_key,idempotency_key,original_message,status) VALUES($1,$2,$3,$4,'queued')",
        [id, owner, input.idempotencyKey, input.message],
      );
      return id;
    });
    this.schedule(id);
    return this.get(owner, id);
  }
  async get(owner: string, id: string): Promise<AgentQuery> {
    if (!z.uuid().safeParse(id).success)
      throw new BadRequestException("无效任务编号");
    const rows = await this.db.query(
      "SELECT * FROM agent_queries WHERE owner_key=$1 AND id=$2",
      [owner, id],
    );
    if (!rows.rows.length) throw new NotFoundException("情报任务不存在");
    return this.serialize(rows.rows[0]);
  }
  async list(owner: string) {
    const rows = await this.db.query(
      "SELECT id,original_message,status,created_at,finished_at,error,'[]'::jsonb AS events FROM agent_queries WHERE owner_key=$1 ORDER BY created_at DESC,id LIMIT 100",
      [owner],
    );
    return { items: rows.rows.map((row) => this.serialize(row)) };
  }
  private serialize(row: Record<string, unknown>): AgentQuery {
    return {
      id: String(row.id),
      context: "public_intelligence",
      targetAssessment: "not_assessed",
      originalMessage: String(row.original_message),
      status: row.status as AgentQuery["status"],
      createdAt: new Date(row.created_at as string).toISOString(),
      ...(row.finished_at
        ? { finishedAt: new Date(row.finished_at as string).toISOString() }
        : {}),
      events: row.events as AgentEvent[],
      ...(row.error ? { error: String(row.error) } : {}),
      ...(row.result ? { result: row.result as PublicIntelligenceResult } : {}),
    };
  }
}
function owner(req: AuthorizedRequest) {
  return createHash("sha256").update(req.operator!.token).digest("hex");
}
@Controller("api/intelligence/queries")
class AgentController {
  constructor(private service: AgentService) {}
  @Post() @HttpCode(202) submit(req: AuthorizedRequest) {
    const parsed = inputSchema.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequestException(
        "需原始问题和幂等编号，公开查询不接受客户资产引用",
      );
    return this.service.submit(owner(req), parsed.data);
  }
  @Get() list(req: AuthorizedRequest) {
    return this.service.list(owner(req));
  }
  @Get(":id") get(req: AuthorizedRequest) {
    return this.service.get(owner(req), req.params.id);
  }
}
for (const method of ["submit", "list", "get"] as const)
  Req()(AgentController.prototype, method, 0);
Inject(AgentService)(AgentController, undefined, 0);
@Module({})
export class AgentModule {
  static register(
    executor: PublicQueryExecutor = configuredPublicExecutor(),
  ): DynamicModule {
    return {
      module: AgentModule,
      controllers: [AgentController],
      providers: [
        {
          provide: AgentService,
          inject: [DATABASE],
          useFactory: (db: Database) => new AgentService(db, executor),
        },
      ],
      exports: [AgentService],
    };
  }
}
