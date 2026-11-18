export type WindowsSnapshot = {
  hostname: string;
  serial: string | null;
  collectorVersion: string | null;
  collectedAt: string | null;
  os: string | null;
  osVersion: string | null;
  osBuild: string | null;
  fullBuild: string | null;
  architecture: string | null;
  ubr: number | null;
  software:
    | {
        name: string | null;
        version: string | null;
        publisher: string | null;
        raw: unknown;
      }[]
    | null;
  kbs: string[] | null;
  collectionStatus: Record<string, unknown> | null;
  kbInventoryComplete: boolean | null;
  softwareInventoryComplete: boolean | null;
  rebootPending: boolean | null;
  extensions: unknown;
  assessmentSupport: { state: string; limitations: string[] };
};
export type WindowsMaterial = {
  id: string;
  customerId: string;
  fileName: string;
  contentHash: string;
  importedAt: string;
  content?: string;
  status: "imported" | "pending_confirmation" | "unsupported_version";
  assetId: string | null;
  snapshotId: string | null;
  snapshot: WindowsSnapshot;
  issues: string[];
  replayed?: boolean;
};
