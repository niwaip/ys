import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type { ReportTask } from "../../../../../packages/contracts/report-center";
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
  const controller = useRef(new AbortController());
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
  async function create() {
    setBusy(true);
    setError("");
    try {
      const task = await call<ReportTask>(`${base}/tasks`, {
        method: "POST",
        body: JSON.stringify({
          name,
          scope: { kind: "selected", assetIds: [selected] },
          mode: "existing",
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
        报告服务器
        <select aria-label="报告服务器" value={selected} onChange={(e) => setSelected(e.target.value)}>
          <option value="">请选择服务器</option>
          {hosts.map((host) => (
            <option key={host.id} value={host.id}>
              {host.name}
            </option>
          ))}
        </select>
      </label>
      <button
        className="primary"
        disabled={busy || !selected || !name.trim()}
        onClick={create}
      >
        使用已有结果生成报告
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h3>服务器报告任务</h3>
      {!tasks.length && <p>暂无服务器报告任务</p>}
      {tasks.map((task) => (
        <p key={task.id}>
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
      ))}
    </section>
  );
}
