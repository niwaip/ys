import { requestId } from "../../request-id";
import type {
  ReportSummary,
  Report,
} from "../../../../../packages/contracts/reports";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type {
  ReportTask,
  ReportTaskInput,
  ReportPreflight,
} from "../../../../../packages/contracts/report-center";
import {
  ReportPresentationFields,
  defaultPresentation,
} from "./ReportPresentationFields";
type HostOption = { id: string; name: string };

export function ReportCenterPanel({
  customerId,
  token,
  onUnauthorized,
  onOpen,
  history = [],
  sourceReport,
}: FeatureProps & {
  onOpen: (id: string) => Promise<void>;
  history?: ReportSummary[];
  sourceReport?: Report;
}) {
  const [hosts, setHosts] = useState<HostOption[]>([]),
    [selected, setSelected] = useState(""),
    [name, setName] = useState("服务器风险报告"),
    [tasks, setTasks] = useState<ReportTask[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [overrides, setOverrides] = useState<ReportTaskInput["overrides"]>([]);
  const [dirtySelection, setDirtySelection] = useState(false);
  const [step, setStep] = useState(1),
    [preflight, setPreflight] = useState<ReportPreflight>();
  const [comparisonReportId, setComparison] = useState(""),
    [useSource, setUseSource] = useState(false);
  const [output, setOutput] = useState<NonNullable<ReportTaskInput["output"]>>({
    pdfMode: "summary",
    perHost: false,
    evidence: false,
  });
  const submission = useRef<{ fingerprint: string; key: string } | undefined>(
    undefined,
  );
  const [windowsRuleImportId, setWindowsRule] = useState("");
  const [rules, setRules] = useState<{ id: string; fileName: string }[]>([]);
  const [allowExistingCollection, setAllowExistingCollection] = useState(false);
  const [mode, setMode] = useState<ReportTaskInput["mode"]>("existing");
  const [presentation, setPresentation] = useState(defaultPresentation);
  const controller = useRef(new AbortController());
  const [scopeMode, setScopeMode] = useState("single"),
    [multiIds, setMultiIds] = useState<string[]>([]),
    [freshnessDays, setFreshnessDays] = useState(7);
  const base = `/customers/${customerId}/report-center`;
  const call = <T,>(path: string, options: RequestInit = {}) =>
    api<T>(path, token, options, controller.current.signal);
  function fail(e: unknown) {
    if (controller.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  async function refresh() {
    setTasks((await call<{ items: ReportTask[] }>(`${base}/tasks`)).items);
  }
  useEffect(() => {
    controller.current = new AbortController();
    setHosts([]);
    setTasks([]);
    setSelected("");
    setMultiIds([]);
    setComparison("");
    setUseSource(false);
    setPreflight(undefined);
    setStep(1);
    submission.current = undefined;
    async function load() {
      const results = await Promise.all(
        ["server", "vm"].map(async (category) => {
          const items: HostOption[] = [];
          let offset = 0,
            total = 1;
          while (offset < total) {
            const page = await call<{ items: HostOption[]; total: number }>(
              `/customers/${customerId}/assets?category=${category}&limit=100&offset=${offset}`,
            );
            items.push(...page.items);
            total = page.total;
            offset += 100;
          }
          return items;
        }),
      );
      setHosts(results.flat());
      setRules(
        (
          await call<{ items: typeof rules }>(
            `/customers/${customerId}/windows/rules`,
          )
        ).items,
      );
      await refresh();
    }
    load().catch(fail);
    return () => controller.current.abort();
  }, [customerId, token]);
  useEffect(() => {
    setOverrides([]);
    setDirtySelection(false);
  }, [selected, scopeMode, JSON.stringify(multiIds), customerId, mode]);
  const hasActive = tasks.some((task) =>
    ["queued", "running"].includes(task.status),
  );
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => refresh().catch(fail), 500);
    return () => clearInterval(timer);
  }, [hasActive, customerId, token]);
  async function taskAction(
    task: ReportTask,
    action: "retry" | "cancel" | "finish" | "resume",
    itemIds?: string[],
  ) {
    setBusy(true);
    try {
      await call(`${base}/tasks/${task.id}/${action}`, {
        method: "POST",
        body: JSON.stringify(
          action === "retry"
            ? {
                itemIds:
                  itemIds ??
                  task.items
                    ?.filter((item) =>
                      ["failed", "interrupted", "running", "pending"].includes(
                        item.status,
                      ),
                    )
                    .map((item) => item.id),
              }
            : {},
        ),
      });
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  function input(): ReportTaskInput {
    const config = {
      name,
      scope:
        scopeMode === "tenant"
          ? { kind: "tenant" as const }
          : {
              kind: "selected" as const,
              assetIds: scopeMode === "multiple" ? multiIds : [selected],
            },
      mode,
      presentation,
      freshnessDays,
      allowExistingCollection,
      overrides: mode === "existing" ? overrides : [],
      output,
      ...(comparisonReportId ? { comparisonReportId } : {}),
      ...(useSource && sourceReport ? { sourceReportId: sourceReport.id } : {}),
      ...(windowsRuleImportId ? { windowsRuleImportId } : {}),
    };
    const fingerprint = JSON.stringify(config);
    if (submission.current?.fingerprint !== fingerprint)
      submission.current = { fingerprint, key: requestId() };
    return { ...config, idempotencyKey: submission.current!.key };
  }
  const validScope =
    !!name.trim() &&
    (scopeMode === "tenant" ||
      (scopeMode === "single" ? !!selected : multiIds.length > 0)) &&
    Number.isInteger(freshnessDays) &&
    freshnessDays >= 1 &&
    freshnessDays <= 3650;
  async function next() {
    if (step === 2 || (step === 3 && dirtySelection)) {
      setBusy(true);
      setError("");
      try {
        setPreflight(
          await call(`${base}/preflight`, {
            method: "POST",
            body: JSON.stringify(input()),
          }),
        );
        setDirtySelection(false);
        setStep(3);
      } catch (e) {
        fail(e);
      } finally {
        setBusy(false);
      }
    } else setStep(step + 1);
  }
  async function create() {
    setBusy(true);
    setError("");
    try {
      const task = await call<ReportTask>(`${base}/tasks`, {
        method: "POST",
        body: JSON.stringify(input()),
      });
      await refresh();
      submission.current = undefined;
      if (task.reportId) await onOpen(task.reportId);
    } catch (e) {
      fail(e);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  return (
    <section className="asset-panel" aria-label="服务器报告中心">
      <h2>从服务器生成报告</h2>
      <p>
        选择服务器，核对已有评估；未取得结果的范围仍保留，不能解释为零风险。
      </p>
      <ol aria-label="报告生成步骤">
        {["范围与名称", "结果来源", "覆盖检查", "章节与附件", "确认生成"].map(
          (label, index) => (
            <li
              key={label}
              aria-current={step === index + 1 ? "step" : undefined}
            >
              {index + 1}. {label}
            </li>
          ),
        )}
      </ol>
      <div hidden={step !== 1}>
        <label className="block">
          报告名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={160}
          />
        </label>
        <label className="block">
          报告范围
          <select
            aria-label="报告范围"
            value={scopeMode}
            onChange={(e) => setScopeMode(e.target.value)}
          >
            <option value="single">单台服务器</option>
            <option value="multiple">选中多台服务器</option>
            <option value="tenant">租户全部服务器</option>
          </select>
        </label>
        <label className="block">
          新鲜度提醒天数
          <input
            aria-label="新鲜度提醒天数"
            type="number"
            min={1}
            max={3650}
            value={freshnessDays}
            onChange={(e) => setFreshnessDays(Number(e.target.value))}
          />
        </label>
        {scopeMode === "single" && (
          <label className="block">
            报告服务器
            <select
              aria-label="报告服务器"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">请选择服务器</option>
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {scopeMode === "multiple" && (
          <label className="block">
            报告服务器（多选）
            <select
              aria-label="报告服务器（多选）"
              multiple
              size={6}
              value={multiIds}
              onChange={(e) =>
                setMultiIds(
                  Array.from(e.currentTarget.selectedOptions).map(
                    (option) => option.value,
                  ),
                )
              }
            >
              {hosts.map((host) => (
                <option key={host.id} value={host.id}>
                  {host.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {scopeMode === "tenant" && (
          <p>
            将固定当前租户全部在管物理服务器和虚拟机；没有评估结果的主机仍保留在报告中。
          </p>
        )}
      </div>
      <div hidden={step !== 2}>
        <label>
          结果来源
          <select
            aria-label="报告结果来源"
            value={mode}
            onChange={(e) => setMode(e.target.value as ReportTaskInput["mode"])}
          >
            <option value="existing">使用已有扫描结果</option>
            <option value="assess">基于已确认资料重新评估</option>
            <option value="collect">重新采集、确认后评估</option>
            <option value="incremental">仅补扫缺失或过期评估</option>
          </select>
        </label>
        {mode === "incremental" && (
          <label>
            <input
              type="checkbox"
              checked={allowExistingCollection}
              onChange={(e) => setAllowExistingCollection(e.target.checked)}
            />
            明确采用现有采集资料（含陈旧或未知日期），只补评估
          </label>
        )}
        {mode !== "existing" && (
          <p>
            使用固定的已确认资料；不隐式重新采集。未接入的平台或不完整资料会保留缺口；任务在后台执行，可刷新后查看。
          </p>
        )}
        {mode !== "existing" && (
          <label>
            Windows 离线规则
            <select
              aria-label="Windows 离线规则"
              value={windowsRuleImportId}
              onChange={(e) => setWindowsRule(e.target.value)}
            >
              <option value="">未选择（Windows 会披露缺口）</option>
              {rules.map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {rule.fileName}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div hidden={step !== 3}>
        <h3>范围与覆盖预检</h3>
        {preflight && (
          <>
            <p>
              当前预检 {preflight.total} 台，可用结果 {preflight.available}{" "}
              台，待补资料或未评估 {preflight.total - preflight.available}{" "}
              台。预检时间 {new Date(preflight.checkedAt).toLocaleString()}
              ；任务创建时固定实际范围。
            </p>
            <ul>
              {preflight.hosts.map((host) => (
                <li key={host.assetId}>
                  {host.name} ·{" "}
                  {host.status === "available" ? "有可用结果" : "未评估"} · 采集
                  {host.freshness.collection} / 评估{host.freshness.assessment}{" "}
                  {host.issues.join("；")}
                </li>
              ))}
            </ul>
          </>
        )}
        {mode === "existing" &&
          preflight?.resultChoices.map((group) => {
            const selected = overrides.find(
              (item) =>
                item.objectId === group.objectId &&
                item.versionId === group.versionId,
            );
            return (
              <label
                className="block"
                key={`${group.objectId}:${group.versionId ?? ""}`}
              >
                历史结果 · {group.name}
                <select
                  aria-label={`历史结果 ${group.name}${group.versionId ? ` ${group.versionId.slice(0, 8)}` : ""}`}
                  value={selected?.assessmentId ?? ""}
                  onChange={(e) => {
                    const others = overrides.filter(
                      (item) =>
                        !(
                          item.objectId === group.objectId &&
                          item.versionId === group.versionId
                        ),
                    );
                    setOverrides(
                      e.target.value
                        ? [
                            ...others,
                            {
                              objectId: group.objectId,
                              ...(group.versionId
                                ? { versionId: group.versionId }
                                : {}),
                              assessmentId: e.target.value,
                            },
                          ]
                        : others,
                    );
                    setDirtySelection(true);
                  }}
                >
                  <option value="">自动匹配当前资料版本的最近成功结果</option>
                  {group.items.map((item) => (
                    <option
                      key={item.id}
                      value={item.id}
                      disabled={["queued", "running"].includes(item.status)}
                    >
                      {new Date(item.createdAt).toLocaleString()} ·{" "}
                      {item.status} · 资料 {item.versionId.slice(0, 8)}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        {dirtySelection && (
          <>
            <p role="status">历史结果选择已变化，请重新检查对应资料与覆盖。</p>
            <button disabled={busy} onClick={next}>
              应用历史选择并重新检查
            </button>
          </>
        )}
      </div>
      <div hidden={step !== 4}>
        <ReportPresentationFields
          value={presentation}
          onChange={setPresentation}
          disabled={busy}
        />
        <label>
          历史比较基准
          <select
            aria-label="历史比较基准"
            value={comparisonReportId}
            onChange={(e) => setComparison(e.target.value)}
          >
            <option value="">不启用历史比较</option>
            {history.map((report) => (
              <option key={report.id} value={report.id}>
                {report.name ?? "历史报告"} ·{" "}
                {new Date(report.createdAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        {sourceReport && (
          <label>
            <input
              type="checkbox"
              checked={useSource}
              onChange={(e) => setUseSource(e.target.checked)}
            />
            关联当前查看的报告作为来源
          </label>
        )}
        <label>
          PDF 明细模式
          <select
            aria-label="新报告 PDF 明细模式"
            value={output.pdfMode}
            onChange={(e) =>
              setOutput({
                ...output,
                pdfMode: e.target.value as "summary" | "full",
              })
            }
          >
            <option value="summary">摘要（每评估前 20 条）</option>
            <option value="full">完整漏洞明细</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={output.perHost}
            onChange={(e) =>
              setOutput({ ...output, perHost: e.target.checked })
            }
          />
          附逐台服务器 PDF
        </label>
        <label>
          <input
            type="checkbox"
            checked={output.evidence}
            onChange={(e) =>
              setOutput({ ...output, evidence: e.target.checked })
            }
          />
          附原始扫描证据
        </label>
        <p>
          默认生成 PDF、离线 HTML、完整 XLSX
          和清单；所选附件失败会标为包不完整，可以单独重试或调整附件选择重新生成。
        </p>
      </div>
      <div hidden={step !== 5}>
        <h3>确认生成</h3>
        <p>
          {name} ·{" "}
          {scopeMode === "tenant"
            ? "租户全部服务器"
            : scopeMode === "single"
              ? "单台服务器"
              : `${multiIds.length} 台服务器`}{" "}
          · {mode === "existing" ? "已有结果" : "后台扫描任务"} ·{" "}
          {output.pdfMode === "summary" ? "摘要 PDF" : "完整 PDF"}
          、HTML、XLSX；草稿需内部复核后正式交付。
        </p>
        <button
          className="primary"
          disabled={busy || !validScope || !preflight}
          onClick={create}
        >
          {mode === "existing" ? "使用已有结果生成报告" : "提交扫描报告任务"}
        </button>
      </div>
      <p>
        {step > 1 && (
          <button disabled={busy} onClick={() => setStep(step - 1)}>
            上一步
          </button>
        )}{" "}
        {step < 5 && (
          <button
            disabled={busy || !validScope || (step === 3 && dirtySelection)}
            onClick={next}
          >
            下一步
          </button>
        )}
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h3>服务器报告任务</h3>
      {!tasks.length && <p>暂无服务器报告任务</p>}
      {tasks.map((task) => (
        <article key={task.id}>
          <p>
            {task.name} ·{" "}
            {task.status === "completed" ? "草稿已生成" : task.status} ·{" "}
            {task.hosts.length} 台 · {new Date(task.createdAt).toLocaleString()}
            {task.reportId && (
              <button
                onClick={() => onOpen(task.reportId!).catch(fail)}
                aria-label={`查看报告 ${task.name}`}
              >
                查看报告
              </button>
            )}
          </p>
          {task.status === "waiting" && (
            <button disabled={busy} onClick={() => taskAction(task, "resume")}>
              已上传或确认，继续任务
            </button>
          )}
          {task.error && <p role="status">{task.error}</p>}
          {task.items && (
            <details>
              <summary>
                查看逐项进度 ·{" "}
                {
                  task.items.filter((item) =>
                    ["succeeded", "reused"].includes(item.status),
                  ).length
                }
                /{task.items.length} 项可用
              </summary>
              <ul>
                {task.items.map((item) => (
                  <li key={item.id}>
                    {item.name} · {item.kind} · {item.status} · 输入{" "}
                    {item.snapshotId ?? "未知"} · {item.error}{" "}
                    {item.collectionRunId && `采集批次 ${item.collectionRunId}`}
                    {item.needsCollection && (
                      <a
                        href={`#collections?asset=${item.hostIds[0]}${item.snapshotId ? `&snapshot=${item.snapshotId}` : ""}`}
                      >
                        打开采集与资料确认
                      </a>
                    )}
                    {!task.reportId &&
                      [
                        "needs_attention",
                        "interrupted",
                        "failed",
                        "waiting",
                      ].includes(task.status) &&
                      ["failed", "interrupted", "pending", "running"].includes(
                        item.status,
                      ) && (
                        <button
                          disabled={busy}
                          onClick={() => taskAction(task, "retry", [item.id])}
                        >
                          重试此项 · {item.name}
                        </button>
                      )}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!task.reportId &&
            ["queued", "running", "waiting"].includes(task.status) && (
              <button
                disabled={busy}
                onClick={() => taskAction(task, "cancel")}
              >
                取消后续执行
              </button>
            )}
          {!task.reportId &&
            ["needs_attention", "interrupted", "failed"].includes(
              task.status,
            ) && (
              <button disabled={busy} onClick={() => taskAction(task, "retry")}>
                重试失败或中断项
              </button>
            )}
          {!task.reportId &&
            [
              "needs_attention",
              "interrupted",
              "failed",
              "cancelled",
              "waiting",
            ].includes(task.status) && (
              <button
                disabled={busy}
                onClick={() => taskAction(task, "finish")}
              >
                保留缺口生成报告
              </button>
            )}
        </article>
      ))}
    </section>
  );
}
