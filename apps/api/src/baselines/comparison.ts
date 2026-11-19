import {
  hardwareSummary,
  networkSummary,
} from "../../../../packages/contracts/collection-display";
import { ConflictException } from "@nestjs/common";
export type Values = Record<string, unknown>;
export type Change = {
  key: string;
  kind: "added" | "removed" | "changed";
  before?: unknown;
  after?: unknown;
};
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
function records(name: string, data: unknown): Map<string, unknown> {
  if (!Array.isArray(data))
    return new Map(Object.entries((data ?? {}) as Values));
  const result = new Map<string, unknown>();
  for (const item of data) {
    const v = item as Values;
    const key =
      name === "packages"
        ? JSON.stringify([v.manager, v.name, v.architecture])
        : name === "network"
          ? String(v.ifname)
          : name === "containers"
            ? String(v.containerId)
            : name === "images"
              ? JSON.stringify([v.imageId, v.repository, v.tag, v.digest])
              : canonical(item);
    if (result.has(key))
      throw new ConflictException("资料存在重复条目身份，不能可靠比较或采纳");
    result.set(key, item);
  }
  return result;
}
export function compare(
  name: string,
  before: unknown,
  after: unknown,
): Change[] {
  if (name === "hardware") {
    before = before == null ? undefined : hardwareSummary(before);
    after = hardwareSummary(after);
  }
  if (name === "network") {
    before = networkSummary(before);
    after = networkSummary(after);
  }
  const old = records(name, before),
    next = records(name, adopt(name, before, after, {}, "comparison").value),
    changes: Change[] = [];
  for (const [key, value] of next) {
    if (value == null) continue;
    if (!old.has(key)) changes.push({ key, kind: "added", after: value });
    else if (canonical(old.get(key)) !== canonical(value))
      changes.push({
        key,
        kind: "changed",
        before: old.get(key),
        after: value,
      });
  }
  // Null or absent object fields mean unknown, never deletion. Complete list absence is deletion.
  if (Array.isArray(after))
    for (const [key, value] of old)
      if (!next.has(key)) changes.push({ key, kind: "removed", before: value });
  return changes;
}
export function adopt(
  name: string,
  old: unknown,
  next: unknown,
  prior: unknown,
  snapshotId: string,
): { value: unknown; sources: unknown } {
  if (next == null) return { value: old ?? null, sources: prior ?? null };
  if (Array.isArray(next)) {
    const before = records(name, old),
      after = records(name, next),
      value: unknown[] = [],
      sources: Values = {};
    for (const [key, item] of after) {
      const merged = adopt(
        "",
        before.get(key),
        item,
        (prior as Values | undefined)?.[key],
        snapshotId,
      );
      value.push(merged.value);
      Object.defineProperty(sources, key, {
        value: merged.sources,
        enumerable: true,
      });
    }
    return { value, sources };
  }
  if (typeof next !== "object") return { value: next, sources: snapshotId };
  const value = {
      ...((old && typeof old === "object" && !Array.isArray(old)
        ? old
        : {}) as Values),
    },
    sources = {
      ...((prior && typeof prior === "object" ? prior : {}) as Values),
    };
  for (const [key, item] of Object.entries(next)) {
    const merged = adopt("", value[key], item, sources[key], snapshotId);
    Object.defineProperty(value, key, {
      value: merged.value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(sources, key, {
      value: merged.sources,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return { value, sources };
}
