import type { AnyAssessment } from "../../../../packages/contracts/assessments";
import type {
  LifecycleAssessment,
  LifecycleAssessmentItem,
} from "../../../../packages/contracts/lifecycle";
import type {
  DashboardObject,
  DashboardView,
  DashboardTrend,
} from "../../../../packages/contracts/dashboard";
function phase(item: LifecycleAssessmentItem | null, key: "eos" | "eol") {
  if (
    !item ||
    item.match !== "exact" ||
    item.verification !== "verified" ||
    !item.evidence.length
  )
    return "unknown";
  const statuses = new Set(
    item.evidence.map((e) =>
      e[key].dateStatus === "known" ? e[key].status : "unknown",
    ),
  );
  return statuses.size === 1 ? [...statuses][0] : "conflicting";
}
export function aggregateDashboard(
  rows: DashboardObject[],
  lifecycle: LifecycleAssessment | null,
): DashboardView["metrics"] {
  const usable = rows.filter((r) => r.status === "succeeded" && r.coverage),
    findings = usable.flatMap((r) => r.findings),
    windows = usable.filter((r) => r.kind === "host"),
    bySeverity: Record<string, number> = {},
    byApplicability: Record<string, number> = {};
  for (const f of findings) {
    bySeverity[f.severity] = (bySeverity[f.severity] ?? 0) + 1;
    byApplicability[f.applicability] =
      (byApplicability[f.applicability] ?? 0) + 1;
  }
  const eos: Record<string, number> = {
      reached: 0,
      future: 0,
      unknown: 0,
      conflicting: 0,
    },
    eol = { ...eos };
  if (lifecycle)
    for (const r of rows) {
      eos[phase(r.lifecycle, "eos")]++;
      eol[phase(r.lifecycle, "eol")]++;
    }
  return {
    inventory: {
      host: rows.filter((r) => r.kind === "host").length,
      software: rows.filter((r) => r.kind === "software").length,
      container: rows.filter((r) => r.kind === "container").length,
    },
    components: {
      known: rows.reduce((n, r) => n + (r.componentCount ?? 0), 0),
      unknownObjects: rows.filter(
        (r) => r.kind !== "host" && r.componentCount === null,
      ).length,
    },
    cve: {
      uniqueCves: usable.length
        ? new Set(
            findings
              .filter((f) => /^CVE-\d{4}-\d{4,}$/i.test(f.cve))
              .map((f) => f.cve.toUpperCase()),
          ).size
        : null,
      uniqueObserved: usable.length
        ? new Set(findings.map((f) => f.cve)).size
        : null,
      instances: usable.length ? findings.length : null,
      confirmedAffectedObjects: windows.length
        ? windows.filter((r) =>
            r.findings.some((f) => f.applicability === "affected"),
          ).length
        : null,
      toolReportedObjects: usable.filter((r) =>
        r.findings.some((f) => f.applicability === "tool_reported"),
      ).length,
      bySeverity,
      byApplicability,
    },
    coverage: {
      selected: rows.filter((r) => !!r.assessmentId).length,
      succeeded: usable.length,
      failed: rows.filter((r) =>
        ["failed", "unavailable", "timed_out", "interrupted"].includes(
          r.status,
        ),
      ).length,
      running: rows.filter((r) => ["queued", "running"].includes(r.status))
        .length,
      unselected: rows.filter((r) => r.status === "unselected").length,
      outsideTimeRange: rows.filter((r) => r.status === "outside_time_range")
        .length,
      complete: usable.filter(
        (r) => r.coverage?.status === "complete_for_declared_input",
      ).length,
      partial: usable.filter((r) => r.coverage?.status === "partial").length,
      unknown: rows.filter(
        (r) => !r.coverage || r.coverage.status === "unknown",
      ).length,
    },
    freshness: {
      fresh: usable.filter((r) => r.database?.freshness === "fresh").length,
      stale: usable.filter((r) => r.database?.freshness === "stale").length,
      unknown: rows.filter(
        (r) => !r.database || r.database.freshness === "unknown",
      ).length,
      collectedAtUnknown: rows.filter((r) => !r.collectedAt).length,
    },
    lifecycle: {
      status: lifecycle ? "selected" : "unselected",
      assessmentId: lifecycle?.id ?? null,
      evaluatedAt: lifecycle?.evaluatedAt ?? null,
      batchId: lifecycle?.batchId ?? null,
      sourceHash: lifecycle?.contentHash ?? null,
      coveredObjects: rows.filter((r) => !!r.lifecycle).length,
      eos: lifecycle ? eos : null,
      eol: lifecycle ? eol : null,
    },
  };
}
export function trendPoints(
  jobs: (AnyAssessment & { toolVersion: string | null })[],
): DashboardTrend[] {
  const previous = new Map<string, (typeof jobs)[number]>();
  return jobs.map((job) => {
    const t = job.target,
      kind = t.kind === "windows" ? "host" : t.kind,
      id =
        t.kind === "windows"
          ? t.assetId
          : t.kind === "container"
            ? t.containerId
            : t.softwareId,
      inputId = t.kind === "windows" ? t.snapshotId : t.versionId,
      key = `${kind}:${id}`,
      old = previous.get(key);
    previous.set(key, job);
    const valid = job.status === "succeeded" && job.result,
      oldInput = old
        ? old.target.kind === "windows"
          ? old.target.snapshotId
          : old.target.versionId
        : null,
      inputChanged = !!old && oldInput !== inputId,
      coverageChanged =
        !!old && old.result?.coverage.status !== job.result?.coverage.status;
    return {
      assessmentId: job.id,
      kind,
      objectId: id,
      inputId,
      at: job.createdAt,
      status: job.status,
      uniqueObserved: valid
        ? new Set(job.result!.findings.map((f) => f.vulnerabilityId)).size
        : null,
      instances: valid ? job.result!.findings.length : null,
      coverage: job.result?.coverage.status ?? "unknown",
      databaseFreshness: job.result?.database.freshness ?? "unknown",
      inputChanged,
      coverageChanged,
      comparableWithPrevious:
        !!old &&
        !inputChanged &&
        old.status === "succeeded" &&
        job.status === "succeeded" &&
        old.result?.coverage.status === "complete_for_declared_input" &&
        job.result?.coverage.status === "complete_for_declared_input" &&
        old.toolVersion !== null &&
        job.toolVersion !== null &&
        old.toolVersion === job.toolVersion &&
        old.result.database.updatedAt !== null &&
        job.result.database.updatedAt !== null &&
        JSON.stringify(old.result.database) ===
          JSON.stringify(job.result.database),
    };
  });
}
