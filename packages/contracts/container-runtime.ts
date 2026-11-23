import { z } from "zod";
export const imageIdSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const generatedImageSchema = z
  .object({
    schemaVersion: z.literal("ys-image/1"),
    host: z
      .object({
        hostname: z.string().min(1).max(255),
        machineId: z.string().nullable(),
        serial: z.string().nullable(),
      })
      .strict(),
    image: z
      .object({
        imageId: imageIdSchema,
        architecture: z.string().nullable(),
        os: z.string().nullable(),
        repoTags: z.array(z.string().max(500)).max(1000),
        repoDigests: z.array(z.string().max(1000)).max(1000),
      })
      .strict(),
    toolVersion: z.string().min(1).max(300),
    generatedAt: z.iso.datetime({ offset: true }),
    sbom: z.record(z.string(), z.json()),
  })
  .strict();
export type GeneratedImage = z.infer<typeof generatedImageSchema>;
export type RuntimeImage = {
  imageId: string;
  repositories: string[];
  tags: string[];
  digests: string[];
  containers: { containerId: string; name: string; state: string }[];
};
export type ContainerSource = {
  id: string;
  customerId: string;
  assetId: string | null;
  snapshotId: string | null;
  snapshotHash: string | null;
  containerId: string;
  versionId: string;
  contentHash: string;
  artifactHash: string;
  basis: "docker_image_observation" | "operator_declaration";
  imageId: string | null;
  architecture: string | null;
  containers: RuntimeImage["containers"];
  generator: string | null;
  generatedAt: string | null;
  actor: string;
  createdAt: string;
  coverage: string;
};
export type ContainerJob = {
  id: string;
  customerId: string;
  assetId: string;
  profileId: string;
  snapshotId: string;
  imageId: string;
  status:
    | "queued"
    | "generating"
    | "assessing"
    | "succeeded"
    | "failed"
    | "unavailable"
    | "timed_out"
    | "interrupted";
  containerId: string | null;
  versionId: string | null;
  sourceId: string | null;
  assessmentId: string | null;
  error: string | null;
  createdAt: string;
  events: { at: string; message: string }[];
};
export type ContainerRuntimeSummary = {
  hosts: number;
  observedImages: number;
  runningContainers: number;
  generatedVersions: number;
  pending: number;
  succeeded: number;
  failed: number;
};
export const runtimeTerminal = (status: string) =>
  !["queued", "generating", "assessing"].includes(status);
