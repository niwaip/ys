import { z } from "zod";
import { deviceCategory, type DeviceCategory } from "./device-collection";
import type { LifecycleAsset } from "./lifecycle-risk";
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
  version: string;
  status: "matched" | "unmatched" | "conflict" | "missing";
  batchId?: string;
  row?: number;
  phase?: "eos" | "eol";
  date?: string | null;
  source?: string;
  sourceRef?: string;
  stage?: string;
  basis: string;
};
export type LifecycleWorkspaceItem = {
  id: string;
  name: string;
  category: DeviceCategory;
  source: string;
  data: Partial<LifecycleAsset>;
  state: "empty" | "partial" | "complete";
  support: SupportReference[];
  issues: string[];
};
export type LifecycleWorkspace = {
  items: LifecycleWorkspaceItem[];
  total: number;
  limit: number;
  offset: number;
  summary: {
    total: number;
    empty: number;
    partial: number;
    complete: number;
    unmatched: number;
    conflict: number;
  };
};
