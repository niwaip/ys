import { z } from "zod";

const observation = <T extends z.ZodType>(data: T) =>
  z
    .object({
      status: z.enum([
        "acquired",
        "not_collected",
        "unsupported",
        "permission_denied",
        "failed",
      ]),
      data: data.nullable(),
      issues: z.array(z.string().max(1000)).max(20).default([]),
    })
    .strict();
export const runtimeObservationsSchema = z
  .object({
    virtualization: observation(z.string().trim().min(1).max(100)).optional(),
    xenNetback: observation(z.boolean()).optional(),
    listeningPorts: observation(z.string().max(16000)).optional(),
  })
  .strict();
export type RuntimeContext = z.infer<typeof runtimeObservationsSchema> & {
  origin?: string | null;
  kernel: string | null;
  collectedAt: string | null;
};
export type ApplicabilityConclusion = {
  status: "unknown" | "conditions_not_met";
  reason: string;
  rule: string;
  observedAt: string | null;
  sourceUrl?: string;
};
export type FindingEvidence = {
  sourcePackage: string | null;
  sourceVersion: string | null;
  scannerStatus: string | null;
  source: { name: string; url: string | null } | null;
  title: string | null;
  description: string | null;
  basis: string;
  applicability: ApplicabilityConclusion;
  runtime: RuntimeContext | null;
  reference: Record<string, unknown>;
};
/** Opaque selection key: component, package, version, ecosystem, target, unresolved record. */
export const componentIdentitySchema = z.tuple([
  z.string().nullable(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string().nullable(),
]);
export type ComponentFindingGroup = {
  key: string;
  componentId: string | null;
  packageName: string;
  installedVersion: string;
  ecosystem: string;
  target: string;
  records: number;
  uniqueCves: number;
};
