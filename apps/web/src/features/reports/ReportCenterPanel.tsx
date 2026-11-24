import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type {
  ReportTask,
  ReportTaskInput,
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
}: FeatureProps & { onOpen: (id: string) => Promise<void> }) {
  const [hosts, setHosts] = useState<HostOption[]>([]),
    [selected, setSelected] = useState(""),
    [name, setName] = useState("服务器风险报告"),
    [tasks, setTasks] = useState<ReportTask[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [choice, setChoice] = useState(""),
    [choices, setChoices] = useState<
      { id: string; status: string; versionId: string; createdAt: string }[]
    >([]);
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
      await refresh();
    }
    load().catch(fail);
    return () => controller.current.abort();
  }, [customerId, token]);
  useEffect(() => {
    let active = true;
    setChoice("");
    setChoices([]);
    if (selected)
      call<{ items: typeof choices }>(`${base}/hosts/${selected}/assessments`)
        .then((result) => {
          if (active) setChoices(result.items);
        })
        .catch((e) => {
          if (active) fail(e);
        });
    return () => {
      active = false;
    };
  }, [selected, customerId, token]);
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
    action: "retry" | "cancel" | "finish",
  ) {
    setBusy(true);
    try {
      await call(`${base}/tasks/${task.id}/${action}`, {
        method: "POST",
        body: JSON.stringify(
          action === "retry"
            ? {
                itemIds: task.items
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
  async function create() {
    setBusy(true);
    setError("");
    try {
      const task = await call<ReportTask>(`${base}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          name,
          scope:
            scopeMode === "tenant"
              ? { kind: "tenant" }
              : {
                  kind: "selected",
                  assetIds: scopeMode === "multiple" ? multiIds : [selected],
                },
          mode,
          presentation,
          freshnessDays,
          overrides:
            choice && scopeMode === "single"
              ? [{ objectId: selected, assessmentId: choice }]
              : [],
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      await refresh();
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
      {selected && scopeMode === "single" && (
        <label className="block">
          报告评估批次
          <select
            aria-label="报告评估批次"
            value={choice}
            onChange={(e) => setChoice(e.target.value)}
          >
            <option value="">自动匹配当前资料版本</option>
            {choices.map((item) => (
              <option
                key={item.id}
                value={item.id}
                disabled={item.status === "queued" || item.status === "running"}
              >
                {new Date(item.createdAt).toLocaleString()} · {item.status} ·
                版本 {item.versionId.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label>
        结果来源
        <select
          aria-label="报告结果来源"
          value={mode}
          onChange={(e) => setMode(e.target.value as ReportTaskInput["mode"])}
        >
          <option value="existing">使用已有扫描结果</option>
          <option value="assess">基于已确认资料重新评估</option>
          <option value="incremental">仅补扫缺失或过期评估</option>
        </select>
      </label>
      {mode !== "existing" && (
        <p>
          使用固定的已确认资料；不隐式重新采集。未接入的平台或不完整资料会保留缺口；任务在后台执行，可刷新后查看。
        </p>
      )}
      <ReportPresentationFields
        value={presentation}
        onChange={setPresentation}
        disabled={busy}
      />
      <button
        className="primary"
        disabled={
          busy ||
          (scopeMode === "single" && !selected) ||
          (scopeMode === "multiple" && !multiIds.length) ||
          !name.trim() ||
          !Number.isInteger(freshnessDays) ||
          freshnessDays < 1 ||
          freshnessDays > 3650
        }
        onClick={create}
      >
        {mode === "existing" ? "使用已有结果生成报告" : "提交扫描报告任务"}
      </button>
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
                    {item.snapshotId ?? "未知"} · {item.error}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {!task.reportId && ["queued", "running"].includes(task.status) && (
            <button disabled={busy} onClick={() => taskAction(task, "cancel")}>
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
            ["needs_attention", "interrupted", "failed", "cancelled"].includes(
              task.status,
            ) && (
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
