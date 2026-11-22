import type { Assessment } from "../../../../packages/contracts/assessments";
import type { Database } from "../persistence/database";
import { linuxInput } from "./linux-input";

/** Historical enrichment reads only the exact, hash-bound snapshot, never the live host. */
export async function assessmentRuntime(
  db: Database,
  customer: string,
  target: Assessment["target"],
  input: Assessment["input"],
) {
  if (input.runtime || target.kind !== "linux" || !input.snapshotHash)
    return input.runtime;
  const rows = await db.query(
    "SELECT id,asset_id,entry,normalized,content_hash FROM collection_snapshots WHERE customer_id=$1 AND id=$2 AND asset_id=$3 AND content_hash=$4",
    [customer, target.snapshotId, target.assetId, input.snapshotHash],
  );
  if (!rows.rows.length) return undefined;
  try {
    return linuxInput(rows.rows[0], target.assetId).runtime;
  } catch {
    return undefined;
  }
}
