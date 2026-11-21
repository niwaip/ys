import {
  narrationGrammar,
  narrationReferences,
} from "../../../../packages/contracts/report-language";
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
import type { Database } from "../persistence/database";
import type { AuthorizedRequest, Operator } from "../auth/auth";
import type { ReportsService } from "./reports.module";
import { ReportReviewService } from "./review";
import { hashFacts, validateNarrative } from "./render";
import { AgentExecutionError } from "../agent/errors";
import type {
  ReportNarrationInput,
  ReportNarrationJob,
} from "../../../../packages/contracts/report-narration";
export interface ReportNarrationExecutor {
  execute(
    input: ReportNarrationInput,
    emit: (type: string, message: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<unknown>;
}
const proposal = z
  .object({
    schemaVersion: z.literal("report-proposal-v1"),
    baseRevisionId: z.uuid(),
    factHash: z.string().regex(/^[a-f0-9]{64}$/),
    narrative: z.unknown(),
  })
  .strict();
const actorKey = (operator: Operator) =>
  createHash("sha256").update(operator.token).digest("hex");
export class ReportNarrationService {
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private again = false;
  private controller?: AbortController;
  constructor(
    private db: Database,
    private reports: ReportsService,
    private review: ReportReviewService,
    private executor: ReportNarrationExecutor,
    private operators: Operator[],
    private timeoutMs = 60000,
  ) {}
  async onModuleInit() {
    await this.db.query(
      `UPDATE report_narrations SET status='interrupted',details=details||$1::jsonb WHERE status='running'`,
      [
        JSON.stringify({
          status: "interrupted",
          fallback: true,
          error: "服务重启中断，固定事实草稿保留；未自动重试",
          finishedAt: new Date().toISOString(),
        }),
      ],
    );
    this.wake();
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
    await this.active;
  }
  private wake() {
    if (this.stopping || this.timer) return;
    if (this.active) {
      this.again = true;
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.active = this.drain()
        .catch(() => {})
        .finally(() => {
          this.active = undefined;
          if (this.again) {
            this.again = false;
            this.wake();
          }
        });
    }, 15);
  }
  async submit(
    customer: string,
    reportId: string,
    baseRevisionId: string,
    key: string,
    operator: Operator,
  ) {
    const revision = await this.reports.getRevision(
      customer,
      reportId,
      baseRevisionId,
    );
    if (hashFacts(revision.facts) !== revision.factHash)
      throw new BadRequestException("报告事实hash不符");
    const job: ReportNarrationJob = {
      id: randomUUID(),
      customerId: customer,
      reportId,
      baseRevisionId,
      factHash: revision.factHash,
      idempotencyKey: key,
      createdBy: operator.name,
      createdAt: new Date().toISOString(),
      status: "queued",
      fallback: false,
      events: [],
    };
    const saved = await this.db.transaction(async (s) => {
      const r = await s.query(
        "INSERT INTO report_narrations(id,customer_id,report_id,base_revision_id,idempotency_key,actor_key,status,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(customer_id,report_id,idempotency_key) DO NOTHING RETURNING details",
        [
          job.id,
          customer,
          reportId,
          baseRevisionId,
          key,
          actorKey(operator),
          "queued",
          JSON.stringify(job),
        ],
      );
      if (r.rows.length) return job;
      const old = (
        await s.query(
          "SELECT details FROM report_narrations WHERE customer_id=$1 AND report_id=$2 AND idempotency_key=$3",
          [customer, reportId, key],
        )
      ).rows[0].details as ReportNarrationJob;
      if (
        old.baseRevisionId !== baseRevisionId ||
        old.factHash !== revision.factHash
      )
        throw new ConflictException("幂等键已绑定其他报告修订");
      return { ...old, replayed: true };
    });
    this.wake();
    return saved;
  }
  async get(customer: string, reportId: string, id: string) {
    await this.reports.get(customer, reportId);
    const r = await this.db.query(
      "SELECT details FROM report_narrations WHERE customer_id=$1 AND report_id=$2 AND id=$3",
      [customer, reportId, id],
    );
    if (!r.rows.length)
      throw new NotFoundException("该客户报告下未找到AI叙述任务");
    return r.rows[0].details as ReportNarrationJob;
  }
  async list(customer: string, reportId: string) {
    await this.reports.get(customer, reportId);
    const r = await this.db.query(
      "SELECT details FROM report_narrations WHERE customer_id=$1 AND report_id=$2 ORDER BY created_at DESC,id LIMIT 100",
      [customer, reportId],
    );
    return { items: r.rows.map((x) => x.details as ReportNarrationJob) };
  }
  private async save(job: ReportNarrationJob) {
    await this.db.query(
      "UPDATE report_narrations SET status=$2,details=$3::jsonb WHERE id=$1 AND customer_id=$4 AND report_id=$5",
      [job.id, job.status, JSON.stringify(job), job.customerId, job.reportId],
    );
  }
  private async drain() {
    while (!this.stopping) {
      const r = await this.db.query(
        `UPDATE report_narrations SET status='running' WHERE id=(SELECT id FROM report_narrations WHERE status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) AND status='queued' RETURNING actor_key,details`,
      );
      if (!r.rows.length) return;
      const job = r.rows[0].details as ReportNarrationJob;
      job.status = "running";
      await this.save(job);
      this.controller = new AbortController();
      const signal = this.controller.signal;
      const timeout = setTimeout(
        () => this.controller?.abort(),
        this.timeoutMs,
      );
      const emit = async (type: string, message: string) => {
        job.events.push({
          at: new Date().toISOString(),
          type,
          message: message.slice(0, 2000),
        });
        if (job.events.length > 200) throw Error("事件数超限");
        await this.save(job);
      };
      try {
        const operator = this.operators.find(
          (o) =>
            actorKey(o) === r.rows[0].actor_key &&
            o.customerIds.includes(job.customerId),
        );
        if (!operator) throw Error("操作员客户授权已失效，固定草稿保留");
        const revision = await this.reports.getRevision(
          job.customerId,
          job.reportId,
          job.baseRevisionId,
        );
        if (
          revision.factHash !== job.factHash ||
          hashFacts(revision.facts) !== job.factHash
        )
          throw Error("绑定事实hash校验失败");
        await emit("started", "报告AI叙述开始；固定事实保持保护");
        const input: ReportNarrationInput = {
          id: job.id,
          reportId: job.reportId,
          baseRevisionId: job.baseRevisionId,
          factHash: job.factHash,
          scope: revision.facts.scope,
          statistics: revision.facts.statistics,
          coverageIssues: revision.facts.coverageIssues,
          allowedNarrative: revision.narrative,
          language: {
            grammar: narrationGrammar,
            references: narrationReferences(revision.facts),
          },
          optionalTemplates: ["summary", "recommendations"],
        };
        const raw = await Promise.race([
          this.executor.execute(input, emit, signal),
          new Promise<never>((_, reject) => {
            const abort = () =>
              reject(
                new AgentExecutionError(
                  "timed_out",
                  "AI叙述超时或中断，固定事实草稿保留",
                ),
              );
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          }),
        ]);
        if (signal.aborted)
          throw new AgentExecutionError("timed_out", "AI叙述中止");
        const parsed = proposal.safeParse(raw);
        if (!parsed.success)
          throw Error("AI提案格式越界；仅接受受控叙述，不接受事实覆盖");
        if (
          parsed.data.baseRevisionId !== job.baseRevisionId ||
          parsed.data.factHash !== job.factHash
        )
          throw Error("AI提案绑定的事实或修订不符");
        const narrative = validateNarrative(
          revision.facts,
          parsed.data.narrative,
        );
        if (!narrative.blocks.some((block) => block.text?.includes("建议")))
          throw Error(
            "AI提案须提供引用事实的说明文字和建议句，不能仅返回段落枚举",
          );
        await emit("validated", "受控模板、事实引用和覆盖段落校验通过");
        const next = await this.review.revise(
          job.customerId,
          job.reportId,
          job.baseRevisionId,
          narrative,
          operator,
        );
        job.resultRevisionId = next.id;
        job.proposalHash = createHash("sha256")
          .update(JSON.stringify(parsed.data))
          .digest("hex");
        job.status = "succeeded";
        job.fallback = false;
      } catch (e) {
        job.status = this.stopping
          ? "interrupted"
          : e instanceof AgentExecutionError
            ? e.status
            : "failed";
        job.fallback = true;
        job.error = (e as Error).message.slice(0, 2000);
      } finally {
        clearTimeout(timeout);
        job.finishedAt = new Date().toISOString();
        await this.save(job);
        this.controller = undefined;
      }
    }
  }
}
@Controller("api/customers/:customerId/reports/:reportId/narrations")
export class ReportNarrationController {
  constructor(private service: ReportNarrationService) {}
  private valid(req: AuthorizedRequest) {
    if (
      !z.uuid().safeParse(req.params.reportId).success ||
      (req.params.jobId && !z.uuid().safeParse(req.params.jobId).success)
    )
      throw new BadRequestException("报告/任务编号无效");
  }
  @Post() @HttpCode(202) submit(req: AuthorizedRequest) {
    this.valid(req);
    const input = z
      .object({
        baseRevisionId: z.uuid(),
        idempotencyKey: z.string().trim().min(1).max(200),
      })
      .strict()
      .safeParse(req.body);
    if (!input.success)
      throw new BadRequestException("需明确报告修订与幂等键，不接受客户端事实");
    return this.service.submit(
      req.params.customerId,
      req.params.reportId,
      input.data.baseRevisionId,
      input.data.idempotencyKey,
      req.operator,
    );
  }
  @Get() list(req: AuthorizedRequest) {
    this.valid(req);
    return this.service.list(req.params.customerId, req.params.reportId);
  }
  @Get(":jobId") get(req: AuthorizedRequest) {
    this.valid(req);
    return this.service.get(
      req.params.customerId,
      req.params.reportId,
      req.params.jobId,
    );
  }
}
for (const method of ["submit", "list", "get"] as const)
  Req()(ReportNarrationController.prototype, method, 0);
Inject(ReportNarrationService)(ReportNarrationController, undefined, 0);
