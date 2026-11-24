import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Queryable } from "../persistence/database";
/** Call inside the same transaction as each new asset write. */
export async function requireActiveAsset(
  db: Queryable,
  customer: string,
  id: string,
) {
  const row = (
    await db.query(
      "SELECT id,deleted_at FROM assets WHERE customer_id=$1 AND id=$2 FOR UPDATE",
      [customer, id],
    )
  ).rows[0];
  if (!row) throw new NotFoundException("该客户下未找到资产");
  if (row.deleted_at) throw new ConflictException("资产已删除，请先恢复纳管");
}
