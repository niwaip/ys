export type AssessmentStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "unavailable"
  | "timed_out"
  | "interrupted";
export type AssessmentPhase = "updating_database" | "scanning";
export type DatabaseUpdate = {
  status: Exclude<AssessmentStatus, "queued" | "running">;
  argv: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  error?: string;
};
export type TrivyExecution = {
  databaseUpdate?: DatabaseUpdate;
  status: Exclude<AssessmentStatus, "queued" | "running">;
  toolVersion: string | null;
  argv: string[];
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  signal: string | null;
  stderr: string;
  rawReport?: string;
  outputHash?: string;
  databaseBefore: Record<string, unknown> | null;
  databaseAfter: Record<string, unknown> | null;
  error?: string;
};
export type VulnerabilityFinding = {
  id: string;
  componentId: string | null;
  target: string;
  ecosystem: string;
  packageName: string;
  installedVersion: string;
  vulnerabilityId: string;
  severity: string;
  fixedVersion: string | null;
  primaryUrl: string | null;
  applicability: "tool_reported";
  runtimeApplicability?: import("./finding-context").ApplicabilityConclusion;
  evidence: Record<string, unknown>;
  match?: {
    sourcePackage: string | null;
    sourceVersion: string | null;
    scannerStatus: string | null;
    source: { name: string; url: string | null } | null;
  };
};
export type AssessmentResult = {
  outcome: "findings" | "no_findings";
  findings: VulnerabilityFinding[];
  coverage: {
    status: "complete_for_declared_input" | "partial" | "unknown";
    inputComponents: number;
    matchedComponents: number;
    issues: string[];
  };
  database: {
    freshness: "fresh" | "stale" | "unknown";
    updatedAt: string | null;
    nextUpdate: string | null;
    changedDuringScan: boolean;
  };
  parserVersion: "trivy-json-v1";
};
export type Assessment = {
  id: string;
  customerId: string;
  status: AssessmentStatus;
  phase?: AssessmentPhase;
  idempotencyKey: string;
  target:
    | { kind: "software"; softwareId: string; versionId: string }
    | { kind: "container"; containerId: string; versionId: string }
    | { kind: "linux"; assetId: string; snapshotId: string; versionId: string };
  input: {
    importId: string;
    contentHash: string;
    version: string | null;
    snapshotHash?: string;
    scope?: string;
    runtime?: import("./finding-context").RuntimeContext;
    provenance?: import("./collections").AssetVersionLink;
    containerSource?: import("./container-runtime").ContainerSource;
  };
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  execution?: TrivyExecution;
  result?: AssessmentResult;
  replayed?: boolean;
  findingStats?: { records: number; uniqueCves: number; components: number };
  componentGroups?: import("./finding-context").ComponentFindingGroup[];
  findingsPage?: {
    total: number;
    offset: number;
    limit: number;
    unfilteredTotal?: number;
    severities?: string[];
    search?: string;
    component?: string;
  };
};

export type AssessmentSummary = Omit<Assessment, "execution" | "result"> & {
  findingCount: number | null;
  coverage?: AssessmentResult["coverage"];
  database?: AssessmentResult["database"];
};
export type AssessmentPage = {
  items: AssessmentSummary[];
  total: number;
  limit: number;
  offset: number;
};

/** All targets returned by the shared assessment HTTP/service read interfaces. */
export type AnyAssessment =
  Assessment | import("./windows-assessments").WindowsAssessment;
export type AnyAssessmentSummary =
  | AssessmentSummary
  | (Omit<
      import("./windows-assessments").WindowsAssessment,
      "execution" | "result"
    > & {
      findingCount: number | null;
      coverage?: import("./windows-assessments").WindowsAssessmentResult["coverage"];
      database?: import("./windows-assessments").WindowsAssessmentResult["database"];
    });
export type AnyAssessmentPage = Omit<AssessmentPage, "items"> & {
  items: AnyAssessmentSummary[];
};
