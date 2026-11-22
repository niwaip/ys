import { FindingSourcePanel } from "./FindingSourcePanel";
import {
  findingGroupKey,
  groupFindings,
} from "../../../../../packages/contracts/finding-groups";
import { FindingEvidenceDetails } from "./FindingEvidenceDetails";
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
    component?: string,
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
    [grouped, setGrouped] = useState(true),
    [component, setComponent] = useState(""),
    [analysis, setAnalysis] = useState<VulnerabilityFinding>(),
    [source, setSource] = useState<VulnerabilityFinding>();
  const severities = selectedSeverities ?? localSeverities,
    pageSize = 50;
  useEffect(() => {
    setComponent("");
    setGrouped(true);
  }, [job.id]);
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
      (received !== requested ||
        (job.findingsPage.search ?? "") !== search ||
        (job.findingsPage.component ?? "") !== component)
    )
      pageCallback.current?.(0, severities, search, component);
  }, [
    job.id,
    !!job.result,
    !!job.findingsPage,
    received,
    requested,
    search,
    job.findingsPage?.search,
    job.findingsPage?.component,
    component,
  ]);
  const pending =
    !!job.findingsPage &&
    (received !== requested ||
      (job.findingsPage.search ?? "") !== search ||
      (job.findingsPage.component ?? "") !== component);
  const groupFiltersCurrent =
    !job.findingsPage ||
    (received === requested && (job.findingsPage.search ?? "") === search);
  const groups = !groupFiltersCurrent
    ? []
    : (job.componentGroups ??
      groupFindings(
        (job.result?.findings ?? []).filter(
          (f) =>
            severities.includes(f.severity.toUpperCase()) &&
            `${f.vulnerabilityId} ${f.packageName} ${f.installedVersion}`
              .toLowerCase()
              .includes(search.toLowerCase()),
        ),
      ));
  const [groupPage, setGroupPage] = useState(0);
  useEffect(() => {
    setGroupPage(0);
  }, [job.id, search, requested]);
  const autoOpened = useRef("");
  useEffect(() => {
    const key = `${job.id}/${search}/${requested}`;
    if (
      groupFiltersCurrent &&
      !pending &&
      grouped &&
      groups.length === 1 &&
      !component &&
      autoOpened.current !== key
    ) {
      autoOpened.current = key;
      setComponent(groups[0].key);
    }
  }, [
    job.id,
    search,
    requested,
    grouped,
    groups.length,
    groups[0]?.key,
    component,
    groupFiltersCurrent,
    pending,
  ]);
  useEffect(() => {
    if (
      groupFiltersCurrent &&
      !pending &&
      component &&
      !groups.some((g) => g.key === component)
    )
      setComponent("");
  }, [groupFiltersCurrent, pending, component, groups]);
  const visible = pending
    ? []
    : (job.result?.findings ?? []).filter(
        (f) =>
          (job.findingsPage ||
            !grouped ||
            !component ||
            findingGroupKey(f) === component) &&
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
    if (onFindingsPage)
      onFindingsPage(next * pageSize, severities, search, component);
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
              <span>完整匹配记录</span>
              <strong>{originalTotal.toLocaleString()}</strong>
              <small>组件与漏洞的匹配，不代表确认受影响</small>
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
            {job.findingStats && (
              <div>
                <span>去重 CVE / 组件组</span>
                <strong>
                  {job.findingStats.uniqueCves.toLocaleString()} /{" "}
                  {job.findingStats.components.toLocaleString()}
                </strong>
                <small>完整结果统计；适用性需另行核实</small>
              </div>
            )}
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
                onChange={(e) => {
                  setQuery(e.target.value);
                  setComponent("");
                }}
              />
            </label>
            <SeverityControls
              value={severities}
              onChange={(v) => {
                setPage(0);
                setComponent("");
                (onSeveritiesChange ?? setLocalSeverities)(v);
              }}
            />
          </div>
          {job.result && (
            <div className="component-groups">
              <div role="group" aria-label="结果显示方式">
                <button
                  aria-pressed={!grouped}
                  onClick={() => {
                    setGrouped(false);
                    setComponent("");
                  }}
                >
                  逐条匹配
                </button>
                <button
                  aria-pressed={grouped}
                  onClick={() => {
                    setGrouped(true);
                    setComponent("");
                  }}
                >
                  按组件分组
                </button>
              </div>
              {grouped && (
                <>
                  <p>
                    按当前检索与等级对完整结果分组；每个组件保留版本、架构关联和扫描目标。匹配数不等同于已确认漏洞数。
                  </p>
                  <label>
                    选择组件
                    <select
                      aria-label="选择漏洞组件"
                      value={component}
                      onChange={(e) => {
                        setComponent(e.target.value);
                        setPage(0);
                      }}
                    >
                      <option value="">选择组件查看漏洞</option>
                      {groups.map((g) => (
                        <option key={g.key} value={g.key}>
                          {g.packageName} · {g.installedVersion} ·{" "}
                          {g.componentId ?? "组件关联未知"} · {g.uniqueCves} 个
                          CVE / {g.records} 条匹配 · {g.target}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="component-cards">
                    {groups
                      .slice(groupPage * 20, (groupPage + 1) * 20)
                      .map((g) => (
                        <article key={g.key} className="component-card">
                          <button
                            aria-expanded={component === g.key}
                            onClick={() => {
                              setComponent(component === g.key ? "" : g.key);
                              setPage(0);
                            }}
                          >
                            <strong>{g.packageName}</strong> ·{" "}
                            {g.installedVersion} ·{" "}
                            {g.componentId ?? "组件关联未知"}
                            <span>
                              {g.uniqueCves} 个 CVE / {g.records} 条匹配 ·{" "}
                              {component === g.key ? "收起漏洞" : "展开漏洞"}
                            </span>
                          </button>
                          <p>
                            {Object.entries(g.severities ?? {})
                              .filter(([, n]) => n > 0)
                              .map(
                                ([level, n]) =>
                                  `${severityLabels[level] ?? level} ${n}`,
                              )
                              .join(" · ")}
                          </p>
                          <small>
                            适用性需逐条核实，匹配数量不代表已确认受影响。
                          </small>
                        </article>
                      ))}
                  </div>
                  {groups.length > 20 && (
                    <div className="pagination">
                      <button
                        disabled={!groupPage}
                        onClick={() => setGroupPage((v) => v - 1)}
                      >
                        上一批组件
                      </button>
                      <span>组件第 {groupPage + 1} 页</span>
                      <button
                        disabled={(groupPage + 1) * 20 >= groups.length}
                        onClick={() => setGroupPage((v) => v + 1)}
                      >
                        下一批组件
                      </button>
                    </div>
                  )}
                  <p>
                    {groups.length} 个组件组 ·{" "}
                    {groups.reduce((sum, g) => sum + g.records, 0)} 条筛选后匹配
                  </p>
                </>
              )}
            </div>
          )}
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
          {(!grouped || !!component) && (
            <div className="findings-table-scroll">
              <table className="findings-table">
                <thead>
                  <tr>
                    <th>漏洞 / 严重程度</th>
                    {!grouped && <th>组件 / 安装版本</th>}
                    <th>修复版本</th>
                    <th>运行适用性</th>
                    <th>来源与证据</th>
                    {context && <th>解析</th>}
                  </tr>
                </thead>
                <tbody>
                  {visible
                    .slice(
                      job.findingsPage ? 0 : currentPage * pageSize,
                      job.findingsPage
                        ? pageSize
                        : (currentPage + 1) * pageSize,
                    )
                    .map((f) => (
                      <tr key={f.id}>
                        <td>
                          <strong className="cve-id">
                            {f.vulnerabilityId}
                          </strong>
                          <span
                            className={`severity-badge severity-${f.severity.toLowerCase()}`}
                          >
                            {severityLabels[f.severity.toUpperCase()] ??
                              f.severity}
                          </span>
                        </td>
                        {!grouped && (
                          <td>
                            <strong>{f.packageName}</strong>
                            <span className="cell-subtext">
                              {f.installedVersion}
                            </span>
                            <small className="muted">{f.ecosystem}</small>
                          </td>
                        )}
                        <td>
                          <span>
                            {f.fixedVersion ?? "扫描结果未提供修复版本"}
                          </span>
                          <small className="cell-subtext muted">
                            工具报告，升级前需验证
                          </small>
                        </td>
                        <td>
                          <span>
                            {f.runtimeApplicability?.status ===
                            "conditions_not_met"
                              ? "采集时未发现适用条件"
                              : "证据不足"}
                          </span>
                          <small className="cell-subtext muted">
                            独立于扫描器严重性，详见证据
                          </small>
                        </td>
                        <td>
                          <button
                            className="source-button"
                            onClick={() => setSource(f)}
                          >
                            漏洞来源与依据
                          </button>
                          <FindingEvidenceDetails
                            finding={f}
                            assessmentId={job.id}
                            context={context}
                          />
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
          )}
          {(!grouped || !!component) && (
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
          )}
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
      {source && (
        <FindingSourcePanel
          key={`${job.id}/${source.id}`}
          finding={source}
          assessmentId={job.id}
          context={context}
          scannedAt={job.finishedAt}
          onClose={() => setSource(undefined)}
        />
      )}
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
