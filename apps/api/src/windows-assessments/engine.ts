import { BadRequestException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { WindowsSnapshot } from "../../../../packages/contracts/windows";
import type {
  WindowsAssessmentResult,
  WindowsFinding,
} from "../../../../packages/contracts/windows-assessments";
const kb = z.string().regex(/^KB\d+$/);
const refs = z.array(z.string().min(1).max(100)).min(1).max(100);
const source = z
  .object({
    id: z.string().min(1).max(100),
    url: z.url().refine((v) => {
      const u = new URL(v);
      return (
        u.protocol === "https:" &&
        [
          "msrc.microsoft.com",
          "api.msrc.microsoft.com",
          "support.microsoft.com",
        ].includes(u.hostname) &&
        !u.username &&
        !u.password
      );
    }),
    retrievedAt: z.iso.datetime({ offset: true }),
    content: z.string().min(1).max(200000),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const ruleSchema = z
  .object({
    schemaVersion: z.literal("1"),
    ruleVersion: z.string().trim().min(1).max(100),
    product: z.literal("Windows Server 2022"),
    branch: z.literal(20348),
    architecture: z.literal("x64"),
    scope: z.string().trim().min(1).max(2000),
    sources: z.array(source).min(1).max(100),
    advisories: z
      .array(
        z
          .object({
            cve: z.string().regex(/^CVE-\d{4}-\d{4,}$/),
            severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "UNKNOWN"]),
            fixedUbr: z.number().int().nonnegative().max(99999999),
            fixedKbs: z.array(kb).min(1).max(100),
            affectedBeforeFixed: z.boolean(),
            sourceIds: refs,
          })
          .strict(),
      )
      .min(1)
      .max(1000),
    supersedence: z
      .array(
        z
          .object({ supersededKb: kb, replacementKb: kb, sourceIds: refs })
          .strict(),
      )
      .max(1000),
  })
  .strict();
export type WindowsRules = z.infer<typeof ruleSchema>;
export function parseRules(content: string) {
  let raw: unknown;
  try {
    raw = JSON.parse(content.replace(/^\uFEFF/, ""));
  } catch {
    throw new BadRequestException("规则 JSON 无效");
  }
  const r = ruleSchema.safeParse(raw);
  if (!r.success) throw new BadRequestException("规则格式/产品线/来源字段无效");
  const rules = r.data;
  const ids = new Set(rules.sources.map((s) => s.id));
  if (
    ids.size !== rules.sources.length ||
    new Set(rules.advisories.map((a) => a.cve)).size !== rules.advisories.length
  )
    throw new BadRequestException("规则来源或 CVE 标识重复");
  for (const s of rules.sources)
    if (createHash("sha256").update(s.content).digest("hex") !== s.sha256)
      throw new BadRequestException("规则来源内容哈希不匹配");
  for (const r of [...rules.advisories, ...rules.supersedence])
    if (r.sourceIds.some((id) => !ids.has(id)))
      throw new BadRequestException("规则引用不存在来源");
  return rules;
}
export function evaluateWindows(
  host: WindowsSnapshot,
  rules: WindowsRules,
  provenance: { importId: string; contentHash: string },
): WindowsAssessmentResult {
  const matched =
    /^(?:Microsoft\s+)?Windows Server 2022(?: (?:Standard|Datacenter)(?: Evaluation)?)?$/i.test(
      host.os ?? "",
    ) &&
    host.osBuild === "20348" &&
    ["x64", "64-bit", "amd64"].includes(
      (host.architecture ?? "").toLowerCase(),
    );
  const overall = String(host.collectionStatus?.Overall ?? "").toUpperCase();
  const complete =
    host.kbs !== null &&
    !Object.values(host.collectionStatus ?? {}).some((v) =>
      ["FAILED", "PARTIAL"].includes(String(v).toUpperCase()),
    ) &&
    host.kbInventoryComplete === true &&
    host.rebootPending === false &&
    ["COMPLETE", "SUCCESS", "SUCCEEDED"].includes(overall) &&
    host.collectedAt !== null;
  const issues = [
    "仅覆盖所上传人工整理规则；不是完整或最新 Windows 漏洞库",
    "来源内容哈希已核对；未联网核实上传内容真实性",
  ];
  if (!matched) issues.push("产品、20348 分支或 x64 架构无法确认");
  if (!complete)
    issues.push("采集完整性、采集时间或重启状态不足；不能确认已修复");
  const installed = new Set(host.kbs ?? []);
  function replacement(fixedKbs: string[]) {
    const seen = new Set(fixedKbs),
      queue = fixedKbs.map((kb) => ({
        kb,
        path: [] as typeof rules.supersedence,
      }));
    while (queue.length) {
      const current = queue.shift()!;
      if (installed.has(current.kb)) return current;
      for (const edge of rules.supersedence)
        if (edge.supersededKb === current.kb && !seen.has(edge.replacementKb)) {
          seen.add(edge.replacementKb);
          queue.push({ kb: edge.replacementKb, path: [...current.path, edge] });
        }
    }
    return null;
  }
  const findings = rules.advisories.map<WindowsFinding>((a) => {
    const patch = replacement(a.fixedKbs);
    const buildKnown = host.ubr !== null;
    const buildFixed = buildKnown && host.ubr! >= a.fixedUbr;
    let applicability:
        "unknown" | "potentially_affected" | "affected" | "fixed" = "unknown",
      basis = "insufficient_evidence";
    if (matched) {
      if (complete && (patch || buildFixed)) {
        applicability = "fixed";
        basis = patch
          ? patch.path.length
            ? "qualified_supersedence"
            : "installed_exact_kb"
          : "same_branch_build";
      } else if (buildKnown && !buildFixed && !patch) {
        applicability =
          complete && a.affectedBeforeFixed
            ? "affected"
            : "potentially_affected";
        basis =
          applicability === "affected"
            ? "source_declared_affected_build"
            : "lower_build_incomplete_evidence";
      }
    }
    return {
      id: a.cve,
      vulnerabilityId: a.cve,
      severity: a.severity,
      applicability,
      componentId: null,
      target: "Windows Server 2022",
      ecosystem: "windows",
      packageName: "Windows Server 2022",
      installedVersion:
        host.ubr === null
          ? (host.osBuild ?? "unknown")
          : `${host.osBuild}.${host.ubr}`,
      fixedVersion: `20348.${a.fixedUbr}`,
      primaryUrl: rules.sources.find((s) => s.id === a.sourceIds[0])!.url,
      evidence: {
        basis,
        observed: {
          os: host.os,
          build: host.osBuild,
          ubr: host.ubr,
          kbs: host.kbs,
          collectedAt: host.collectedAt,
          collectionStatus: host.collectionStatus,
          kbInventoryComplete: host.kbInventoryComplete,
          rebootPending: host.rebootPending,
        },
        fixedKbs: a.fixedKbs,
        matchedKb: patch?.kb ?? null,
        supersedencePath: patch?.path ?? [],
        sourceIds: a.sourceIds,
        affectedBeforeFixed: a.affectedBeforeFixed,
      },
    };
  });
  return {
    outcome: "findings" as const,
    findings,
    coverage: {
      status: "partial" as const,
      inputComponents: 1,
      matchedComponents: matched ? 1 : 0,
      issues,
    },
    database: {
      freshness: "unknown" as const,
      updatedAt: null,
      nextUpdate: null,
      changedDuringScan: false,
    },
    parserVersion: "windows-evidence-v1",
    rules: {
      ...provenance,
      version: rules.ruleVersion,
      scope: rules.scope,
      product: rules.product,
      branch: rules.branch,
      architecture: rules.architecture,
      sources: rules.sources.map(({ content, ...s }) => ({
        ...s,
        verifiedOnline: false,
      })),
    },
  };
}
