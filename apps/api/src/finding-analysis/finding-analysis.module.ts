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
import type { AuthorizedRequest, Operator } from "../auth/auth";
import { AgentExecutionError } from "../agent/errors";
import type { PublicQueryExecutor } from "../agent/agent.module";
import {
  linuxReportContent,
  type StoredAssessment,
} from "../assessments/linux-artifact";
import type {
  FindingFacts,
  FindingAnalysis,
  AnalysisSource,
  FindingAnalysisInput,
} from "../../../../packages/contracts/finding-analysis";
import type { FindingAnalysisExecutor } from "./pi-analysis";
import { hashJson as hash } from "../persistence/hash-json";
const actorKey = (o: Operator) =>
  createHash("sha256").update(o.token).digest("hex");
const section = z
  .object({
    text: z.string().trim().min(1).max(5000),
    sourceIds: z.array(z.string().max(100)).min(1).max(20),
  })
  .strict();
const proposal = z
  .object({
    schemaVersion: z.literal("finding-analysis-v1"),
    factHash: z.string(),
    narrative: z
      .object({
        explanation: section,
        impact: section,
        checks: z.array(section).min(1).max(10),
        nextSteps: z.array(section).min(1).max(10),
      })
      .strict(),
  })
  .strict();
const url = (v: unknown): v is string =>
  typeof v === "string" && /^https?:\/\//i.test(v);
