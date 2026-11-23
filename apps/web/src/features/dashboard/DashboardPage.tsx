import { ContainerRuntimeSummary } from "../containers/ContainerRuntimeSummary";
import { LifecycleRiskSummary } from "../lifecycle-risk/LifecycleRiskSummary";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type {
  DashboardCatalog,
  DashboardView,
  DashboardRequest,
  DashboardObject,
} from "../../../../../packages/contracts/dashboard";
import "./dashboard.css";
const kindLabels = { host: "硬件", software: "软件", container: "容器镜像" };
const statusLabels: Record<string, string> = {
  queued: "等待执行",
  running: "执行中",
  succeeded: "成功",
  failed: "失败",
  unavailable: "不可用",
  timed_out: "超时",
  interrupted: "中断",
  unselected: "未选择评估",
  outside_time_range: "所选批次在时间范围外",
};
const coverLabels: Record<string, string> = {
  complete_for_declared_input: "声明输入覆盖完整",
  partial: "部分覆盖",
  unknown: "覆盖未知",
};
const applicability: Record<string, string> = {
  tool_reported: "工具报告候选",
  affected: "确认受影响",
  potentially_affected: "可能受影响",
  fixed: "已修复",
  unknown: "未知",
};
const show = (v: unknown) =>
  v === null || v === undefined ? "未知" : String(v);
