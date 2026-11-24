export type AgentStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "partial"
  | "failed"
  | "timed_out"
  | "unavailable"
  | "interrupted";
export type AgentEvent = { at: string; type: string; message: string };
export type PublicIntelligenceResult = {
  schemaVersion: "2.2";
  status: "complete_for_declared_sources" | "partial" | "unavailable";
  query: Record<string, unknown>;
  coverage: Record<string, unknown>;
  summary: string;
  scope: string;
  results: Record<string, unknown>[];
  sources: Record<string, unknown>[];
  targetAssessment: "not_assessed";
  targetVerification: "not_executed";
  evidence: { contentHash: string; scriptContract: "yata-cve-research/2.2" };
};
export type AgentQuery = {
  id: string;
  context: "public_intelligence";
  originalMessage: string;
  targetAssessment: "not_assessed";
  status: AgentStatus;
  createdAt: string;
  finishedAt?: string;
  events: AgentEvent[];
  error?: string;
  result?: PublicIntelligenceResult;
};
