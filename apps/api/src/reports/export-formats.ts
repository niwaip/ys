import { reportStatistics, reportCoverage } from "./fact-summary";
import ExcelJS from "exceljs";
import { chromium } from "playwright";
import type { ReportRevision } from "../../../../packages/contracts/reports";
import { renderReport, hashFacts, defaultNarrative } from "./render";
import { remediation } from "./remediation";

export async function xlsx(revision: ReportRevision): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  book.creator = "YS";
  book.created = new Date(revision.createdAt);
  function sheet(name: string, headers: string[], rows: unknown[][]) {
    const tab = book.addWorksheet(name, {
      views: [{ state: "frozen", ySplit: 1 }],
    });
    tab.addRow(headers);
    for (const row of rows)
      tab.addRow(
        row.map((value) =>
          value === null || value === undefined
            ? "未知"
            : typeof value === "number"
              ? value
              : String(value),
        ),
      );
    tab.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
    tab.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF173F55" },
    };
    tab.columns.forEach((column, index) => {
      column.width = index < 2 ? 30 : 24;
      column.alignment = { vertical: "top", wrapText: true };
    });
    tab.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: Math.max(1, tab.rowCount), column: headers.length },
    };
    return tab;
  }
  const f = revision.facts;
  sheet(
    "说明",
    ["项目", "值"],
    [
      ["报告", revision.reportId],
      [
        "标识",
        revision.status === "delivered" ? "正式交付 · 已复核" : "草稿 · 未复核",
      ],
      ["修订", revision.id],
      ["事实 SHA-256", revision.factHash],
      ["发现实例", f.statistics.findingInstances],
      ["唯一 CVE", f.statistics.uniqueCveCount],
      ["涉及服务器", f.statistics.involvedHostCount],
      ["确认受影响服务器", f.statistics.confirmedAffectedHostCount],
      ["口径", "共享对象发现全局去重；关联不等于确认受影响；未知不填零"],
    ],
  );
  sheet(
    "服务器",
    [
      "服务器 ID",
      "名称",
      "结果状态",
      "采集时间",
      "评估时间",
      "采集新鲜度",
      "评估新鲜度",
      "缺口",
    ],
    (f.center?.hosts ?? []).map((host) => [
      host.assetId,
      host.name,
      host.status,
      host.collectedAt,
      host.assessedAt,
      host.freshness.collection,
      host.freshness.assessment,
      host.issues.join("；"),
    ]),
  );
  sheet(
    "漏洞明细",
    [
      "评估",
      "发现 ID",
      "漏洞标识",
      "组件",
      "安装版本",
      "严重程度",
      "适用性",
      "修复版本依据",
      "来源",
      "组件 ID",
      "涉及服务器 ID",
      "原始证据",
    ],
    f.assessmentSnapshots.flatMap((a) =>
      (a.result?.findings ?? []).map((v) => [
        a.id,
        v.id,
        v.vulnerabilityId,
        v.packageName,
        v.installedVersion,
        v.severity,
        v.applicability,
        v.fixedVersion,
        v.primaryUrl,
        v.componentId,
        f.center?.hosts
          .filter((h) => h.assessmentRefs.includes(a.id))
          .map((h) => h.assetId)
          .join("；"),
        JSON.stringify(v.evidence),
      ]),
    ),
  );
  sheet(
    "关联对象",
    [
      "对象 ID",
      "名称",
      "类型",
      "资料版本",
      "涉及服务器 ID",
      "依据",
      "来源",
      "快照",
      "哈希",
    ],
    (f.center?.objects ?? []).flatMap((o) =>
      o.bindings.map((b) => [
        o.objectId,
        o.name,
        o.kind,
        o.versionId,
        b.assetId,
        b.basis,
        b.id,
        b.snapshotId,
        b.contentHash,
      ]),
    ),
  );
  sheet(
    "生命周期",
    ["服务器 ID", "名称", "风险类型", "等级", "期限", "依据", "来源"],
    (f.center?.lifecycle?.items ?? []).map((i) => [
      i.assetId,
      i.assetName,
      i.type,
      i.level,
      i.dueDate,
      i.basis,
      JSON.stringify(i.evidence),
    ]),
  );
  sheet(
    "产品阶段",
    ["评估", "对象", "名称", "版本", "匹配", "核实", "依据", "来源"],
    f.lifecycleSnapshots.flatMap((a) =>
      a.items.map((i) => [
        a.id,
        i.assetId,
        i.name,
        i.version,
        i.match,
        i.verification,
        i.basis,
        JSON.stringify(i.evidence),
      ]),
    ),
  );
  sheet(
    "整改建议",
    [
      "评估",
      "发现 ID",
      "漏洞标识",
      "严重程度",
      "适用性",
      "业务重要性",
      "动作",
      "修复版本依据",
      "来源",
      "复测",
    ],
    remediation(f).map((r) => [
      r.assessmentId,
      r.findingId,
      r.vulnerabilityId,
      r.severity,
      r.applicability,
      r.businessImportance,
      r.action,
      r.fixedVersion,
      r.source,
      r.retest,
    ]),
  );
  sheet(
    "覆盖与来源",
    ["类别", "内容"],
    [
      ...f.coverageIssues.map((i) => ["覆盖缺口", i]),
      ...f.sourceRefs.map((r) => ["来源", JSON.stringify(r)]),
    ],
  );
  return Buffer.from(await book.xlsx.writeBuffer());
}

