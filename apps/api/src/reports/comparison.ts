import type { ReportFacts } from "../../../../packages/contracts/reports";
import type { AnyAssessment } from "../../../../packages/contracts/assessments";
import type {
  ComparisonBase,
  ReportComparison,
} from "../../../../packages/contracts/report-comparison";
import { hashJson } from "../persistence/hash-json";
function identity(a: AnyAssessment) {
  const target = a.target;
  const objectId =
    target.kind === "software"
      ? target.softwareId
      : target.kind === "container"
        ? target.containerId
        : target.assetId;
  const versionId =
    target.kind === "windows" || target.kind === "linux"
      ? target.snapshotId
      : target.versionId;
  return { key: JSON.stringify([target.kind, objectId, versionId]), objectId };
}
function capability(a: AnyAssessment) {
  return hashJson({
    kind: a.target.kind,
    parser: a.result?.parserVersion,
    coverage: a.result?.coverage.status,
    ruleHash: "ruleHash" in a.input ? a.input.ruleHash : null,
  });
}
export function compareReports(
  current: ReportFacts,
  base: ComparisonBase,
): ReportComparison {
  const nowHosts = current.center?.hosts.map((h) => h.assetId) ?? [];
  const output: ReportComparison = {
    baseline: {
      reportId: base.reportId,
      revisionId: base.revisionId,
      factHash: base.factHash,
    },
    addedHostIds: nowHosts.filter((id) => !base.hostIds.includes(id)),
    removedHostIds: base.hostIds.filter((id) => !nowHosts.includes(id)),
    incomparable: [],
    added: [],
    persistent: [],
    changed: [],
    notObserved: [],
  };
  const before = new Map(
    base.facts.assessmentSnapshots.map((a) => [identity(a).key, a]),
  );
  const after = new Map(
    current.assessmentSnapshots.map((a) => [identity(a).key, a]),
  );
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key),
      now = after.get(key),
      sample = now ?? old!;
    if (output.removedHostIds.includes(identity(sample).objectId)) continue;
    if (
      !old?.result ||
      !now?.result ||
      old.status !== "succeeded" ||
      now.status !== "succeeded" ||
      capability(old) !== capability(now)
    ) {
      output.incomparable.push(
        `${key}：资料版本、评估能力、覆盖或可用状态不同，不推断新增或修复`,
      );
      continue;
    }
    const findingKey = (
      v: NonNullable<AnyAssessment["result"]>["findings"][number],
    ) =>
      JSON.stringify([
        v.vulnerabilityId,
        v.packageName,
        v.installedVersion,
        v.ecosystem,
        v.target,
        v.componentId,
      ]);
    const oldRows = new Map(old.result.findings.map((v) => [findingKey(v), v]));
    const nowRows = new Map(now.result.findings.map((v) => [findingKey(v), v]));
    for (const row of new Set([...oldRows.keys(), ...nowRows.keys()])) {
      const a = oldRows.get(row),
        b = nowRows.get(row),
        label = `${key} / ${row}`;
      if (!a) output.added.push(label);
      else if (!b) output.notObserved.push(label);
      else if (
        hashJson([a.severity, a.applicability, a.fixedVersion]) !==
        hashJson([b.severity, b.applicability, b.fixedVersion])
      )
        output.changed.push(label);
      else output.persistent.push(label);
    }
  }
  return output;
}
