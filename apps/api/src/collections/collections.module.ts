import { parseCollector } from "../windows/collector";
import { parseCollection } from "./input";
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
  collectionScope,
  type CollectionScope,
  hostCollectionSchema,
  sectionName,
  type CollectionSnapshot,
  type HostCollection,
} from "../../../../packages/contracts/collections";
import {
  DATABASE,
  type Database,
  type Queryable,
} from "../persistence/database";
import type { AuthorizedRequest } from "../auth/auth";
import { NetBoxService } from "../netbox/netbox.module";
import { deviceCategory } from "../../../../packages/contracts/device-collection";
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
    scope: z.enum(["basic", "container-inventory"]).optional(),
  })
  .strict();
const manual = z
  .object({
    assetId: z.uuid(),
    note: z.string().trim().min(1).max(1000),
    data: hostCollectionSchema,
  })
  .strict();
const scopeExpression =
  "COALESCE(summary->>'scope',CASE WHEN normalized->'extensions'->'execution'->>'scope' IN ('basic','container-inventory') THEN normalized->'extensions'->'execution'->>'scope' WHEN normalized->'sections'->'images'->>'status' IN ('acquired','partial') THEN 'container-inventory' ELSE 'basic' END)";
function summary(row: Record<string, unknown>): CollectionSnapshot {
  if (row.summary) {
    const old = row.summary as CollectionSnapshot;
    return { ...old, scope: old.scope ?? collectionScope(old) };
  }
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
    scope: collectionScope(data),
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
  async roleTemplates(customer: string) {
    const rows = (
      await this.db.query(
        "SELECT role_id,category FROM collection_role_templates WHERE customer_id=$1",
        [customer],
      )
    ).rows;
    return {
      mappings: Object.fromEntries(
        rows.map((r) => [String(r.role_id), r.category]),
      ),
    };
  }
  async setRoleTemplate(customer: string, roleId: number, category: string) {
    await this.db.query(
      "INSERT INTO collection_role_templates(customer_id,role_id,category) VALUES($1,$2,$3) ON CONFLICT(customer_id,role_id) DO UPDATE SET category=EXCLUDED.category",
      [customer, roleId, category],
    );
    return this.roleTemplates(customer);
  }
  private async checkedTarget(
    customerId: string,
    assetId: string,
    session: Queryable = this.db,
  ) {
    const asset = (
      await session.query(
        "SELECT id,name,source,source_ref,attributes,deleted_at FROM assets WHERE customer_id=$1 AND id=$2 FOR UPDATE",
        [customerId, assetId],
      )
    ).rows[0];
    if (!asset) throw new NotFoundException("该客户下未找到目标资产");
    if (asset.deleted_at)
      throw new ConflictException("资产已删除，请先恢复纳管");
    let mapping: Record<string, unknown> | undefined;
    if (this.netbox.enabled) {
      mapping = (
        await session.query(
          "SELECT tenant_id,instance,active,object_type,external_id FROM netbox_assets WHERE customer_id=$1 AND asset_id=$2",
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
    return { asset, mapping };
  }
  async assertTarget(customerId: string, assetId: string) {
    const { mapping } = await this.checkedTarget(customerId, assetId);
    if (mapping)
      await this.netbox.resolveReference(
        customerId,
        `${mapping.object_type}:${mapping.external_id}`,
      );
  }
  async save(
    customerId: string,
    assetId: string,
    entry: CollectionSnapshot["entry"],
    fileName: string,
    content: string,
    note: string | null = null,
    expectedScope?: CollectionScope,
  ) {
    if (Buffer.byteLength(content) > 5000000 || content.includes("\0"))
      throw new BadRequestException(
        "采集JSON最多5000000字节，不能含NUL；不会截断输入",
      );
    const data = parseCollection(content);
    const hash = createHash("sha256").update(content).digest("hex");
    await this.assertTarget(customerId, assetId);
    return this.db.transaction(async (session) => {
      const { asset } = await this.checkedTarget(customerId, assetId, session);
      const attrs = asset.attributes as Record<string, unknown>;
      const objectType = (attrs.netbox as { objectType?: string } | undefined)
        ?.objectType;
      const category = (
        data.sections.device?.data as { category?: string } | undefined
      )?.category;
      if (
        category &&
        ((objectType === "virtual-machine" && category !== "vm") ||
          (objectType === "device" && category === "vm"))
      )
        throw new ConflictException("设备资料类型与NetBox原生对象不符");
      if (
        data.extensions.targetAssetId &&
        data.extensions.targetAssetId !== assetId
      )
        throw new ConflictException("脚本声明的目标编号与所选资产不符");
      if (
        data.extensions.inputFormat === "windows-bat/1" &&
        !attrs.serial &&
        data.extensions.targetAssetId !== assetId
      )
        throw new ConflictException(
          "目标资产未登记序列号，Windows资料身份待确认；请先在资产主数据补充序列号",
        );
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
        if (
          old.asset_id !== assetId ||
          old.note !== note ||
          (expectedScope && summary(old).scope !== expectedScope)
        )
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
          "INSERT INTO collection_snapshots(id,customer_id,asset_id,entry,file_name,content,content_hash,note,normalized,target,review_required) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,true) RETURNING *",
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
      const view = {
        ...summary(saved),
        ...(expectedScope ? { scope: expectedScope } : {}),
      };
      await session.query(
        "UPDATE collection_snapshots SET summary=$3::jsonb WHERE customer_id=$1 AND id=$2",
        [customerId, view.id, JSON.stringify(view)],
      );
      return view;
    });
  }
  async row(customerId: string, id: string, session: Queryable = this.db) {
    const row = (
      await session.query(
        "SELECT * FROM collection_snapshots WHERE customer_id=$1 AND id=$2",
        [customerId, id],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("该客户下未找到采集快照");
    return row;
  }
  async assertAccepted(customer: string, id: string) {
    const row = await this.row(customer, id);
    if (!row.review_required) return;
    const approvals = (
      await this.db.query(
        "SELECT plan->'selection' AS selection FROM asset_baselines WHERE customer_id=$1 AND snapshot_id=$2 AND status='confirmed'",
        [customer, id],
      )
    ).rows;
    const selections = approvals.map(
      (r) => r.selection as { sections: string[]; excludeFields: string[] },
    );
    if (
      !selections.some(
        (s) =>
          s.sections.includes("os") &&
          !s.excludeFields.some((f) => f.startsWith("os.")),
      ) ||
      !selections.some((s) => s.sections.includes("packages"))
    )
      throw new ConflictException(
        "采集资料尚未采纳完整的操作系统及系统包区块，请先确认资料再评估",
      );
  }
  async get(customerId: string, id: string) {
    return summary(await this.row(customerId, id));
  }
  async list(
    customerId: string,
    query: { limit: number; offset: number; assetId?: string; scope?: string },
  ) {
    const rows = await this.db.query(
      `SELECT id,customer_id,asset_id,entry,file_name,content_hash,note,created_at,target,summary,CASE WHEN summary IS NULL THEN normalized ELSE NULL END AS normalized FROM collection_snapshots WHERE customer_id=$1 AND ($2::uuid IS NULL OR asset_id=$2)  AND ($5::text IS NULL OR ${scopeExpression}=$5) ORDER BY created_at DESC,id LIMIT $3 OFFSET $4`,
      [
        customerId,
        query.assetId ?? null,
        query.limit,
        query.offset,
        query.scope ?? null,
      ],
    );
    const total = (
      await this.db.query(
        `SELECT count(*)::int AS total FROM collection_snapshots WHERE customer_id=$1 AND ($2::uuid IS NULL OR asset_id=$2) AND ($3::text IS NULL OR ${scopeExpression}=$3)`,
        [customerId, query.assetId ?? null, query.scope ?? null],
      )
    ).rows[0].total;
    return {
      items: rows.rows.map(summary),
      total: Number(total),
      limit: query.limit,
      offset: query.offset,
    };
  }
  async windowsPreview(customer: string, id: string, offset: number) {
    const row = await this.row(customer, id);
    if (
      (row.normalized as HostCollection).extensions.inputFormat !==
      "windows-bat/1"
    )
      throw new NotFoundException("该快照不是Windows脚本资料");
    const { extensions, software, kbs, ...snapshot } = parseCollector(
      String(row.content),
    );
    return {
      snapshot,
      software: {
        items: software?.slice(offset, offset + 50) ?? null,
        total: software?.length ?? null,
      },
      kbs: {
        items: kbs?.slice(offset, offset + 50) ?? null,
        total: kbs?.length ?? null,
      },
      offset,
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
  @Get("role-templates") roleTemplates(req: AuthorizedRequest) {
    return this.service.roleTemplates(req.params.customerId);
  }
  @Post("role-templates") setRoleTemplate(req: AuthorizedRequest) {
    const input = z
      .object({
        roleId: z.number().int().positive(),
        category: deviceCategory.exclude(["vm"]),
      })
      .strict()
      .safeParse(req.body);
    if (!input.success) throw new BadRequestException("设备角色及表单类型无效");
    return this.service.setRoleTemplate(
      req.params.customerId,
      input.data.roleId,
      input.data.category,
    );
  }
  @Post("upload") upload(req: AuthorizedRequest) {
    const input = upload.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException("需assetId、fileName和content");
    if (input.data.scope) {
      let raw;
      try {
        raw = parseCollection(input.data.content);
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        throw new BadRequestException("采集格式无效");
      }
      const declared = (
        raw.extensions.execution as { scope?: string } | undefined
      )?.scope;
      const docker =
        ["acquired", "partial"].includes(raw.sections.images?.status ?? "") ||
        ["acquired", "partial"].includes(
          raw.sections.containers?.status ?? "",
        ) ||
        ["acquired", "partial"].includes(
          raw.sections.dockerDaemon?.status ?? "",
        );
      if (
        (declared && declared !== input.data.scope) ||
        (input.data.scope === "basic" && docker) ||
        (input.data.scope === "container-inventory" &&
          (!raw.sections.images ||
            !raw.sections.containers ||
            raw.sections.os ||
            raw.sections.packages))
      )
        throw new BadRequestException("资料范围与选定采集任务不符");
    }
    return this.service.save(
      req.params.customerId,
      input.data.assetId,
      "upload",
      input.data.fileName,
      input.data.content,
      null,
      input.data.scope,
    );
  }
  @Post("manual") manual(req: AuthorizedRequest) {
    const input = manual.safeParse(req.body);
    if (!input.success)
      throw new BadRequestException("手工资料需目标、来源说明及ys-host/1数据");
    if (
      [
        input.data.data.sections.images,
        input.data.data.sections.containers,
        input.data.data.sections.dockerDaemon,
      ].some(
        (section) =>
          section && ["acquired", "partial"].includes(section.status),
      )
    )
      throw new BadRequestException(
        "容器运行资料须来自采集结果，不能人工声明为发现",
      );
    return this.service.save(
      req.params.customerId,
      input.data.assetId,
      "manual",
      "manual.json",
      JSON.stringify(input.data.data),
      input.data.note,
      "basic",
    );
  }
  @Get("snapshots") list(req: AuthorizedRequest) {
    const query = pagination
      .extend({
        assetId: z.uuid().optional(),
        scope: z.enum(["basic", "container-inventory"]).optional(),
      })
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
  @Get("snapshots/:snapshotId/windows") windowsPreview(req: AuthorizedRequest) {
    const q = z
      .object({ offset: z.coerce.number().int().min(0).max(10000).default(0) })
      .strict()
      .safeParse(req.query);
    if (!q.success) throw new BadRequestException("Windows资料分页无效");
    return this.service.windowsPreview(
      req.params.customerId,
      this.id(req),
      q.data.offset,
    );
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
  "windowsPreview",
  "roleTemplates",
  "setRoleTemplate",
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
