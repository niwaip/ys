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
import {
  collectionSectionNames,
  hostCollectionSchema,
  sectionName,
  type CollectionSnapshot,
  type HostCollection,
} from "../../../../packages/contracts/collections";
import { DATABASE, type Database } from "../persistence/database";
import type { AuthorizedRequest } from "../auth/auth";
import { NetBoxService } from "../netbox/netbox.module";
const pagination = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
  })
  .strict();
const upload = z
  .object({
    assetId: z.uuid(),
    fileName: z.string().trim().min(1).max(200),
    content: z.string().min(1).max(5000000),
  })
  .strict();
const manual = z
  .object({
    assetId: z.uuid(),
    note: z.string().trim().min(1).max(1000),
    data: hostCollectionSchema,
  })
  .strict();
function summary(row: Record<string, unknown>): CollectionSnapshot {
  if (row.summary) return row.summary as CollectionSnapshot;
  const data = row.normalized as HostCollection;
  return {
    id: String(row.id),
    customerId: String(row.customer_id),
    assetId: String(row.asset_id),
    entry: row.entry as CollectionSnapshot["entry"],
    fileName: String(row.file_name),
    contentHash: String(row.content_hash),
    note: row.note as string | null,
    collectedAt: data.collectedAt,
    importedAt: new Date(row.created_at as string).toISOString(),
    identity: data.identity,
    extensions: Object.fromEntries(
      Object.entries(data.extensions).filter(([key]) => key !== "rawSections"),
    ),
    assessmentStatus: "not_assessed",
    target: row.target as Record<string, unknown>,
    sections: Object.fromEntries(
      collectionSectionNames.map((name) => {
        const section = data.sections[name];
        return [
          name,
          {
            status: section?.status ?? "not_collected",
            count: Array.isArray(section?.data) ? section.data.length : null,
            issues: section?.issues ?? [],
          },
        ];
      }),
    ) as CollectionSnapshot["sections"],
  };
}
export class CollectionsService {
  constructor(
    private readonly db: Database,
    private readonly netbox: NetBoxService,
  ) {}
  async assertTarget(customerId: string, assetId: string) {
    const asset = (
      await this.db.query(
        "SELECT id FROM assets WHERE customer_id=$1 AND id=$2",
        [customerId, assetId],
      )
    ).rows[0];
    if (!asset) throw new NotFoundException("该客户下未找到目标资产");
    if (this.netbox.enabled) {
      const mapping = (
        await this.db.query(
          "SELECT tenant_id,instance,active FROM netbox_assets WHERE customer_id=$1 AND asset_id=$2",
          [customerId, assetId],
        )
      ).rows[0];
      if (
        !mapping ||
        !mapping.active ||
        !this.netbox.acceptsMapping(customerId, mapping)
      )
        throw new ConflictException(
          "采集目标未映射至当前客户NetBox，请先同步或关联",
        );
    }
  }
  async save(
    customerId: string,
    assetId: string,
    entry: CollectionSnapshot["entry"],
    fileName: string,
    content: string,
    note: string | null = null,
  ) {
    if (Buffer.byteLength(content) > 5000000 || content.includes("\0"))
      throw new BadRequestException(
        "采集JSON最多5000000字节，不能含NUL；不会截断输入",
      );
    let raw: unknown;
    try {
      raw = JSON.parse(content);
    } catch {
      throw new BadRequestException("采集内容必须为JSON");
    }
    const parsed = hostCollectionSchema.safeParse(raw);
    if (!parsed.success)
      throw new BadRequestException(
        "不支持的采集格式或字段；请使用ys-host/1规范，未知资料放extensions",
      );
    const data = parsed.data;
    const hash = createHash("sha256").update(content).digest("hex");
    return this.db.transaction(async (session) => {
      const asset = (
        await session.query(
          "SELECT id,name,source,source_ref,attributes FROM assets WHERE customer_id=$1 AND id=$2",
          [customerId, assetId],
        )
      ).rows[0];
      if (!asset) throw new NotFoundException("该客户下未找到目标资产");
      if (this.netbox.enabled) {
        const mapping = (
          await session.query(
            "SELECT tenant_id,instance,active FROM netbox_assets WHERE customer_id=$1 AND asset_id=$2",
            [customerId, assetId],
          )
        ).rows[0];
        if (
          !mapping ||
          !mapping.active ||
          !this.netbox.acceptsMapping(customerId, mapping)
        )
          throw new ConflictException("请先同步或映射该客户的NetBox资产");
      }
      const attrs = asset.attributes as Record<string, unknown>;
      if (
        data.identity.serial &&
        attrs.serial &&
        attrs.serial !== data.identity.serial
      )
        throw new ConflictException("资料序列号与目标资产不符，未保存快照");
      const old = (
        await session.query(
          "SELECT * FROM collection_snapshots WHERE customer_id=$1 AND content_hash=$2 AND entry=$3",
          [customerId, hash, entry],
        )
      ).rows[0];
      if (old) {
        if (old.asset_id !== assetId || old.note !== note)
          throw new ConflictException("相同资料已绑定其他目标或来源声明");
        return { ...summary(old), replayed: true };
      }
      const identity = (
        await session.query(
          "SELECT normalized->'identity'->>'machineId' AS machine_id FROM collection_snapshots WHERE customer_id=$1 AND asset_id=$2 AND normalized->'identity'->>'machineId' IS NOT NULL LIMIT 1",
          [customerId, assetId],
        )
      ).rows[0];
      if (
        identity &&
        data.identity.machineId &&
        identity.machine_id !== data.identity.machineId
      )
        throw new ConflictException(
          "主机machineId与历史资料冲突，请解决目标身份后再提交",
        );
      const saved = (
        await session.query(
          "INSERT INTO collection_snapshots(id,customer_id,asset_id,entry,file_name,content,content_hash,note,normalized,target) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb) RETURNING *",
          [
            randomUUID(),
            customerId,
            assetId,
            entry,
            fileName,
            content,
            hash,
            note,
            JSON.stringify(data),
            JSON.stringify(asset),
          ],
        )
      ).rows[0];
      const view = summary(saved);
      await session.query(
        "UPDATE collection_snapshots SET summary=$3::jsonb WHERE customer_id=$1 AND id=$2",
        [customerId, view.id, JSON.stringify(view)],
      );
      return view;
    });
  }
  async row(customerId: string, id: string) {
    const row = (
      await this.db.query(
        "SELECT * FROM collection_snapshots WHERE customer_id=$1 AND id=$2",
        [customerId, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("该客户下未找到采集快照");
    return row;
  }
  async get(customerId: string, id: string) {
    return summary(await this.row(customerId, id));
  }
  async list(
    customerId: string,
    query: { limit: number; offset: number; assetId?: string },
  ) {
    const rows = await this.db.query(
      "SELECT id,customer_id,asset_id,entry,file_name,content_hash,note,created_at,target,summary,CASE WHEN summary IS NULL THEN normalized ELSE NULL END AS normalized FROM collection_snapshots WHERE customer_id=$1 AND ($2::uuid IS NULL OR asset_id=$2) ORDER BY created_at DESC,id LIMIT $3 OFFSET $4",
      [customerId, query.assetId ?? null, query.limit, query.offset],
    );
    const total = (
      await this.db.query(
        "SELECT count(*)::int AS total FROM collection_snapshots WHERE customer_id=$1 AND ($2::uuid IS NULL OR asset_id=$2)",
        [customerId, query.assetId ?? null],
      )
    ).rows[0].total;
    return {
      items: rows.rows.map(summary),
      total: Number(total),
      limit: query.limit,
      offset: query.offset,
    };
  }
  async raw(customerId: string, id: string) {
    const row = await this.row(customerId, id);
    return {
      fileName: row.file_name,
      content: row.content,
      contentHash: row.content_hash,
    };
  }
  async section(
    customerId: string,
    id: string,
    name: z.infer<typeof sectionName>,
    query: z.infer<typeof pagination>,
  ) {
    const row = await this.row(customerId, id);
    const section = (row.normalized as HostCollection).sections[name] ?? {
      status: "not_collected",
      data: null,
      issues: [],
    };
    const data = section.data;
    return {
      status: section.status,
      issues: section.issues,
      data: Array.isArray(data) ? undefined : data,
      items: Array.isArray(data)
        ? data.slice(query.offset, query.offset + query.limit)
        : [],
      total: Array.isArray(data) ? data.length : null,
      ...query,
    };
  }
}
@Controller("api/customers/:customerId/collections")
class CollectionsController {
  constructor(private readonly service: CollectionsService) {}
  @Post("upload") upload(req: AuthorizedRequest) {
    const input = upload.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException("需assetId、fileName和content");
    return this.service.save(
      req.params.customerId,
      input.data.assetId,
      "upload",
      input.data.fileName,
      input.data.content,
    );
  }
  @Post("manual") manual(req: AuthorizedRequest) {
    const input = manual.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException("手工资料需目标、来源说明及ys-host/1数据");
    return this.service.save(
      req.params.customerId,
      input.data.assetId,
      "manual",
      "manual.json",
      JSON.stringify(input.data.data),
      input.data.note,
    );
  }
  @Get("snapshots") list(req: AuthorizedRequest) {
    const query = pagination
      .extend({ assetId: z.uuid().optional() })
      .safeParse(req.query);
    if (!query.success) throw new BadRequestException("分页或目标编号无效");
    return this.service.list(req.params.customerId, query.data);
  }
  private id(req: AuthorizedRequest) {
    if (!z.uuid().safeParse(req.params.snapshotId).success)
      throw new BadRequestException("快照编号无效");
    return req.params.snapshotId;
  }
  @Get("snapshots/:snapshotId") get(req: AuthorizedRequest) {
    return this.service.get(req.params.customerId, this.id(req));
  }
  @Get("snapshots/:snapshotId/raw") raw(req: AuthorizedRequest) {
    return this.service.raw(req.params.customerId, this.id(req));
  }
  @Get("snapshots/:snapshotId/sections/:section") section(
    req: AuthorizedRequest,
  ) {
    const query = pagination.safeParse(req.query);
    const name = sectionName.safeParse(req.params.section);
    if (!query.success || !name.success)
      throw new BadRequestException("分项或分页无效");
    return this.service.section(
      req.params.customerId,
      this.id(req),
      name.data,
      query.data,
    );
  }
}
for (const method of [
  "upload",
  "manual",
  "list",
  "get",
  "raw",
  "section",
] as const)
  Req()(CollectionsController.prototype, method, 0);
Inject(CollectionsService)(CollectionsController, undefined, 0);
@Module({
  controllers: [CollectionsController],
  providers: [
    {
      provide: CollectionsService,
      inject: [DATABASE, NetBoxService],
      useFactory: (db: Database, netbox: NetBoxService) =>
        new CollectionsService(db, netbox),
    },
  ],
  exports: [CollectionsService],
})
export class CollectionsModule {}
