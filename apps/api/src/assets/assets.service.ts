import { type LifecycleAsset } from "../../../../packages/contracts/lifecycle-risk";
import { NetBoxService } from "../netbox/netbox.module";
import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type {
  Asset,
  AssetPage,
  AssetSummary,
  CreateAsset,
} from "../../../../packages/contracts";
import type { Database } from "../persistence/database";
const columns = `id, customer_id AS "customerId", name, kind, source, source_ref AS "sourceRef", attributes, import_id AS "importId", collected_at AS "collectedAt", created_at AS "createdAt", deleted_at AS "deletedAt", deleted_by AS "deletedBy", hardware_type AS "hardwareType"`;
// Device role templates take precedence over role-name heuristics; native VM identity always wins.
const roleName =
  "lower(COALESCE(attributes#>>'{role,slug}','') || ' ' || COALESCE(attributes#>>'{role,name}',''))";
const categoryExpression = `CASE WHEN attributes#>>'{netbox,objectType}'='virtual-machine' THEN 'vm' ELSE COALESCE((SELECT category FROM collection_role_templates t WHERE t.customer_id=assets.customer_id AND t.role_id::text=assets.attributes#>>'{role,id}'),CASE WHEN ${roleName} ~ 'switch|router|firewall|network|交换|路由|防火墙|网络' THEN 'network' WHEN ${roleName} ~ 'storage|san|nas|存储' THEN 'storage' WHEN ${roleName} ~ 'power|pdu|ups|电源' THEN 'power' WHEN ${roleName} ~ 'server|服务器' THEN 'server' WHEN hardware_type='server' THEN 'server' WHEN hardware_type='network' THEN 'network' ELSE 'other' END) END`;
function serialize(row: Record<string, unknown>): Asset {
  return {
    ...row,
    sourceRef: row.sourceRef ?? undefined,
    importId: row.importId ?? undefined,
    collectedAt: row.collectedAt
      ? new Date(row.collectedAt as string).toISOString()
      : undefined,
    createdAt: new Date(row.createdAt as string).toISOString(),
    deletedAt: row.deletedAt
      ? new Date(row.deletedAt as string).toISOString()
      : null,
  } as Asset;
}
export class AssetsService {
  constructor(
    private readonly db: Database,
    private readonly netbox: NetBoxService,
  ) {}
  async create(customerId: string, input: CreateAsset): Promise<Asset> {
    if (this.netbox.enabled)
      throw new ConflictException(
        "NetBox模式下请在NetBox建档后同步，不能建立第二份本地主数据",
      );
    const result = await this.db.query(
      `INSERT INTO assets (id, customer_id, name, kind, source, source_ref, attributes) VALUES ($1,$2,$3,$4,'manual',$5,$6::jsonb) RETURNING ${columns}`,
      [
        randomUUID(),
        customerId,
        input.name,
        input.kind,
        input.sourceRef ?? null,
        JSON.stringify(input.attributes),
      ],
    );
    return serialize(result.rows[0]);
  }
  async updateLifecycle(customer: string, id: string, input: LifecycleAsset) {
    if (this.netbox.enabled)
      throw new ConflictException(
        "NetBox模式下请在NetBox维护生命周期资料后同步",
      );
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM customers WHERE id=$1 FOR UPDATE", [
        customer,
      ]);
      const { requireActiveAsset } = await import("./asset-state");
      await requireActiveAsset(tx, customer, id);
      for (const binding of [input.os, input.device])
        if (binding) {
          const found = await tx.query(
            "SELECT id FROM import_materials WHERE customer_id=$1 AND id=$2 AND format='lifecycle-csv-v1'",
            [customer, binding.batchId],
          );
          if (!found.rows.length)
            throw new NotFoundException("该客户下未找到生命周期批次");
        }
      const r = await tx.query(
        `UPDATE assets SET attributes=jsonb_set(attributes,'{lifecycle}',$3::jsonb) WHERE customer_id=$1 AND id=$2 RETURNING ${columns}`,
        [customer, id, JSON.stringify(input)],
      );
      return serialize(r.rows[0]);
    });
  }
  async summary(customerId: string): Promise<AssetSummary> {
    const result = await this.db.query(
      `SELECT count(*) FILTER (WHERE deleted_at IS NULL)::int AS active, count(*) FILTER (WHERE deleted_at IS NULL AND hardware_type='server')::int AS server, count(*) FILTER (WHERE deleted_at IS NULL AND hardware_type='network')::int AS network, count(*) FILTER (WHERE deleted_at IS NULL AND hardware_type='unknown')::int AS unclassified, count(*) FILTER (WHERE deleted_at IS NOT NULL)::int AS deleted FROM assets WHERE customer_id=$1`,
      [customerId],
    );
    return result.rows[0] as AssetSummary;
  }
  async list(
    customerId: string,
    limit: number,
    offset: number,
    status = "active",
    category?: string,
  ): Promise<AssetPage> {
    const result = await this.db.query(
      `SELECT ${columns} FROM assets WHERE customer_id=$1 AND (deleted_at IS NOT NULL)=$4 AND ($5::text IS NULL OR (${categoryExpression})=$5) ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,
      [customerId, limit, offset, status === "deleted", category ?? null],
    );
    const total = await this.db.query(
      `SELECT count(*)::int AS total FROM assets WHERE customer_id=$1 AND (deleted_at IS NOT NULL)=$2 AND ($3::text IS NULL OR (${categoryExpression})=$3)`,
      [customerId, status === "deleted", category ?? null],
    );
    return {
      items: result.rows.map(serialize),
      total: Number(total.rows[0].total),
      limit,
      offset,
    };
  }
  async get(customerId: string, id: string): Promise<Asset> {
    const result = await this.db.query(
      `SELECT ${columns} FROM assets WHERE customer_id=$1 AND id=$2`,
      [customerId, id],
    );
    if (!result.rows.length) throw new NotFoundException("该客户下未找到资产");
    return serialize(result.rows[0]);
  }
  async setDeleted(
    customer: string,
    id: string,
    actor: string,
    deleted: boolean,
  ) {
    return this.db.transaction(async (tx) => {
      await tx.query("SELECT id FROM customers WHERE id=$1 FOR UPDATE", [
        customer,
      ]);
      const asset = (
        await tx.query(
          "SELECT * FROM assets WHERE customer_id=$1 AND id=$2 FOR UPDATE",
          [customer, id],
        )
      ).rows[0];
      if (!asset) throw new NotFoundException("该客户下未找到资产");
      if (deleted) {
        const pending = await tx.query(
          `SELECT id FROM collection_jobs WHERE customer_id=$1 AND asset_id=$2 AND status IN ('queued','running') UNION ALL SELECT id FROM asset_baselines WHERE customer_id=$1 AND asset_id=$2 AND status IN ('pending','unknown') UNION ALL SELECT id FROM netbox_operations WHERE customer_id=$1 AND status IN ('pending','unknown') AND input#>>'{update,assetId}'=$2::text UNION ALL SELECT id FROM vulnerability_jobs WHERE customer_id=$1 AND status IN ('queued','running') AND (details#>>'{target,assetId}'=$2::text OR details#>>'{input,provenance,assetId}'=$2::text)`,
          [customer, id],
        );
        if (pending.rows.length)
          throw new ConflictException(
            "资产有执行中任务或待核对写回，请处理完成后删除",
          );
      }
      if (Boolean(asset.deleted_at) !== deleted) {
        await tx.query(
          "UPDATE assets SET deleted_at=CASE WHEN $3 THEN now() ELSE NULL END,deleted_by=CASE WHEN $3 THEN $4 ELSE NULL END WHERE customer_id=$1 AND id=$2",
          [customer, id, deleted, actor],
        );
        await tx.query(
          "INSERT INTO asset_audit(id,customer_id,asset_id,action,actor) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), customer, id, deleted ? "delete" : "restore", actor],
        );
      }
      return { id, deleted };
    });
  }
  async classify(customer: string, id: string, hardwareType: string) {
    const r = await this.db.query(
      "UPDATE assets SET hardware_type=$3 WHERE customer_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id",
      [customer, id, hardwareType],
    );
    if (!r.rows.length) throw new NotFoundException("未找到在管资产");
    return this.get(customer, id);
  }
}
