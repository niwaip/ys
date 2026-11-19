import {
  AssessmentDetails,
  assessmentStatusLabels as labels,
} from "./AssessmentDetails";
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
      {job && <AssessmentDetails job={job} />}
    </section>
  );
}
