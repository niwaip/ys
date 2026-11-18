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
import type { ImportMaterial } from "../../../../packages/contracts";
import { type AuthorizedRequest } from "../auth/auth";
import {
  DATABASE,
  type Database,
  type Queryable,
} from "../persistence/database";
import { parseCsv } from "./csv";
const upload = z
  .object({
    fileName: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(500000),
  })
  .strict();
const columns = `id, customer_id AS "customerId", format, file_name AS "fileName", content_hash AS "contentHash", imported_at AS "importedAt", content, result`;
function serialize(row: Record<string, unknown>): ImportMaterial {
  const { result, ...base } = row;
  return {
    ...base,
    ...(result as object),
    importedAt: new Date(row.importedAt as string).toISOString(),
  } as ImportMaterial;
}
export class ImportsService {
  constructor(private readonly db: Database) {}
  async get(
    customer: string,
    id: string,
    session: Queryable = this.db,
  ): Promise<ImportMaterial> {
    const result = await session.query(
      `SELECT ${columns} FROM import_materials WHERE customer_id=$1 AND id=$2 AND format IN ('csv','cyclonedx-json')`,
      [customer, id],
    );
    if (!result.rows.length)
      throw new NotFoundException("该客户下未找到导入资料");
    return serialize(result.rows[0]);
  }
  async list(customer: string) {
    const result = await this.db.query(
      `SELECT ${columns} FROM import_materials WHERE customer_id=$1 AND format='csv' ORDER BY imported_at DESC,id LIMIT 100`,
      [customer],
    );
    return {
      items: result.rows.map((row) => {
        const { content, ...item } = serialize(row);
        return item;
      }),
    };
  }
  async preview(customer: string, fileName: string, content: string) {
    if (Buffer.byteLength(content, "utf8") > 500000 || content.includes("\0"))
      throw new BadRequestException(
        "CSV 最多 500000 UTF-8 字节且不能含 NUL 字符",
      );
    const parsed = parseCsv(content);
    const hash = createHash("sha256").update(content, "utf8").digest("hex");
    return this.db.transaction(async (session) => {
      const found = await session.query(
        `SELECT ${columns} FROM import_materials WHERE customer_id=$1 AND format='csv' AND content_hash=$2`,
        [customer, hash],
      );
      if (found.rows.length)
        return { ...serialize(found.rows[0]), replayed: true };
      for (const row of parsed.rows) {
        if (row.status !== "ready") continue;
        const m = row.mapped!;
        const match = await session.query(
          "SELECT id FROM assets WHERE customer_id=$1 AND source=$2 AND kind=$3 AND source_ref=$4 AND import_id IS NOT NULL",
          [customer, m.source, m.kind, m.sourceRef],
        );
        if (match.rows.length) {
          row.status = "duplicate";
          row.issues.push("来源对象已存在；不覆盖历史资料");
          row.assetId = String(match.rows[0].id);
        }
      }
      const result = {
        ...parsed,
        status: "preview",
        policy: "atomic",
        canCommit: parsed.rows.every((r) => r.status === "ready"),
      };
      const saved = await session.query(
        `INSERT INTO import_materials(id,customer_id,format,file_name,content,content_hash,result) VALUES($1,$2,'csv',$3,$4,$5,$6::jsonb) RETURNING ${columns}`,
        [
          randomUUID(),
          customer,
          fileName,
          content,
          hash,
          JSON.stringify(result),
        ],
      );
      return serialize(saved.rows[0]);
    });
  }
  async commit(customer: string, id: string) {
    return this.db.transaction(async (session) => {
      // Lock also protects duplicate commits from independent PostgreSQL connections.
      await session.query(
        "SELECT id FROM import_materials WHERE customer_id=$1 AND id=$2 FOR UPDATE",
        [customer, id],
      );
      const material = await this.get(customer, id, session);
      if (material.format !== "csv")
        throw new ConflictException("该资料不使用资产 CSV 提交流程");
      if (material.status === "committed")
        return { ...material, replayed: true };
      if (!material.canCommit)
        throw new ConflictException("整批提交被阻止：请修正问题记录后重新预览");
      for (const row of material.rows) {
        const m = row.mapped!;
        const assetId = randomUUID();
        const inserted = await session.query(
          `INSERT INTO assets(id,customer_id,name,kind,source,source_ref,attributes,import_id,collected_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9) ON CONFLICT DO NOTHING RETURNING id`,
          [
            assetId,
            customer,
            m.name,
            m.kind,
            m.source,
            m.sourceRef,
            JSON.stringify(m.attributes),
            id,
            m.collectedAt,
          ],
        );
        if (!inserted.rows.length)
          throw new ConflictException(
            `第 ${row.row} 条来源对象已存在；整批未导入，请重新检查资料`,
          );
        row.status = "imported";
        row.assetId = assetId;
      }
      const result = {
        status: "committed",
        committedAt: new Date().toISOString(),
        policy: "atomic",
        canCommit: false,
        mapping: material.mapping,
        rows: material.rows,
      };
      await session.query(
        "UPDATE import_materials SET result=$3::jsonb WHERE customer_id=$1 AND id=$2",
        [customer, id, JSON.stringify(result)],
      );
      return this.get(customer, id, session);
    });
  }
}
@Controller("api/customers/:customerId/imports")
export class ImportsController {
  constructor(private readonly imports: ImportsService) {}
  @Post("csv/preview") preview(req: AuthorizedRequest) {
    const input = upload.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException(
        "CSV 上传需 fileName 和 content，最多 500000 字符",
      );
    return this.imports.preview(
      req.params.customerId,
      input.data.fileName,
      input.data.content,
    );
  }
  @Get() list(req: AuthorizedRequest) {
    return this.imports.list(req.params.customerId);
  }
  @Get(":importId") get(req: AuthorizedRequest) {
    this.valid(req);
    return this.imports.get(req.params.customerId, req.params.importId);
  }
  @Post(":importId/commit") commit(req: AuthorizedRequest) {
    this.valid(req);
    return this.imports.commit(req.params.customerId, req.params.importId);
  }
  private valid(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.importId).success)
      throw new BadRequestException("导入编号无效");
  }
}
for (const method of ["preview", "list", "get", "commit"] as const)
  Req()(ImportsController.prototype, method, 0);
Inject(ImportsService)(ImportsController, undefined, 0);
@Module({
  controllers: [ImportsController],
  providers: [
    {
      provide: ImportsService,
      inject: [DATABASE],
      useFactory: (db: Database) => new ImportsService(db),
    },
  ],
  exports: [ImportsService],
})
export class ImportsModule {}
