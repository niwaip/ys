import { NetBoxService } from "../netbox/netbox.module";
import { randomUUID } from "node:crypto";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type {
  Asset,
  AssetPage,
  CreateAsset,
} from "../../../../packages/contracts";
import type { Database } from "../persistence/database";
const columns = `id, customer_id AS "customerId", name, kind, source, source_ref AS "sourceRef", attributes, import_id AS "importId", collected_at AS "collectedAt", created_at AS "createdAt"`;
function serialize(row: Record<string, unknown>): Asset {
  return {
    ...row,
    sourceRef: row.sourceRef ?? undefined,
    importId: row.importId ?? undefined,
    collectedAt: row.collectedAt
      ? new Date(row.collectedAt as string).toISOString()
      : undefined,
    createdAt: new Date(row.createdAt as string).toISOString(),
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
  async list(
    customerId: string,
    limit: number,
    offset: number,
  ): Promise<AssetPage> {
    const result = await this.db.query(
      `SELECT ${columns} FROM assets WHERE customer_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3`,
      [customerId, limit, offset],
    );
    const total = await this.db.query(
      "SELECT count(*)::int AS total FROM assets WHERE customer_id=$1",
      [customerId],
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
}
