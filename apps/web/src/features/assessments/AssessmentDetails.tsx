import { SeverityControls, defaultSeverities } from "./SeverityControls";
import { useEffect, useRef, useState } from "react";
import type {
  Assessment,
  VulnerabilityFinding,
} from "../../../../../packages/contracts/assessments";
import type { FeatureProps } from "../../features";
import { FindingAnalysisPanel } from "./FindingAnalysisPanel";
import "./assessments.css";
export const assessmentStatusLabels = {
  queued: "等待执行",
  running: "正在执行",
  succeeded: "执行成功",
  failed: "执行失败",
  unavailable: "工具或数据库不可用",
  timed_out: "执行超时",
  interrupted: "执行中断",
};
const coverageLabels = {
  complete_for_declared_input: "已覆盖声明组件",
  partial: "部分覆盖",
  unknown: "覆盖未知",
};
const freshLabels = {
  fresh: "库时间有效",
  stale: "漏洞数据库已过期",
  unknown: "库时间未知",
};
const severityLabels: Record<string, string> = {
  CRITICAL: "致命",
  HIGH: "高危",
  MEDIUM: "中危",
  LOW: "低危",
  UNKNOWN: "未知",
};
const date = (v?: string | null) =>
  v ? new Date(v).toLocaleString("zh-CN") : "未知";
