import { z } from "zod";
import { reportPresentation } from "./report-presentation";
export const reportTaskInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    scope: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("selected"),
          assetIds: z
            .array(z.uuid())
            .min(1)
            .max(10000)
            .refine((ids) => new Set(ids).size === ids.length),
        })
        .strict(),
      z.object({ kind: z.literal("tenant") }).strict(),
    ]),
    mode: z.enum(["existing", "assess", "incremental", "collect"]),
    windowsRuleImportId: z.uuid().optional(),
    sourceReportId: z.uuid().optional(),
    comparisonReportId: z.uuid().optional(),
    presentation: reportPresentation.optional(),
    output: z
      .object({
        pdfMode: z.enum(["summary", "full"]).default("summary"),
        perHost: z.boolean().default(false),
        evidence: z.boolean().default(false),
      })
      .strict()
      .optional(),
    allowExistingCollection: z.boolean().default(false),
    freshnessDays: z.number().int().min(1).max(3650).default(7),
    overrides: z
      .array(
        z
          .object({
            objectId: z.uuid(),
            versionId: z.uuid().optional(),
            assessmentId: z.uuid(),
          })
          .strict(),
      )
      .max(10000)
      .refine(
        (items) =>
          new Set(
            items.map((item) => `${item.objectId}:${item.versionId ?? ""}`),
          ).size === items.length,
      )
      .default([]),
    idempotencyKey: z.string().min(1).max(100),
  })
  .strict();
export type ReportTaskInput = z.infer<typeof reportTaskInput>;
export type ReportHost = {
  assetId: string;
  name: string;
  attributes: Record<string, unknown>;
  snapshotId: string | null;
  collectedAt: string | null;
  assessedAt: string | null;
  freshness: {
    collection: "fresh" | "stale" | "unknown";
    assessment: "fresh" | "stale" | "unknown" | "missing";
  };
  assessmentRefs: string[];
  lifecycleRefs: string[];
  status: "available" | "unassessed";
  issues: string[];
};
export type ReportCenterFacts = {
  sourceReport?: { reportId: string; revisionId: string; factHash: string };
  comparison?: import("./report-comparison").ReportComparison;
  name: string;
  taskId: string;
  hosts: ReportHost[];
  checkedAt: string;
  freshnessDays: number;
  objects?: ReportLinkedObject[];
  lifecycle?: Pick<
    import("./lifecycle-risk").RiskView,
    "id" | "calculatedAt" | "localDate" | "config" | "items"
  >;
};
export type ReportBinding = {
  id: string;
  assetId: string;
  snapshotId: string | null;
  basis: string;
  contentHash: string;
  observedAt: string | null;
  coverage: string;
  imageId?: string | null;
  digest?: string | null;
};
export type ReportLinkedObject = {
  collectedAt?: string | null;
  assessedAt?: string | null;
  freshness?: ReportHost["freshness"];
  key: string;
  kind: "software" | "container";
  objectId: string;
  versionId: string;
  name: string;
  hostIds: string[];
  bindings: ReportBinding[];
  assessmentId: string | null;
  lifecycleRefs: string[];
  status: "available" | "unassessed";
  issues: string[];
};
export type ReportTask = {
  id: string;
  customerId: string;
  name: string;
  createdAt: string;
  createdBy: string;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "needs_attention"
    | "interrupted"
    | "cancelled"
    | "completed"
    | "failed";
  items?: ReportTaskItem[];
  frozenScope?: ReportCenterFacts;
  comparisonBase?: import("./report-comparison").ComparisonBase;
  cancelledAt?: string;
  hosts: ReportHost[];
  input: ReportTaskInput;
  reportId?: string;
  packageId?: string;
  error?: string;
};

export type ReportTaskItem = {
  id: string;
  name: string;
  kind: "linux" | "windows" | "software" | "container";
  objectId: string;
  hostIds: string[];
  snapshotId: string | null;
  assessmentId?: string;
  status:
    | "pending"
    | "waiting_upload"
    | "waiting_confirmation"
    | "running"
    | "succeeded"
    | "failed"
    | "unsupported"
    | "interrupted"
    | "cancelled"
    | "reused";
  attempt: number;
  error?: string;
  previousAssessmentIds?: string[];
  collectionRunId?: string;
  needsCollection?: boolean;
  previousCollectionRunIds?: string[];
  collectionConfiguration?: import("./collection-configuration").CollectionConfiguration;
};

export type ReportResultChoice = {
  objectId: string;
  versionId?: string;
  name: string;
  items: {
    id: string;
    kind: string;
    status: string;
    versionId: string;
    createdAt: string;
  }[];
};
export type ReportPreflight = {
  checkedAt: string;
  hosts: ReportHost[];
  objects: ReportLinkedObject[];
  resultChoices: ReportResultChoice[];
  total: number;
  available: number;
};
