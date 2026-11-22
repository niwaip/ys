import type {
  Assessment,
  VulnerabilityFinding,
} from "../../../../packages/contracts/assessments";
import type {
  ApplicabilityConclusion,
  FindingEvidence,
} from "../../../../packages/contracts/finding-context";

/** Conclusions describe the bound observation only, never current or future safety. */
export function findingContext(
  finding: VulnerabilityFinding,
  input: Assessment["input"],
  raw: Record<string, unknown> = finding.evidence,
): FindingEvidence {
  const runtime = input.runtime ?? null;
  let applicability: ApplicabilityConclusion = {
    status: "unknown",
    rule: "evidence-gap-v1",
    observedAt: runtime?.collectedAt ?? null,
    reason: "扫描匹配尚未验证运行适用性；需要运行版本、配置与暴露条件的证据。",
  };
  if (
    finding.vulnerabilityId === "CVE-2026-99287" &&
    runtime?.collectedAt &&
    runtime.virtualization?.status === "acquired" &&
    runtime.virtualization.data === "kvm" &&
    runtime.xenNetback?.status === "acquired" &&
    runtime.xenNetback.data === false
  ) {
    applicability = {
      status: "conditions_not_met",
      rule: "xsa-532-kvm-no-backend-v1",
      observedAt: runtime.collectedAt,
      reason:
        "采集时虚拟化类型为 KVM，未发现 xen-netback 后端；当时未发现该漏洞的 Xen 后端触发条件。此结论不代表当前或其他漏洞安全。",
      sourceUrl: "https://xenbits.xen.org/xsa/advisory-532.html",
    };
  }
  return {
    sourcePackage: finding.match?.sourcePackage ?? null,
    sourceVersion: finding.match?.sourceVersion ?? null,
    scannerStatus:
      finding.match?.scannerStatus ??
      (typeof raw.Status === "string" ? raw.Status : null),
    source: finding.match?.source ?? null,
    title: typeof raw.Title === "string" ? raw.Title.slice(0, 1000) : null,
    description:
      typeof raw.Description === "string"
        ? raw.Description.slice(0, 8000)
        : null,
    basis: finding.match?.sourcePackage
      ? `依据源码包 ${finding.match.sourcePackage} 的漏洞情报关联；包匹配不证明当前运行代码受影响。`
      : "扫描器按组件与版本报告匹配；具体匹配依据未提供，运行适用性未验证。",
    applicability,
    runtime,
    reference: finding.evidence,
  };
}