export async function pdf(
  html: string,
  mode: "summary" | "full",
): Promise<Buffer> {
  const printStyle =
    "@page{size:A4;margin:18mm 14mm 20mm}body{font-family:'Noto Sans CJK SC','PingFang SC','Microsoft YaHei',sans-serif;font-size:10pt;max-width:none;margin:0;padding:0}h1{font-size:22pt}h2{font-size:15pt;break-after:avoid}h3{break-after:avoid}th{background:#edf3f5}table{table-layout:fixed;font-size:8pt}tr{break-inside:avoid}thead{display:table-header-group}li{margin-bottom:5pt}section{padding:12pt 0}a{color:#173f55}nav{break-after:page}";
  const browser = await chromium.launch({
    headless: true,
    timeout: 15000,
    ...(process.env.REPORT_PDF_CHANNEL
      ? { channel: process.env.REPORT_PDF_CHANNEL }
      : {}),
  });
  const deadline = setTimeout(() => void browser.close(), 120000);
  try {
    const page = await browser.newPage({ javaScriptEnabled: false });
    await page.route("**/*", (route) => route.abort());
    await page.setContent(
      html.replace("</head>", `<style>${printStyle}</style></head>`),
      { waitUntil: "load", timeout: 15000 },
    );
    await page.evaluate((summary) => {
      for (const details of document.querySelectorAll("details"))
        details.open = true;
      if (summary)
        for (const list of document.querySelectorAll("[data-findings]")) {
          const rows = [...list.children];
          const rank: Record<string, number> = {
            CRITICAL: 0,
            HIGH: 1,
            MEDIUM: 2,
            LOW: 3,
          };
          rows.sort(
            (a, b) =>
              (rank[a.getAttribute("data-severity") ?? ""] ?? 4) -
              (rank[b.getAttribute("data-severity") ?? ""] ?? 4),
          );
          for (const row of rows) row.remove();
          for (const row of rows.slice(0, 20)) list.append(row);
          const note = document.createElement("p");
          note.textContent = `摘要 PDF：每个评估按严重程度展示前 20 条；本项共 ${rows.length} 条，未展开 ${Math.max(0, rows.length - 20)} 条。完整明细见 HTML / XLSX，未展开不代表无风险。`;
          list.before(note);
        }
      const nav = document.createElement("nav");
      const title = document.createElement("h2");
      title.textContent = "目录";
      nav.append(title);
      const list = document.createElement("ul");
      [...document.querySelectorAll("h2")].forEach((heading, index) => {
        heading.id = `section-${index}`;
        const item = document.createElement("li");
        const a = document.createElement("a");
        a.href = `#section-${index}`;
        a.textContent = heading.textContent;
        item.append(a);
        list.append(item);
      });
      nav.append(list);
      document.querySelector("h1")?.after(nav);
    }, mode === "summary");
    return await page.pdf({
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate:
        '<div style="font-size:8px;width:100%;text-align:center">YS · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      tagged: true,
      outline: true,
    });
  } finally {
    clearTimeout(deadline);
    await browser.close();
  }
}

export function hostRevision(
  parent: ReportRevision,
  hostId: string,
): ReportRevision {
  const f = structuredClone(parent.facts),
    center = f.center!;
  const host = center.hosts.find((h) => h.assetId === hostId)!;
  center.hosts = [host];
  delete center.comparison;
  center.name = `${center.name} / ${host.name}`;
  center.objects = center.objects
    ?.filter((o) => o.hostIds.includes(hostId))
    .map((o) => ({
      ...o,
      hostIds: [hostId],
      bindings: o.bindings.filter((b) => b.assetId === hostId),
    }));
  if (center.lifecycle)
    center.lifecycle.items = center.lifecycle.items.filter(
      (i) => i.assetId === hostId,
    );
  f.assessmentSnapshots = f.assessmentSnapshots.filter((a) =>
    host.assessmentRefs.includes(a.id),
  );
  f.lifecycleSnapshots = f.lifecycleSnapshots
    .filter((a) => host.lifecycleRefs.includes(a.id))
    .map((a) => ({
      ...a,
      items: a.items.filter(
        (i) =>
          i.assetId === hostId ||
          center.objects?.some(
            (o) => o.objectId === i.assetId && o.versionId === i.versionId,
          ),
      ),
    }));
  f.scope = f.scope.filter(
    (t) =>
      t.objectId === hostId ||
      center.objects?.some(
        (o) => o.objectId === t.objectId && o.versionId === t.versionId,
      ),
  );
  const refs = new Set([
    ...host.assessmentRefs,
    ...host.lifecycleRefs,
    ...f.assessmentSnapshots.flatMap((a) =>
      "ruleImportId" in a.input ? [a.input.ruleImportId] : [],
    ),
  ]);
  f.sourceRefs = f.sourceRefs.filter((r) => refs.has(r.id));
  f.coverageIssues = [
    ...host.issues,
    ...reportCoverage(f),
    "本分报告为父修订固定事实的主机视图；共享对象不可按分报告数量累计。父事实 SHA-256：" +
      parent.factHash,
  ];
  f.statistics = reportStatistics(f, center.hosts);
  return {
    ...parent,
    facts: f,
    factHash: hashFacts(f),
    narrative: {
      ...defaultNarrative(f),
      presentation: parent.narrative.presentation,
    },
  };
}
