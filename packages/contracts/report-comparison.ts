import type { ReportFacts } from "./reports";
export type ComparisonBase = {
  reportId: string;
  revisionId: string;
  factHash: string;
  facts: Pick<ReportFacts, "scope" | "assessmentSnapshots">;
  hostIds: string[];
};
export type ReportComparison = {
  baseline: Omit<ComparisonBase, "facts" | "hostIds">;
  addedHostIds: string[];
  removedHostIds: string[];
  incomparable: string[];
  added: string[];
  persistent: string[];
  changed: string[];
  notObserved: string[];
};
