import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Header,
  Inject,
  NotFoundException,
  Post,
  Req,
  StreamableFile,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { gunzip } from "node:zlib";
import { promisify } from "node:util";
import { zipSync, strToU8 } from "fflate";
import { z } from "zod";
import {
  reportPackageInput,
  type ReportPackage,
  type ReportPackageFile,
} from "../../../../packages/contracts/report-packages";
import type { AuthorizedRequest } from "../auth/auth";
import type { Database } from "../persistence/database";
import { hashJson } from "../persistence/hash-json";
import type { ReportsService } from "./reports.module";
import type { ReportReviewService } from "./review";
import type { AssessmentService } from "../assessments/assessments.module";
import { renderReport } from "./render";
import { hostRevision, pdf, xlsx } from "./export-formats";
const decompress = promisify(gunzip);
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");
export class ReportPackageService {
  private active = new Map<string, Promise<void>>();
  private stopping = false;
  constructor(
    private db: Database,
    private reports: ReportsService,
    private review: ReportReviewService,
    private assessments: AssessmentService,
  ) {}
  async onModuleInit() {
    const rows = await this.db.query(
      "SELECT id,details FROM report_exports WHERE status='generating'",
    );
    for (const row of rows.rows) {
      const bundle = row.details as ReportPackage;
      for (const file of bundle.files)
        if (["pending", "running"].includes(file.status)) {
          file.status = "failed";
          file.error = "文件生成被重启中断，请明确重试；扫描结果保留";
        }
      bundle.status = "partial";
      await this.save(bundle);
    }
  }
  async onModuleDestroy() {
    this.stopping = true;
    await Promise.allSettled(this.active.values());
  }
  private async save(bundle: ReportPackage) {
    await this.db.query(
      "UPDATE report_exports SET status=$2,details=$3::jsonb WHERE id=$1",
      [bundle.id, bundle.status, JSON.stringify(bundle)],
    );
  }
  async get(
    customer: string,
    reportId: string,
    revisionId: string,
    id: string,
  ): Promise<ReportPackage> {
    const row = (
      await this.db.query(
        "SELECT details FROM report_exports WHERE customer_id=$1 AND report_id=$2 AND revision_id=$3 AND id=$4",
        [customer, reportId, revisionId, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("该客户报告修订下未找到文件包");
    return row.details as ReportPackage;
  }
  async list(customer: string, reportId: string, revisionId: string) {
    await this.reports.getRevision(customer, reportId, revisionId);
    return {
      items: (
        await this.db.query(
          "SELECT details FROM report_exports WHERE customer_id=$1 AND report_id=$2 AND revision_id=$3 ORDER BY created_at DESC,id DESC",
          [customer, reportId, revisionId],
        )
      ).rows.map((row) => row.details as ReportPackage),
    };
  }
  async create(
    customer: string,
    reportId: string,
    revisionId: string,
    actor: string,
    value: unknown,
  ) {
    const parsed = reportPackageInput.safeParse(value ?? {});
    if (!parsed.success) throw new BadRequestException("报告包选项无效");
    const input = parsed.data,
      revision = await this.reports.getRevision(customer, reportId, revisionId);
    renderReport(revision);
    if (input.audience === "official")
      await this.review.export(customer, reportId, revisionId);
    if (
      input.perHostIds.some(
        (id) => !revision.facts.center?.hosts.some((h) => h.assetId === id),
      ) ||
      input.evidenceAssessmentIds.some(
        (id) => !revision.facts.assessmentSnapshots.some((a) => a.id === id),
      )
    )
      throw new BadRequestException("附件必须属于此固定修订范围");
    input.perHostIds.sort();
    input.evidenceAssessmentIds.sort();
    const files: ReportPackageFile[] = [
      ...(["pdf", "html", "xlsx"] as const).map((format) => ({
        id: randomUUID(),
        name: `${input.audience}-report.${format}`,
        format,
        status: "pending" as const,
      })),
      ...input.perHostIds.map((hostId) => ({
        id: randomUUID(),
        name: `hosts/${hostId}.pdf`,
        format: "pdf" as const,
        hostId,
        status: "pending" as const,
      })),
      ...input.evidenceAssessmentIds.map((assessmentId) => ({
        id: randomUUID(),
        name: `evidence/${assessmentId}.json`,
        format: "evidence" as const,
        assessmentId,
        status: "pending" as const,
      })),
    ];
    const bundle: ReportPackage = {
      id: randomUUID(),
      reportId,
      revisionId,
      factHash: revision.factHash,
      createdAt: new Date().toISOString(),
      createdBy: actor,
      status: "generating",
      input,
      files,
    };
    const key = hashJson(input);
    const saved = await this.db.query(
      "INSERT INTO report_exports(id,customer_id,report_id,revision_id,input_hash,status,details) VALUES($1,$2,$3,$4,$5,'generating',$6::jsonb) ON CONFLICT(customer_id,revision_id,input_hash) DO NOTHING RETURNING id",
      [bundle.id, customer, reportId, revisionId, key, JSON.stringify(bundle)],
    );
    if (!saved.rows.length)
      return (
        await this.db.query(
          "SELECT details FROM report_exports WHERE customer_id=$1 AND revision_id=$2 AND input_hash=$3",
          [customer, revisionId, key],
        )
      ).rows[0].details as ReportPackage;
    this.start(customer, bundle);
    return bundle;
  }
  private start(customer: string, bundle: ReportPackage) {
    if (this.stopping || this.active.has(bundle.id)) return;
    const work = this.generate(customer, bundle)
      .catch(async (error) => {
        for (const file of bundle.files)
          if (["pending", "running"].includes(file.status)) {
            file.status = "failed";
            file.error = (error as Error).message;
          }
        bundle.status = "partial";
        await this.save(bundle);
      })
      .finally(() => this.active.delete(bundle.id));
    this.active.set(bundle.id, work);
  }
  private async generate(customer: string, bundle: ReportPackage) {
    const parent = await this.reports.getRevision(
      customer,
      bundle.reportId,
      bundle.revisionId,
    );
    if (bundle.input.audience === "official")
      await this.review.export(customer, bundle.reportId, bundle.revisionId);
    const revision = structuredClone(parent);
    if (bundle.input.audience === "draft") revision.status = "draft";
    for (const file of bundle.files) {
      if (this.stopping) break;
      if (file.status !== "pending") continue;
      file.status = "running";
      delete file.error;
      await this.save(bundle);
      try {
        let bytes: Buffer;
        if (file.format === "evidence") {
          const result = parent.facts.assessmentSnapshots.find(
            (a) => a.id === file.assessmentId,
          )!;
          const reference = parent.facts.sourceRefs.find(
            (r) => r.kind === "cve" && r.id === file.assessmentId,
          );
          const raw = JSON.parse(
            (
              await decompress(
                await this.assessments.report(customer, result.id),
              )
            ).toString("utf8"),
          ) as { content: string };
          bytes = Buffer.from(raw.content, "utf8");
          if (!reference?.outputHash || sha(bytes) !== reference.outputHash)
            throw new ConflictException(
              "原始证据缺少冻结输出哈希或字节校验不符",
            );
        } else {
          const view = file.hostId
            ? hostRevision(revision, file.hostId)
            : revision;
          if (file.format === "xlsx") bytes = await xlsx(view);
          else {
            const html = renderReport(view);
            bytes =
              file.format === "html"
                ? Buffer.from(html, "utf8")
                : await pdf(html, bundle.input.pdfMode);
          }
        }
        file.sha256 = sha(bytes);
        file.bytes = bytes.length;
        file.status = "ready";
        await this.db.query(
          "INSERT INTO report_export_files(export_id,id,content) VALUES($1,$2,$3) ON CONFLICT(export_id,id) DO UPDATE SET content=excluded.content",
          [bundle.id, file.id, bytes.toString("base64")],
        );
      } catch (error) {
        file.status = "failed";
        file.error = (error as Error).message;
      }
      await this.save(bundle);
    }
    for (const file of bundle.files)
      if (file.status === "pending") {
        file.status = "failed";
        file.error = "生成中断，请明确重试";
      }
    bundle.status = bundle.files.every((file) => file.status === "ready")
      ? "complete"
      : "partial";
    await this.save(bundle);
  }
  async retry(
    customer: string,
    reportId: string,
    revisionId: string,
    id: string,
    value: unknown,
  ) {
    const parsed = z
      .object({
        fileIds: z
          .array(z.uuid())
          .min(1)
          .refine((ids) => new Set(ids).size === ids.length),
      })
      .strict()
      .safeParse(value);
    if (!parsed.success) throw new BadRequestException("请选择失败文件");
    const bundle = await this.get(customer, reportId, revisionId, id);
    if (this.active.has(id)) throw new ConflictException("文件仍在生成");
    const files = bundle.files.filter((file) =>
      parsed.data.fileIds.includes(file.id),
    );
    if (
      files.length !== parsed.data.fileIds.length ||
      files.some((file) => file.status !== "failed")
    )
      throw new ConflictException("只能重试此包失败的文件");
    for (const file of files) file.status = "pending";
    bundle.status = "generating";
    await this.save(bundle);
    this.start(customer, bundle);
    return bundle;
  }
  private async bytes(bundle: ReportPackage, file: ReportPackageFile) {
    if (file.status !== "ready")
      throw new ConflictException("该文件尚未成功生成");
    const row = (
      await this.db.query(
        "SELECT content FROM report_export_files WHERE export_id=$1 AND id=$2",
        [bundle.id, file.id],
      )
    ).rows[0];
    if (!row) throw new ConflictException("文件原文缺失");
    const bytes = Buffer.from(String(row.content), "base64");
    if (sha(bytes) !== file.sha256 || bytes.length !== file.bytes)
      throw new ConflictException("文件字节校验失败");
    return bytes;
  }
  async download(
    customer: string,
    reportId: string,
    revisionId: string,
    id: string,
    fileId?: string,
    partial = false,
  ) {
    const bundle = await this.get(customer, reportId, revisionId, id);
    if (bundle.input.audience === "official")
      await this.review.export(customer, reportId, revisionId);
    if (fileId) {
      const file = bundle.files.find((file) => file.id === fileId);
      if (!file) throw new NotFoundException("此包未选择该文件");
      return new StreamableFile(await this.bytes(bundle, file), {
        type:
          file.format === "pdf"
            ? "application/pdf"
            : file.format === "xlsx"
              ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              : file.format === "html"
                ? "text/html; charset=utf-8"
                : "application/json",
        disposition: `attachment; filename="${file.name.replaceAll("/", "-")}"`,
      });
    }
    if (bundle.status !== "complete" && !partial)
      throw new ConflictException(
        "所选文件未全部成功；可明确下载可用部分，或重试失败文件",
      );
    const files: Record<string, Uint8Array> = {};
    for (const file of bundle.files)
      if (file.status === "ready")
        files[file.name] = await this.bytes(bundle, file);
    files["manifest.json"] = strToU8(
      JSON.stringify(
        {
          ...bundle,
          complete: bundle.status === "complete",
          notice:
            bundle.input.audience === "draft"
              ? "草稿 · 未复核"
              : "正式交付 · 已复核",
          coverageIndependent: true,
        },
        null,
        2,
      ),
    );
    return new StreamableFile(Buffer.from(zipSync(files, { level: 6 })), {
      type: "application/zip",
      disposition: `attachment; filename="ys-${bundle.input.audience}-${bundle.status === "complete" ? "complete" : "INCOMPLETE"}-${bundle.id}.zip"`,
    });
  }
}
@Controller(
  "api/customers/:customerId/reports/:reportId/revisions/:revisionId/packages",
)
export class ReportPackageController {
  constructor(private service: ReportPackageService) {}
  private ids(req: AuthorizedRequest) {
    for (const key of ["reportId", "revisionId", "packageId", "fileId"])
      if (req.params[key] && !z.uuid().safeParse(req.params[key]).success)
        throw new BadRequestException("报告文件编号无效");
  }
  @Post() @HttpCode(202) create(req: AuthorizedRequest) {
    this.ids(req);
    return this.service.create(
      req.params.customerId,
      req.params.reportId,
      req.params.revisionId,
      req.operator.name,
      req.body,
    );
  }
  @Get() list(req: AuthorizedRequest) {
    this.ids(req);
    return this.service.list(
      req.params.customerId,
      req.params.reportId,
      req.params.revisionId,
    );
  }
  @Get(":packageId") get(req: AuthorizedRequest) {
    this.ids(req);
    return this.service.get(
      req.params.customerId,
      req.params.reportId,
      req.params.revisionId,
      req.params.packageId,
    );
  }
  @Post(":packageId/retry") retry(req: AuthorizedRequest) {
    this.ids(req);
    return this.service.retry(
      req.params.customerId,
      req.params.reportId,
      req.params.revisionId,
      req.params.packageId,
      req.body,
    );
  }
  @Get(":packageId/files/:fileId") file(req: AuthorizedRequest) {
    this.ids(req);
    return this.service.download(
      req.params.customerId,
      req.params.reportId,
      req.params.revisionId,
      req.params.packageId,
      req.params.fileId,
    );
  }
  @Get(":packageId/download") download(req: AuthorizedRequest) {
    this.ids(req);
    const query = z
      .object({ partial: z.literal("true").optional() })
      .strict()
      .safeParse(req.query);
    if (!query.success) throw new BadRequestException("下载选项无效");
    return this.service.download(
      req.params.customerId,
      req.params.reportId,
      req.params.revisionId,
      req.params.packageId,
      undefined,
      query.data.partial === "true",
    );
  }
}
for (const method of [
  "create",
  "list",
  "get",
  "retry",
  "file",
  "download",
] as const) {
  Req()(ReportPackageController.prototype, method, 0);
  Header("Cache-Control", "private, no-store")(
    ReportPackageController.prototype,
    method,
    Object.getOwnPropertyDescriptor(ReportPackageController.prototype, method)!,
  );
}
Inject(ReportPackageService)(ReportPackageController, undefined, 0);
