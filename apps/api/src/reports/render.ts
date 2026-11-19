import { BadRequestException } from "@nestjs/common";
import { z } from "zod";
import { createHash } from "node:crypto";
export function hashFacts(facts: ReportFacts): string {
  const canonical = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(canonical)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.entries(v)
              .filter(([, value]) => value !== undefined)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, value]) => [key, canonical(value)]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(canonical(facts)))
    .digest("hex");
}
import type {
  ReportFacts,
  ReportNarrative,
  ReportRevision,
} from "../../../../packages/contracts/reports";
export function defaultNarrative(facts: ReportFacts): ReportNarrative {
  return {
    schemaVersion: "controlled-paragraphs-v1",
    density: "standard",
    blocks: [
      { templateId: "scope", wording: "standard" },
      ...facts.assessmentSnapshots.map((a) => ({
        templateId: "assessment" as const,
        factRef: a.id,
        wording: "standard" as const,
      })),
      ...facts.lifecycleSnapshots.map((a) => ({
        templateId: "lifecycle" as const,
        factRef: a.id,
        wording: "standard" as const,
      })),
      { templateId: "coverage", wording: "standard" },
      { templateId: "evidence", wording: "standard" },
    ],
  };
}
/** Shared T14/T15 boundary: only reorder protected paragraphs and select approved wording; never accept free factual prose or HTML. */
export function validateNarrative(
  facts: ReportFacts,
  input: unknown,
): ReportNarrative {
  const parsed = z
    .object({
      schemaVersion: z.literal("controlled-paragraphs-v1"),
      density: z.enum(["standard", "compact"]),
      blocks: z
        .array(
          z
            .object({
              templateId: z.enum([
                "scope",
                "assessment",
                "lifecycle",
                "coverage",
                "evidence",
              ]),
              factRef: z.uuid().optional(),
              wording: z.enum(["standard", "concise"]),
            })
            .strict(),
        )
        .max(43),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success)
    throw new BadRequestException("报告段落只能使用受控模板和事实引用");
  const key = (x: { templateId: string; factRef?: string }) =>
    `${x.templateId}:${x.factRef ?? ""}`;
  const expected = defaultNarrative(facts).blocks.map(key).sort();
  const actual = parsed.data.blocks.map(key).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new BadRequestException(
      "段落事实引用不符、重复或缺少必要范围/覆盖/证据",
    );
  return parsed.data;
}
export const escapeHtml = (value: unknown) =>
  String(value ?? "未知").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function renderReport(revision: ReportRevision): string {
  if (hashFacts(revision.facts) !== revision.factHash)
    throw new BadRequestException("报告事实校验失败");
  const f = revision.facts;
  const narrative = validateNarrative(f, revision.narrative);
  const h = escapeHtml;
  const sections = narrative.blocks
    .map((block) => {
      if (block.templateId === "scope")
        return `<section><h2>明确报告范围</h2><p>客户 ${h(f.customerId)}；事实生成时间 ${h(f.generatedAt)}。</p><ul>${f.scope.map((t) => `<li>${h(t.kind)} ${h(t.name)} / ${h(t.version)}；对象 ${h(t.objectId)}；输入版本 ${h(t.versionId)}</li>`).join("")}</ul><p>工具发现条目 ${h(f.statistics.findingInstances)}；唯一 CVE 标识 ${h(f.statistics.uniqueCveCount)}。这些数字仅统计所选评估记录，不能解释为已确认受影响资产数。</p><p>严重程度（工具原值）：${h(JSON.stringify(f.statistics.severityCounts))}。生命周期匹配：精确 ${h(f.statistics.lifecycleExact)} / 弱 ${h(f.statistics.lifecycleWeak)} / 未匹配 ${h(f.statistics.lifecycleUnmatched)}。</p></section>`;
      if (block.templateId === "assessment") {
        const a = f.assessmentSnapshots.find((a) => a.id === block.factRef)!;
        return `<section><h2>${block.wording === "concise" ? "CVE 结果" : "CVE 软件评估"}</h2><p>评估 ${h(a.id)}；执行状态 ${h(a.status)}；输入版本 ${h(a.target.versionId)} / ${h(a.input.version)}；执行时间 ${h(a.finishedAt)}。</p>${a.result ? `<p>覆盖 ${h(a.result.coverage.status)}，输入组件 ${a.result.coverage.inputComponents} / 匹配组件 ${a.result.coverage.matchedComponents}；库新鲜度 ${h(a.result.database.freshness)}；库更新时间 ${h(a.result.database.updatedAt)}；下次更新 ${h(a.result.database.nextUpdate)}。零发现仅表示该输入与覆盖范围内未返回条目。</p><ul>${a.result.findings.map((v) => `<li><strong>${h(v.vulnerabilityId)}</strong> · ${h(v.severity)} · ${h(v.packageName)} / ${h(v.installedVersion)}；修复版本资料 ${h(v.fixedVersion)}；适用性 ${h(v.applicability)}；组件 ${h(v.componentId)}。工具返回不等于人工确认受影响。</li>`).join("")}</ul>` : `<p>未取得可用 CVE 结果；不能解释为零漏洞。${h(a.error)}</p>`}</section>`;
      }
      if (block.templateId === "lifecycle") {
        const a = f.lifecycleSnapshots.find((a) => a.id === block.factRef)!;
        return `<section><h2>${block.wording === "concise" ? "生命周期结果" : "EOS/EOL 独立评估"}</h2><p>评估 ${h(a.id)}；批次 ${h(a.batchId)}；时间 ${h(a.evaluatedAt)}；规则 ${h(a.ruleVersion)}。</p>${a.items.map((item) => `<article><h3>${h(item.name)} / ${h(item.version)}</h3><p>产品 ${h(item.product)}；匹配 ${h(item.match)}；核实 ${h(item.verification)}；${h(item.basis)}。版本未知或弱匹配不能解释为已核实阶段状态。</p>${item.evidence.map((e) => `<p>来源 ${h(e.source)} / ${h(e.sourceRef)}，来源行 ${e.row}。EOS：${h(e.eos.name)}，日期 ${h(e.eos.date)}，日期状态 ${h(e.eos.dateStatus)}，原值 ${h(e.eos.rawDate)}，阶段 ${h(e.eos.status)}。EOL：${h(e.eol.name)}，日期 ${h(e.eol.date)}，日期状态 ${h(e.eol.dateStatus)}，原值 ${h(e.eol.rawDate)}，阶段 ${h(e.eol.status)}。${h(e.issues.join("；"))}</p>`).join("")}</article>`).join("")}</section>`;
      }
      if (block.templateId === "coverage")
        return `<section><h2>覆盖缺口与未知</h2><ul>${f.coverageIssues.map((x) => `<li>${h(x)}</li>`).join("")}</ul><p>未评估、失败、未知、未匹配与完整覆盖下零发现各自独立。评估时间不能替代未知日期；CVE 结果不提供 EOS/EOL。来源日期未设置统一时效阈值，不自动断言资料为最新。</p></section>`;
      return `<section><h2>来源证据</h2><ul>${f.sourceRefs.map((r) => `<li>${h(r.kind)}：评估 ${h(r.id)}；输入 ${h(r.inputId)}；SHA-256 ${h(r.contentHash)}；规则 ${h(r.ruleVersion)}；接入时间 ${h(r.importedAt)}；来源采集时间 ${h(r.collectedAt)}；评估时间 ${h(r.evaluatedAt)}；工具 ${h(r.toolVersion)}</li>`).join("")}</ul><p>事实SHA-256 ${h(revision.factHash)}；模板 ${h(revision.templateVersion)}。</p></section>`;
    })
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>风险事实报告草稿</title><style>body{font:16px/${narrative.density === "compact" ? "1.4" : "1.7"} system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#172632}section{border-top:1px solid #ccd7df;padding:20px 0}p,li{overflow-wrap:anywhere}.draft{color:#8b4600;background:#fff3d6;padding:16px}</style></head><body><h1>客户风险事实报告</h1><p class="draft">草稿 · 尚未内部复核，不代表正式交付</p><p>报告 ${h(revision.reportId)}；修订 ${h(revision.id)} / ${revision.number}；作者 ${h(revision.createdBy)}；状态 ${h(revision.status)}。</p>${sections}</body></html>`;
}
