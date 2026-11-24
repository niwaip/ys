import { scannerMatch, sourceVersion } from "./scanner-match";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import type {
  AssessmentResult,
  TrivyExecution,
  VulnerabilityFinding,
} from "../../../../packages/contracts/assessments";
import type { SoftwareComponent } from "../../../../packages/contracts/software";
const pkg = z
  .object({
    Name: z.string(),
    Version: z.string(),
    Epoch: z.number().int().nonnegative().optional(),
    Release: z.string().optional(),
    Arch: z.string().optional(),
    Identifier: z
      .object({ PURL: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const vulnerability = z
  .object({
    VulnerabilityID: z.string().min(1),
    PkgName: z.string().min(1),
    InstalledVersion: z.string(),
    Severity: z.string(),
    FixedVersion: z.string().optional(),
    PrimaryURL: z.string().optional(),
    PkgIdentifier: z
      .object({ PURL: z.string().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();
const schema = z
  .object({
    SchemaVersion: z.literal(2),
    Results: z.array(
      z
        .object({
          Target: z.string(),
          Class: z.string().optional(),
          Type: z.string(),
          Packages: z.array(pkg).optional(),
          Vulnerabilities: z.array(vulnerability).optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();
export function normalizeTrivy(
  execution: TrivyExecution,
  components: SoftwareComponent[],
  linuxOs?: { id: string; version: string },
): AssessmentResult {
  let json: unknown;
  try {
    json = JSON.parse(execution.rawReport ?? "");
  } catch {
    throw Error("Trivy 输出不是有效 JSON");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success)
    throw Error("Trivy 输出结构不兼容；需要 SchemaVersion 2 及 Results");
  if (linuxOs) {
    const metadata = (
      json as {
        Metadata?: { OS?: { Family?: string; Name?: string; EOSL?: boolean } };
      }
    ).Metadata;
    if (
      metadata?.OS?.Family !== linuxOs.id ||
      metadata?.OS?.Name !== linuxOs.version
    )
      throw Error("Trivy识别的发行版与固定输入不一致，未保存成功判定");
  }
  const issues: string[] = linuxOs
    ? [
        "仅扫描该快照已安装dpkg系统包；不含应用依赖、容器内部、挂载卷及运行内核适用性验证。包清单被读取不代表每个包均有厂商漏洞匹配，第三方包可能被跳过",
      ]
    : [
        "第三方 SBOM 可能缺少 Trivy 专有属性；覆盖仅针对已声明组件，不证明全部软件或运行环境安全",
      ];
  const matched = new Set<string>();
  const findings: VulnerabilityFinding[] = [];
  const match = (
    name: string,
    version: string,
    purl?: string,
    architecture?: string,
  ) => {
    const candidates = components.filter(
      (c) =>
        c.name === name &&
        c.version === version &&
        (!linuxOs || !architecture || c.raw.architecture === architecture) &&
        (!!linuxOs || !purl || c.purl === purl),
    );
    return candidates.length === 1 ? candidates[0] : null;
  };
  for (const r of parsed.data.Results) {
    for (const p of r.Packages ?? []) {
      // Native dpkg output splits Debian version into epoch/upstream/revision.
      const version = linuxOs
        ? `${p.Epoch ? `${p.Epoch}:` : ""}${p.Version}${p.Release ? `-${p.Release}` : ""}`
        : p.Version;
      const c = match(p.Name, version, p.Identifier?.PURL, p.Arch);
      if (c && c.version && (c.purl || linuxOs)) matched.add(c.id);
    }
    for (const v of r.Vulnerabilities ?? []) {
      let architecture: string | undefined;
      if (linuxOs && v.PkgIdentifier?.PURL) {
        try {
          architecture =
            new URL(v.PkgIdentifier.PURL).searchParams.get("arch") ?? undefined;
        } catch {
          /* Unparseable package identity remains unknown. */
        }
      }
      const c = match(
        v.PkgName,
        v.InstalledVersion,
        v.PkgIdentifier?.PURL,
        architecture,
      );
      if (!c) issues.push(`发现 ${v.VulnerabilityID} 无法唯一关联输入组件`);
      const packages = r.Packages?.filter(
        (p) =>
          p.Name === v.PkgName && (!architecture || p.Arch === architecture),
      );
      const source = packages?.length === 1 ? packages[0] : undefined;
      findings.push({
        id: randomUUID(),
        componentId: c?.id ?? null,
        target: r.Target,
        ecosystem: r.Type,
        packageName: v.PkgName,
        installedVersion: v.InstalledVersion,
        vulnerabilityId: v.VulnerabilityID,
        severity: v.Severity,
        fixedVersion: v.FixedVersion || null,
        primaryUrl: v.PrimaryURL || null,
        applicability: "tool_reported",
        match: scannerMatch(
          v,
          (linuxOs ? c?.raw.source : undefined) ?? source?.SrcName,
          sourceVersion(source),
        ),
        evidence: v,
      });
    }
  }
  if (!parsed.data.Results.length)
    issues.push("工具未提供扫描目标，不能确认组件已评估");
  if (matched.size < components.length)
    issues.push(
      `${components.length - matched.size} 个输入组件没有可核实的包覆盖证据`,
    );
  if (!components.length) issues.push("输入组件清单为空，无法声明评估覆盖");
  if (components.some((c) => !c.version || (!c.purl && !linuxOs)))
    issues.push("存在未知版本或生态的组件");
  const before = execution.databaseBefore,
    after = execution.databaseAfter;
  const validDate = (v: unknown) =>
    typeof v === "string" && Number.isFinite(Date.parse(v))
      ? new Date(v).toISOString()
      : null;
  const updatedAt = validDate(after?.UpdatedAt),
    nextUpdate = validDate(after?.NextUpdate),
    changed = JSON.stringify(before) !== JSON.stringify(after);
  const freshness =
    !nextUpdate || !updatedAt
      ? "unknown"
      : Date.parse(execution.finishedAt) > Date.parse(nextUpdate)
        ? "stale"
        : "fresh";
  if (freshness !== "fresh")
    issues.push(
      freshness === "stale" ? "漏洞数据库已过期" : "漏洞数据库时间未知",
    );
  if (changed) issues.push("执行期间数据库元数据发生变化，不能固定单一库版本");
  return {
    outcome: findings.length ? "findings" : "no_findings",
    findings,
    coverage: {
      status: !parsed.data.Results.length
        ? "unknown"
        : !linuxOs &&
            components.length > 0 &&
            matched.size === components.length &&
            !components.some((c) => !c.version || (!c.purl && !linuxOs)) &&
            !changed &&
            findings.every((f) => f.componentId !== null)
          ? "complete_for_declared_input"
          : "partial",
      inputComponents: components.length,
      matchedComponents: matched.size,
      issues,
    },
    database: { freshness, updatedAt, nextUpdate, changedDuringScan: changed },
    parserVersion: "trivy-json-v1",
  };
}