export function AssessmentDetails({
  job,
  onFindingsPage,
  onDownloadEvidence,
  selectedSeverities,
  onSeveritiesChange,
  context,
}: {
  job: Assessment;
  onFindingsPage?: (
    offset: number,
    severities?: string[],
    search?: string,
  ) => void;
  selectedSeverities?: string[];
  onSeveritiesChange?: (severities: string[]) => void;
  onDownloadEvidence?: () => void;
  context?: FeatureProps;
}) {
  const [page, setPage] = useState(0),
    [localSeverities, setLocalSeverities] = useState(defaultSeverities),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [analysis, setAnalysis] = useState<VulnerabilityFinding>();
  const severities = selectedSeverities ?? localSeverities,
    pageSize = 50;
  const requested = severities.join(","),
    received = job.findingsPage?.severities?.join(",");
  const pageCallback = useRef(onFindingsPage);
  pageCallback.current = onFindingsPage;
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query.trim());
      setPage(0);
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    if (
      job.result &&
      job.findingsPage &&
      (received !== requested || (job.findingsPage.search ?? "") !== search)
    )
      pageCallback.current?.(0, severities, search);
  }, [
    job.id,
    !!job.result,
    !!job.findingsPage,
    received,
    requested,
    search,
    job.findingsPage?.search,
  ]);
  const pending =
    !!job.findingsPage &&
    (received !== requested || (job.findingsPage.search ?? "") !== search);
  const visible = pending
    ? []
    : (job.result?.findings ?? []).filter(
        (f) =>
          severities.includes(f.severity.toUpperCase()) &&
          (!!job.findingsPage ||
            `${f.vulnerabilityId} ${f.packageName} ${f.installedVersion}`
              .toLowerCase()
              .includes(search.toLowerCase())),
      );
  const total = job.findingsPage
    ? pending
      ? 0
      : job.findingsPage.total
    : visible.length;
  const originalTotal =
    job.findingsPage?.unfilteredTotal ??
    job.findingsPage?.total ??
    job.result?.findings.length ??
    0;
  const currentPage = job.findingsPage
    ? Math.floor(job.findingsPage.offset / pageSize)
    : Math.min(page, Math.max(0, Math.ceil(total / pageSize) - 1));
  function changePage(next: number) {
    if (onFindingsPage) onFindingsPage(next * pageSize, severities, search);
    else setPage(next);
  }
  return (
    <div className="panel assessment-results">
      <header className="result-header">
        <div>
          <span className="eyebrow">扫描结果</span>
          <h2>
            {job.status === "succeeded"
              ? "扫描完成"
              : assessmentStatusLabels[job.status]}
          </h2>
          <p className="muted">
            完成时间 {date(job.finishedAt)} ·{" "}
            {job.target.kind === "linux"
              ? "Linux 系统包"
              : job.target.kind === "container"
                ? "容器镜像"
                : "软件组件"}
          </p>
        </div>
        <span
          className={`result-state ${job.status === "succeeded" ? "success" : ""}`}
        >
          {assessmentStatusLabels[job.status]}
        </span>
      </header>
      {job.error && <p role="alert">{job.error}</p>}
      {!job.result && <p>尚无有效评估结果；不可解读为零发现。</p>}
      {job.result && (
        <>
          <div className="result-metrics">
            <div>
              <span>完整漏洞记录</span>
              <strong>{originalTotal.toLocaleString()}</strong>
              <small>按组件记录，非去重 CVE 数</small>
            </div>
            <div>
              <span>当前匹配</span>
              <strong>{pending ? "…" : total.toLocaleString()}</strong>
              <small>检索与等级筛选后的记录</small>
            </div>
            <div>
              <span>组件覆盖</span>
              <strong>
                {job.result.coverage.matchedComponents.toLocaleString()}
                <small>
                  {" "}
                  / {job.result.coverage.inputComponents.toLocaleString()}
                </small>
              </strong>
              <small>扫描工具识别的声明组件</small>
            </div>
          </div>
          <div className="coverage-notice">
            <strong>{freshLabels[job.result.database.freshness]}</strong>
            <span>
              {" "}
              · {coverageLabels[job.result.coverage.status]}
              ，结果为工具报告，尚未验证运行适用性。
            </span>
            <details>
              <summary>查看覆盖范围与数据库依据</summary>
              <p>{job.input.scope}</p>
              <p>
                库更新：{date(job.result.database.updatedAt)} · 下次更新：
                {date(job.result.database.nextUpdate)}
              </p>
              {[...new Set(job.result.coverage.issues)]
                .filter(
                  (issue) =>
                    issue !== freshLabels[job.result!.database.freshness],
                )
                .map((issue, i) => (
                  <p key={i}>{issue}</p>
                ))}
            </details>
          </div>
          <div className="findings-toolbar">
            <label className="findings-search">
              检索漏洞记录
              <input
                type="search"
                maxLength={200}
                placeholder="搜索 CVE、组件名或安装版本"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <SeverityControls
              value={severities}
              onChange={(v) => {
                setPage(0);
                (onSeveritiesChange ?? setLocalSeverities)(v);
              }}
            />
          </div>
          <div className="findings-caption">
            <h3 aria-label={`发现 ${originalTotal} 条漏洞记录`}>漏洞一览</h3>
            <span className="muted" aria-live="polite">
              {pending
                ? "正在加载匹配结果…"
                : `当前关注等级显示 ${total} 条，完整记录 ${originalTotal} 条。`}
            </span>
          </div>
          {!pending && !total && (
            <p className="empty-results">
              没有符合条件的记录，可调整检索词或等级。
            </p>
          )}
          <div className="findings-table-scroll">
            <table className="findings-table">
              <thead>
                <tr>
                  <th>漏洞 / 严重程度</th>
                  <th>组件 / 安装版本</th>
                  <th>修复版本</th>
                  <th>来源与证据</th>
                  {context && <th>解析</th>}
                </tr>
              </thead>
              <tbody>
                {visible
                  .slice(
                    job.findingsPage ? 0 : currentPage * pageSize,
                    job.findingsPage ? pageSize : (currentPage + 1) * pageSize,
                  )
                  .map((f) => (
                    <tr key={f.id}>
                      <td>
                        <strong className="cve-id">{f.vulnerabilityId}</strong>
                        <span
                          className={`severity-badge severity-${f.severity.toLowerCase()}`}
                        >
                          {severityLabels[f.severity.toUpperCase()] ??
                            f.severity}
                        </span>
                      </td>
                      <td>
                        <strong>{f.packageName}</strong>
                        <span className="cell-subtext">
                          {f.installedVersion}
                        </span>
                        <small className="muted">{f.ecosystem}</small>
                      </td>
                      <td>
                        <span>{f.fixedVersion ?? "来源未提供"}</span>
                        <small className="cell-subtext muted">
                          工具报告，升级前需验证
                        </small>
                      </td>
                      <td>
                        {f.primaryUrl && /^https?:\/\//.test(f.primaryUrl) && (
                          <a
                            href={f.primaryUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            漏洞来源 ↗
                          </a>
                        )}
                        <details>
                          <summary>查看证据</summary>
                          <p>扫描目标：{f.target}</p>
                          <p>适用性：工具报告；未人工改判</p>
                          <p>
                            {f.componentId
                              ? "已关联输入组件"
                              : "无法唯一关联组件"}
                          </p>
                          <pre>{JSON.stringify(f.evidence, null, 2)}</pre>
                        </details>
                      </td>
                      {context && (
                        <td>
                          <button
                            className="analysis-button"
                            onClick={() => setAnalysis(f)}
                          >
                            AI解析
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="pagination">
            <button
              disabled={pending || !currentPage}
              onClick={() => changePage(currentPage - 1)}
            >
              上一页漏洞
            </button>
            <span>
              第 {currentPage + 1} 页 · 共 {total} 条
            </span>
            <button
              disabled={pending || (currentPage + 1) * pageSize >= total}
              onClick={() => changePage(currentPage + 1)}
            >
              下一页漏洞
            </button>
          </div>
        </>
      )}
      <details className="execution-details">
        <summary>任务详情与执行证据</summary>
        <p>任务编号：{job.id}</p>
        <p>输入版本：{job.target.versionId}</p>
        <p>
          来源资料：{job.input.importId} · SHA-256：{job.input.contentHash}
        </p>
        <p>
          开始：{date(job.startedAt)} · 完成：{date(job.finishedAt)}
        </p>
        {job.execution && (
          <>
            <p>
              Trivy：{job.execution.toolVersion ?? "版本未知"} · 退出码：
              {job.execution.exitCode ?? "未知"}
            </p>
            <p>报告 SHA-256：{job.execution.outputHash ?? "未知"}</p>
            <details>
              <summary>命令、数据库与标准错误</summary>
              <pre>
                {JSON.stringify(
                  { ...job.execution, rawReport: undefined },
                  null,
                  2,
                )}
              </pre>
            </details>
            {onDownloadEvidence && job.execution.outputHash && (
              <button onClick={onDownloadEvidence}>下载原始Trivy报告</button>
            )}
            {job.execution.rawReport && (
              <details>
                <summary>原始 Trivy 报告</summary>
                <pre>{job.execution.rawReport.slice(0, 20000)}</pre>
              </details>
            )}
          </>
        )}
      </details>
      {analysis && context && (
        <FindingAnalysisPanel
          key={`${job.id}/${analysis.id}`}
          context={context}
          assessmentId={job.id}
          finding={analysis}
          onClose={() => setAnalysis(undefined)}
        />
      )}
    </div>
  );
}
