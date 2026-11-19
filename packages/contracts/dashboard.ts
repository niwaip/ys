import type { AnyAssessment, AssessmentStatus } from "./assessments";
import type { LifecycleAssessmentItem } from "./lifecycle";
export type DashboardKind = "host" | "software" | "container";
export type DashboardObject = {
  kind: DashboardKind;
  hardwareType?: string;
  id: string;
  name: string;
  inputId: string | null;
  inputLabel: string | null;
  assessmentId: string | null;
  selection:
    | "software_current"
    | "explicit_assessment"
    | "latest_attempt"
    | "unselected";
  lifecycleAssessmentId?: string;
  status: AssessmentStatus | "unselected" | "outside_time_range";
  componentCount: number | null;
  installedSoftwareCount: number | null;
  collectedAt: string | null;
  createdAt: string | null;
  findings: {
    assessmentId: string;
    findingId: string;
    cve: string;
    severity: string;
    applicability: string;
    packageName: string;
    installedVersion: string;
    fixedVersion: string | null;
  }[];
  coverage: NonNullable<AnyAssessment["result"]>["coverage"] | null;
  database: {
    freshness: string;
    updatedAt: string | null;
    nextUpdate: string | null;
  } | null;
  toolVersion: string | null;
  inputHash: string | null;
  issues: string[];
  lifecycle: LifecycleAssessmentItem | null;
};
export type DashboardRequest = {
  hardwareType?: "server" | "network" | "unknown";
  selectionMode?: "explicit" | "current";
  trendMode?: "selected_inputs" | "object_history";
  assessmentRefs?: string[];
  lifecycleAssessmentId?: string;
  object?: { kind: DashboardKind; id: string };
  from?: string;
  to?: string;
};
export type DashboardTrend = {
  assessmentId: string;
  kind: DashboardKind;
  objectId: string;
  inputId: string;
  at: string;
  status: AssessmentStatus;
  uniqueObserved: number | null;
  instances: number | null;
  coverage: string;
  databaseFreshness: string;
  inputChanged: boolean;
  coverageChanged: boolean;
  comparableWithPrevious: boolean;
};
export type DashboardView = {
  customerId: string;
  generatedAt: string;
  scope: {
    hash: string;
    object: DashboardRequest["object"] | null;
    hardwareType?: DashboardRequest["hardwareType"] | null;
    from: string | null;
    to: string | null;
    assessmentRefs: string[];
    lifecycleAssessmentId: string | null;
    selectionPolicy: string;
    lifecycleAssessmentRefs?: string[];
    trendMode: "selected_inputs" | "object_history";
  };
  metrics: {
    inventory: {
      host: number;
      software: number;
      container: number;
      server?: number;
      network?: number;
      unclassified?: number;
    };
    components: { known: number; unknownObjects: number };
    cve: {
      uniqueObserved: number | null;
      uniqueCves: number | null;
      instances: number | null;
      confirmedAffectedObjects: number | null;
      toolReportedObjects: number;
      bySeverity: Record<string, number>;
      byApplicability: Record<string, number>;
    };
    coverage: {
      selected: number;
      succeeded: number;
      failed: number;
      running: number;
      unselected: number;
      outsideTimeRange: number;
      complete: number;
      partial: number;
      unknown: number;
    };
    freshness: {
      fresh: number;
      stale: number;
      unknown: number;
      collectedAtUnknown: number;
    };
    lifecycle: {
      status: "selected" | "unselected" | "outside_time_range";
      assessmentId: string | null;
      evaluatedAt: string | null;
      batchId: string | null;
      sourceHash: string | null;
      coveredObjects: number;
      upcoming90d?: number | null;
      eos: Record<string, number> | null;
      eol: Record<string, number> | null;
    };
  };
  objects: DashboardObject[];
  trend: {
    items: DashboardTrend[];
    total: number;
    truncated: boolean;
    warning: string;
  };
  warnings: string[];
};
export type DashboardCatalog = {
  inventory: {
    host: number;
    software: number;
    container: number;
    server?: number;
    network?: number;
    unclassified?: number;
  };
  objectTotal: number;
  objectLimit: number;
  objectOffset: number;
  objects: { kind: DashboardKind; id: string; name: string }[];
  assessments: {
    id: string;
    target: AnyAssessment["target"];
    status: AssessmentStatus;
    createdAt: string;
  }[];
  lifecycleAssessments: {
    id: string;
    evaluatedAt: string;
    batchId: string;
    itemCount: number;
  }[];
  truncated: boolean;
};
