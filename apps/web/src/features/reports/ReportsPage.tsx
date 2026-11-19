import { useEffect, useRef, useState } from "react";
import type { AssessmentPage } from "../../../../../packages/contracts/assessments";
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
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
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
    const response = await fetch(`/api${base}/reports/${selected.id}/preview`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.current.signal,
    });
    if (!response.ok) throw new ApiError("报告预览失败", response.status);
    setHtml(await response.text());
    setReport(selected);
    setEvidence(undefined);
  }
  const toggle = (ids: string[], id: string, checked: boolean) =>
    checked ? [...ids, id] : ids.filter((x) => x !== id);
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">FACT REPORT</div>
          <h1>风险事实报告</h1>
          <p>选择明确评估版本生成固定模板草稿，事实与证据不会随新扫描改变。</p>
        </div>
      </div>
      <section className="asset-panel">
        <h2>选择报告依据</h2>
        <p>
          合计1–20个引用；同一对象输入版本每类只可选一次评估。这里只列最近100次。缺失、失败或未知范围保持披露，草稿尚未内部复核。
        </p>
        <h3>CVE 软件评估</h3>
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
            {a.id} · {a.status} · 输入版本 {a.target.versionId} /{" "}
            {a.input.version ?? "未知版本"} · 发现 {a.findingCount ?? "未知"} ·{" "}
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
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="asset-panel">
        <h2>报告历史</h2>
        {!history.length && <p>暂无报告</p>}
        {history.map((r) => (
          <p key={r.id}>
            <button
              disabled={busy}
              onClick={() =>
                run(async () =>
                  preview(await call<Report>(`${base}/reports/${r.id}`)),
                )
              }
            >
              {r.id}
            </button>{" "}
            · 修订 {r.revisionNumber} · {r.status} · {r.createdAt}
          </p>
        ))}
      </section>
      {report && (
        <section className="asset-panel">
          <h2>事实草稿预览</h2>
          <p>
            报告 {report.id} · 修订 {report.revision.id} ·{" "}
            {report.revision.status} · SHA-256 {report.revision.factHash}
          </p>
          <p>
            仅受控段落与保护事实；本片不提供自由事实编辑、AI生成或正式交付。
          </p>
          <iframe
            title="事实报告草稿"
            sandbox=""
            srcDoc={html}
            style={{
              width: "100%",
              height: "800px",
              border: "1px solid #ccd7df",
            }}
          />
          <h3>依据明细</h3>
          {report.revision.facts.sourceRefs.map((r) => (
            <p key={`${r.kind}:${r.id}`}>
              <button
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setEvidence(
                      await call(
                        `${base}/${r.kind === "cve" ? "assessments" : "lifecycle/assessments"}/${r.id}`,
                      ),
                    ),
                  )
                }
              >
                {r.kind} 依据 {r.id}
              </button>
            </p>
          ))}
          {evidence !== undefined && (
            <details open>
              <summary>原始评估依据</summary>
              <pre>{JSON.stringify(evidence, null, 2)}</pre>
            </details>
          )}
        </section>
      )}
    </>
  );
}
