import { useEffect, useRef, useState } from "react";
import type { FeatureProps } from "../../features";
import type {
  Report,
  ReportRevision,
} from "../../../../../packages/contracts/reports";
import type { ReportNarrationJob } from "../../../../../packages/contracts/report-narration";
import { api, ApiError } from "../../api";
export function ReportNarrationPanel({
  report,
  customerId,
  token,
  onUnauthorized,
  onRevision,
}: FeatureProps & {
  report: Report;
  onRevision: (revision: ReportRevision) => Promise<void>;
}) {
  const [jobs, setJobs] = useState<ReportNarrationJob[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const controller = useRef(new AbortController()),
    base = `/customers/${customerId}/reports/${report.id}`;
  const call = <T,>(path: string, options: RequestInit = {}) =>
    api<T>(path, token, options, controller.current.signal);
  function fail(e: unknown) {
    if (controller.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  async function refresh() {
    setJobs(
      (await call<{ items: ReportNarrationJob[] }>(`${base}/narrations`)).items,
    );
  }
  useEffect(() => {
    controller.current = new AbortController();
    setJobs([]);
    setError("");
    setBusy(false);
    refresh().catch(fail);
    return () => controller.current.abort();
  }, [report.id, customerId, token]);
  const active = jobs.some(
    (j) => j.status === "queued" || j.status === "running",
  );
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => refresh().catch(fail), 500);
    return () => clearInterval(timer);
  }, [active, report.id]);
  async function generate() {
    setBusy(true);
    setError("");
    try {
      const job = await call<ReportNarrationJob>(`${base}/narrations`, {
        method: "POST",
        body: JSON.stringify({
          baseRevisionId: report.revision.id,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setJobs((current) => [job, ...current.filter((j) => j.id !== job.id)]);
    } catch (e) {
      fail(e);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  return (
    <section>
      <h3>AI 受控叙述</h3>
      <p>
        基于当前明确修订组织固定摘要、解释和建议模板。保护事实由服务端插入；生成成功仍为待复核草稿。校验、工具或模型失败保留现有事实草稿。
      </p>
      <button disabled={busy || active} onClick={generate}>
        生成 AI 受控叙述
      </button>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!jobs.length && <p>暂无AI叙述任务</p>}
      {jobs.map((job) => (
        <article key={job.id}>
          <p>
            任务 {job.id} · <strong>{job.status}</strong> · 基于修订{" "}
            {job.baseRevisionId}
          </p>
          {job.fallback && (
            <p role="status">AI叙述失败，固定事实草稿保留：{job.error}</p>
          )}
          <ul>
            {job.events.map((event, i) => (
              <li key={i}>
                {event.at} · {event.type} · {event.message}
              </li>
            ))}
          </ul>
          {job.resultRevisionId && (
            <button
              onClick={() =>
                call<ReportRevision>(
                  `${base}/revisions/${job.resultRevisionId}`,
                )
                  .then(onRevision)
                  .catch(fail)
              }
            >
              打开 AI 草稿
            </button>
          )}
        </article>
      ))}
    </section>
  );
}
