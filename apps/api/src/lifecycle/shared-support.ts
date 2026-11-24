import type { Queryable } from "../persistence/database";
import type { LifecycleRow } from "../../../../packages/contracts/lifecycle";
import type {
  SupportReference,
  OsIdentity,
} from "../../../../packages/contracts/lifecycle-workspace";
import { supportBindingSchema } from "../../../../packages/contracts/lifecycle-risk";
const object = (value: unknown): Record<string, any> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
const text = (value: unknown) =>
  typeof value === "string" ? value.trim() : "";
export async function sharedSupport(db: Queryable, customer: string) {
  const aliases = (
    await db.query(
      "SELECT category,alias,product,basis FROM lifecycle_product_aliases WHERE customer_id=$1",
      [customer],
    )
  ).rows;
  function canonical(kind: string, product: string) {
    const mappings = aliases.filter(
      (a) => a.category === kind && a.alias === product,
    );
    const targets = [...new Set(mappings.map((a) => String(a.product)))];
    return {
      product: targets.length === 1 ? targets[0] : product,
      conflict: targets.length > 1,
      basis: mappings.map((a) => String(a.basis)).join("；"),
    };
  }
  const batches = (
    await db.query(
      "SELECT id,result FROM import_materials WHERE customer_id=$1 AND format='lifecycle-csv-v1' ORDER BY imported_at DESC,id",
      [customer],
    )
  ).rows;
  const rows = batches.flatMap((batch) =>
    (batch.result as { rows: LifecycleRow[] }).rows.map((row) => ({
      row,
      batchId: String(batch.id),
    })),
  );
  const baselines = (
    await db.query(
      "SELECT DISTINCT ON(asset_id) asset_id,id,snapshot_id,actor,created_at,plan FROM asset_baselines WHERE customer_id=$1 AND status='confirmed' ORDER BY asset_id,sequence DESC",
      [customer],
    )
  ).rows;
  const software = (
    await db.query(
      "SELECT l.asset_id,s.id AS software_id,s.name,v.version FROM asset_version_links l JOIN software_objects s ON s.customer_id=l.customer_id AND s.id=(l.details->>'objectId')::uuid JOIN software_versions v ON v.customer_id=s.customer_id AND v.software_id=s.id AND v.id=(l.details->>'versionId')::uuid WHERE l.customer_id=$1 AND l.details->>'kind'='software' ORDER BY l.created_at DESC,l.id DESC",
      [customer],
    )
  ).rows;
  const values = new Map(
    baselines.map((b) => [String(b.asset_id), object(object(b.plan).values)]),
  );
  function resolve(
    kind: SupportReference["kind"],
    product: string,
    version: string,
    binding?: unknown,
  ): SupportReference {
    const explicit = supportBindingSchema.safeParse(binding);
    if (binding !== undefined && !explicit.success)
      return {
        kind,
        product,
        version,
        status: "conflict",
        basis: "支持关联或扩展支持适用依据无效，请核对",
      };
    const target = explicit.success ? explicit.data : undefined;
    const mapping = canonical(kind, target?.product ?? product);
    const p = mapping.product,
      v = target?.version ?? version;
    const allCandidates = rows.filter(({ row, batchId }) =>
      target
        ? batchId === target.batchId &&
          canonical(kind, row.product).product === p &&
          (row.version ?? "") === v &&
          (!row.extensions.phase || row.extensions.phase === target.phase) &&
          (!row.extensions.category ||
            row.extensions.category === kind ||
            (kind === "device" && row.extensions.category === "hardware"))
        : row.extensions.category === kind &&
          canonical(kind, row.product).product === p &&
          (row.version ?? "") === v &&
          ["eos", "eol"].includes(row.extensions.phase),
    );
    const tier = target?.supportTier ?? "standard";
    const candidates = allCandidates.filter(
      ({ row }) => (row.extensions.supportTier || "standard") === tier,
    );
    const stages = allCandidates.map(({ row, batchId }) => {
      const phase = target?.phase ?? (row.extensions.phase as "eos" | "eol");
      return {
        supportTier: row.extensions.supportTier || "standard",
        date: row[phase].date,
        stage: row[phase].name,
        source: row.source,
        sourceRef: row.sourceRef,
        batchId,
        row: row.row,
      };
    });
    const standard = stages.filter((s) => s.supportTier === "standard");
    const base = {
      supportTier: tier,
      entitlement: target?.entitlement,
      stages,
      standardDate: standard.length === 1 ? standard[0].date : null,
      kind,
      product: p,
      rawProduct: product,
      mappingBasis: mapping.basis || undefined,
      version: v,
    };
    if (
      mapping.conflict ||
      allCandidates.some(({ row }) => canonical(kind, row.product).conflict)
    )
      return {
        ...base,
        status: "conflict",
        basis: "产品别名映射有歧义，请核对明确配置",
      };
    if (!p || (!v && (!target || kind === "os" || kind === "software")))
      return {
        ...base,
        status: "missing",
        basis: "缺少明确产品/型号或版本，不能自动推断",
      };
    if (!candidates.length)
      return {
        ...base,
        status: "unmatched",
        basis: "未找到精确产品版本及明确阶段的厂商资料",
      };
    if (candidates.length !== 1)
      return {
        ...base,
        status: "conflict",
        basis: "匹配多个来源或版本记录，请明确选择来源批次与阶段",
      };
    const { row, batchId } = candidates[0],
      phase = target?.phase ?? (row.extensions.phase as "eos" | "eol"),
      stage = row[phase];
    return {
      ...base,
      status: "matched",
      batchId,
      row: row.row,
      phase,
      date: stage.date,
      rawDate: stage.rawDate,
      stage: stage.name,
      source: row.source,
      sourceRef: row.sourceRef,
      basis:
        (mapping.basis
          ? `产品别名 ${product} → ${p}；${mapping.basis}；`
          : "") +
        (target
          ? "明确选择来源批次、产品版本及阶段"
          : "唯一精确产品版本及明确阶段，自动引用") +
        (tier === "extended"
          ? `；扩展支持适用依据：${target?.entitlement}`
          : "；采用标准支持（旧资料保留原始阶段，不推断缩写含义）"),
    };
  }
  function osIdentity(id: string, attributes: unknown): OsIdentity {
    const a = object(attributes),
      b = baselines.find((b) => String(b.asset_id) === id),
      plan = object(b?.plan),
      os = object(object(plan.values).os),
      platform = object(a.platform);
    const confirmed =
      text(os.id) || text(os.name)
        ? {
            product: text(os.id) || text(os.name),
            version: text(os.version),
            source: "已确认采集基线",
            at: b?.created_at
              ? new Date(String(b.created_at)).toISOString()
              : null,
            snapshotId: String(b?.snapshot_id),
            baselineId: String(b?.id),
            actor: String(b?.actor),
            sources: object(object(plan.sources).os),
          }
        : null;
    const registered = text(platform.name)
      ? {
          product: text(platform.name),
          version: text(platform.version),
          source: "NetBox登记平台",
          at: text(object(a.netbox).syncedAt) || null,
        }
      : null;
    const status =
      registered && confirmed
        ? canonical("os", registered.product).product ===
            canonical("os", confirmed.product).product &&
          !canonical("os", registered.product).conflict &&
          !canonical("os", confirmed.product).conflict &&
          (!registered.version || registered.version === confirmed.version)
          ? "consistent"
          : "conflict"
        : confirmed
          ? "platform_missing"
          : registered
            ? "confirmed_missing"
            : "missing";
    return { platform: registered, confirmed, status };
  }
  return {
    resolve,
    osIdentity,
    forAsset(id: string, attributes: unknown) {
      const a = object(attributes),
        baseline = values.get(id) ?? {},
        os = object(baseline.os),
        device = object(baseline.device),
        lifecycle = object(a.lifecycle),
        platform = object(a.platform),
        deviceType = object(a.deviceType);
      const osProduct =
          (Object.keys(os).length ? text(os.id) || text(os.name) : "") ||
          text(object(a.os).id) ||
          text(a.osProduct) ||
          text(platform.name),
        osVersion = Object.keys(os).length
          ? text(os.version)
          : text(object(a.os).version) || text(a.osVersion);
      const product =
          text(a.product) || text(device.model) || text(deviceType.model),
        version = text(a.version) || text(device.firmware);
      const refs = [resolve("device", product, version, lifecycle.device)];
      if (osProduct || lifecycle.os) {
        const identity = osIdentity(id, a);
        refs.push(
          identity.status === "conflict"
            ? {
                kind: "os",
                product: osProduct,
                version: osVersion,
                status: "conflict",
                basis: "NetBox登记平台与已确认OS不一致，待核对；不回写登记平台",
              }
            : resolve("os", osProduct, osVersion, lifecycle.os),
        );
      }
      if (!lifecycle.device) {
        const hardware = resolve("hardware", product, version);
        if (hardware.status === "matched" || hardware.status === "conflict")
          refs[0] =
            refs[0].status === "matched" || refs[0].status === "conflict"
              ? {
                  ...refs[0],
                  status: "conflict",
                  date: undefined,
                  basis: "设备与硬件分类存在多个适用来源，请明确选择批次和阶段",
                }
              : hardware;
      }
      const seen = new Set<string>();
      for (const linked of software.filter(
        (row) => String(row.asset_id) === id,
      )) {
        const key = String(linked.software_id);
        if (!seen.has(key)) {
          seen.add(key);
          const ref = resolve(
            "software",
            String(linked.name),
            text(linked.version),
          );
          ref.basis = "资产明确关联的软件输入版本；" + ref.basis;
          refs.push(ref);
        }
      }
      return refs;
    },
  };
}
