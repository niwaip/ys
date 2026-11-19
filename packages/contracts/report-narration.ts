import type { NarrationReference, narrationGrammar } from "./report-language";
import type {
  ReportNarrative,
  ReportScopeTarget,
  ReportFacts,
} from "./reports";
export type ReportNarrationInput = {
  id: string;
  reportId: string;
  baseRevisionId: string;
  factHash: string;
  scope: ReportScopeTarget[];
  statistics: ReportFacts["statistics"];
  coverageIssues: string[];
  allowedNarrative: ReportNarrative;
  language?: {
    grammar: typeof narrationGrammar;
    references: NarrationReference[];
  };
  optionalTemplates: ["summary", "recommendations"];
};
export type ReportNarrationJob = {
  id: string;
  customerId: string;
  reportId: string;
  baseRevisionId: string;
  factHash: string;
  idempotencyKey: string;
  createdBy: string;
  createdAt: string;
  finishedAt?: string;
  status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed"
    | "unavailable"
    | "timed_out"
    | "interrupted";
  fallback: boolean;
  error?: string;
  resultRevisionId?: string;
  proposalHash?: string;
  events: { at: string; type: string; message: string }[];
};