export class FindingAnalysisService {
  private active?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopping = false;
  private again = false;
  private abort?: AbortController;
  constructor(
    private db: Database,
    private executor: FindingAnalysisExecutor,
    private researcher: PublicQueryExecutor,
    private operators: Operator[],
    private model: string,
    private timeoutMs = 180000,
  ) {}
  async onModuleInit() {
    await this.db.query(
      `UPDATE finding_analyses SET status='interrupted',details=details||$1::jsonb WHERE status='running'`,
      [
        JSON.stringify({
          status: "interrupted",
          error: "服务重启中断，未自动重试",
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
  private async facts(
    customer: string,
    assessmentId: string,
    findingId: string,
  ): Promise<FindingFacts> {
    const rows = await this.db.query(
      `SELECT status,details->'target' AS target,details->'input' AS input,details#>>'{execution,outputHash}' AS "outputHash",details#>'{result,coverage}' AS coverage,details#>'{result,database}' AS database,
      (SELECT value FROM jsonb_array_elements(COALESCE(details#>'{result,findings}','[]')) WHERE value->>'id'=$3 LIMIT 1) AS finding
      FROM vulnerability_jobs WHERE customer_id=$1 AND id=$2`,
      [customer, assessmentId, findingId],
    );
    const row = rows.rows[0];
    if (!row || !row.finding)
      throw new NotFoundException("该客户扫描下未找到漏洞记录");
    if (row.status !== "succeeded" || !row.coverage || !row.database)
      throw new ConflictException("仅支持已完成的组件漏洞扫描记录");
    const finding = row.finding as FindingFacts["finding"];
    let evidence = finding.evidence;
    if ((row.target as FindingFacts["target"]).kind === "linux") {
      const r = await this.db.query(
        `SELECT details->'artifact' AS artifact FROM vulnerability_jobs WHERE customer_id=$1 AND id=$2`,
        [customer, assessmentId],
      );
      const content = await linuxReportContent({
        artifact: r.rows[0].artifact,
      } as StoredAssessment);
      if (content) {
        const doc = JSON.parse(content),
          ri = evidence.resultIndex,
          vi = evidence.vulnerabilityIndex;
        if (Number.isInteger(ri) && Number.isInteger(vi)) {
          const candidate =
            doc.Results?.[Number(ri)]?.Vulnerabilities?.[Number(vi)];
          if (
            candidate?.VulnerabilityID === finding.vulnerabilityId &&
            candidate.PkgName === finding.packageName &&
            candidate.InstalledVersion === finding.installedVersion
          )
            evidence = candidate;
        }
      }
    }
    const advisory = {
      title:
        typeof evidence.Title === "string"
          ? evidence.Title.slice(0, 1000)
          : undefined,
      description:
        typeof evidence.Description === "string"
          ? evidence.Description.slice(0, 8000)
          : undefined,
    };
    // Only selected finding evidence is stored; scanner raw documents never reach Pi.
    return {
      assessmentId,
      findingId,
      target: row.target as FindingFacts["target"],
      input: row.input as FindingFacts["input"],
      outputHash: row.outputHash as string | null,
      finding: {
        ...finding,
        evidence: {
          reportSha256: row.outputHash,
          resultIndex: finding.evidence.resultIndex,
          vulnerabilityIndex: finding.evidence.vulnerabilityIndex,
        },
      },
      coverage: row.coverage as FindingFacts["coverage"],
      database: row.database as FindingFacts["database"],
      advisory,
    };
  }
  async submit(
    customer: string,
    assessmentId: string,
    findingId: string,
    key: string,
    operator: Operator,
  ) {
    const existing = await this.db.query(
      `SELECT details FROM finding_analyses WHERE customer_id=$1 AND assessment_id=$2 AND idempotency_key=$3`,
      [customer, assessmentId, key],
    );
    if (existing.rows.length) {
      const old = existing.rows[0].details as FindingAnalysis;
      if (old.findingId !== findingId)
        throw new ConflictException("幂等键已用于其他漏洞记录");
      return old;
    }
    const facts = await this.facts(customer, assessmentId, findingId),
      at = new Date().toISOString();
    const sources: AnalysisSource[] = url(facts.finding.primaryUrl)
      ? [
          {
            id: "scanner",
            title: "扫描工具的漏洞来源",
            url: facts.finding.primaryUrl,
            origin: "scanner",
            retrievedAt: at,
          },
        ]
      : [];
    const job: FindingAnalysis = {
      id: randomUUID(),
      customerId: customer,
      assessmentId,
      findingId,
      idempotencyKey: key,
      factHash: hash(facts),
      facts,
      status: "queued",
      createdAt: at,
      createdBy: operator.name,
      model: this.model,
      skillVersion: "finding-analysis-v1",
      events: [],
      sources,
    };
    const saved = await this.db.transaction(async (s) => {
      const r = await s.query(
        `INSERT INTO finding_analyses(id,customer_id,assessment_id,finding_id,idempotency_key,actor_key,status,details) VALUES($1,$2,$3,$4,$5,$6,'queued',$7::jsonb) ON CONFLICT(customer_id,assessment_id,idempotency_key) DO NOTHING RETURNING details`,
        [
          job.id,
          customer,
          assessmentId,
          findingId,
          key,
          actorKey(operator),
          JSON.stringify(job),
        ],
      );
      const old = r.rows.length
        ? job
        : ((
            await s.query(
              `SELECT details FROM finding_analyses WHERE customer_id=$1 AND assessment_id=$2 AND idempotency_key=$3`,
              [customer, assessmentId, key],
            )
          ).rows[0].details as FindingAnalysis);
      if (old.findingId !== findingId)
        throw new ConflictException("幂等键已用于其他漏洞记录");
      return old;
    });
    this.wake();
    return saved;
  }
  async list(customer: string, assessmentId: string, findingId: string) {
    const rows = await this.db.query(
      `WITH scoped AS (SELECT id,created_at,status,details FROM finding_analyses WHERE customer_id=$1 AND assessment_id=$2 AND finding_id=$3),
       retained AS ((SELECT id,created_at,details FROM scoped ORDER BY created_at DESC,id DESC LIMIT 20)
       UNION (SELECT id,created_at,details FROM scoped WHERE status='succeeded' ORDER BY created_at DESC,id DESC LIMIT 1))
       SELECT details FROM retained ORDER BY created_at DESC,id DESC`,
      [customer, assessmentId, findingId],
    );
    return { items: rows.rows.map((r) => r.details as FindingAnalysis) };
  }
  async get(
    customer: string,
    assessmentId: string,
    findingId: string,
    id: string,
  ) {
    const rows = await this.db.query(
      `SELECT details FROM finding_analyses WHERE customer_id=$1 AND assessment_id=$2 AND finding_id=$3 AND id=$4`,
      [customer, assessmentId, findingId, id],
    );
    if (!rows.rows.length)
      throw new NotFoundException("未找到该客户记录的AI解析");
    return rows.rows[0].details as FindingAnalysis;
  }
  private async save(job: FindingAnalysis) {
    await this.db.query(
      `UPDATE finding_analyses SET status=$2,details=$3::jsonb WHERE id=$1 AND customer_id=$4`,
      [job.id, job.status, JSON.stringify(job), job.customerId],
    );
  }
  private async research(job: FindingAnalysis, signal: AbortSignal) {
    const queriedAt = new Date().toISOString();
    try {
      if (!/^CVE-\d{4}-\d{4,}$/.test(job.facts.finding.vulnerabilityId))
        throw Error("not CVE");
      const result = await this.researcher.execute(
        {
          id: randomUUID(),
          message: `查询 ${job.facts.finding.vulnerabilityId} 的漏洞机制、受影响条件与厂商修复公告，仅查询该漏洞的公开资料。`,
        },
        async () => {},
        signal,
      );
      const matches = result.results.filter(
        (row) => row.cve_id === job.facts.finding.vulnerabilityId,
      );
      const ids = new Set(
        matches.flatMap((row) =>
          Array.isArray(row.source_ids) ? row.source_ids : [],
        ),
      );
      for (const source of result.sources
        .filter((s) => ids.has(s.source_id))
        .slice(0, 20)) {
        const link = source.url ?? source.source_url;
        if (url(link))
          job.sources.push({
            id: `public-${job.sources.length}`,
            title: String(
              source.name ?? source.title ?? source.source_id,
            ).slice(0, 300),
            url: link,
            origin: "public_query",
            retrievedAt: queriedAt,
          });
      }
      const hasSources = job.sources.some(
        (source) => source.origin === "public_query",
      );
      const limitations = Array.isArray(result.coverage.limitations)
        ? result.coverage.limitations
            .filter((v): v is string => typeof v === "string")
            .slice(0, 20)
            .map((v) => v.slice(0, 1000))
        : [];
      job.research = {
        limitations,
        contentHash: result.evidence.contentHash,
        status:
          result.status === "unavailable" || !matches.length || !hasSources
            ? "unavailable"
            : result.status === "partial"
              ? "partial"
              : "available",
        message:
          matches.length && hasSources
            ? "公开查询资料已取得；仍需核实当前系统适用条件"
            : "未取得该漏洞的公开资料",
        queriedAt,
        summary: hasSources
          ? JSON.stringify(matches).slice(0, 16000)
          : undefined,
      };
    } catch {
      if (signal.aborted)
        throw new AgentExecutionError("timed_out", "AI解析超时或中断");
      job.research = {
        status: "unavailable",
        limitations: ["未取得可核实的公开查询结果，仅保留现有扫描证据"],
        message: "公开情报查询不可用，本次仅基于已有扫描证据解析",
        queriedAt,
      };
    }
  }
  private async drain() {
    while (!this.stopping) {
      const r = await this.db.query(
        `UPDATE finding_analyses SET status='running' WHERE id=(SELECT id FROM finding_analyses WHERE status='queued' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) AND status='queued' RETURNING details,actor_key`,
      );
      if (!r.rows.length) return;
      const job = r.rows[0].details as FindingAnalysis;
      job.status = "running";
      await this.save(job);
      const controller = new AbortController();
      this.abort = controller;
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let removeAbort = () => {};
      const emit = async (type: string, message: string) => {
        if (controller.signal.aborted) return;
        if (job.events.length >= 100) throw Error("解析事件超限");
        job.events.push({
          at: new Date().toISOString(),
          type,
          message: message.slice(0, 500),
        });
        await this.save(job);
      };
      try {
        if (
          !this.operators.some(
            (o) =>
              actorKey(o) === r.rows[0].actor_key &&
              o.customerIds.includes(job.customerId),
          )
        )
          throw Error("操作员客户授权已失效");
        if (hash(job.facts) !== job.factHash) throw Error("绑定事实校验失败");
        const work = async () => {
          await emit("research", "正在查询公开漏洞资料");
          await this.research(job, controller.signal);
          if (controller.signal.aborted)
            throw new AgentExecutionError("timed_out", "AI解析已中止");
          await emit("analysis", "Pi 正在解析单条漏洞与当前系统影响");
          const input: FindingAnalysisInput = {
            id: job.id,
            factHash: job.factHash,
            facts: job.facts,
            sources: job.sources,
            research: job.research,
          };
          return this.executor.execute(input, emit, controller.signal);
        };
        const raw = await Promise.race([
          work(),
          new Promise<never>((_, reject) => {
            const abort = () =>
              reject(
                new AgentExecutionError(
                  "timed_out",
                  "AI解析超时或中断，未自动重试",
                ),
              );
            removeAbort = () =>
              controller.signal.removeEventListener("abort", abort);
            controller.signal.addEventListener("abort", abort, { once: true });
            if (controller.signal.aborted) abort();
          }),
        ]);
        if (controller.signal.aborted)
          throw new AgentExecutionError("timed_out", "AI解析已中止");
        const parsed = proposal.safeParse(raw);
        if (!parsed.success || parsed.data.factHash !== job.factHash)
          throw new AgentExecutionError("failed", "AI解析格式或绑定事实不符");
        const all = [
            parsed.data.narrative.explanation,
            parsed.data.narrative.impact,
            ...parsed.data.narrative.checks,
            ...parsed.data.narrative.nextSteps,
          ],
          allowed = new Set(["finding", ...job.sources.map((s) => s.id)]);
        if (
          all.some((s) => s.sourceIds.some((id) => !allowed.has(id))) ||
          !all.some((s) => s.sourceIds.includes("finding"))
        )
          throw new AgentExecutionError(
            "failed",
            "AI解析引用了未绑定来源或未引用当前扫描事实，请重新解析",
          );
        job.narrative = parsed.data.narrative;
        job.status = "succeeded";
      } catch (e) {
        job.status = this.stopping
          ? "interrupted"
          : e instanceof AgentExecutionError
            ? e.status
            : "failed";
        job.error =
          e instanceof AgentExecutionError
            ? e.message
            : "AI解析失败：输出格式、事实绑定或来源校验未通过";
      } finally {
        clearTimeout(timer);
        removeAbort();
        job.finishedAt = new Date().toISOString();
        await this.save(job);
      }
    }
  }
}
@Controller(
  "api/customers/:customerId/assessments/:assessmentId/findings/:findingId/analyses",
)
class FindingAnalysisController {
  constructor(private service: FindingAnalysisService) {}
  private scope(req: AuthorizedRequest) {
    if (
      !z.uuid().safeParse(req.params.assessmentId).success ||
      !z.uuid().safeParse(req.params.findingId).success
    )
      throw new BadRequestException("漏洞记录编号无效");
  }
  @Post() @HttpCode(202) submit(req: AuthorizedRequest) {
    this.scope(req);
    const body = z
      .object({ idempotencyKey: z.string().trim().min(1).max(200) })
      .strict()
      .safeParse(req.body);
    if (!body.success) throw new BadRequestException("解析请求无效");
    return this.service.submit(
      req.params.customerId,
      req.params.assessmentId,
      req.params.findingId,
      body.data.idempotencyKey,
      req.operator,
    );
  }
  @Get() list(req: AuthorizedRequest) {
    this.scope(req);
    return this.service.list(
      req.params.customerId,
      req.params.assessmentId,
      req.params.findingId,
    );
  }
  @Get(":analysisId") get(req: AuthorizedRequest) {
    this.scope(req);
    if (!z.uuid().safeParse(req.params.analysisId).success)
      throw new BadRequestException("解析编号无效");
    return this.service.get(
      req.params.customerId,
      req.params.assessmentId,
      req.params.findingId,
      req.params.analysisId,
    );
  }
}
for (const method of ["submit", "list", "get"] as const)
  Req()(FindingAnalysisController.prototype, method, 0);
Inject(FindingAnalysisService)(FindingAnalysisController, undefined, 0);
@Module({})
export class FindingAnalysisModule {
  static register(options: {
    executor: FindingAnalysisExecutor;
    researcher: PublicQueryExecutor;
    operators: Operator[];
    model: string;
    timeoutMs?: number;
  }): DynamicModule {
    return {
      module: FindingAnalysisModule,
      controllers: [FindingAnalysisController],
      providers: [
        {
          provide: FindingAnalysisService,
          inject: [DATABASE],
          useFactory: (db: Database) =>
            new FindingAnalysisService(
              db,
              options.executor,
              options.researcher,
              options.operators,
              options.model,
              options.timeoutMs,
            ),
        },
      ],
    };
  }
}
