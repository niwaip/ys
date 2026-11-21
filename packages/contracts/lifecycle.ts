export type LifecycleStage = {
  name: string;
  rawDate: string;
  date: string | null;
  dateStatus: "known" | "unknown" | "invalid";
};
export type LifecycleRow = {
  row: number;
  source: string;
  sourceRef: string;
  product: string;
  version: string | null;
  eos: LifecycleStage;
  eol: LifecycleStage;
  issues: string[];
  extensions: Record<string, string>;
};
export type LifecycleBatch = {
  id: string;
  customerId: string;
  format: "lifecycle-csv-v1";
  fileName: string;
  contentHash: string;
  importedAt: string;
  content?: string;
  rows: LifecycleRow[];
  replayed?: boolean;
};
export type LifecycleEvidence = LifecycleRow & {
  eos: LifecycleStage & { status: "reached" | "future" | "unknown" };
  eol: LifecycleStage & { status: "reached" | "future" | "unknown" };
};
export type LifecycleAssessmentItem = {
  assetId: string;
  versionId?: string;
  importId?: string;
  name: string;
  kind: string;
  product: string | null;
  version: string | null;
  inputSource: string;
  match: "exact" | "weak" | "unmatched";
  verification: "verified" | "needs_verification" | "unknown";
  basis: string;
  evidence: LifecycleEvidence[];
};
export type LifecycleAssessment = {
  id: string;
  customerId: string;
  batchId: string;
  contentHash: string;
  evaluatedAt: string;
  ruleVersion: "literal-product-version-v1";
  items: LifecycleAssessmentItem[];
};
