import { resolveNarration } from "../../../../packages/contracts/report-language";
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
      ...(facts.assessmentSnapshots.length
        ? facts.assessmentSnapshots.map((a) => ({
            templateId: "assessment" as const,
            factRef: a.id,
            wording: "standard" as const,
          }))
        : [
            { templateId: "assessment" as const, wording: "standard" as const },
          ]),
      ...(facts.lifecycleSnapshots.length
        ? facts.lifecycleSnapshots.map((a) => ({
            templateId: "lifecycle" as const,
            factRef: a.id,
            wording: "standard" as const,
          }))
        : [{ templateId: "lifecycle" as const, wording: "standard" as const }]),
      { templateId: "coverage", wording: "standard" },
      { templateId: "evidence", wording: "standard" },
    ],
  };
}
/** Shared T14/T15 boundary: protected facts plus a finite, reference-bound prose language. */
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
                "summary",
                "recommendations",
              ]),
              factRef: z.uuid().optional(),
              wording: z.enum(["standard", "concise"]),
              text: z.string().max(4000).optional(),
            })
            .strict(),
        )
        .max(45),
    })
    .strict()
    .safeParse(input);
  if (!parsed.success)
    throw new BadRequestException("报告段落只能使用受控模板和事实引用");
  const key = (x: { templateId: string; factRef?: string }) =>
    `${x.templateId}:${x.factRef ?? ""}`;
  const expected = defaultNarrative(facts).blocks.map(key).sort();
  const extra = parsed.data.blocks.filter(
    (b) => b.templateId === "summary" || b.templateId === "recommendations",
  );
  if (
    extra.some((b) => b.factRef !== undefined) ||
    new Set(extra.map((b) => b.templateId)).size !== extra.length
  )
    throw new BadRequestException(
      "摘要/建议只能使用无事实覆盖的受控模板且不重复",
    );
  const actual = parsed.data.blocks
    .filter(
      (b) => b.templateId !== "summary" && b.templateId !== "recommendations",
    )
    .map(key)
    .sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new BadRequestException(
      "段落事实引用不符、重复或缺少必要范围/覆盖/证据",
    );
  for (const block of parsed.data.blocks) {
    try {
      resolveNarration(block.text ?? "", facts);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }
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
      if (block.templateId === "summary")
        return `<section><h2>事实摘要</h2><p>明确范围包含 ${f.scope.length} 个对象输入版本；结果条目 ${h(f.statistics.findingInstances)}；唯一CVE ${h(f.statistics.uniqueCveCount)}。未知、失败、弱匹配和覆盖缺口需结合下方明细解读，不能据摘要判断无风险。</p></section>`;
      if (block.templateId === "recommendations")
        return "<section><h2>后续核查建议</h2><p>依据选定版本、来源和覆盖缺口安排核查；补充未知版本、日期及完整性证据后重新评估。修复资料须经变更评审验证，本建议不表示已经修复或已确认安全。</p></section>";
      if (block.templateId === "scope")
        return `<section><h2>明确报告范围</h2><p>客户 ${h(f.customerId)}；事实生成时间 ${h(f.generatedAt)}。</p><ul>${f.scope.map((t) => `<li>${h(t.kind)} ${h(t.name)} / ${h(t.version)}；对象 ${h(t.objectId)}；输入版本 ${h(t.versionId)}；来源身份 ${h(t.sourceIdentity ? JSON.stringify(t.sourceIdentity) : "未提供附加身份")}</li>`).join("")}</ul><p>评估结果条目 ${h(f.statistics.findingInstances)}；唯一 CVE 标识 ${h(f.statistics.uniqueCveCount)}。这些数字仅统计所选评估记录，不能解释为已确认受影响资产数。</p><p>适用性分布 ${h(JSON.stringify(f.statistics.applicabilityCounts ?? {}))}；明确affected条目 ${h(f.statistics.confirmedAffectedCount)}（其他状态不计入，不表示其无风险）。严重程度（评估原值）：${h(JSON.stringify(f.statistics.severityCounts))}。生命周期匹配：精确 ${h(f.statistics.lifecycleExact)} / 弱 ${h(f.statistics.lifecycleWeak)} / 未匹配 ${h(f.statistics.lifecycleUnmatched)}。</p></section>`;
      if (block.templateId === "assessment") {
        const a = f.assessmentSnapshots.find((a) => a.id === block.factRef);
        if (!a)
          return "<section><h2>CVE 软件评估</h2><p>未选择CVE评估，未评估；发现数量未知，不能解释为零漏洞。</p></section>";
        return `<section><h2>${block.wording === "concise" ? "CVE 结果" : a.target.kind === "windows" ? "CVE Windows补丁评估" : a.target.kind === "container" ? "CVE 容器镜像评估" : a.target.kind === "linux" ? "CVE Linux系统包评估" : "CVE 软件评估"}</h2><p>评估 ${h(a.id)}；执行状态 ${h(a.status)}；目标类型 ${h(a.target.kind)}；输入版本 ${h(a.target.kind === "windows" || a.target.kind === "linux" ? a.target.snapshotId : a.target.versionId)} / ${h("version" in a.input ? a.input.version : "Windows采集快照")}；执行时间 ${h(a.finishedAt)}。</p>${"provenance" in a.input && a.input.provenance ? `<p>固定主机关联来源（操作员声明）：${h(JSON.stringify(a.input.provenance))}。该关联不扩大SBOM扫描覆盖。</p>` : ""}${a.target.kind === "container" ? "<p>容器镜像资料不证明任何运行实例采用该镜像。</p>" : ""}${a.result && "rules" in a.result ? `<p>Windows offline_curated_rules：人工收录规则，仅部分覆盖，不声称完整Microsoft feed。规则 ${h(JSON.stringify(a.result.rules))}</p>` : ""}${a.result ? `<p>覆盖 ${h(a.result.coverage.status)}，输入组件 ${a.result.coverage.inputComponents} / 匹配组件 ${a.result.coverage.matchedComponents}；库新鲜度 ${h(a.result.database.freshness)}；库更新时间 ${h(a.result.database.updatedAt)}；下次更新 ${h(a.result.database.nextUpdate)}。零发现仅表示该输入与覆盖范围内未返回条目。</p>${a.result.findings.length > 100 ? `<details><summary>完整漏洞明细（${a.result.findings.length}条，展开查看）</summary>` : ""}<ul>${a.result.findings.map((v) => `<li><strong>${h(v.vulnerabilityId)}</strong> · ${h(v.severity)} · ${h(v.packageName)} / ${h(v.installedVersion)}；修复版本资料 ${h(v.fixedVersion)}；适用性 ${h(v.applicability)}；组件 ${h(v.componentId)}。原始适用性独立呈现：fixed/unknown/potentially_affected/tool_reported 不计入 affected。证据 ${h(JSON.stringify(v.evidence))}。</li>`).join("")}</ul>${a.result.findings.length > 100 ? "</details>" : ""}` : `<p>未取得可用 CVE 结果；不能解释为零漏洞。${h(a.error)}</p>`}</section>`;
      }
      if (block.templateId === "lifecycle") {
        const a = f.lifecycleSnapshots.find((a) => a.id === block.factRef);
        if (!a)
          return "<section><h2>EOS/EOL 独立评估</h2><p>未选择生命周期评估，未评估；不能使用CVE结果或评估时间填补阶段日期。</p></section>";
        return `<section><h2>${block.wording === "concise" ? "生命周期结果" : "EOS/EOL 独立评估"}</h2><p>评估 ${h(a.id)}；批次 ${h(a.batchId)}；时间 ${h(a.evaluatedAt)}；规则 ${h(a.ruleVersion)}。</p>${a.items.map((item) => `<article><h3>${h(item.name)} / ${h(item.version)}</h3><p>产品 ${h(item.product)}；匹配 ${h(item.match)}；核实 ${h(item.verification)}；${h(item.basis)}。版本未知或弱匹配不能解释为已核实阶段状态。</p>${item.evidence.map((e) => `<p>来源 ${h(e.source)} / ${h(e.sourceRef)}，来源行 ${e.row}。EOS：${h(e.eos.name)}，日期 ${h(e.eos.date)}，日期状态 ${h(e.eos.dateStatus)}，原值 ${h(e.eos.rawDate)}，阶段 ${h(e.eos.status)}。EOL：${h(e.eol.name)}，日期 ${h(e.eol.date)}，日期状态 ${h(e.eol.dateStatus)}，原值 ${h(e.eol.rawDate)}，阶段 ${h(e.eol.status)}。${h(e.issues.join("；"))}</p>`).join("")}</article>`).join("")}</section>`;
      }
      if (block.templateId === "coverage")
        return `<section><h2>覆盖缺口与未知</h2><ul>${f.coverageIssues.map((x) => `<li>${h(x)}</li>`).join("")}</ul><p>未评估、失败、未知、未匹配与完整覆盖下零发现各自独立。评估时间不能替代未知日期；CVE 结果不提供 EOS/EOL。来源日期未设置统一时效阈值，不自动断言资料为最新。</p></section>`;
      return `<section><h2>来源证据</h2><ul>${f.sourceRefs.map((r) => `<li>${h(r.kind)}：评估 ${h(r.id)}；输入 ${h(r.inputId)}；SHA-256 ${h(r.contentHash)}；原始输出SHA-256 ${h(r.outputHash)}；规则 ${h(r.ruleVersion)}；接入时间 ${h(r.importedAt)}；来源采集时间 ${h(r.collectedAt)}；评估时间 ${h(r.evaluatedAt)}；工具 ${h(r.toolVersion)}</li>`).join("")}</ul><p>事实SHA-256 ${h(revision.factHash)}；模板 ${h(revision.templateVersion)}。</p></section>`;
    })
    .map((section, index) => {
      const text = resolveNarration(narrative.blocks[index].text ?? "", f);
      return text
        ? section.replace(
            "</section>",
            `<p class="narration">${h(text)}</p></section>`,
          )
        : section;
    })
    .join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${revision.status === "delivered" ? "已复核风险报告" : "风险事实报告草稿"}</title><style>body{font:16px/${narrative.density === "compact" ? "1.4" : "1.7"} system-ui;max-width:1100px;margin:40px auto;padding:0 24px;color:#172632}section{border-top:1px solid #ccd7df;padding:20px 0}p,li{overflow-wrap:anywhere}.draft{color:#8b4600;background:#fff3d6;padding:16px}</style></head><body><h1>客户风险事实报告</h1><p class="draft">${revision.status === "delivered" ? "正式交付 · 已内部复核" : revision.status === "approved" ? "已通过复核 · 尚未正式交付" : revision.status === "in_review" ? "待复核草稿 · 不代表正式交付" : "草稿 · 尚未内部复核，不代表正式交付"}</p><p>报告 ${h(revision.reportId)}；修订 ${h(revision.id)} / ${revision.number}；作者 ${h(revision.createdBy)}；状态 ${h(revision.status)}。</p>${revision.approvedAt ? `<p>复核人 ${h(revision.approvedBy)}；复核时间 ${h(revision.approvedAt)}；交付人 ${h(revision.deliveredBy)}；交付时间 ${h(revision.deliveredAt)}</p>` : ""}${sections}</body></html>`;
}
