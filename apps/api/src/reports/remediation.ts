import type { ReportFacts } from "../../../../packages/contracts/reports";
export function remediation(facts: ReportFacts) {
  const order: Record<string, number> = {
    CRITICAL: 0,
    HIGH: 1,
    MEDIUM: 2,
    LOW: 3,
    UNKNOWN: 4,
  };
  return facts.assessmentSnapshots
    .flatMap((assessment) =>
      (assessment.result?.findings ?? []).map((finding) => ({
        assessmentId: assessment.id,
        findingId: finding.id,
        vulnerabilityId: finding.vulnerabilityId,
        packageName: finding.packageName,
        installedVersion: finding.installedVersion,
        severity: finding.severity,
        applicability: finding.applicability,
        hostIds:
          facts.center?.hosts
            .filter((host) => host.assessmentRefs.includes(assessment.id))
            .map((host) => host.assetId) ?? [],
        fixedVersion: finding.fixedVersion,
        source: finding.primaryUrl,
        businessImportance: "未知",
        action: finding.fixedVersion
          ? `依据来源核实升级至 ${finding.fixedVersion} 的适用性，按变更流程测试与实施`
          : "缺少明确修复版本依据，需核实厂商公告及适用条件",
        retest: "更新采集资料并确认后重新评估；本建议不代表已经修复",
        evidence: JSON.stringify(finding.evidence),
      })),
    )
    .sort(
      (a, b) =>
        (order[a.severity] ?? 4) - (order[b.severity] ?? 4) ||
        Number(b.applicability === "affected") -
          Number(a.applicability === "affected") ||
        a.vulnerabilityId.localeCompare(b.vulnerabilityId),
    );
}
