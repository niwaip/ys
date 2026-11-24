import { z } from "zod";
export const riskTypes = [
  "os_support",
  "device_support",
  "warranty",
  "service_age",
] as const;
export type RiskType = (typeof riskTypes)[number];
export const riskTypeLabels: Record<RiskType, string> = {
  os_support: "OS 停止支持",
  device_support: "设备停止支持",
  warranty: "维保到期",
  service_age: "使用年限",
};
export const levelLabels = {
  critical: "致命",
  warning: "警告",
  reminder: "提醒",
  normal: "正常",
  missing: "待补资料",
  conflict: "资料冲突",
  unassessed: "不评估",
};
export type RiskLevel = keyof typeof levelLabels;
export const handlingLabels = {
  pending: "待处理",
  in_progress: "处理中",
  accepted: "已接受风险",
};
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (s) =>
      Number.isFinite(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
    "日期无效",
  );
export const supportBindingSchema = z
  .object({
    batchId: z.uuid(),
    product: z.string().trim().min(1).max(500),
    version: z.string().trim().max(500),
    phase: z.enum(["eos", "eol"]),
    supportTier: z.enum(["standard", "extended"]).optional(),
    entitlement: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine(
    (v) => v.supportTier !== "extended" || !!v.entitlement,
    "扩展支持须填写明确适用依据",
  );
export const lifecycleAssetSchema = z
  .object({
    os: supportBindingSchema.optional(),
    device: supportBindingSchema.optional(),
    purchasedOn: dateSchema.optional(),
    warrantyUntil: dateSchema.optional(),
    sourceRef: z.string().trim().max(500).default(""),
  })
  .strict();
export type LifecycleAsset = z.infer<typeof lifecycleAssetSchema>;
const rule = z
  .object({
    enabled: z.boolean(),
    reminderMonths: z.number().int().min(1).max(120),
    warningMonths: z.number().int().min(0).max(120),
  })
  .strict()
  .refine(
    (x) => x.reminderMonths > x.warningMonths,
    "提醒阈值必须大于警告阈值",
  );
export const riskConfigSchema = z
  .object({
    timeZone: z
      .string()
      .max(100)
      .refine((s) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: s });
          return true;
        } catch {
          return false;
        }
      }, "时区无效"),
    defaultRule: rule,
    overrides: z
      .array(
        z
          .object({
            type: z.enum(riskTypes),
            category: z.enum(["all", "server", "network", "unknown"]),
            rule,
          })
          .strict(),
      )
      .max(40),
    serviceYears: z
      .object({
        server: z.number().int().min(1).max(100).nullable(),
        network: z.number().int().min(1).max(100).nullable(),
        unknown: z.number().int().min(1).max(100).nullable(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (x) =>
      new Set(x.overrides.map((o) => `${o.type}:${o.category}`)).size ===
      x.overrides.length,
    "不能重复配置同类规则",
  );
export type RiskConfig = z.infer<typeof riskConfigSchema>;
export const defaultRiskConfig: RiskConfig = {
  timeZone: "Asia/Shanghai",
  defaultRule: { enabled: true, reminderMonths: 12, warningMonths: 6 },
  overrides: [],
  serviceYears: { server: null, network: null, unknown: null },
};
export const treatmentSchema = z
  .object({
    status: z.enum(["pending", "in_progress", "accepted"]),
    owner: z.string().trim().max(200),
    note: z.string().trim().max(2000),
    acceptedUntil: dateSchema.nullable(),
  })
  .strict()
  .refine(
    (x) => x.status !== "accepted" || (!!x.note && !!x.acceptedUntil),
    "接受风险需填写原因和有效期",
  );
export type Treatment = z.infer<typeof treatmentSchema>;
export type RiskEvent = Treatment & {
  at: string;
  actor: string;
  action: string;
};
export type RiskItem = {
  id: string;
  assetId: string;
  assetName: string;
  category: "server" | "network" | "unknown";
  type: RiskType;
  level: RiskLevel;
  dueDate: string | null;
  daysRemaining: number | null;
  basis: string;
  rule: RiskConfig["defaultRule"];
  ruleSource: string;
  evidence: {
    source: string;
    sourceRef: string;
    stage: string;
    rawDate: string;
    batchId?: string;
    row?: number;
  }[];
  treatment: Treatment;
  history: RiskEvent[];
};
export type RiskSummary = {
  riskAssets: number;
  riskItems: number;
  acceptedItems: number;
  missing: number;
  conflict: number;
  unassessed: number;
  byLevel: Record<
    "critical" | "warning" | "reminder",
    { assets: number; items: number }
  >;
};
export type RiskView = {
  id: string;
  customerId: string;
  calculatedAt: string;
  localDate: string;
  config: RiskConfig;
  items: RiskItem[];
  summary: RiskSummary;
};

export type LifecycleRiskOverview = Pick<
  RiskView,
  "id" | "calculatedAt" | "summary"
> & { pendingItems: number };

/** Read independent known fields without discarding valid dates because a different source field is invalid. */
export function readLifecycleAsset(value: unknown): {
  data: Partial<LifecycleAsset>;
  issues: string[];
  hasValues: boolean;
} {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const data: Partial<LifecycleAsset> = {},
    issues: string[] = [];
  for (const key of ["purchasedOn", "warrantyUntil"] as const) {
    if (raw[key] === undefined || raw[key] === "") continue;
    const parsed = dateSchema.safeParse(raw[key]);
    if (parsed.success) data[key] = parsed.data;
    else issues.push(`${key}日期无效，请核对来源`);
  }
  for (const key of ["os", "device"] as const) {
    if (raw[key] === undefined) continue;
    const parsed = supportBindingSchema.safeParse(raw[key]);
    if (parsed.success) data[key] = parsed.data;
    else issues.push(`${key}支持资料关联无效`);
  }
  if (typeof raw.sourceRef === "string") data.sourceRef = raw.sourceRef;
  return {
    data,
    issues,
    hasValues: ["purchasedOn", "warrantyUntil", "os", "device"].some(
      (key) => raw[key] !== undefined && raw[key] !== null && raw[key] !== "",
    ),
  };
}
