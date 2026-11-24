import { z } from "zod";
export const reportPackageInput = z
  .object({
    audience: z.enum(["draft", "official"]).default("draft"),
    pdfMode: z.enum(["summary", "full"]).default("summary"),
    perHostIds: z.array(z.uuid()).max(10000).default([]),
    evidenceAssessmentIds: z.array(z.uuid()).max(10000).default([]),
  })
  .strict()
  .refine(
    (input) =>
      new Set(input.perHostIds).size === input.perHostIds.length &&
      new Set(input.evidenceAssessmentIds).size ===
        input.evidenceAssessmentIds.length,
  );
export type ReportPackageInput = z.infer<typeof reportPackageInput>;
export type ReportPackageFile = {
  id: string;
  name: string;
  format: "html" | "pdf" | "xlsx" | "evidence";
  hostId?: string;
  assessmentId?: string;
  status: "pending" | "running" | "ready" | "failed";
  error?: string;
  sha256?: string;
  bytes?: number;
};
export type ReportPackage = {
  id: string;
  reportId: string;
  revisionId: string;
  factHash: string;
  createdAt: string;
  createdBy: string;
  status: "generating" | "complete" | "partial";
  input: ReportPackageInput;
  files: ReportPackageFile[];
};
