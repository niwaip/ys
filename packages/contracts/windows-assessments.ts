import type { AssessmentStatus } from "./assessments";
export type WindowsApplicability =
  "unknown" | "potentially_affected" | "affected" | "fixed";
export type WindowsFinding = {
  id: string;
  vulnerabilityId: string;
  severity: string;
  applicability: WindowsApplicability;
  componentId: null;
  target: string;
  ecosystem: "windows";
  packageName: string;
  installedVersion: string;
  fixedVersion: string;
  primaryUrl: string;
  evidence: {
    basis: string;
    observed: Record<string, unknown>;
    fixedKbs: string[];
    matchedKb: string | null;
    supersedencePath: {
      supersededKb: string;
      replacementKb: string;
      sourceIds: string[];
    }[];
    sourceIds: string[];
    affectedBeforeFixed: boolean;
  };
};
export type WindowsRuleSource = {
  id: string;
  url: string;
  retrievedAt: string;
  sha256: string;
  verifiedOnline: false;
};
export type WindowsAssessmentResult = {
  outcome: "findings";
  findings: WindowsFinding[];
  coverage: {
    status: "partial";
    inputComponents: 1;
    matchedComponents: number;
    issues: string[];
  };
  database: {
    freshness: "unknown";
    updatedAt: null;
    nextUpdate: null;
    changedDuringScan: false;
  };
  parserVersion: "windows-evidence-v1";
  rules: {
    importId: string;
    contentHash: string;
    version: string;
    scope: string;
    product: "Windows Server 2022";
    branch: 20348;
    architecture: "x64";
    sources: WindowsRuleSource[];
  };
};
export type WindowsAssessment = {
  id: string;
  customerId: string;
  status: AssessmentStatus;
  idempotencyKey: string;
  target: { kind: "windows"; assetId: string; snapshotId: string };
  input: {
    importId: string;
    contentHash: string;
    snapshotId: string;
    ruleImportId: string;
    ruleHash: string;
  };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  execution?: {
    toolVersion: "ys-windows-evidence/1";
    rulesVersion: string;
    adapterVersion: "windows-bat/1";
    startedAt: string;
    finishedAt: string;
    outputHash: string;
    mode: "offline_curated_rules";
  };
  result?: WindowsAssessmentResult;
  replayed?: boolean;
};
export type WindowsRuleMaterial = {
  id: string;
  customerId: string;
  fileName: string;
  contentHash: string;
  content?: string;
  importedAt: string;
  rules: {
    ruleVersion: string;
    scope: string;
    sources: { id: string; url: string; retrievedAt: string; sha256: string }[];
  };
};
