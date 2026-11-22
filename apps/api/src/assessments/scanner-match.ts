import type { VulnerabilityFinding } from "../../../../packages/contracts/assessments";
/** Preserve scanner claims independently of runtime applicability. */
export function scannerMatch(
  raw: Record<string, unknown>,
  sourcePackage?: unknown,
  sourceVersion?: unknown,
): NonNullable<VulnerabilityFinding["match"]> {
  const data = raw.DataSource as Record<string, unknown> | undefined;
  return {
    sourcePackage:
      typeof sourcePackage === "string" ? sourcePackage.split(" ")[0] : null,
    sourceVersion: typeof sourceVersion === "string" ? sourceVersion : null,
    scannerStatus: typeof raw.Status === "string" ? raw.Status : null,
    source:
      typeof data?.Name === "string"
        ? {
            name: data.Name,
            url: typeof data.URL === "string" ? data.URL : null,
          }
        : null,
  };
}
export function sourceVersion(pkg?: Record<string, unknown>) {
  return typeof pkg?.SrcVersion === "string"
    ? `${typeof pkg.SrcEpoch === "number" && pkg.SrcEpoch ? `${pkg.SrcEpoch}:` : ""}${pkg.SrcVersion}${typeof pkg.SrcRelease === "string" && pkg.SrcRelease ? `-${pkg.SrcRelease}` : ""}`
    : null;
}

/** Resolve compact references against the hash-checked original, rejecting identity drift. */
export function originalFindingEvidence(
  finding: VulnerabilityFinding,
  content?: string,
) {
  if (!content) return finding.evidence;
  const ri = finding.evidence.resultIndex,
    vi = finding.evidence.vulnerabilityIndex;
  if (!Number.isInteger(ri) || !Number.isInteger(vi)) return finding.evidence;
  const report = JSON.parse(content),
    result = report.Results?.[Number(ri)];
  const raw = result?.Vulnerabilities?.[Number(vi)];
  if (
    raw?.VulnerabilityID !== finding.vulnerabilityId ||
    raw.PkgName !== finding.packageName ||
    raw.InstalledVersion !== finding.installedVersion
  )
    throw Error("原始漏洞证据身份不符");
  if (!finding.match) {
    const packages = (result.Packages ?? []).filter(
      (p: Record<string, unknown>) =>
        p.Name === finding.packageName &&
        `${p.Epoch ? `${p.Epoch}:` : ""}${p.Version}${p.Release ? `-${p.Release}` : ""}` ===
          finding.installedVersion &&
        (!finding.componentId || `${p.Name}:${p.Arch}` === finding.componentId),
    );
    const pkg = packages.length === 1 ? packages[0] : undefined;
    finding.match = scannerMatch(raw, pkg?.SrcName, sourceVersion(pkg));
  }
  return raw as Record<string, unknown>;
}
