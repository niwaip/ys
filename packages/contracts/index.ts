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
  source: "manual";
  createdAt: string;
};
export type Customer = { id: string; name: string };
export type AssetPage = {
  items: Asset[];
  total: number;
  limit: number;
  offset: number;
};
