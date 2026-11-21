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
import { AssessmentService } from "../assessments/assessments.module";
import type { AuthorizedRequest } from "../auth/auth";
import { AgentExecutionError } from "../agent/errors";
import type {
  CustomerChatFacts,
  CustomerConversation,
} from "../../../../packages/contracts/conversations";
import type { CustomerReadExecutor } from "./pi-customer";
const schema = z
  .object({
    message: z.string().trim().min(1).max(4000),
    assessmentIds: z
      .array(z.uuid())
      .max(100)
      .refine((ids) => new Set(ids).size === ids.length),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
export class ConversationsService {
  private jobs = new Map<string, Promise<void>>();
  private controllers = new Map<string, AbortController>();
  private stopping = false;
  constructor(
    private db: Database,
    private assessments: AssessmentService,
    private executor: CustomerReadExecutor,
  ) {}
  async onModuleInit() {
    const rows = await this.db.query(
      "SELECT id,details FROM customer_conversations WHERE details->>'status' IN ('running','queued')",
    );
    for (const row of rows.rows) {
      const d = row.details as CustomerConversation;
      if (d.status === "running") {
        d.status = "interrupted";
        d.error = "服务重启中断，未自动重试";
        await this.save(d);
      } else this.schedule(d);
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    for (const c of this.controllers.values()) c.abort();
    await Promise.allSettled(this.jobs.values());
  }
  private async save(d: CustomerConversation) {
    await this.db.query(
      "UPDATE customer_conversations SET details=$2::jsonb WHERE id=$1 AND customer_id=$3",
      [d.id, JSON.stringify(d), d.customerId],
    );
  }
  private schedule(d: CustomerConversation) {
    if (this.jobs.has(d.id) || d.status !== "queued") return;
    const controller = new AbortController();
    this.controllers.set(d.id, controller);
    const work = (async () => {
      d.status = "running";
      await this.save(d);
      try {
        await this.executor.execute(
          d,
          async (type, message) => {
            d.events.push({
              type,
              message: message.slice(0, 2000),
              at: new Date().toISOString(),
            });
            await this.save(d);
          },
          controller.signal,
        );
        d.status = "succeeded";
      } catch (e) {
        d.status = this.stopping
          ? "interrupted"
          : e instanceof AgentExecutionError
            ? e.status
            : "failed";
        d.error =
          e instanceof AgentExecutionError
            ? e.message
            : "Pi 客户只读工具未完成，固定事实仍可核查";
      }
      await this.save(d);
    })().finally(() => {
      this.jobs.delete(d.id);
      this.controllers.delete(d.id);
    });
    this.jobs.set(d.id, work);
  }
  async submit(customer: string, input: z.infer<typeof schema>) {
    const cves = [
      ...new Set(input.message.toUpperCase().match(/CVE-\d{4}-\d{4,}/g) ?? []),
    ];
    if (cves.length > 1)
      throw new BadRequestException(
        "首个固定能力每次查询一个CVE或全部选定评估发现",
      );
    const cveId = cves[0] ?? null;
    const facts: CustomerChatFacts = {
      coverage: "not_assessed",
      cveId,
      scopeNote:
        "仅查询明确选择的已有软件评估；无发现不等于安全，不执行新扫描。",
      assessments: [],
      matches: [],
      hash: "",
    };
    for (const id of input.assessmentIds) {
      const a = await this.assessments.get(customer, id);
      if (a.target.kind !== "software")
        throw new BadRequestException("首个客户对话能力仅支持软件评估");
      facts.assessments.push({
        id: a.id,
        status: a.status,
        versionId: a.target.versionId,
        inputHash: a.input.contentHash,
        findingCount: a.result ? a.result.findings.length : null,
        coverage: a.result?.coverage ?? null,
        database: a.result?.database ?? null,
      });
      for (const f of a.result?.findings ?? []) {
        if (cveId && f.vulnerabilityId !== cveId) continue;
        facts.matches.push({
          reference: `${a.id}/${f.id}`,
          assessmentId: a.id,
          findingId: f.id,
          componentId: f.componentId,
          packageName: f.packageName,
          installedVersion: f.installedVersion,
          vulnerabilityId: f.vulnerabilityId,
          severity: f.severity,
          applicability: f.applicability,
          fixedVersion: f.fixedVersion,
          evidence: f.evidence,
        });
      }
    }
    if (facts.assessments.length) {
      const available = facts.assessments.filter(
        (a) => a.findingCount !== null,
      );
      facts.coverage = !available.length
        ? "evidence_unavailable"
        : available.length < facts.assessments.length ||
            available.some(
              (a) =>
                (a.coverage as { status?: string })?.status !==
                "complete_for_declared_input",
            )
          ? "partial"
          : "available";
    }
    facts.hash = createHash("sha256")
      .update(JSON.stringify({ ...facts, hash: undefined }))
      .digest("hex");
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          message: input.message,
          ids: [...input.assessmentIds].sort(),
        }),
      )
      .digest("hex");
    const d = await this.db.transaction(async (db) => {
      const old = await db.query(
        "SELECT details,input_hash FROM customer_conversations WHERE customer_id=$1 AND idempotency_key=$2",
        [customer, input.idempotencyKey],
      );
      if (old.rows.length) {
        if (old.rows[0].input_hash !== fingerprint)
          throw new ConflictException("幂等编号已用于其他客户问题或评估范围");
        return old.rows[0].details as CustomerConversation;
      }
      const answer =
        facts.coverage === "not_assessed"
          ? "未选择已保存的评估，当前范围未评估。"
          : facts.coverage === "evidence_unavailable"
            ? "所选评估没有可用结果，不能据此判断没有漏洞。"
            : `所选评估中匹配到 ${facts.matches.length} 条工具发现；适用性沿用原记录，未再评估客户资产。`;
      const record: CustomerConversation = {
        id: randomUUID(),
        customerId: customer,
        message: input.message,
        assessmentIds: input.assessmentIds,
        createdAt: new Date().toISOString(),
        status: "queued",
        facts,
        answer,
        events: [
          {
            at: new Date().toISOString(),
            type: "authorized_read",
            message: "通过客户范围业务接口读取选定评估并固定证据",
          },
        ],
      };
      await db.query(
        "INSERT INTO customer_conversations(id,customer_id,idempotency_key,input_hash,details) VALUES($1,$2,$3,$4,$5::jsonb)",
        [
          record.id,
          customer,
          input.idempotencyKey,
          fingerprint,
          JSON.stringify(record),
        ],
      );
      return record;
    });
    this.schedule(d);
    return d;
  }
  async get(customer: string, id: string): Promise<CustomerConversation> {
    if (!z.uuid().safeParse(id).success)
      throw new BadRequestException("无效对话编号");
    const rows = await this.db.query(
      "SELECT details FROM customer_conversations WHERE customer_id=$1 AND id=$2",
      [customer, id],
    );
    if (!rows.rows.length) throw new NotFoundException("客户对话不存在");
    return rows.rows[0].details as CustomerConversation;
  }
  async list(customer: string) {
    const rows = await this.db.query(
      "SELECT details - 'facts' - 'events' AS summary FROM customer_conversations WHERE customer_id=$1 ORDER BY created_at DESC,id LIMIT 100",
      [customer],
    );
    return { items: rows.rows.map((r) => r.summary) };
  }
}
@Controller("api/customers/:customerId/conversations")
class ConversationsController {
  constructor(private service: ConversationsService) {}
  @Post() @HttpCode(202) submit(req: AuthorizedRequest) {
    const p = schema.safeParse(req.body);
    if (!p.success)
      throw new BadRequestException("需问题、明确评估范围和幂等编号");
    return this.service.submit(req.params.customerId, p.data);
  }
  @Get() list(req: AuthorizedRequest) {
    return this.service.list(req.params.customerId);
  }
  @Get(":id") get(req: AuthorizedRequest) {
    return this.service.get(req.params.customerId, req.params.id);
  }
}
for (const method of ["submit", "list", "get"] as const)
  Req()(ConversationsController.prototype, method, 0);
Inject(ConversationsService)(ConversationsController, undefined, 0);
@Module({})
export class ConversationsModule {
  static register(
    assessmentModule: DynamicModule,
    executor: CustomerReadExecutor,
  ): DynamicModule {
    return {
      module: ConversationsModule,
      imports: [assessmentModule],
      controllers: [ConversationsController],
      providers: [
        {
          provide: ConversationsService,
          inject: [DATABASE, AssessmentService],
          useFactory: (db: Database, assessments: AssessmentService) =>
            new ConversationsService(db, assessments, executor),
        },
      ],
      exports: [ConversationsService],
    };
  }
}
