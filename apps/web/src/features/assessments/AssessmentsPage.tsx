import { useEffect, useRef, useState } from "react";
import type { FeatureProps } from "../../features";
import { api, ApiError } from "../../api";
import type {
  Software,
  SoftwareDetail,
} from "../../../../../packages/contracts/software";
import type {
  Assessment,
  AssessmentPage,
} from "../../../../../packages/contracts/assessments";
import "../software/software.css";
const labels = {
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
export function AssessmentsPage({
  customerId,
  token,
  onUnauthorized,
}: FeatureProps) {
  const [software, setSoftware] = useState<Software[]>([]),
    [selected, setSelected] = useState<SoftwareDetail>(),
    [versionId, setVersionId] = useState(""),
    [history, setHistory] = useState<AssessmentPage>({
      items: [],
      total: 0,
      limit: 20,
      offset: 0,
    }),
    [job, setJob] = useState<Assessment>(),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const controller = useRef(new AbortController()),
    selectedJob = useRef<string | undefined>(undefined),
    offset = useRef(0);
  const base = `/customers/${customerId}`;
  async function call<T>(path: string, options: RequestInit = {}) {
    return api<T>(path, token, options, controller.current.signal);
  }
  function fail(e: unknown) {
    if (controller.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  async function refresh() {
    try {
      const pageOffset = offset.current;
      const page = await call<AssessmentPage>(
        `${base}/assessments?targetKind=software&limit=20&offset=${pageOffset}`,
      );
      if (pageOffset === offset.current) setHistory(page);
      const id = selectedJob.current;
      if (id) {
        const detail = await call<Assessment>(`${base}/assessments/${id}`);
        if (id === selectedJob.current) setJob(detail);
      }
    } catch (e) {
      fail(e);
    }
  }
  useEffect(() => {
    controller.current = new AbortController();
    call<{ items: Software[] }>(`${base}/software`)
      .then((r) => setSoftware(r.items))
      .catch(fail);
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      clearInterval(timer);
      controller.current.abort();
    };
  }, [customerId, token]);
  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      fail(e);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function select(id: string) {
    await run(async () => {
      setSelected(undefined);
      setVersionId("");
      setKey(crypto.randomUUID());
      if (id) setSelected(await call<SoftwareDetail>(`${base}/software/${id}`));
    });
  }
  return (
    <section className="software-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">固定工具评估</p>
          <h1>软件漏洞评估</h1>
          <p>
            选择已保存的软件 SBOM
            输入版本。任务在后端运行，刷新后可回读；公开情报不代表客户已受影响。
          </p>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <div className="panel">
        <h2>发起 Trivy 评估</h2>
        <label>
          软件对象
          <select
            disabled={busy}
            value={selected?.id ?? ""}
            onChange={(e) => select(e.target.value)}
          >
            <option value="">选择软件对象</option>
            {software.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          SBOM 输入版本
          <select
            disabled={busy || !selected}
            value={versionId}
            onChange={(e) => {
              setVersionId(e.target.value);
              setKey(crypto.randomUUID());
            }}
          >
            <option value="">选择输入版本</option>
            {selected?.versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.version ?? "版本未知"} · {v.createdAt} · {v.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>
        <p>
          重复提交同一请求回读原任务。超时或中断不会自动重试；需要重新评估时建立新请求。
        </p>
        <button
          disabled={busy || !selected || !versionId}
          onClick={() =>
            run(async () => {
              const result = await call<Assessment>(`${base}/assessments`, {
                method: "POST",
                body: JSON.stringify({
                  softwareId: selected!.id,
                  versionId,
                  idempotencyKey: key,
                }),
              });
              selectedJob.current = result.id;
              setJob(result);
              setMessage(
                result.replayed
                  ? "重复请求：回读原任务"
                  : "任务已提交，后台执行",
              );
              offset.current = 0;
              await refresh();
            })
          }
        >
          提交评估
        </button>
        <button
          disabled={busy}
          onClick={() => {
            setKey(crypto.randomUUID());
            setMessage("已建立新的评估请求；提交后生成独立任务");
          }}
        >
          新建评估请求
        </button>
      </div>
      <div className="panel">
        <h2>评估历史</h2>
        <p>{history.total} 个任务</p>
        {history.items.map((j) => (
          <button
            key={j.id}
            disabled={busy}
            onClick={() =>
              run(async () => {
                selectedJob.current = j.id;
                setJob(await call<Assessment>(`${base}/assessments/${j.id}`));
              })
            }
          >
            {labels[j.status]} · {j.createdAt} · {j.id.slice(0, 8)}
          </button>
        ))}
        <div>
          <button
            disabled={busy || history.offset === 0}
            onClick={() => {
              offset.current = Math.max(0, history.offset - 20);
              refresh();
            }}
          >
            上一页
          </button>
          <button
            disabled={busy || history.offset + history.limit >= history.total}
            onClick={() => {
              offset.current = history.offset + 20;
              refresh();
            }}
          >
            下一页
          </button>
        </div>
      </div>
      {job && (
        <div className="panel">
          <h2>任务详情</h2>
          <p>
            状态：<strong>{labels[job.status]}</strong>
          </p>
          <p>任务编号：{job.id}</p>
          <p>
            对象（{job.target.kind}）：{job.target.kind==="software"?job.target.softwareId:job.target.containerId} · 输入版本：{job.target.versionId}
          </p>
          <p>
            来源资料：{job.input.importId} · SHA-256：{job.input.contentHash}
          </p>
          <p>
            开始：{job.startedAt ?? "未开始"} · 完成：
            {job.finishedAt ?? "未完成"}
          </p>
          {job.error && <p role="alert">{job.error}</p>}
          {!job.result && <p>尚无有效评估结果；不可解读为零发现。</p>}
          {job.result && (
            <>
              <h3>
                {job.result.outcome === "findings"
                  ? `发现 ${job.result.findings.length} 条漏洞记录`
                  : "本次工具未报告漏洞"}
              </h3>
              <p>
                覆盖：{coverageLabels[job.result.coverage.status]}（
                {job.result.coverage.matchedComponents}/
                {job.result.coverage.inputComponents} 个声明组件） ·{" "}
                {freshLabels[job.result.database.freshness]}
              </p>
              <p>
                库更新：{job.result.database.updatedAt ?? "未知"} · 下次更新：
                {job.result.database.nextUpdate ?? "未知"}
              </p>
              {job.result.coverage.issues.map((issue, i) => (
                <p key={i}>{issue}</p>
              ))}
              <table>
                <thead>
                  <tr>
                    <th>组件 / 安装版本</th>
                    <th>漏洞 / 严重程度</th>
                    <th>修复与工具依据</th>
                  </tr>
                </thead>
                <tbody>
                  {job.result.findings.map((f) => (
                    <tr key={f.id}>
                      <td>
                        {f.packageName}
                        <br />
                        {f.installedVersion}
                        <p>
                          {f.ecosystem} · {f.target}
                        </p>
                        <p>
                          {f.componentId
                            ? "已关联输入组件"
                            : "无法唯一关联组件"}
                        </p>
                      </td>
                      <td>
                        <strong>{f.vulnerabilityId}</strong>
                        <p>{f.severity}</p>
                      </td>
                      <td>
                        <p>
                          工具报告修复版本：
                          {f.fixedVersion ?? "未知，不能据此认定无补丁"}
                        </p>
                        <p>适用性：工具报告；未人工改判</p>
                        {f.primaryUrl && /^https?:\/\//.test(f.primaryUrl) && (
                          <a
                            href={f.primaryUrl}
                            target="_blank"
                            rel="noreferrer"
                          >
                            工具来源
                          </a>
                        )}
                        <details>
                          <summary>漏洞原始证据</summary>
                          <pre>{JSON.stringify(f.evidence, null, 2)}</pre>
                        </details>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          {job.execution && (
            <>
              <h3>执行证据</h3>
              <p>
                Trivy：{job.execution.toolVersion ?? "版本未知"} · 退出码：
                {job.execution.exitCode ?? "未知"} · 信号：
                {job.execution.signal ?? "无"}
              </p>
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
              {job.execution.rawReport && (
                <details>
                  <summary>原始 Trivy 报告</summary>
                  <pre>{job.execution.rawReport}</pre>
                </details>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
