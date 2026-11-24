import type { DashboardObject } from "./dashboard";
export type DashboardFilters = {
  severity?: string | null;
  state?: string | null;
  hardwareType?: string | null;
};
export function matchesDashboardObject(
  object: DashboardObject,
  filter: DashboardFilters,
) {
  if (filter.hardwareType && object.hardwareType !== filter.hardwareType)
    return false;
  if (
    filter.severity &&
    !object.findings.some((f) => f.severity.toLowerCase() === filter.severity)
  )
    return false;
  switch (filter.state) {
    case "unselected":
      return object.status === "unselected";
    case "succeeded":
      return object.status === "succeeded";
    case "failed":
      return ["failed", "unavailable", "timed_out", "interrupted"].includes(
        object.status,
      );
    case "coverage_unknown":
      return !object.coverage || object.coverage.status === "unknown";
    case "freshness_unknown":
      return !object.database || object.database.freshness === "unknown";
    case "stale":
      return object.database?.freshness === "stale";
    case undefined:
    case null:
    case "":
      return true;
    default:
      return false;
  }
}
