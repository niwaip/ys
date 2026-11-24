import { z } from "zod";
import { deviceCategory, type DeviceCategory } from "./device-collection";
import type { RiskLevel, LifecycleAsset } from "./lifecycle-risk";
export const lifecycleWorkspaceQuery = z
  .object({
    category: deviceCategory.optional(),
    state: z.enum(["empty", "partial", "complete"]).optional(),
    missing: z
      .enum([
        "purchasedOn",
        "warrantyUntil",
        "support",
        "unmatched",
        "conflict",
      ])
      .optional(),
    q: z.string().trim().max(200).default(""),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).max(1000000).default(0),
  })
  .strict();
export type SupportReference = {
  kind: "os" | "device" | "hardware" | "software";
  product: string;
  rawProduct?: string;
  mappingBasis?: string;
  version: string;
  status: "matched" | "unmatched" | "conflict" | "missing";
  batchId?: string;
  row?: number;
  phase?: "eos" | "eol";
  date?: string | null;
  rawDate?: string;
  source?: string;
  sourceRef?: string;
  stage?: string;
  riskLevel?: RiskLevel;
  basis: string;
  supportTier?: "standard" | "extended";
  entitlement?: string;
  standardDate?: string | null;
  standardStatus?: "matched" | "missing" | "conflict";
  stages?: {
    supportTier: string;
    date: string | null;
    stage: string;
    source: string;
    sourceRef: string;
    batchId: string;
    row: number;
  }[];
};
export type LifecycleWorkspaceItem = {
  id: string;
  name: string;
  category: DeviceCategory;
  source: string;
  osIdentity: OsIdentity;
  applicability: ReturnType<typeof lifecycleApplicability>;
  data: Partial<LifecycleAsset>;
  state: "empty" | "partial" | "complete";
  support: SupportReference[];
  dateRisks: {
    type: "warranty" | "service_age";
    dueDate: string | null;
    level: RiskLevel;
  }[];
  issues: string[];
};
export type LifecycleWorkspace = {
  items: LifecycleWorkspaceItem[];
  total: number;
  limit: number;
  offset: number;
  summary: {
    riskAssets: number;
    expiredAssets: number;
    total: number;
    empty: number;
    partial: number;
    complete: number;
    unmatched: number;
    conflict: number;
  };
};

export function lifecycleApplicability(category: DeviceCategory) {
  return {
    os: !["storage", "power"].includes(category),
    device: category !== "vm",
    purchasedOn: category !== "vm",
    warrantyUntil: category !== "vm",
  };
}

export type OsIdentity = {
  platform: {
    product: string;
    version: string;
    source: string;
    at: string | null;
  } | null;
  confirmed: {
    product: string;
    version: string;
    source: string;
    at: string | null;
    snapshotId: string;
    baselineId: string;
    actor: string;
    sources: Record<string, unknown>;
  } | null;
  status:
    | "platform_missing"
    | "confirmed_missing"
    | "consistent"
    | "conflict"
    | "missing";
};

export const productAliasSchema = z
  .object({
    category: z.enum(["os", "device", "hardware", "software"]),
    alias: z.string().trim().min(1).max(500),
    product: z.string().trim().min(1).max(500),
    basis: z.string().trim().min(1).max(1000),
  })
  .strict();
export type ProductAlias = z.infer<typeof productAliasSchema> & {
  id: string;
  actor: string;
  createdAt: string;
};
