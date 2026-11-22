import { AssessmentDetails } from "../assessments/AssessmentDetails";
import type { Assessment } from "../../../../../packages/contracts/assessments";
import { ReportNarrationPanel } from "./ReportNarrationPanel";
import { ReportReviewPanel } from "./ReportReviewPanel";
import { useEffect, useRef, useState } from "react";
import type { AnyAssessmentPage as AssessmentPage } from "../../../../../packages/contracts/assessments";
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
    [linuxEvidence, setLinuxEvidence] = useState<Assessment>(),
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
    const response = await fetch(
      `/api${base}/reports/${selected.id}/revisions/${selected.revision.id}/preview`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.current.signal,
      },
    );
    if (!response.ok) throw new ApiError("报告预览失败", response.status);
    setHtml(await response.text());
    setReport(selected);
    setEvidence(undefined);
    setLinuxEvidence(undefined);
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
        <h3>CVE评估（主机 / 软件 / 镜像）</h3>
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
            {a.id} · {a.status} · 输入版本 {JSON.stringify(a.target)} /{" "}
            {("version" in a.input ? a.input.version : null) ?? "未知版本"} ·
            发现 {a.findingCount ?? "未知"} ·{" "}
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
          <p>仅受控段落与保护事实；正式交付需通过内部复核并绑定明确修订。</p>
          <ReportNarrationPanel
            report={report}
            customerId={customerId}
            token={token}
            onUnauthorized={onUnauthorized}
            onRevision={async (revision) => {
              await preview({ ...report, revision });
              await refresh();
            }}
          />
          <ReportReviewPanel
            report={report}
            customerId={customerId}
            token={token}
            onUnauthorized={onUnauthorized}
            onRevision={async (revision) => {
              await preview({ ...report, revision });
              await refresh();
            }}
          />
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
                  run(async () => {
                    const linux =
                      r.kind === "cve" &&
                      report.revision.facts.assessmentSnapshots.some(
                        (a) => a.id === r.id && a.target.kind === "linux",
                      );
                    setEvidence(undefined);
                    setLinuxEvidence(undefined);
                    if (linux) {
                      const source = await call<Assessment>(
                        `${base}/assessments/${r.id}?findingsOffset=0`,
                      );
                      if (
                        r.outputHash &&
                        source.execution?.outputHash !== r.outputHash
                      )
                        throw new Error("原始评估报告哈希与冻结依据不一致");
                      setLinuxEvidence(source);
                    } else
                      setEvidence(
                        await call(
                          `${base}/${r.kind === "cve" ? "assessments" : r.kind === "windows_rules" ? "windows/rules" : "lifecycle/assessments"}/${r.id}`,
                        ),
                      );
                  })
                }
              >
                {r.kind} 依据 {r.id}
              </button>
              {r.kind === "cve" &&
                report.revision.facts.assessmentSnapshots.some(
                  (a) => a.id === r.id && a.target.kind === "linux",
                ) && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        const original = await call<{
                          content: string;
                          contentHash: string;
                        }>(`${base}/assessments/${r.id}/report`);
                        if (
                          r.outputHash &&
                          original.contentHash !== r.outputHash
                        )
                          throw new Error("原始报告哈希与冻结依据不一致");
                        const url = URL.createObjectURL(
                          new Blob([original.content], {
                            type: "application/json",
                          }),
                        );
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = `trivy-${r.id}.json`;
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      })
                    }
                  >
                    下载原始扫描报告
                  </button>
                )}
            </p>
          ))}
          {linuxEvidence && (
            <AssessmentDetails
              context={{ customerId, token, onUnauthorized }}
              job={linuxEvidence}
              onFindingsPage={(offset, levels, search, component) =>
                void run(async () => {
                  const next = await call<Assessment>(
                    `${base}/assessments/${linuxEvidence.id}?findingsOffset=${offset}${levels ? "&severities=" + levels.join(",") : ""}&search=${encodeURIComponent(search ?? "")}${component ? `&component=${encodeURIComponent(component)}` : ""}`,
                  );
                  if (
                    next.execution?.outputHash !==
                    linuxEvidence.execution?.outputHash
                  )
                    throw new Error("原始评估报告哈希与冻结依据不一致");
                  setLinuxEvidence(next);
                })
              }
            />
          )}
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
