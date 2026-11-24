import type {
  LifecycleAsset,
  RiskConfig,
  RiskType,
  RiskItem,
  RiskLevel,
  RiskSummary,
} from "../../../../packages/contracts/lifecycle-risk";
export function localDate(now: Date, timeZone: string) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const part = (type: string) => p.find((v) => v.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}
export function addMonths(date: string, months: number) {
  const [y, m, d] = date.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}
export function riskLevel(
  due: string,
  today: string,
  rule: RiskItem["rule"],
): RiskLevel {
  if (due <= today) return "critical";
  if (today >= addMonths(due, -rule.warningMonths)) return "warning";
  if (today >= addMonths(due, -rule.reminderMonths)) return "reminder";
  return "normal";
}
export const isRisk = (level: RiskLevel) =>
  ["critical", "warning", "reminder"].includes(level);
export const ranks: Record<RiskLevel, number> = {
  critical: 0,
  warning: 1,
  reminder: 2,
  conflict: 3,
  missing: 4,
  unassessed: 5,
  normal: 6,
};
export function summarize(items: RiskItem[]): RiskSummary {
  const summary: RiskSummary = {
    riskAssets: 0,
    riskItems: 0,
    acceptedItems: 0,
    missing: 0,
    conflict: 0,
    unassessed: 0,
    byLevel: {
      critical: { assets: 0, items: 0 },
      warning: { assets: 0, items: 0 },
      reminder: { assets: 0, items: 0 },
    },
  };
  const assets = new Map<string, "critical" | "warning" | "reminder">();
  for (const i of items) {
    if (
      i.level === "missing" ||
      i.level === "conflict" ||
      i.level === "unassessed"
    )
      summary[i.level]++;
    if (!isRisk(i.level)) continue;
    const level = i.level as "critical" | "warning" | "reminder";
    summary.riskItems++;
    summary.byLevel[level].items++;
    if (i.treatment.status === "accepted") summary.acceptedItems++;
    const previous = assets.get(i.assetId);
    if (!previous || ranks[level] < ranks[previous])
      assets.set(i.assetId, level);
  }
  summary.riskAssets = assets.size;
  for (const level of assets.values()) summary.byLevel[level].assets++;
  return summary;
}

export function ruleFor(
  config: RiskConfig,
  type: RiskType,
  category: RiskItem["category"],
) {
  const override =
    config.overrides.find((o) => o.type === type && o.category === category) ??
    config.overrides.find((o) => o.type === type && o.category === "all");
  return {
    rule: override?.rule ?? config.defaultRule,
    source: override ? `${override.category} / ${type}` : "客户默认",
  };
}

export function riskCategoryFor(category: string): RiskItem["category"] {
  return category === "server"
    ? "server"
    : category === "network"
      ? "network"
      : "unknown";
}
export function deadlineLevel(
  dueDate: string | null | undefined,
  today: string,
  rule: RiskItem["rule"],
  conflict = false,
): RiskLevel {
  return !rule.enabled
    ? "unassessed"
    : conflict
      ? "conflict"
      : dueDate
        ? riskLevel(dueDate, today, rule)
        : "missing";
}
export function assetDateDeadline(
  type: "warranty" | "service_age",
  data: Partial<LifecycleAsset>,
  config: RiskConfig,
  category: RiskItem["category"],
) {
  return type === "warranty"
    ? (data.warrantyUntil ?? null)
    : data.purchasedOn && config.serviceYears[category]
      ? addMonths(data.purchasedOn, config.serviceYears[category]! * 12)
      : null;
}
