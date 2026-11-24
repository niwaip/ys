import type { ReportFacts } from "../../../../packages/contracts/reports";
import {
  riskTypeLabels,
  levelLabels,
} from "../../../../packages/contracts/lifecycle-risk";
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
      `<section><h2>整改建议</h2><p>先补齐缺失或过期资料，再依据下方来源和修复版本核对变更。业务重要性未提供，优先级需由资产责任人确认；报告不声明已经修复。</p></section>`,
    );
  return parts.join("");
}
