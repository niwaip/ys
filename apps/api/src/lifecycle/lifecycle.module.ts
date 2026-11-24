import {
  LifecycleWorkspaceService,
  LifecycleWorkspaceController,
} from "./workspace";
import { requireActiveAsset } from "../assets/asset-state";
import {
  BadRequestException,
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
import type {
  LifecycleBatch,
  LifecycleRow,
  LifecycleStage,
  LifecycleAssessment,
  LifecycleAssessmentItem,
} from "../../../../packages/contracts/lifecycle";
import type { AuthorizedRequest } from "../auth/auth";
import {
  DATABASE,
  type Database,
  type Queryable,
} from "../persistence/database";
import { SoftwareModule, SoftwareService } from "../software/software.module";
import { parseCsvRecords } from "../imports/csv";
const upload = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(500000),
  })
  .strict();
const assessmentInput = z
  .object({
    batchId: z.uuid(),
    assetIds: z
      .array(z.uuid())
      .max(1000)
      .refine((x) => new Set(x).size === x.length)
      .default([]),
    softwareTargets: z
      .array(z.object({ softwareId: z.uuid(), versionId: z.uuid() }).strict())
      .max(1000)
      .default([]),
  })
  .strict()
  .refine(
    (x) =>
      x.assetIds.length + x.softwareTargets.length > 0 &&
      x.assetIds.length + x.softwareTargets.length <= 1000 &&
      new Set(x.softwareTargets.map((t) => t.softwareId + ":" + t.versionId))
        .size === x.softwareTargets.length,
  );
