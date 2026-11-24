import { z } from "zod";
export const createAssetSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    kind: z.literal("host"),
    sourceRef: z.string().trim().max(500).optional(),
    attributes: z.record(z.string(), z.json()).default({}),
  })
  .strict();
export type CreateAsset = z.infer<typeof createAssetSchema>;
export type Asset = CreateAsset & {
  id: string;
  customerId: string;
  source: string;
  importId?: string;
  collectedAt?: string | null;
  createdAt: string;
  deletedAt?: string | null;
  deletedBy?: string | null;
  hardwareType?: "unknown" | "server" | "network";
};
export type Customer = { id: string; name: string };
export type AssetSummary = {
  active: number;
  server: number;
  network: number;
  unclassified: number;
  deleted: number;
};
export type AssetPage = {
  items: Asset[];
  total: number;
  limit: number;
  offset: number;
};

export type ImportRow = {
  row: number;
  status: "ready" | "invalid" | "duplicate" | "imported";
  issues: string[];
  mapped?: {
    name: string;
    kind: string;
    source: string;
    sourceRef: string;
    collectedAt: string | null;
    attributes: Record<string, string>;
  };
  assetId?: string;
  componentId?: string;
};
export type ImportMaterial = {
  id: string;
  customerId: string;
  format: "csv" | "cyclonedx-json" | "container-cyclonedx-json";
  fileName: string;
  contentHash: string;
  content?: string;
  importedAt: string;
  committedAt?: string;
  status: "preview" | "committed";
  policy: "atomic";
  canCommit: boolean;
  mapping: Record<string, string>;
  rows: ImportRow[];
};
