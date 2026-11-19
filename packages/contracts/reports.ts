import type { AnyAssessment } from "./assessments";
import type { LifecycleAssessment } from "./lifecycle";
export type ReportScopeTarget = {
  kind: string;
  objectId: string;
  versionId?: string;
  name: string;
  version: string | null;
  sourceIdentity?: Record<string, unknown>;
};
export type ReportFacts = {
  schemaVersion: "report-facts-v1";
  customerId: string;
  generatedAt: string;
  scope: ReportScopeTarget[];
  assessmentSnapshots: AnyAssessment[];
  lifecycleSnapshots: LifecycleAssessment[];
  sourceRefs: {
    kind: "cve" | "lifecycle" | "windows_rules";
    id: string;
    inputId: string;
    contentHash: string;
    ruleVersion: string;
    importedAt: string;
    collectedAt: string | null;
    evaluatedAt: string | null;
    toolVersion: string | null;
  }[];
  statistics: {
    findingInstances: number | null;
    confirmedAffectedCount?: number | null;
    applicabilityCounts?: Record<string, number>;
    uniqueCveCount: number | null;
    severityCounts: Record<string, number>;
    lifecycleExact: number | null;
    lifecycleWeak: number | null;
    lifecycleUnmatched: number | null;
  };
  coverageIssues: string[];
};
export type ReportBlock = {
  templateId:
    | "scope"
    | "assessment"
    | "lifecycle"
    | "coverage"
    | "evidence"
    | "summary"
    | "recommendations";
  factRef?: string;
  wording: "standard" | "concise";
  text?: string;
};
export type ReportNarrative = {
  schemaVersion: "controlled-paragraphs-v1";
  blocks: ReportBlock[];
  density: "standard" | "compact";
};
export type ReportRevision = {
  id: string;
  reportId: string;
  customerId: string;
  number: number;
  createdAt: string;
  createdBy: string;
  parentRevisionId?: string;
  status: "draft" | "in_review" | "approved" | "delivered";
  submittedAt?: string;
  submittedBy?: string;
  approvedAt?: string;
  approvedBy?: string;
  deliveredAt?: string;
  deliveredBy?: string;
  factHash: string;
  facts: ReportFacts;
  narrative: ReportNarrative;
  templateVersion: "fixed-report-v1";
};
export type Report = {
  id: string;
  customerId: string;
  createdAt: string;
  createdBy: string;
  revision: ReportRevision;
};
export type ReportSummary = Omit<Report, "revision"> & {
  revisionId: string;
  revisionNumber: number;
  status: ReportRevision["status"];
  factHash: string;
};

export type ReportDelivery = {
  id: string;
  reportId: string;
  revisionId: string;
  customerId: string;
  deliveredAt: string;
  deliveredBy: string;
  factHash: string;
  contentHash: string;
  replayed?: boolean;
};
export type ReportAudit = {
  id: string;
  revisionId: string;
  action: "submit_review" | "approve" | "deliver" | "revise";
  actor: { name: string; operatorId: string };
  createdAt: string;
  details: Record<string, unknown>;
};
