import type { ReportFacts } from "../../../../packages/contracts/reports";
import {
  riskTypeLabels,
  levelLabels,
} from "../../../../packages/contracts/lifecycle-risk";
import { remediation } from "./remediation";
import { escapeHtml as h, table } from "./html";

import type { ReportPresentation } from "../../../../packages/contracts/report-presentation";

export function renderCenterScope(
  facts: ReportFacts,
  presentation?: ReportPresentation,
): string {
  const center = facts.center;
  if (!center) return "";
  const life = center.lifecycle;
  const hasLife = !!life?.items.some(
    (item) => !["missing", "conflict", "unassessed"].includes(item.level),
  );
  const title =
    facts.statistics.findingInstances === null &&
    !facts.lifecycleSnapshots.length &&
    !hasLife
      ? "执行与覆盖说明"
      : "服务器报告范围";
  const byId = new Map(center.hosts.map((host) => [host.assetId, host.name]));
  const parts = [
    ...(center.sourceReport
      ? [
          `<p>来源报告 ${h(center.sourceReport.reportId)} / 修订 ${h(center.sourceReport.revisionId)}；来源事实 SHA-256 ${h(center.sourceReport.factHash)}。本报告采用新结果形成独立固定事实。</p>`,
        ]
      : []),
    `<section><h2>${title}</h2><p>${h(center.name)}；固定服务器 ${center.hosts.length} 台。检查时间 ${h(center.checkedAt)}，新鲜度提醒 ${center.freshnessDays} 天。</p><p>发现实例 ${h(facts.statistics.findingInstances)}；唯一 CVE ${h(facts.statistics.uniqueCveCount)}；涉及服务器 ${h(facts.statistics.involvedHostCount)}；确认受影响服务器 ${h(facts.statistics.confirmedAffectedHostCount)}。关联或工具匹配不等于确认受影响。</p>${table(
      ["服务器", "结果状态", "采集时间", "评估时间", "覆盖及提醒"],
      center.hosts.map((host) => [
        host.name,
        host.status,
        host.collectedAt,
        host.assessedAt,
        host.issues.join("；"),
      ]),
    )}</section>`,
  ];
  if (center.objects?.length)
    parts.push(
      `<section><h2>关联软件与镜像</h2>${table(
        ["对象", "类型", "输入版本", "涉及主机", "关联依据与覆盖"],
        center.objects.map((object) => [
          object.name,
          object.kind,
          object.versionId,
          object.hostIds.map((id) => byId.get(id) ?? id).join("、"),
          `采集 ${object.collectedAt ?? "未知"} / 评估 ${object.assessedAt ?? "未知"}；${object.issues.join("；")}；` +
            object.bindings
              .map(
                (binding) =>
                  `${binding.basis}；${binding.coverage}；来源 ${binding.id}；快照 ${binding.snapshotId ?? "未知"}；SHA-256 ${binding.contentHash}`,
              )
              .join("；"),
        ]),
      )}</section>`,
    );
  if (life && presentation?.topic !== "vulnerability")
    parts.push(
      `<section><h2>生命周期风险</h2><p>固定期限视图 ${h(life.id)}；判定时间 ${h(life.calculatedAt)}；业务日期 ${h(life.localDate)}。CVE 扫描不提供支持或维保日期。</p>${table(
        ["服务器", "风险类型", "等级", "期限", "依据", "来源"],
        life.items.map((item) => [
          item.assetName,
          riskTypeLabels[item.type],
          levelLabels[item.level],
          item.dueDate,
          item.basis,
          item.evidence
            .map(
              (e) => `${e.source} / ${e.sourceRef}；${e.stage}；${e.rawDate}`,
            )
            .join("；"),
        ]),
      )}</section>`,
    );
  if (presentation?.optionalChapters.includes("summary"))
    parts.unshift(
      `<section><h2>管理摘要</h2><p>${h(center.name)}；范围 ${center.hosts.length} 台服务器，可用结果 ${center.hosts.filter((host) => host.status === "available").length} 台，未评估 ${center.hosts.filter((host) => host.status === "unassessed").length} 台。发现实例 ${h(facts.statistics.findingInstances)}；唯一 CVE ${h(facts.statistics.uniqueCveCount)}。范围内无结果与零发现分别呈现；关联或工具匹配不等于确认受影响。</p></section>`,
    );
  if (presentation?.optionalChapters.includes("overview"))
    parts.push(
      `<section><h2>风险总览</h2><p>漏洞严重程度（发现实例）：${h(JSON.stringify(facts.statistics.severityCounts))}。期限风险独立判定，不合成为总分。未评估、未知日期和覆盖缺口见保留章节。</p></section>`,
    );
  if (presentation?.optionalChapters.includes("recommendations"))
    parts.push(
      `<section><h2>整改建议</h2><p>先补齐缺失或过期资料，再依据下方来源和修复版本核对变更。业务重要性未提供，优先级需由资产责任人确认；报告不声明已经修复。按严重程度、确认影响排序展示前 20 项；共 ${remediation(facts).length} 项，完整动作见 XLSX。</p>${table(
        ["漏洞 / 对象", "严重程度 / 适用性", "动作及依据", "来源 / 复测"],
        remediation(facts)
          .slice(0, 20)
          .map((r) => [
            `${r.vulnerabilityId} / ${r.packageName} ${r.installedVersion}`,
            `${r.severity} / ${r.applicability}；业务重要性 ${r.businessImportance}`,
            r.action,
            `${r.source ?? "来源待核实"}；${r.retest}；评估 ${r.assessmentId} / 发现 ${r.findingId}`,
          ]),
      )}</section>`,
    );
  if (center.comparison) {
    const c = center.comparison;
    parts.push(
      `<section><h2>历史对比</h2><p>基准报告 ${h(c.baseline.reportId)} / 修订 ${h(c.baseline.revisionId)}；事实 SHA-256 ${h(c.baseline.factHash)}。仅比较同对象、同输入版本和可比评估能力；未再观察到不等于已修复。</p><p>新增主机 ${c.addedHostIds.length}；移出主机 ${c.removedHostIds.length}（不视为问题消失）。新增 ${c.added.length}；持续 ${c.persistent.length}；变化 ${c.changed.length}；本次未再观察到 ${c.notObserved.length}。</p>${table(["类别", "固定比较明细"], [["新增主机", c.addedHostIds.join("；")], ["移出主机", c.removedHostIds.join("；")], ...c.incomparable.map((x) => ["不可比", x]), ...c.added.map((x) => ["新增", x]), ...c.changed.map((x) => ["变化", x]), ...c.notObserved.map((x) => ["本次未再观察到", x])])}</section>`,
    );
  }
  return parts.join("");
}