function stage(name: string, rawDate: string): LifecycleStage {
  const valid =
    /^\d{4}-\d\d-\d\d$/.test(rawDate) &&
    Number.isFinite(Date.parse(rawDate)) &&
    new Date(rawDate).toISOString().slice(0, 10) === rawDate;
  return {
    name,
    rawDate,
    date: valid ? rawDate : null,
    dateStatus: rawDate ? (valid ? "known" : "invalid") : "unknown",
  };
}
const batchColumns = `id,customer_id AS "customerId",format,file_name AS "fileName",content_hash AS "contentHash",imported_at AS "importedAt",content,result`;
function batch(row: Record<string, unknown>): LifecycleBatch {
  const { result, ...base } = row;
  return {
    ...base,
    ...(result as object),
    importedAt: new Date(row.importedAt as string).toISOString(),
  } as LifecycleBatch;
}
export class LifecycleService {
  constructor(
    private readonly db: Database,
    private readonly software: SoftwareService,
  ) {}
  async getBatch(
    customer: string,
    id: string,
    session: Queryable = this.db,
  ): Promise<LifecycleBatch> {
    const r = await session.query(
      `SELECT ${batchColumns} FROM import_materials WHERE customer_id=$1 AND id=$2 AND format='lifecycle-csv-v1'`,
      [customer, id],
    );
    if (!r.rows.length)
      throw new NotFoundException("该客户下未找到生命周期批次");
    return batch(r.rows[0]);
  }
  async batches(customer: string) {
    const r = await this.db.query(
      `SELECT ${batchColumns} FROM import_materials WHERE customer_id=$1 AND format='lifecycle-csv-v1' ORDER BY imported_at DESC,id LIMIT 100`,
      [customer],
    );
    return {
      items: r.rows.map((x) => {
        const { content, ...rest } = batch(x);
        return rest;
      }),
    };
  }
  async import(customer: string, fileName: string, content: string) {
    if (Buffer.byteLength(content, "utf8") > 500000 || content.includes("\0"))
      throw new BadRequestException("CSV 最多500000字节且不能含NUL");
    const { headers, records } = parseCsvRecords(content);
    const required = [
      "source",
      "sourceRef",
      "product",
      "version",
      "eosStage",
      "eosDate",
      "eolStage",
      "eolDate",
    ];
    if (required.some((x) => !headers.includes(x)) || !records.length)
      throw new BadRequestException("缺少生命周期CSV表头或数据");
    const rows: LifecycleRow[] = records.map((values, index) => {
      const raw = Object.fromEntries(
        headers.map((h, i) => [h, (values[i] ?? "").trim()]),
      );
      if (
        values.length !== headers.length ||
        ["source", "sourceRef", "product", "eosStage", "eolStage"].some(
          (k) => !raw[k] || raw[k].length > 500,
        )
      )
        throw new BadRequestException(
          `第${index + 2}行列数或来源/产品/阶段无效`,
        );
      if (
        (raw.category &&
          !["os", "software", "device", "hardware"].includes(raw.category)) ||
        (raw.phase && !["eos", "eol"].includes(raw.phase))
      )
        throw new BadRequestException(`第${index + 2}行分类或引用阶段无效`);
      if (raw.category && !raw.phase)
        throw new BadRequestException(
          `第${index + 2}行分类资料须填写明确phase阶段`,
        );
      if (
        raw.supportTier &&
        !["standard", "extended"].includes(raw.supportTier)
      )
        throw new BadRequestException(
          `第${index + 2}行supportTier须为standard或extended`,
        );
      const eos = stage(raw.eosStage, raw.eosDate),
        eol = stage(raw.eolStage, raw.eolDate);
      return {
        row: index + 2,
        source: raw.source,
        sourceRef: raw.sourceRef,
        product: raw.product,
        version: raw.version || null,
        eos,
        eol,
        issues: [
          ...(eos.dateStatus === "invalid"
            ? ["eosDate 无效，保留其他信息"]
            : []),
          ...(eol.dateStatus === "invalid"
            ? ["eolDate 无效，保留其他信息"]
            : []),
        ],
        extensions: Object.fromEntries(
          headers
            .filter((h) => !required.includes(h))
            .map((h) => [h, values[headers.indexOf(h)]]),
        ),
      };
    });
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    return this.db.transaction(async (session) => {
      const r = await session.query(
        `INSERT INTO import_materials(id,customer_id,format,file_name,content,content_hash,result) VALUES($1,$2,'lifecycle-csv-v1',$3,$4,$5,$6::jsonb) ON CONFLICT(customer_id,format,content_hash) DO NOTHING RETURNING ${batchColumns}`,
        [
          randomUUID(),
          customer,
          fileName,
          content,
          hash,
          JSON.stringify({ rows }),
        ],
      );
      if (r.rows.length) return batch(r.rows[0]);
      const found = await session.query(
        `SELECT ${batchColumns} FROM import_materials WHERE customer_id=$1 AND format='lifecycle-csv-v1' AND content_hash=$2`,
        [customer, hash],
      );
      return { ...batch(found.rows[0]), replayed: true };
    });
  }
  async assess(
    customer: string,
    batchId: string,
    assetIds: string[],
    softwareTargets: { softwareId: string; versionId: string }[] = [],
  ): Promise<LifecycleAssessment> {
    const source = await this.getBatch(customer, batchId);
    const evaluatedAt = new Date().toISOString();
    const items: LifecycleAssessmentItem[] = [];
    const inputs: {
      assetId: string;
      versionId?: string;
      importId?: string;
      name: string;
      kind: string;
      product: string | null;
      version: string | null;
      inputSource: string;
    }[] = [];
    for (const id of assetIds) {
      const r = await this.db.query(
        "SELECT id,name,kind,attributes FROM assets WHERE customer_id=$1 AND id=$2",
        [customer, id],
      );
      if (!r.rows.length) throw new NotFoundException("该客户下未找到评估对象");
      const asset = r.rows[0];
      const attributes = asset.attributes as Record<string, unknown>;
      inputs.push({
        assetId: id,
        name: String(asset.name),
        kind: String(asset.kind),
        product:
          typeof attributes.product === "string"
            ? attributes.product.trim() || null
            : null,
        version:
          typeof attributes.version === "string"
            ? attributes.version.trim() || null
            : null,
        inputSource: "assets.attributes.product/version",
      });
    }
    for (const target of softwareTargets) {
      const object = await this.software.get(customer, target.softwareId);
      const snapshot = await this.software.getVersion(
        customer,
        target.softwareId,
        target.versionId,
      );
      inputs.push({
        assetId: object.id,
        versionId: snapshot.id,
        importId: snapshot.importId,
        name: object.name,
        kind: "software",
        product: object.name,
        version: snapshot.version,
        inputSource: "software/SBOM input version",
      });
    }
    for (const input of inputs) {
      const { product, version } = input;
      const candidates = source.rows.filter(
        (row) => product !== null && row.product === product,
      );
      const exact = candidates.filter(
        (row) => version !== null && row.version === version,
      );
      const matched = exact.length
        ? exact
        : candidates.filter((row) => !version || !row.version);
      const match = exact.length
        ? "exact"
        : matched.length
          ? "weak"
          : "unmatched";
      items.push({
        ...input,
        match,
        verification:
          match === "exact"
            ? "verified"
            : match === "weak"
              ? "needs_verification"
              : "unknown",
        basis:
          match === "exact"
            ? "产品和版本字面精确匹配"
            : match === "weak"
              ? "产品匹配，版本资料缺失；需核实"
              : "无相符产品及版本资料",
        evidence: matched.map((row) => ({
          ...row,
          eos: {
            ...row.eos,
            status: row.eos.date
              ? row.eos.date <= evaluatedAt.slice(0, 10)
                ? "reached"
                : "future"
              : "unknown",
          },
          eol: {
            ...row.eol,
            status: row.eol.date
              ? row.eol.date <= evaluatedAt.slice(0, 10)
                ? "reached"
                : "future"
              : "unknown",
          },
        })),
      });
    }
    const result: LifecycleAssessment = {
      id: randomUUID(),
      customerId: customer,
      batchId,
      contentHash: source.contentHash,
      evaluatedAt,
      ruleVersion: "literal-product-version-v1",
      items,
    };
    await this.db.transaction(async (tx) => {
      for (const id of assetIds) await requireActiveAsset(tx, customer, id);
      await tx.query(
        "INSERT INTO lifecycle_assessments(id,customer_id,batch_id,evaluated_at,result) VALUES($1,$2,$3,$4,$5::jsonb)",
        [result.id, customer, batchId, evaluatedAt, JSON.stringify(result)],
      );
    });
    return result;
  }
  async getAssessment(customer: string, id: string) {
    const r = await this.db.query(
      "SELECT result FROM lifecycle_assessments WHERE customer_id=$1 AND id=$2",
      [customer, id],
    );
    if (!r.rows.length)
      throw new NotFoundException("该客户下未找到生命周期评估");
    return r.rows[0].result as LifecycleAssessment;
  }
  async assessments(customer: string) {
    const r = await this.db.query(
      "SELECT result FROM lifecycle_assessments WHERE customer_id=$1 ORDER BY evaluated_at DESC,id LIMIT 100",
      [customer],
    );
    return { items: r.rows.map((x) => x.result as LifecycleAssessment) };
  }
}
@Controller("api/customers/:customerId/lifecycle")
export class LifecycleController {
  constructor(private readonly service: LifecycleService) {}
  @Post("batches") import(req: AuthorizedRequest) {
    const parsed = upload.safeParse(req.body);
    if (!parsed.success) throw new BadRequestException("需fileName/content");
    return this.service.import(
      req.params.customerId,
      parsed.data.fileName,
      parsed.data.content,
    );
  }
  @Get("batches") batches(req: AuthorizedRequest) {
    return this.service.batches(req.params.customerId);
  }
  @Get("batches/:id") batch(req: AuthorizedRequest) {
    this.valid(req.params.id);
    return this.service.getBatch(req.params.customerId, req.params.id);
  }
  @Post("assessments") assess(req: AuthorizedRequest) {
    const parsed = assessmentInput.safeParse(req.body);
    if (!parsed.success)
      throw new BadRequestException("需批次和非重复资产编号列表");
    return this.service.assess(
      req.params.customerId,
      parsed.data.batchId,
      parsed.data.assetIds,
      parsed.data.softwareTargets,
    );
  }
  @Get("assessments") assessments(req: AuthorizedRequest) {
    return this.service.assessments(req.params.customerId);
  }
  @Get("assessments/:id") assessment(req: AuthorizedRequest) {
    this.valid(req.params.id);
    return this.service.getAssessment(req.params.customerId, req.params.id);
  }
  private valid(id: string) {
    if (!z.uuid().safeParse(id).success)
      throw new BadRequestException("编号无效");
  }
}
for (const method of [
  "import",
  "batches",
  "batch",
  "assess",
  "assessments",
  "assessment",
] as const)
  Req()(LifecycleController.prototype, method, 0);
Inject(LifecycleService)(LifecycleController, undefined, 0);
@Module({
  imports: [SoftwareModule],
  controllers: [LifecycleController, LifecycleWorkspaceController],
  providers: [
    {
      provide: LifecycleWorkspaceService,
      inject: [DATABASE],
      useFactory: (db: Database) => new LifecycleWorkspaceService(db),
    },
    {
      provide: LifecycleService,
      inject: [DATABASE, SoftwareService],
      useFactory: (db: Database, software: SoftwareService) =>
        new LifecycleService(db, software),
    },
  ],
  exports: [LifecycleService],
})
export class LifecycleModule {}
