import "./reports.css";
import { reportStatus, reportDate } from "./report-ui";
import { ReportPackagePanel } from "./ReportPackagePanel";
import { AssessmentDetails } from "../assessments/AssessmentDetails";
import { ReportCenterPanel } from "./ReportCenterPanel";
import type { Assessment } from "../../../../../packages/contracts/assessments";
import { ReportNarrationPanel } from "./ReportNarrationPanel";
import { ReportReviewPanel } from "./ReportReviewPanel";
import { useEffect, useRef, useState } from "react";
import type { AnyAssessmentPage as AssessmentPage } from "../../../../../packages/contracts/assessments";
import type { LifecycleAssessment } from "../../../../../packages/contracts/lifecycle";
import type {
  Report,
  ReportSummary,
} from "../../../../../packages/contracts/reports";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
export function ReportsPage({
  customerId,
  token,
  onUnauthorized,
}: FeatureProps) {
  const [assessments, setAssessments] = useState<AssessmentPage["items"]>([]),
    [lifecycles, setLifecycles] = useState<LifecycleAssessment[]>([]),
    [history, setHistory] = useState<ReportSummary[]>([]),
    [assessmentRefs, setAssessmentRefs] = useState<string[]>([]),
    [lifecycleRefs, setLifecycleRefs] = useState<string[]>([]),
    [report, setReport] = useState<Report>(),
    [html, setHtml] = useState(""),
    [evidence, setEvidence] = useState<unknown>(),
    [linuxEvidence, setLinuxEvidence] = useState<Assessment>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const filteredHistory = history.filter((r) =>
    `${r.name ?? ""} ${r.id}`
      .toLowerCase()
      .includes(historyQuery.trim().toLowerCase()),
  );
  const [showCreator, setShowCreator] = useState(true);
  const [creatorKey, setCreatorKey] = useState(0);
  const [detailTab, setDetailTab] = useState("preview");
  const detailRef = useRef<HTMLElement>(null);
  const createRef = useRef<HTMLDivElement>(null);
  const controller = useRef(new AbortController());
  const base = `/customers/${customerId}`;
  const call = <T,>(path: string, options: RequestInit = {}) =>
    api<T>(path, token, options, controller.current.signal);
  function fail(e: unknown) {
    if (controller.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  async function refresh() {
    const [a, l, r] = await Promise.all([
      call<AssessmentPage>(`${base}/assessments?limit=100`),
      call<{ items: LifecycleAssessment[] }>(`${base}/lifecycle/assessments`),
      call<{ items: ReportSummary[] }>(`${base}/reports`),
    ]);
    setAssessments(a.items);
    setLifecycles(l.items);
    setHistory(r.items);
  }
  useEffect(() => {
    controller.current = new AbortController();
    refresh().catch(fail);
    const query = new URLSearchParams(location.hash.split("?")[1]);
    const reportId = query.get("report"),
      revisionId = query.get("revision");
    if (reportId && /^[0-9a-f-]{36}$/i.test(reportId))
      call<Report>(`${base}/reports/${reportId}`)
        .then(async (selected) => {
          if (revisionId && /^[0-9a-f-]{36}$/i.test(revisionId))
            selected.revision = await call(
              `${base}/reports/${reportId}/revisions/${revisionId}`,
            );
          await preview(selected);
        })
        .catch(fail);
    return () => controller.current.abort();
  }, [customerId, token]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      fail(e);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function preview(selected: Report) {
    const response = await fetch(
      `/api${base}/reports/${selected.id}/revisions/${selected.revision.id}/preview`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.current.signal,
      },
    );
    if (!response.ok) throw new ApiError("报告预览失败", response.status);
    setHtml(await response.text());
    setReport(selected);
    setShowCreator(false);
    if (report?.id !== selected.id) setDetailTab("preview");
    const query = new URLSearchParams({
      report: selected.id,
      revision: selected.revision.id,
    });
    window.history.replaceState(null, "", `#reports?${query}`);
    setEvidence(undefined);
    setLinuxEvidence(undefined);
  }
  useEffect(() => {
    if (report) detailRef.current?.scrollIntoView({ block: "start" });
  }, [report?.id, showCreator]);
  const toggle = (ids: string[], id: string, checked: boolean) =>
    checked ? [...ids, id] : ids.filter((x) => x !== id);
  return (
    <div className="report-workbench">
      <div className="page-heading report-page-heading">
        <div>
          <div className="eyebrow">REPORT CENTER / 风险交付</div>
          <h1>报告中心</h1>
          <p>从扫描结果到专业报告，让风险、证据与整改路径清晰可见。</p>
        </div>
        <div className="report-header-actions">
          {!showCreator && (
            <button onClick={() => setShowCreator(true)}>← 生成与历史</button>
          )}
          <button
            className="primary report-new-button"
            onClick={() => {
              setShowCreator(true);
              setCreatorKey((key) => key + 1);
              requestAnimationFrame(() =>
                createRef.current?.scrollIntoView({
                  block: "start",
                  behavior: "smooth",
                }),
              );
            }}
          >
            <span aria-hidden="true">＋</span> 创建报告
          </button>
        </div>
      </div>
      <div className="report-metrics" aria-label="报告概况">
        {[
          ["近期报告", history.length],
          ["草稿", history.filter((r) => r.status === "draft").length],
          ["待复核", history.filter((r) => r.status === "in_review").length],
          ["已交付", history.filter((r) => r.status === "delivered").length],
        ].map(([label, value]) => (
          <div key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
            <small>当前客户 · 最近 100 份</small>
          </div>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div
        className="report-start-layout"
        ref={createRef}
        hidden={!showCreator}
      >
        <ReportCenterPanel
          key={creatorKey}
          history={history}
          sourceReport={report}
          customerId={customerId}
          token={token}
          onUnauthorized={onUnauthorized}
          onOpen={async (id) => {
            await preview(await call<Report>(`${base}/reports/${id}`));
            await refresh();
          }}
        />
        <aside className="report-library report-card" aria-label="报告历史">
          <div className="report-card-heading">
            <div>
              <span className="report-kicker">LIBRARY</span>
              <h2>报告历史</h2>
            </div>
            <span className="report-count">{history.length}</span>
          </div>
          <p className="report-muted">继续查看、修订或交付已有报告</p>
          {!history.length && (
            <div className="report-empty">
              <span aria-hidden="true">▤</span>
              <p>暂无报告</p>
              <small>完成左侧向导，创建第一份报告</small>
            </div>
          )}
          {!!history.length && (
            <div className="report-history-search">
              <input
                aria-label="搜索报告"
                type="search"
                placeholder="搜索名称或报告编号"
                value={historyQuery}
                onChange={(e) => setHistoryQuery(e.target.value)}
              />
            </div>
          )}
          {!!history.length && !filteredHistory.length && (
            <p className="report-search-empty">未找到匹配报告</p>
          )}
          <div className="report-history-list">
            {filteredHistory.map((r) => (
              <article
                key={r.id}
                className={report?.id === r.id ? "is-current" : ""}
              >
                <span className="report-document-icon" aria-hidden="true">
                  ▤
                </span>
                <div>
                  <button
                    disabled={busy}
                    aria-label={r.name ?? r.id}
                    title={r.id}
                    onClick={() =>
                      run(async () =>
                        preview(await call<Report>(`${base}/reports/${r.id}`)),
                      )
                    }
                  >
                    {r.name ?? "历史风险报告"}
                  </button>
                  <p>
                    <span className="report-status" data-state={r.status}>
                      {reportStatus(r.status)}
                    </span>
                    <span>修订 {r.revisionNumber}</span>
                  </p>
                  <time>{reportDate(r.createdAt)}</time>
                </div>
              </article>
            ))}
          </div>
          <div className="report-library-note">
            <b>固定事实 · 可追溯交付</b>
            <p>新扫描生成新报告，文字与版式调整保存为新修订。</p>
          </div>
        </aside>
      </div>
      {report && (
        <section
          className="report-detail report-card"
          ref={detailRef}
          hidden={showCreator}
        >
          <div className="report-detail-heading">
            <div>
              <span className="report-kicker">REPORT WORKSPACE</span>
              <h2>{report.name ?? "报告详情"}</h2>
              <p>
                修订 {report.revision.number} · {reportDate(report.createdAt)} ·{" "}
                {report.createdBy}
              </p>
            </div>
            <span className="report-status" data-state={report.revision.status}>
              {reportStatus(report.revision.status)}
            </span>
          </div>
          <div className="report-tabs" role="tablist" aria-label="报告工作区">
            {[
              ["preview", "报告预览"],
              ["files", "文件与交付"],
              ["review", "编辑与复核"],
              ["evidence", "来源依据"],
            ].map(([key, label]) => (
              <button
                key={key}
                id={`report-tab-${key}`}
                role="tab"
                tabIndex={detailTab === key ? 0 : -1}
                onKeyDown={(event) => {
                  const keys = ["preview", "files", "review", "evidence"];
                  const index = keys.indexOf(key);
                  const next =
                    event.key === "ArrowRight"
                      ? (index + 1) % 4
                      : event.key === "ArrowLeft"
                        ? (index + 3) % 4
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? 3
                            : -1;
                  if (next < 0) return;
                  event.preventDefault();
                  setDetailTab(keys[next]);
                  document.getElementById(`report-tab-${keys[next]}`)?.focus();
                }}
                aria-selected={detailTab === key}
                aria-controls={`report-panel-${key}`}
                onClick={() => setDetailTab(key)}
              >
                {label}
              </button>
            ))}
          </div>
          <div
            role="tabpanel"
            id="report-panel-preview"
            aria-labelledby="report-tab-preview"
            hidden={detailTab !== "preview"}
          >
            <div className="report-preview-toolbar">
              <div>
                <h3>事实草稿预览</h3>
                <p>范围、覆盖与来源始终保留；正式交付前请完成内部复核。</p>
              </div>
              {report.revision.status !== "delivered" && (
                <button
                  onClick={() => {
                    const url = URL.createObjectURL(
                      new Blob([html], { type: "text/html;charset=utf-8" }),
                    );
                    const anchor = document.createElement("a");
                    anchor.href = url;
                    anchor.download = "ys-unreviewed-report.html";
                    anchor.click();
                    setTimeout(() => URL.revokeObjectURL(url), 1000);
                  }}
                >
                  下载草稿 HTML（未正式交付）
                </button>
              )}
            </div>
            <iframe
              key={report.revision.id}
              title="事实报告草稿"
              sandbox=""
              srcDoc={html}
              className="report-preview-frame"
            />
            <details className="report-identity">
              <summary>报告标识与事实校验</summary>
              <dl>
                <dt>报告 ID</dt>
                <dd>{report.id}</dd>
                <dt>修订 ID</dt>
                <dd>{report.revision.id}</dd>
                <dt>事实 SHA-256</dt>
                <dd>{report.revision.factHash}</dd>
              </dl>
            </details>
          </div>
          <div
            role="tabpanel"
            id="report-panel-files"
            aria-labelledby="report-tab-files"
            hidden={detailTab !== "files"}
          >
            <ReportPackagePanel
              report={report}
              customerId={customerId}
              token={token}
              onUnauthorized={onUnauthorized}
            />
          </div>
          <div
            role="tabpanel"
            id="report-panel-review"
            aria-labelledby="report-tab-review"
            hidden={detailTab !== "review"}
          >
            <ReportNarrationPanel
              report={report}
              customerId={customerId}
              token={token}
              onUnauthorized={onUnauthorized}
              onRevision={async (revision) => {
                await preview({ ...report, revision });
                await refresh();
              }}
            />
            <ReportReviewPanel
              report={report}
              customerId={customerId}
              token={token}
              onUnauthorized={onUnauthorized}
              onRevision={async (revision) => {
                await preview({ ...report, revision });
                await refresh();
              }}
            />
          </div>
          <div
            role="tabpanel"
            id="report-panel-evidence"
            aria-labelledby="report-tab-evidence"
            hidden={detailTab !== "evidence"}
          >
            <div className="report-section-intro">
              <h3>依据明细</h3>
              <p>查看固定结果的原始来源与证据，保留完整追溯路径。</p>
            </div>

            {report.revision.facts.sourceRefs.map((r) => (
              <p key={`${r.kind}:${r.id}`}>
                <button
                  disabled={busy}
                  onClick={() =>
                    run(async () => {
                      const linux =
                        r.kind === "cve" &&
                        report.revision.facts.assessmentSnapshots.some(
                          (a) => a.id === r.id && a.target.kind === "linux",
                        );
                      setEvidence(undefined);
                      setLinuxEvidence(undefined);
                      if (linux) {
                        const source = await call<Assessment>(
                          `${base}/assessments/${r.id}?findingsOffset=0`,
                        );
                        if (
                          r.outputHash &&
                          source.execution?.outputHash !== r.outputHash
                        )
                          throw new Error("原始评估报告哈希与冻结依据不一致");
                        setLinuxEvidence(source);
                      } else
                        setEvidence(
                          await call(
                            `${base}/${r.kind === "cve" ? "assessments" : r.kind === "windows_rules" ? "windows/rules" : "lifecycle/assessments"}/${r.id}`,
                          ),
                        );
                    })
                  }
                >
                  {r.kind} 依据 {r.id}
                </button>
                {r.kind === "cve" &&
                  report.revision.facts.assessmentSnapshots.some(
                    (a) => a.id === r.id && a.target.kind === "linux",
                  ) && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        run(async () => {
                          const original = await call<{
                            content: string;
                            contentHash: string;
                          }>(`${base}/assessments/${r.id}/report`);
                          if (
                            r.outputHash &&
                            original.contentHash !== r.outputHash
                          )
                            throw new Error("原始报告哈希与冻结依据不一致");
                          const url = URL.createObjectURL(
                            new Blob([original.content], {
                              type: "application/json",
                            }),
                          );
                          const link = document.createElement("a");
                          link.href = url;
                          link.download = `trivy-${r.id}.json`;
                          link.click();
                          setTimeout(() => URL.revokeObjectURL(url), 1000);
                        })
                      }
                    >
                      下载原始扫描报告
                    </button>
                  )}
              </p>
            ))}
            {linuxEvidence && (
              <AssessmentDetails
                context={{ customerId, token, onUnauthorized }}
                job={linuxEvidence}
                onFindingsPage={(offset, levels, search, component) =>
                  void run(async () => {
                    const next = await call<Assessment>(
                      `${base}/assessments/${linuxEvidence.id}?findingsOffset=${offset}${levels ? "&severities=" + levels.join(",") : ""}&search=${encodeURIComponent(search ?? "")}${component ? `&component=${encodeURIComponent(component)}` : ""}`,
                    );
                    if (
                      next.execution?.outputHash !==
                      linuxEvidence.execution?.outputHash
                    )
                      throw new Error("原始评估报告哈希与冻结依据不一致");
                    setLinuxEvidence(next);
                  })
                }
              />
            )}
            {evidence !== undefined && (
              <details open>
                <summary>原始评估依据</summary>
                <pre>{JSON.stringify(evidence, null, 2)}</pre>
              </details>
            )}
          </div>
        </section>
      )}
      <details className="report-legacy" hidden={!showCreator}>
        <summary>旧版评估引用入口（兼容历史使用方式）</summary>
        <h2>选择报告依据</h2>
        <p>
          合计1–20个引用；同一对象输入版本每类只可选一次评估。这里只列最近100次。缺失、失败或未知范围保持披露，草稿尚未内部复核。
        </p>
        <h3>CVE评估（主机 / 软件 / 镜像）</h3>
        {!assessments.length && (
          <p>尚无 CVE 评估；可仅用生命周期资料生成带未评估说明的草稿。</p>
        )}
        {assessments.map((a) => (
          <label className="block" key={a.id}>
            <input
              type="checkbox"
              disabled={busy || a.status === "queued" || a.status === "running"}
              checked={assessmentRefs.includes(a.id)}
              onChange={(e) =>
                setAssessmentRefs(
                  toggle(assessmentRefs, a.id, e.target.checked),
                )
              }
            />
            {a.id} · {a.status} · 输入版本 {JSON.stringify(a.target)} /{" "}
            {("version" in a.input ? a.input.version : null) ?? "未知版本"} ·
            发现 {a.findingCount ?? "未知"} ·{" "}
            {a.coverage?.status ?? "无可用结果"}
          </label>
        ))}
        <h3>EOS/EOL 生命周期评估</h3>
        {!lifecycles.length && (
          <p>尚无生命周期评估，不能由 CVE 结果补充阶段日期。</p>
        )}
        {lifecycles.map((a) => (
          <label className="block" key={a.id}>
            <input
              type="checkbox"
              disabled={busy}
              checked={lifecycleRefs.includes(a.id)}
              onChange={(e) =>
                setLifecycleRefs(toggle(lifecycleRefs, a.id, e.target.checked))
              }
            />
            {a.id} · {a.evaluatedAt} ·{" "}
            {a.items
              .map((i) => `${i.name} / ${i.version ?? "未知"} / ${i.match}`)
              .join("；")}
          </label>
        ))}
        <button
          className="primary"
          disabled={
            busy ||
            assessmentRefs.length + lifecycleRefs.length === 0 ||
            assessmentRefs.length + lifecycleRefs.length > 20
          }
          onClick={() =>
            run(async () => {
              await preview(
                await call<Report>(`${base}/reports`, {
                  method: "POST",
                  body: JSON.stringify({ assessmentRefs, lifecycleRefs }),
                }),
              );
              await refresh();
            })
          }
        >
          生成事实草稿
        </button>
      </details>
    </div>
  );
}
