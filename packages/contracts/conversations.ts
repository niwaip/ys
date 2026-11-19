import type { AgentEvent, AgentStatus } from "./agent";
export type CustomerChatFacts = {
  coverage: "not_assessed" | "evidence_unavailable" | "available" | "partial";
  cveId: string | null;
  scopeNote: string;
  assessments: {
    id: string;
    status: string;
    versionId: string;
    inputHash: string;
    findingCount: number | null;
    coverage: unknown;
    database: unknown;
  }[];
  matches: {
    reference: string;
    assessmentId: string;
    findingId: string;
    componentId: string | null;
    packageName: string;
    installedVersion: string;
    vulnerabilityId: string;
    severity: string;
    applicability: string;
    fixedVersion: string | null;
    evidence: Record<string, unknown>;
  }[];
  hash: string;
};
export type CustomerConversation = {
  id: string;
  customerId: string;
  message: string;
  assessmentIds: string[];
  createdAt: string;
  status: AgentStatus;
  facts: CustomerChatFacts;
  events: AgentEvent[];
  error?: string;
  answer: string;
};