type FindingsPage = {
  items: DashboardObject["findings"];
  total: number;
  limit: number;
  offset: number;
};
export function DashboardPage({
  customerId,
  token,
  onUnauthorized,
  title = "客户风险概览",
  onNavigate,
}: FeatureProps & { title?: string }) {
  const [autoCurrent, setAutoCurrent] = useState(true);
  const [hardwareType, setHardwareType] = useState<
    "" | "server" | "network" | "unknown"
  >("");
  const [catalog, setCatalog] = useState<DashboardCatalog>(),
    [data, setData] = useState<DashboardView>(),
    [object, setObject] = useState(""),
    [selectedObject, setSelectedObject] =
      useState<DashboardCatalog["objects"][number]>(),
    [refs, setRefs] = useState<string[]>([]),
    [lifecycleId, setLifecycleId] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [crossVersion, setCrossVersion] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [detail, setDetail] = useState<DashboardObject>(),
    [findings, setFindings] = useState<FindingsPage>(),
    [evidence, setEvidence] = useState<unknown>();
  const controller = useRef(new AbortController()),
    catalogOffset = useRef(0);
  const base = `/customers/${customerId}`;
  function call<T>(path: string, options: RequestInit = {}) {
    return api<T>(`${base}${path}`, token, options, controller.current.signal);
  }
  function fail(e: unknown) {
    if (controller.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError(e instanceof Error ? e.message : "请求失败");
  }
  async function loadCatalog(offset = 0) {
    const result = await call<DashboardCatalog>(
      `/dashboard/catalog?limit=100&offset=${offset}`,
    );
    catalogOffset.current = offset;
    setCatalog(result);
  }
  useEffect(() => {
    controller.current = new AbortController();
    Promise.all([
      loadCatalog(),
      call<DashboardView>("/dashboard/view", {
        method: "POST",
        body: JSON.stringify({ selectionMode: "current" }),
      }).then(setData),
    ]).catch(fail);
    return () => controller.current.abort();
  }, [customerId, token]);
  async function apply(hardwareOverride?: "server" | "network" | "unknown") {
    setBusy(true);
    setError("");
    setDetail(undefined);
    setFindings(undefined);
    setEvidence(undefined);
    try {
      const request: DashboardRequest = {
        selectionMode: autoCurrent ? "current" : "explicit",
        ...((hardwareOverride ?? hardwareType)
          ? {
              hardwareType: (hardwareOverride ?? hardwareType) as
                "server" | "network" | "unknown",
            }
          : {}),
        assessmentRefs: refs,
        trendMode: crossVersion ? "object_history" : "selected_inputs",
        ...(!hardwareOverride && selectedObject
          ? { object: { kind: selectedObject.kind, id: selectedObject.id } }
          : {}),
        ...(lifecycleId ? { lifecycleAssessmentId: lifecycleId } : {}),
        ...(from ? { from: new Date(from).toISOString() } : {}),
        ...(to ? { to: new Date(to).toISOString() } : {}),
      };
      const view = await call<DashboardView>("/dashboard/view", {
        method: "POST",
        body: JSON.stringify(request),
      });
      setData(view);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function drilldown(offset = 0) {
    if (!data) return;
    try {
      const result = await call<FindingsPage>("/dashboard/findings", {
        method: "POST",
        body: JSON.stringify({
          object: data.scope.object ?? undefined,
          hardwareType: data.scope.hardwareType ?? undefined,
          assessmentRefs: data.scope.assessmentRefs,
          from: data.scope.from ?? undefined,
          to: data.scope.to ?? undefined,
          limit: 20,
          offset,
        }),
      });
      setFindings(result);
    } catch (e) {
      fail(e);
    }
  }
  async function fixedEvidence(id: string) {
    try {
      setEvidence(await call(`/assessments/${id}`));
    } catch (e) {
      fail(e);
    }
  }
  const options = catalog?.objects ?? [];
  const objectOptions =
    selectedObject && !options.some((x) => x.id === selectedObject.id)
      ? [selectedObject, ...options]
      : options;
  return (
    <section className="dashboard">
      <header className="dashboard-heading">
        <div>
          <p className="dashboard-eyebrow">CUSTOMER OVERVIEW</p>
          <h2>{title}</h2>
          <p>
            客户 {customerId} ·
            固定输入与评估范围。未选择、失败与未知不表示安全。
          </p>
        </div>
        <span>
          生成时间{" "}
          {data ? new Date(data.generatedAt).toLocaleString("zh-CN") : "加载中"}
        </span>
      </header>
      <LifecycleRiskSummary
        customerId={customerId}
        token={token}
        onUnauthorized={onUnauthorized}
      />
      <ContainerRuntimeSummary
        customerId={customerId}
        token={token}
        onUnauthorized={onUnauthorized}
        onNavigate={onNavigate}
      />
      {catalog && (
        <p className="dashboard-directory">
          客户全目录：硬件 {catalog.inventory.host} · 软件{" "}
          {catalog.inventory.software} · 容器镜像 {catalog.inventory.container}
          （全部在管对象；以下按已应用范围统计）
        </p>
      )}
      <details className="dashboard-advanced">
        <summary>筛选范围与历史批次</summary>
        <div className="dashboard-filters">
          <label className="dashboard-check">
            <input
              type="checkbox"
              checked={autoCurrent}
              onChange={(e) => setAutoCurrent(e.target.checked)}
            />
            按当前对象汇总（优先软件选定版本，其余取最近尝试，失败不回退）
          </label>
          <label>
            硬件分类范围
            <select
              value={hardwareType}
              onChange={(e) => {
                setHardwareType(e.target.value as typeof hardwareType);
                setObject("");
                setSelectedObject(undefined);
                setRefs([]);
              }}
            >
              <option value="">全部对象</option>
              <option value="server">服务器</option>
              <option value="network">网络设备</option>
              <option value="unknown">未分类硬件</option>
            </select>
          </label>
          <label>
            概览对象
            <select
              value={object}
              onChange={(e) => {
                setObject(e.target.value);
                setSelectedObject(
                  objectOptions.find(
                    (x) => `${x.kind}:${x.id}` === e.target.value,
                  ),
                );
                setRefs([]);
              }}
            >
              <option value="">客户全部在管对象</option>
              {objectOptions.map((x) => (
                <option key={`${x.kind}:${x.id}`} value={`${x.kind}:${x.id}`}>
                  {kindLabels[x.kind]} · {x.name}
                </option>
              ))}
            </select>
          </label>
          <p>
            对象目录{" "}
            {catalog
              ? `${catalog.objectOffset + 1}–${Math.min(catalog.objectOffset + catalog.objectLimit, catalog.objectTotal)} / ${catalog.objectTotal}`
              : "加载中"}
            <button
              disabled={!catalog || catalog.objectOffset === 0}
              onClick={() =>
                loadCatalog(Math.max(0, catalogOffset.current - 100)).catch(
                  fail,
                )
              }
            >
              上一页对象
            </button>
            <button
              disabled={
                !catalog ||
                catalog.objectOffset + catalog.objectLimit >=
                  catalog.objectTotal
              }
              onClick={() =>
                loadCatalog(catalogOffset.current + 100).catch(fail)
              }
            >
              下一页对象
            </button>
          </p>
          <label>
            显式评估批次（可多对象，每个对象限一个）
            <select
              multiple
              size={4}
              value={refs}
              onChange={(e) =>
                setRefs(Array.from(e.target.selectedOptions, (o) => o.value))
              }
            >
              {catalog?.assessments.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.target.kind} · {a.id} · {statusLabels[a.status]} ·{" "}
                  {a.createdAt}
                </option>
              ))}
            </select>
          </label>
          <p>
            自动范围按对象解析固定输入及最近尝试，失败不回退。关闭自动汇总后使用手动指定批次。
            {catalog?.truncated ? "评估选择目录仅列最近1000条，已截断。" : ""}
          </p>
          <label>
            生命周期评估版本
            <select
              value={lifecycleId}
              onChange={(e) => setLifecycleId(e.target.value)}
            >
              <option value="">未选择（EOS/EOL 未知）</option>
              {catalog?.lifecycleAssessments.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.evaluatedAt} · {l.id} · {l.itemCount} 对象
                </option>
              ))}
            </select>
          </label>
          <p>
            手动选择目录为最近100次；自动汇总按对象匹配固定生命周期评估，均不累计历史。
          </p>
          <div className="dashboard-time">
            <label>
              评估开始时间
              <input
                type="datetime-local"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </label>
            <label>
              评估结束时间
              <input
                type="datetime-local"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </label>
          </div>
          <label className="dashboard-check">
            <input
              type="checkbox"
              checked={crossVersion}
              onChange={(e) => setCrossVersion(e.target.checked)}
            />
            趋势对比所选对象的所有输入版本（汇总仍使用固定所选批次）
          </label>
          <button
            className="dashboard-primary"
            disabled={busy}
            onClick={() => void apply()}
          >
            应用概览范围
          </button>
        </div>
      </details>
      {error && <p role="alert">{error}</p>}
      {data && (
        <>
          <div className="dashboard-scope">
            <strong>已应用范围</strong>
            <p>
              {data.scope.object
                ? `${kindLabels[data.scope.object.kind]} ${data.scope.object.id}`
                : "客户全部对象"}{" "}
              · {data.scope.from ?? "不限开始"} — {data.scope.to ?? "不限结束"}{" "}
              · EOS评估{" "}
              {data.scope.lifecycleAssessmentId ??
                (data.scope.lifecycleAssessmentRefs?.length
                  ? `按对象匹配 ${data.scope.lifecycleAssessmentRefs.length} 个固定批次`
                  : "未选择")}
            </p>
            <p>{data.scope.selectionPolicy}</p>
            {data.scope.hardwareType && (
              <p>
                硬件分类：
                {
                  {
                    server: "服务器",
                    network: "网络设备",
                    unknown: "未分类硬件",
                  }[data.scope.hardwareType]
                }
              </p>
            )}
            <small>范围指纹 {data.scope.hash} · 汇总不累计历史批次</small>
          </div>
          <div className="dashboard-cards">
            <article>
              <span>本范围对象</span>
              <strong>{data.objects.length}</strong>
              <small>
                硬件 {data.metrics.inventory.host} · 软件{" "}
                {data.metrics.inventory.software} · 镜像{" "}
                {data.metrics.inventory.container}
              </small>
              <div className="workspace-tabs">
                {(
                  [
                    ["server", "服务器"],
                    ["network", "网络设备"],
                    ["unknown", "未分类硬件"],
                  ] as const
                ).map(([type, label]) => (
                  <button
                    key={type}
                    onClick={() => {
                      setHardwareType(type);
                      setObject("");
                      setSelectedObject(undefined);
                      setRefs([]);
                      void apply(type);
                    }}
                  >
                    {label}{" "}
                    {type === "unknown"
                      ? data.metrics.inventory.unclassified
                      : data.metrics.inventory[type]}
                  </button>
                ))}
              </div>
            </article>
            <article>
              <span>已知 SBOM 组件</span>
              <strong>{data.metrics.components.known}</strong>
              <small>
                {data.metrics.components.unknownObjects}{" "}
                个软件/镜像组件范围未知；主机软件清单单列
              </small>
            </article>
            <article>
              <span>唯一观测 CVE</span>
              <strong>{show(data.metrics.cve.uniqueCves)}</strong>
              <small>
                公告标识 {show(data.metrics.cve.uniqueObserved)} · 实例{" "}
                {show(data.metrics.cve.instances)} · Windows
                fixed/unknown也为观测行，不等于风险数
              </small>
              <button onClick={() => drilldown()}>下钻观测实例</button>
            </article>
            <article>
              <span>已确认受影响对象（Windows）</span>
              <strong>{show(data.metrics.cve.confirmedAffectedObjects)}</strong>
              <small>
                工具报告候选对象 {data.metrics.cve.toolReportedObjects}
                ，不当作已确认
              </small>
            </article>
          </div>
          <div className="dashboard-panels">
            <article>
              <h3>观测实例严重度分布</h3>
              {Object.keys(data.metrics.cve.bySeverity).length ? (
                Object.entries(data.metrics.cve.bySeverity).map(
                  ([severity, count]) => (
                    <div className="dashboard-bar" key={severity}>
                      <span>{severity}</span>
                      <i
                        style={{
                          width: `${Math.max(2, (count / (data.metrics.cve.instances || 1)) * 100)}%`,
                        }}
                      />
                      <strong>{count}</strong>
                    </div>
                  ),
                )
              ) : (
                <p>没有可用观测分布；不代表零风险。</p>
              )}
              <p>
                {Object.entries(data.metrics.cve.byApplicability)
                  .map(
                    ([key, count]) => `${applicability[key] ?? key} ${count}`,
                  )
                  .join(" · ") || "适用性未知"}
              </p>
            </article>
            <article>
              <h3>任务、覆盖与资料新鲜度</h3>
              <p>
                选定批次 {data.metrics.coverage.selected} · 成功{" "}
                {data.metrics.coverage.succeeded} · 失败/不可用{" "}
                {data.metrics.coverage.failed} · 等待/执行{" "}
                {data.metrics.coverage.running}
              </p>
              <p>
                未选择 {data.metrics.coverage.unselected} · 时间范围外{" "}
                {data.metrics.coverage.outsideTimeRange}
              </p>
              <p>
                声明覆盖完整 {data.metrics.coverage.complete} · 部分{" "}
                {data.metrics.coverage.partial} · 未知{" "}
                {data.metrics.coverage.unknown}
              </p>
              <p>
                库时间有效 {data.metrics.freshness.fresh} · 已过期{" "}
                {data.metrics.freshness.stale} · 未知{" "}
                {data.metrics.freshness.unknown} · 采集时间未知{" "}
                {data.metrics.freshness.collectedAtUnknown}
              </p>
              <p>
                本对象范围历史扫描行 {data.trend.total}
                ；与观测实例、唯一CVE分开计数。
              </p>
            </article>
            <article>
              <h3>EOS / EOL 生命周期</h3>
              <p>
                未来90天内支持到期：{show(data.metrics.lifecycle.upcoming90d)}{" "}
                个对象（按展示时日期）
              </p>
              {data.metrics.lifecycle.status !== "selected" ? (
                <p>
                  {data.metrics.lifecycle.status === "outside_time_range"
                    ? "所选生命周期评估在时间范围外；当前范围生命周期未知。"
                    : "未选择评估版本，生命周期未知。"}
                </p>
              ) : (
                <>
                  <p>
                    固定评估时间 {data.metrics.lifecycle.evaluatedAt} · 覆盖{" "}
                    {data.metrics.lifecycle.coveredObjects}/
                    {data.objects.length} 对象
                  </p>
                  <p>
                    EOS 到期 {data.metrics.lifecycle.eos?.reached} · 未来{" "}
                    {data.metrics.lifecycle.eos?.future} · 未知{" "}
                    {data.metrics.lifecycle.eos?.unknown} · 来源冲突{" "}
                    {data.metrics.lifecycle.eos?.conflicting}
                  </p>
                  <p>
                    EOL 到期 {data.metrics.lifecycle.eol?.reached} · 未来{" "}
                    {data.metrics.lifecycle.eol?.future} · 未知{" "}
                    {data.metrics.lifecycle.eol?.unknown} · 来源冲突{" "}
                    {data.metrics.lifecycle.eol?.conflicting}
                  </p>
                  <p>
                    来源批次 {data.metrics.lifecycle.batchId} · 哈希{" "}
                    {data.metrics.lifecycle.sourceHash}
                  </p>
                </>
              )}
            </article>
          </div>
          <h3>对象 → 输入版本 / 快照 → 评估 → 证据</h3>
          <div className="dashboard-scroll">
            <table>
              <thead>
                <tr>
                  <th>对象</th>
                  <th>所选输入</th>
                  <th>评估状态与覆盖</th>
                  <th>采集时间</th>
                  <th>明细</th>
                </tr>
              </thead>
              <tbody>
                {data.objects.map((row) => (
                  <tr key={`${row.kind}:${row.id}`}>
                    <td>
                      {kindLabels[row.kind]} · {row.name}
                    </td>
                    <td>
                      {row.inputLabel ?? "未选择输入"}
                      <small>{row.inputId ?? "未知"}</small>
                    </td>
                    <td>
                      {statusLabels[row.status]}
                      <small>
                        {row.coverage
                          ? coverLabels[row.coverage.status]
                          : "覆盖未知"}
                      </small>
                    </td>
                    <td>{row.collectedAt ?? "未知"}</td>
                    <td>
                      <button
                        onClick={() => {
                          setDetail(row);
                          setEvidence(undefined);
                        }}
                      >
                        下钻 {row.name}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {detail && (
            <article className="dashboard-detail">
              <h3>{detail.name} · 固定范围明细</h3>
              <p>
                对象 {detail.id} · 输入 {detail.inputId ?? "未选择"} · 评估{" "}
                {detail.assessmentId ?? "未选择"} · 哈希{" "}
                {detail.inputHash ?? "未知"}
              </p>
              <p>
                软件/镜像组件 {show(detail.componentCount)} · 主机已安装软件{" "}
                {show(detail.installedSoftwareCount)}
              </p>
              {detail.issues.map((i, n) => (
                <p key={n}>{i}</p>
              ))}
              {detail.assessmentId && (
                <button onClick={() => fixedEvidence(detail.assessmentId!)}>
                  查看固定任务证据
                </button>
              )}
              <details>
                <summary>该对象生命周期证据</summary>
                <pre>
                  {detail.lifecycle
                    ? JSON.stringify(detail.lifecycle, null, 2)
                    : "本所选版本没有匹配的生命周期评估；未知"}
                </pre>
              </details>
            </article>
          )}
          <h3>历史趋势与覆盖变化</h3>
          <p>
            {data.scope.trendMode === "object_history"
              ? "显式跨版本对比：所选对象所有输入的历史批次。"
              : "仅所选输入版本的历史批次。"}{" "}
            {data.trend.warning}
          </p>
          {data.trend.truncated && (
            <p role="status">
              趋势仅展示最近200行，总计{data.trend.total}行，已截断。
            </p>
          )}
          <div className="dashboard-scroll">
            <table>
              <thead>
                <tr>
                  <th>时间 / 固定批次</th>
                  <th>输入</th>
                  <th>独立观测实例 / 唯一标识</th>
                  <th>覆盖 / 库时间</th>
                  <th>可比性</th>
                </tr>
              </thead>
              <tbody>
                {data.trend.items.map((t) => (
                  <tr key={t.assessmentId}>
                    <td>
                      {t.at}
                      <small>
                        {statusLabels[t.status]} · {t.assessmentId}
                      </small>
                    </td>
                    <td>{t.inputId}</td>
                    <td>
                      {show(t.instances)} / {show(t.uniqueObserved)}
                    </td>
                    <td>
                      {coverLabels[t.coverage]} · {t.databaseFreshness}
                    </td>
                    <td>
                      {t.inputChanged ? "输入变化；" : ""}
                      {t.coverageChanged ? "覆盖变化；" : ""}
                      {t.comparableWithPrevious
                        ? "同输入/工具/库/完整覆盖，可对照观测"
                        : "不可据此断言修复"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {findings && (
            <article className="dashboard-detail">
              <h3>固定范围观测明细 · 总计 {findings.total}</h3>
              <p>
                第 {Math.min(findings.offset + 1, findings.total)}–
                {Math.min(findings.offset + findings.limit, findings.total)}{" "}
                条；按同一固定批次与时间范围分页。
              </p>
              <table>
                <thead>
                  <tr>
                    <th>CVE / 公告</th>
                    <th>包 / 版本</th>
                    <th>适用性</th>
                    <th>证据</th>
                  </tr>
                </thead>
                <tbody>
                  {findings.items.map((f, i) => (
                    <tr key={`${f.assessmentId}:${f.findingId}:${i}`}>
                      <td>
                        {f.cve} · {f.severity}
                      </td>
                      <td>
                        {f.packageName} {f.installedVersion}
                      </td>
                      <td>
                        {applicability[f.applicability] ?? f.applicability}
                      </td>
                      <td>
                        <button onClick={() => fixedEvidence(f.assessmentId)}>
                          固定任务 {f.assessmentId.slice(0, 8)}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <button
                disabled={findings.offset === 0}
                onClick={() =>
                  drilldown(Math.max(0, findings.offset - findings.limit))
                }
              >
                上一页实例
              </button>
              <button
                disabled={findings.offset + findings.limit >= findings.total}
                onClick={() => drilldown(findings.offset + findings.limit)}
              >
                下一页实例
              </button>
            </article>
          )}
          {evidence !== undefined && (
            <details open className="dashboard-detail">
              <summary>固定任务原始证据</summary>
              <pre>{JSON.stringify(evidence, null, 2)}</pre>
            </details>
          )}
          <div className="dashboard-notes">
            {data.warnings.map((w) => (
              <p key={w}>{w}</p>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
