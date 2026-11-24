import { z } from "zod";
export const reportTaskInput = z
  .object({
    name: z.string().trim().min(1).max(160),
    scope: z
      .object({
        kind: z.literal("selected"),
        assetIds: z.array(z.uuid()).length(1),
      })
      .strict(),
    mode: z.literal("existing"),
    idempotencyKey: z.string().min(1).max(100),
  })
  .strict();
export type ReportTaskInput = z.infer<typeof reportTaskInput>;
export type ReportHost = {
  assetId: string;
  name: string;
  attributes: Record<string, unknown>;
  snapshotId: string | null;
  assessmentRefs: string[];
  lifecycleRefs: string[];
  status: "available" | "unassessed";
  issues: string[];
};
export type ReportCenterFacts = {
  name: string;
  taskId: string;
  hosts: ReportHost[];
  checkedAt: string;
};
export type ReportTask = {
  id: string;
  customerId: string;
  name: string;
  createdAt: string;
  createdBy: string;
  status: "queued" | "completed" | "failed";
  hosts: ReportHost[];
  input: ReportTaskInput;
  reportId?: string;
  error?: string;
};
