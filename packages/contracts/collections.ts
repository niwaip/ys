import { z } from "zod";
import { runtimeObservationsSchema } from "./finding-context";
export const collectionSectionNames = [
  "os",
  "packages",
  "hardware",
  "network",
  "dockerClient",
  "dockerDaemon",
  "containers",
  "images",
] as const;
export const sectionName = z.enum(collectionSectionNames);
export const sectionSchema = z
  .object({
    status: z.enum([
      "acquired",
      "partial",
      "not_collected",
      "unsupported",
      "permission_denied",
      "failed",
    ]),
    data: z.json().nullable(),
    issues: z.array(z.string().max(1000)).max(100).default([]),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.status === "acquired" && v.data === null)
      ctx.addIssue({
        code: "custom",
        message: "已取得必须包含资料；空清单使用[]",
      });
    if (
      ["not_collected", "unsupported", "permission_denied", "failed"].includes(
        v.status,
      ) &&
      v.data !== null
    )
      ctx.addIssue({
        code: "custom",
        message: "未取得状态不能声明已取得资料，请使用partial",
      });
  });
export const packageRecord = z
  .object({
    name: z.string().min(1).max(500),
    version: z.string().max(500).nullable(),
    architecture: z.string().max(200).nullable(),
    state: z.enum([
      "installed",
      "config-files",
      "unpacked",
      "other",
      "unknown",
    ]),
    manager: z.enum(["dpkg", "rpm"]),
  })
  .passthrough();
export const hostCollectionSchema = z
  .object({
    schemaVersion: z.literal("ys-host/1"),
    identity: z
      .object({
        hostname: z.string().trim().min(1).max(255),
        serial: z.string().min(1).max(255).nullable().default(null),
        machineId: z.string().min(1).max(255).nullable().default(null),
      })
      .strict(),
    collectedAt: z.iso.datetime({ offset: true }).nullable(),
    sections: z.partialRecord(sectionName, sectionSchema),
    extensions: z.record(z.string(), z.json()).default({}),
  })
  .strict()
  .superRefine((v, ctx) => {
    const packages = v.sections.packages;
    if (packages?.status === "acquired" || packages?.status === "partial")
      if (!z.array(packageRecord).max(50000).safeParse(packages.data).success)
        ctx.addIssue({
          code: "custom",
          path: ["sections", "packages"],
          message:
            "包清单须为最多50000项的名称、完整版本、架构、安装状态、包管理器记录",
        });
    if (
      v.sections.os?.status === "acquired" &&
      !z
        .object({
          id: z.string().nullable(),
          version: z.string().nullable(),
          kernel: z.string().nullable(),
          architecture: z.string().nullable(),
          runtime: runtimeObservationsSchema.optional(),
        })
        .passthrough()
        .safeParse(v.sections.os.data).success
    )
      ctx.addIssue({
        code: "custom",
        path: ["sections", "os"],
        message: "OS资料须包含可空的id、version、kernel、architecture",
      });
  });
export type HostCollection = z.infer<typeof hostCollectionSchema>;
export type CollectionSectionName = z.infer<typeof sectionName>;
export type CollectionSnapshot = {
  id: string;
  customerId: string;
  assetId: string;
  entry: "manual" | "upload" | "pi" | "ssh";
  fileName: string;
  contentHash: string;
  note: string | null;
  collectedAt: string | null;
  importedAt: string;
  identity: HostCollection["identity"];
  extensions: HostCollection["extensions"];
  assessmentStatus: "not_assessed";
  sections: Record<
    CollectionSectionName,
    {
      status: z.infer<typeof sectionSchema>["status"];
      count: number | null;
      issues: string[];
    }
  >;
  target: Record<string, unknown>;
};

export type AssetVersionLink = {
  id: string;
  customerId: string;
  assetId: string;
  kind: "software" | "container";
  objectId: string;
  versionId: string;
  importId: string;
  contentHash: string;
  basisType: "operator_declaration";
  declaredBy: string;
  basis: string;
  createdAt: string;
  snapshot: Pick<
    CollectionSnapshot,
    | "id"
    | "contentHash"
    | "identity"
    | "target"
    | "entry"
    | "collectedAt"
    | "importedAt"
    | "sections"
  >;
  imageIdentity?: {
    imageId: string | null;
    digest: string | null;
    coverage: string;
  };
};
