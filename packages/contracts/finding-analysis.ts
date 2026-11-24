import type {
  Assessment,
  AssessmentStatus,
  VulnerabilityFinding,
  AssessmentResult,
} from "./assessments";
export type AnalysisSource = {
  id: string;
  title: string;
  url: string;
  origin: "scanner" | "public_query";
  retrievedAt: string;
};
export type FindingFacts = {
  assessmentId: string;
  findingId: string;
  target: Assessment["target"];
  input: Assessment["input"];
  outputHash: string | null;
  finding: VulnerabilityFinding;
  coverage: AssessmentResult["coverage"];
  database: AssessmentResult["database"];
  context?: import("./finding-context").FindingEvidence;
  advisory: { title?: string; description?: string };
};
export type AnalysisSection = { text: string; sourceIds: string[] };
export type FindingNarrative = {
  explanation: AnalysisSection;
  impact: AnalysisSection;
  checks: AnalysisSection[];
  nextSteps: AnalysisSection[];
};
export type FindingAnalysis = {
  id: string;
  customerId: string;
  assessmentId: string;
  findingId: string;
  factHash: string;
  facts: FindingFacts;
  status: AssessmentStatus;
  idempotencyKey: string;
  createdAt: string;
  finishedAt?: string;
  createdBy: string;
  model: string;
  skillVersion: "finding-analysis-v1";
  events: { at: string; type: string; message: string }[];
  sources: AnalysisSource[];
  research?: {
    status: "available" | "unavailable" | "partial";
    message: string;
    queriedAt: string;
    limitations: string[];
    contentHash?: string;
    summary?: string;
  };
  narrative?: FindingNarrative;
  error?: string;
};
export type FindingAnalysisInput = Pick<
  FindingAnalysis,
  "id" | "factHash" | "facts" | "sources" | "research"
>;
