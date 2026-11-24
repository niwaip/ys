import type { ReportFacts } from "../../../../packages/contracts/reports";
import type { ReportHost } from "../../../../packages/contracts/report-center";
type Facts = Pick<
  ReportFacts,
  "scope" | "assessmentSnapshots" | "lifecycleSnapshots"
>;
export function reportStatistics(
  facts: Pick<Facts, "assessmentSnapshots" | "lifecycleSnapshots">,
  hosts?: ReportHost[],
): ReportFacts["statistics"] {
  const findings = facts.assessmentSnapshots.flatMap<
    NonNullable<
      Facts["assessmentSnapshots"][number]["result"]
    >["findings"][number]
  >((a) => a.result?.findings ?? []);
  const known = facts.assessmentSnapshots.some((a) => a.result),
    life = facts.lifecycleSnapshots.flatMap((a) => a.items);
  const severityCounts: Record<string, number> = {},
    applicabilityCounts: Record<string, number> = {};
  for (const finding of findings) {
    severityCounts[finding.severity] =
      (severityCounts[finding.severity] ?? 0) + 1;
    applicabilityCounts[finding.applicability] =
      (applicabilityCounts[finding.applicability] ?? 0) + 1;
  }
  const involved = new Set<string>(),
    affected = new Set<string>();
  for (const a of facts.assessmentSnapshots)
    if (a.result?.findings.length)
      for (const host of hosts ?? [])
        if (host.assessmentRefs.includes(a.id)) {
          involved.add(host.assetId);
          // Shared-object applicability is never evidence of impact on a linked host.
          if (
            (a.target.kind === "linux" || a.target.kind === "windows") &&
            a.target.assetId === host.assetId &&
            a.result.findings.some((v) => v.applicability === "affected")
          )
            affected.add(host.assetId);
        }
  return {
    findingInstances: known ? findings.length : null,
    uniqueCveCount: known
      ? new Set(
          findings
            .filter((v) => /^CVE-\d{4}-\d{4,}$/.test(v.vulnerabilityId))
            .map((v) => v.vulnerabilityId),
        ).size
      : null,
    confirmedAffectedCount: known
      ? findings.filter((v) => v.applicability === "affected").length
      : null,
    severityCounts,
    applicabilityCounts,
    lifecycleExact: facts.lifecycleSnapshots.length
      ? life.filter((i) => i.match === "exact").length
      : null,
    lifecycleWeak: facts.lifecycleSnapshots.length
      ? life.filter((i) => i.match === "weak").length
      : null,
    lifecycleUnmatched: facts.lifecycleSnapshots.length
      ? life.filter((i) => i.match === "unmatched").length
      : null,
    ...(hosts
      ? {
          uniqueVulnerabilityCount: known
            ? new Set(findings.map((v) => v.vulnerabilityId)).size
            : null,
          involvedHostCount: known ? involved.size : null,
          confirmedAffectedHostCount: known ? affected.size : null,
        }
      : {}),
  };
}
export function reportCoverage(facts: Facts): string[] {
  const cve = new Set(
    facts.assessmentSnapshots.map((a) => {
      const t = a.target;
      return `${t.kind}:${t.kind === "software" ? t.softwareId : t.kind === "container" ? t.containerId : t.assetId}:${t.kind === "linux" || t.kind === "windows" ? t.snapshotId : t.versionId}`;
    }),
  );
  const life = new Set(
    facts.lifecycleSnapshots.flatMap((a) =>
      a.items.map((i) => `${i.kind}:${i.assetId}:${i.versionId ?? ""}`),
    ),
  );
  const issues: string[] = [];
  for (const t of facts.scope) {
    const key = `${t.kind}:${t.objectId}:${t.versionId ?? ""}`;
    if (!cve.has(key))
      issues.push(
        `${t.name} / ${t.version ?? "未知版本"}：未选择CVE评估，未评估`,
      );
    if (!life.has(key))
      issues.push(
        `${t.name} / ${t.version ?? "未知版本"}：未选择生命周期评估，未评估`,
      );
  }
  for (const a of facts.assessmentSnapshots)
    if (!a.result)
      issues.push(`CVE评估 ${a.id}：${a.status}，无可用结果，不是零漏洞`);
    else
      issues.push(
        `CVE评估 ${a.id}：覆盖 ${a.result.coverage.status}，情报库 ${a.result.database.freshness}`,
        ...a.result.coverage.issues.map((issue) => `CVE评估 ${a.id}：${issue}`),
      );
  for (const a of facts.lifecycleSnapshots)
    for (const item of a.items) {
      if (item.match !== "exact")
        issues.push(
          `生命周期 ${item.assetId}：${item.match} / ${item.verification}`,
        );
      for (const evidence of item.evidence)
        for (const [name, stage] of [
          ["EOS", evidence.eos],
          ["EOL", evidence.eol],
        ] as const)
          if (stage.dateStatus !== "known")
            issues.push(
              `生命周期 ${item.assetId} ${name}：${stage.dateStatus}，日期未知`,
            );
    }
  return issues;
}
