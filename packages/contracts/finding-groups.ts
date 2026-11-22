import type { VulnerabilityFinding } from "./assessments";
import type { ComponentFindingGroup } from "./finding-context";
export function findingGroupKey(f: VulnerabilityFinding) {
  return JSON.stringify([
    f.componentId,
    f.packageName,
    f.installedVersion,
    f.ecosystem,
    f.target,
    f.componentId ? null : f.id,
  ]);
}
/** Used only for complete, non-paginated results. Server-paginated groups come from SQL. */
export function groupFindings(
  findings: VulnerabilityFinding[],
): ComponentFindingGroup[] {
  const groups = new Map<
    string,
    ComponentFindingGroup & { cves: Set<string> }
  >();
  for (const f of findings) {
    const key = findingGroupKey(f);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        componentId: f.componentId,
        packageName: f.packageName,
        installedVersion: f.installedVersion,
        ecosystem: f.ecosystem,
        target: f.target,
        records: 0,
        uniqueCves: 0,
        severities: {},
        cves: new Set(),
      };
      groups.set(key, g);
    }
    g.records++;
    g.cves.add(f.vulnerabilityId);
    g.uniqueCves = g.cves.size;
    const severity = f.severity.toUpperCase();
    g.severities![severity] = (g.severities![severity] ?? 0) + 1;
  }
  return [...groups.values()]
    .map(({ cves, ...g }) => g)
    .sort(
      (a, b) =>
        a.packageName.localeCompare(b.packageName) ||
        a.key.localeCompare(b.key),
    );
}
