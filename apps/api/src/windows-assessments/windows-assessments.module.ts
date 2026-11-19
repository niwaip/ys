import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Inject,
  Module,
  NotFoundException,
  Post,
  Req,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthorizedRequest } from "../auth/auth";
import { DATABASE, type Database } from "../persistence/database";
import { WindowsModule, WindowsService } from "../windows/windows.module";
import { ImportsModule, ImportsService } from "../imports/imports.module";
import type { WindowsSnapshot } from "../../../../packages/contracts/windows";
import { parseRules, evaluateWindows } from "./engine";
import type { WindowsAssessment } from "../../../../packages/contracts/windows-assessments";
export const windowsSubmitSchema = z
  .object({
    snapshotId: z.uuid(),
    ruleImportId: z.uuid(),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();
const upload = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    content: z.string().min(1),
  })
  .strict();
const columns = `id,customer_id AS "customerId",file_name AS "fileName",content_hash AS "contentHash",content,imported_at AS "importedAt",result`;
const serialize = (row: Record<string, unknown>): Record<string, unknown> => {
  const { result, ...base } = row;
  return {
    ...base,
    ...(result as object),
    importedAt: new Date(row.importedAt as string).toISOString(),
  };
};
export class WindowsAssessmentService {
  private timer?: ReturnType<typeof setTimeout>;
  private active?: Promise<void>;
  private stopped = false;
  private wakeAgain = false;
  constructor(
    private db: Database,
    private windows: WindowsService,
    private imports: ImportsService,
  ) {}
  async onModuleInit() {
    await this.db.query(
      `UPDATE vulnerability_jobs SET status='interrupted',details=details || $1::jsonb WHERE status='running' AND details#>>'{target,kind}'='windows'`,
      [
        JSON.stringify({
          error: "后端重启，执行结果未知；未自动重试",
          finishedAt: new Date().toISOString(),
        }),
      ],
    );
    this.wake();
  }
  async onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.active;
  }
  private wake() {
    if (this.stopped || this.timer) return;
    if (this.active) {
      this.wakeAgain = true;
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.active = this.drain()
        .catch(() => {})
        .finally(() => {
          this.active = undefined;
          if (this.wakeAgain) {
            this.wakeAgain = false;
            this.wake();
          }
        });
    }, 25);
  }
  async importRules(customer: string, fileName: string, content: string) {
    if (Buffer.byteLength(content) > 500000 || content.includes("\0"))
      throw new BadRequestException("规则资料最多 500000 UTF-8 字节，不含 NUL");
    const rules = parseRules(content),
      hash = createHash("sha256").update(content).digest("hex");
    return this.db.transaction(async (s) => {
      const saved = await s.query(
        `INSERT INTO import_materials(id,customer_id,format,file_name,content,content_hash,result) VALUES($1,$2,'windows-rules',$3,$4,$5,$6::jsonb) ON CONFLICT(customer_id,format,content_hash) DO NOTHING RETURNING ${columns}`,
        [
          randomUUID(),
          customer,
          fileName,
          content,
          hash,
          JSON.stringify({
            status: "imported",
            adapterVersion: "windows-rules/1",
            rules,
          }),
        ],
      );
      if (saved.rows.length) return serialize(saved.rows[0]);
      const old = await s.query(
        `SELECT ${columns} FROM import_materials WHERE customer_id=$1 AND format='windows-rules' AND content_hash=$2`,
        [customer, hash],
      );
      return { ...serialize(old.rows[0]), replayed: true };
    });
  }
  async listRules(customer: string) {
    const r = await this.db.query(
      `SELECT ${columns} FROM import_materials WHERE customer_id=$1 AND format='windows-rules' ORDER BY imported_at DESC,id LIMIT 100`,
      [customer],
    );
    return {
      items: r.rows.map((row) => {
        const { content, ...result } = serialize(row);
        return result;
      }),
    };
  }
  async getRules(customer: string, id: string) {
    const r = await this.db.query(
      `SELECT ${columns} FROM import_materials WHERE customer_id=$1 AND id=$2 AND format='windows-rules'`,
      [customer, id],
    );
    if (!r.rows.length)
      throw new NotFoundException("该客户下未找到 Windows 规则资料");
    const material = serialize(r.rows[0]);
    return {
      ...material,
      id: String(material.id),
      contentHash: String(material.contentHash),
      content: String(material.content),
      rules: parseRules(String(material.content)),
    };
  }
  async submit(customer: string, input: z.infer<typeof windowsSubmitSchema>) {
    const snapshot = await this.windows.getSnapshot(customer, input.snapshotId),
      material = await this.windows.get(customer, String(snapshot.importId)),
      rules = await this.getRules(customer, input.ruleImportId);
    const job: WindowsAssessment = {
      id: randomUUID(),
      customerId: customer,
      status: "queued",
      idempotencyKey: input.idempotencyKey,
      target: {
        kind: "windows",
        assetId: String(snapshot.assetId),
        snapshotId: input.snapshotId,
      },
      input: {
        importId: String(snapshot.importId),
        contentHash: String(material.contentHash),
        snapshotId: input.snapshotId,
        ruleImportId: input.ruleImportId,
        ruleHash: rules.contentHash,
      },
      createdAt: new Date().toISOString(),
    };
    const saved = await this.db.transaction(async (s) => {
      const r = await s.query(
        `INSERT INTO vulnerability_jobs(id,customer_id,idempotency_key,status,details) VALUES($1,$2,$3,'queued',$4::jsonb) ON CONFLICT(customer_id,idempotency_key) DO NOTHING RETURNING details`,
        [job.id, customer, input.idempotencyKey, JSON.stringify(job)],
      );
      if (r.rows.length) return r.rows[0].details;
      const old = (
        await s.query(
          "SELECT details FROM vulnerability_jobs WHERE customer_id=$1 AND idempotency_key=$2",
          [customer, input.idempotencyKey],
        )
      ).rows[0].details as WindowsAssessment;
      if (
        old.target.kind !== "windows" ||
        old.target.snapshotId !== input.snapshotId ||
        old.input.ruleImportId !== input.ruleImportId
      )
        throw new ConflictException("幂等键已用于其他输入或规则");
      return { ...old, replayed: true };
    });
    this.wake();
    return saved;
  }
  private async drain() {
    while (!this.stopped) {
      const r = await this.db.query(
        `UPDATE vulnerability_jobs SET status='running' WHERE id=(SELECT id FROM vulnerability_jobs WHERE status='queued' AND details#>>'{target,kind}'='windows' ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED) AND status='queued' RETURNING details`,
      );
      if (!r.rows.length) return;
      const job = r.rows[0].details as WindowsAssessment;
      job.status = "running";
      job.startedAt = new Date().toISOString();
      await this.save(job);
      try {
        const snapshot = await this.windows.getSnapshot(
            job.customerId,
            job.target.snapshotId,
          ),
          material = await this.windows.get(job.customerId, job.input.importId),
          rules = await this.getRules(job.customerId, job.input.ruleImportId);
        if (
          material.contentHash !== job.input.contentHash ||
          rules.contentHash !== job.input.ruleHash
        )
          throw Error("固定输入哈希不匹配");
        job.result = evaluateWindows(
          snapshot.snapshot as WindowsSnapshot,
          rules.rules,
          { importId: rules.id, contentHash: rules.contentHash },
        );
        job.execution = {
          toolVersion: "ys-windows-evidence/1",
          rulesVersion: rules.rules.ruleVersion,
          adapterVersion: "windows-bat/1",
          startedAt: job.startedAt,
          finishedAt: new Date().toISOString(),
          outputHash: createHash("sha256")
            .update(JSON.stringify(job.result))
            .digest("hex"),
          mode: "offline_curated_rules",
        };
        job.status = "succeeded";
      } catch (e) {
        job.status = "failed";
        job.error = (e as Error).message;
      }
      job.finishedAt = new Date().toISOString();
      await this.save(job);
    }
  }
  private async save(job: WindowsAssessment) {
    await this.db.query(
      "UPDATE vulnerability_jobs SET status=$3,details=$4::jsonb WHERE customer_id=$1 AND id=$2",
      [job.customerId, job.id, job.status, JSON.stringify(job)],
    );
  }
}
@Controller("api/customers/:customerId/windows/rules")
class WindowsRulesController {
  constructor(private service: WindowsAssessmentService) {}
  @Post() import(req: AuthorizedRequest) {
    const r = upload.safeParse(req.body);
    if (!r.success) throw new BadRequestException("需 fileName 和 content");
    return this.service.importRules(
      req.params.customerId,
      r.data.fileName,
      r.data.content,
    );
  }
  @Get() list(req: AuthorizedRequest) {
    return this.service.listRules(req.params.customerId);
  }
  @Get(":ruleId") get(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.ruleId).success)
      throw new BadRequestException("规则编号无效");
    return this.service.getRules(req.params.customerId, req.params.ruleId);
  }
}
for (const method of ["import", "list", "get"] as const)
  Req()(WindowsRulesController.prototype, method, 0);
Inject(WindowsAssessmentService)(WindowsRulesController, undefined, 0);
@Module({
  imports: [WindowsModule, ImportsModule],
  controllers: [WindowsRulesController],
  providers: [
    {
      provide: WindowsAssessmentService,
      inject: [DATABASE, WindowsService, ImportsService],
      useFactory: (db: Database, w: WindowsService, i: ImportsService) =>
        new WindowsAssessmentService(db, w, i),
    },
  ],
  exports: [WindowsAssessmentService],
})
export class WindowsAssessmentsModule {}
