import type { Assessment, AssessmentResult } from "./assessments";
export type SoftwareCurrent = {
  versionId: string;
  assessmentId: string | null;
  version: string | null;
  selectedAt: string;
  selection: "explicit";
};
export type SoftwareVersionSummary = {
  id: string;
  version: string | null;
  importId: string;
  contentHash: string;
  fileName: string;
  createdAt: string;
  collectedAt: string | null;
  componentCount: number;
  issues: string[];
};
export type SoftwareHistory = {
  software: { id: string; name: string; customerId: string };
  current: SoftwareCurrent | null;
  versions: {
    items: SoftwareVersionSummary[];
    total: number;
    limit: number;
    offset: number;
  };
};
export type ComparisonContext = {
  assessmentId: string;
  versionId: string;
  version: string | null;
  importId: string;
  contentHash: string;
  status: Assessment["status"];
  createdAt: string;
  finishedAt: string | null;
  toolVersion: string | null;
  coverage: AssessmentResult["coverage"] | null;
  database: AssessmentResult["database"] | null;
};
export type FindingObservation = {
  occurrences: number;
  installedVersions: string[];
  findingIds: string[];
};
export type FindingChange = {
  key: string;
  status: "added" | "persistent" | "not_observed";
  vulnerabilityId: string;
  packageName: string;
  ecosystem: string;
  target: string;
  baseline: FindingObservation | null;
  compared: FindingObservation | null;
  identity: "linked_component" | "unresolved";
};
export type SoftwareComparison = {
  softwareId: string;
  baseline: ComparisonContext;
  compared: ComparisonContext;
  comparable: boolean;
  counts: {
    added: number | null;
    persistent: number | null;
    notObserved: number | null;
    baselineUnique: number | null;
    comparedUnique: number | null;
    baselineRaw: number | null;
    comparedRaw: number | null;
  };
  changes: {
    items: FindingChange[];
    total: number;
    limit: number;
    offset: number;
  };
  contextChanges: {
    inputChanged: boolean;
    toolChanged: boolean;
    databaseChanged: boolean;
    coverageChanged: boolean;
  };
  warnings: string[];
};
