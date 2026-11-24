import { freshness } from "./freshness";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type { AssetVersionLink } from "../../../../packages/contracts/collections";
import type { ContainerSource } from "../../../../packages/contracts/container-runtime";
import type {
  ReportHost,
  ReportLinkedObject,
  ReportBinding,
  ReportTaskInput,
} from "../../../../packages/contracts/report-center";
import type { Database } from "../persistence/database";

type Link = {
  kind: "software" | "container";
  objectId: string;
  versionId: string;
  createdAt: string;
  binding: ReportBinding;
};
export async function linkedScope(
  db: Database,
  customer: string,
  hosts: ReportHost[],
  overrides: ReportTaskInput["overrides"],
  checkedAt: string,
  freshnessDays: number,
): Promise<ReportLinkedObject[]> {
  const hostIds = hosts.map((host) => host.assetId);
  const links: Link[] = (
    await db.query(
      "SELECT details FROM asset_version_links WHERE customer_id=$1 AND asset_id=ANY($2::uuid[]) ORDER BY created_at DESC,id DESC",
      [customer, hostIds],
    )
  ).rows.map((row) => {
    const link = row.details as AssetVersionLink;
    return {
      kind: link.kind,
      objectId: link.objectId,
      versionId: link.versionId,
      createdAt: link.createdAt,
      binding: {
        id: link.id,
        assetId: link.assetId,
        snapshotId: link.snapshot.id,
        basis: link.basis,
        contentHash: link.contentHash,
        observedAt: link.snapshot.collectedAt,
        coverage: "操作员明确声明关联；资料不证明运行适用性",
        imageId: link.imageIdentity?.imageId,
        digest: link.imageIdentity?.digest,
      },
    };
  });
  for (const row of (
    await db.query(
      "SELECT details FROM container_sources WHERE customer_id=$1 AND asset_id=ANY($2::uuid[]) ORDER BY created_at DESC,id DESC",
      [customer, hostIds],
    )
  ).rows) {
    const source = row.details as ContainerSource;
    links.push({
      kind: "container",
      objectId: source.containerId,
      versionId: source.versionId,
      createdAt: source.createdAt,
      binding: {
        id: source.id,
        assetId: source.assetId!,
        snapshotId: source.snapshotId,
        basis: source.basis,
        contentHash: source.contentHash,
        observedAt: source.generatedAt,
        coverage: source.coverage,
        imageId: source.imageId,
      },
    });
  }
  links.sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.binding.id.localeCompare(a.binding.id),
  );
  const latest = new Set<string>(),
    objects = new Map<string, ReportLinkedObject>();
  for (const link of links) {
    const slot = `${link.binding.assetId}:${link.kind}:${link.objectId}`;
    if (latest.has(slot)) continue;
    latest.add(slot);
    const key = `${link.kind}:${link.objectId}:${link.versionId}`;
    let object = objects.get(key);
    if (!object) {
      object = {
        key,
        kind: link.kind,
        objectId: link.objectId,
        versionId: link.versionId,
        name: link.objectId,
        hostIds: [],
        bindings: [],
        assessmentId: null,
        lifecycleRefs: [],
        status: "unassessed",
        issues: [],
      };
      objects.set(key, object);
    }
    object.hostIds.push(link.binding.assetId);
    object.bindings.push(link.binding);
  }
  for (const object of objects.values()) {
    const table =
      object.kind === "software" ? "software_objects" : "container_images";
    const row = (
      await db.query(
        `SELECT name FROM ${table} WHERE customer_id=$1 AND id=$2`,
        [customer, object.objectId],
      )
    ).rows[0];
    if (!row) throw new NotFoundException("已关联的软件或镜像资料不可读取");
    object.name = String(row.name);
    const override = overrides.find(
      (item) =>
        item.objectId === object.objectId &&
        (!item.versionId || item.versionId === object.versionId),
    );
    const job = (
      await db.query(
        `SELECT id,status,target_input_id,details->>'finishedAt' AS finished,details->>'error' AS error FROM vulnerability_jobs WHERE customer_id=$1 AND target_object_id=$2 AND details#>>'{target,kind}'=$3 AND ($4::uuid IS NULL OR id=$4) AND ($4::uuid IS NOT NULL OR (target_input_id=$5 AND status='succeeded')) ORDER BY created_at DESC,id DESC LIMIT 1`,
        [
          customer,
          object.objectId,
          object.kind,
          override?.assessmentId ?? null,
          object.versionId,
        ],
      )
    ).rows[0];
    if (override && !job)
      throw new NotFoundException("该客户关联对象下未找到所选评估");
    if (job) {
      if (job.target_input_id !== object.versionId)
        throw new ConflictException(
          "所选评估不属于明确关联的资料版本；不能推断其他版本已部署",
        );
      if (job.status === "queued" || job.status === "running")
        throw new ConflictException("关联对象评估仍在执行");
      object.assessmentId = String(job.id);
      object.status = job.status === "succeeded" ? "available" : "unassessed";
    }
    const versionTable =
      object.kind === "software" ? "software_versions" : "container_versions";
    const metadata = (
      await db.query(
        `SELECT details->>'collectedAt' AS collected FROM ${versionTable} WHERE customer_id=$1 AND id=$2`,
        [customer, object.versionId],
      )
    ).rows[0];
    object.collectedAt =
      typeof metadata?.collected === "string" ? metadata.collected : null;
    object.assessedAt = typeof job?.finished === "string" ? job.finished : null;
    object.freshness = {
      collection: freshness(object.collectedAt, checkedAt, freshnessDays),
      assessment:
        job?.status === "succeeded"
          ? freshness(object.assessedAt, checkedAt, freshnessDays)
          : "missing",
    };
    if (object.freshness.collection === "stale")
      object.issues.push(
        `关联资料超过 ${freshnessDays} 天，重新评估不会刷新采集日期`,
      );
    if (object.freshness.assessment === "stale")
      object.issues.push(`关联版本漏洞评估超过 ${freshnessDays} 天`);
    if (!job || job.status !== "succeeded")
      object.issues.push("未取得明确关联版本的可用漏洞结果，不代表零风险");
    const recent = (
      await db.query(
        "SELECT status,details->>'error' AS error FROM vulnerability_jobs WHERE customer_id=$1 AND target_object_id=$2 AND target_input_id=$3 ORDER BY created_at DESC,id DESC LIMIT 1",
        [customer, object.objectId, object.versionId],
      )
    ).rows[0];
    if (recent && recent.status !== "succeeded")
      object.issues.push(
        `最近评估 ${String(recent.status)}：${String(recent.error ?? "未完成")}`,
      );
    if (object.kind === "software") {
      const life = (
        await db.query(
          "SELECT id FROM lifecycle_assessments WHERE customer_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(result->'items') item WHERE item->>'assetId'=$2 AND item->>'versionId'=$3 AND item->>'kind'='software') ORDER BY evaluated_at DESC,id DESC LIMIT 1",
          [customer, object.objectId, object.versionId],
        )
      ).rows[0];
      if (life) object.lifecycleRefs.push(String(life.id));
    }
  }
  return [...objects.values()];
}
