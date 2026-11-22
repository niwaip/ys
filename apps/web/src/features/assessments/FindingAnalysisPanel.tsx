import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { requestId } from "../../request-id";
import type { FeatureProps } from "../../features";
import type { VulnerabilityFinding } from "../../../../../packages/contracts/assessments";
import type {
  FindingAnalysis,
  AnalysisSection,
} from "../../../../../packages/contracts/finding-analysis";
export function FindingAnalysisPanel({
  context,
  assessmentId,
  finding,
  onClose,
}: {
  context: FeatureProps;
  assessmentId: string;
  finding: VulnerabilityFinding;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    key = useRef(requestId());
  const [job, setJob] = useState<FindingAnalysis>(),
    [previous, setPrevious] = useState<FindingAnalysis>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false);
  const base = `/customers/${context.customerId}/assessments/${assessmentId}/findings/${finding.id}/analyses`;
  const active = job && ["queued", "running"].includes(job.status);
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) context.onUnauthorized();
    else setError((e as Error).message);
  };
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  useEffect(() => {
    const c = new AbortController();
    api<{ items: FindingAnalysis[] }>(base, context.token, {}, c.signal)
      .then(({ items }) => {
        if (c.signal.aborted) return;
        setJob(items[0]);
        setPrevious(items.find((j) => j.status === "succeeded"));
        setReady(true);
        if (!items.length) void start(c.signal);
      })
      .catch((e) => {
        if (!c.signal.aborted) fail(e);
      });
    return () => c.abort();
  }, [base, context.token]);
  useEffect(() => {
    if (!active || !job) return;
    const c = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await api<FindingAnalysis>(
          `${base}/${job.id}`,
          context.token,
          {},
          c.signal,
        );
        if (!c.signal.aborted) {
          setJob(next);
          if (next.status === "succeeded") setPrevious(next);
          if (["queued", "running"].includes(next.status))
            timer = setTimeout(refresh, 1500);
        }
      } catch (e) {
        if (!c.signal.aborted) {
          fail(e);
          timer = setTimeout(refresh, 3000);
        }
      }
    };
    timer = setTimeout(refresh, 800);
    return () => {
      c.abort();
      clearTimeout(timer);
    };
  }, [base, context.token, job?.id, !!active]);
  async function start(signal?: AbortSignal) {
    if (busy || active) return;
    setBusy(true);
    setError("");
    try {
      const next = await api<FindingAnalysis>(
        base,
        context.token,
        {
          method: "POST",
          body: JSON.stringify({ idempotencyKey: key.current }),
        },
        signal,
      );
      if (signal?.aborted) return;
      setJob(next);
      key.current = requestId();
    } catch (e) {
      if (!signal?.aborted) fail(e);
    } finally {
      if (!signal?.aborted) setBusy(false);
    }
  }
  const result = job?.status === "succeeded" ? job : previous;
  function section(title: string, rows: AnalysisSection[]) {
    return (
      <section className="analysis-section">
        <h3>{title}</h3>
        {rows.map((s, i) => (
          <p key={i}>
            {s.text}{" "}
            <small className="muted">
              {s.sourceIds
                .map((id) =>
                  id === "finding"
                    ? "[扫描事实]"
                    : `[来源 ${(result?.sources.findIndex((s) => s.id === id) ?? -1) + 1}]`,
                )
                .join(" ")}
            </small>
          </p>
        ))}
      </section>
    );
  }
  return (
    <dialog
      ref={dialog}
      className="finding-dialog"
      aria-label="漏洞 AI 解析"
      onCancel={onClose}
      onClose={onClose}
    >
      <header className="analysis-header">
        <div>
          <span className="eyebrow">漏洞 AI 解析</span>
          <h2>{finding.vulnerabilityId}</h2>
          <p>
            {finding.packageName} · {finding.installedVersion}
          </p>
        </div>
        <button autoFocus aria-label="关闭解析" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="analysis-body">
        <p className="analysis-notice">
          以下为 AI
          辅助解释。系统影响属于待核实推断，扫描判定保持不变；建议不会自动执行。
        </p>
        {error && <p role="alert">{error}</p>}
        {!ready && !error && <p>正在读取已保存解析…</p>}
        {(active || busy) && (
          <div role="status">
            <progress aria-label="AI解析进度" />
            <p>{job?.events.at(-1)?.message ?? "正在提交解析任务…"}</p>
          </div>
        )}
        {job && !active && job.status !== "succeeded" && (
          <p role="alert">
            解析未完成：{job.error ?? job.status}。
            {previous ? "上次成功的解析保留。" : "可重新发起解析。"}
          </p>
        )}
        {ready && (
          <button
            className="primary"
            disabled={busy || !!active}
            onClick={() => void start()}
          >
            {busy || active ? "解析中…" : job ? "重新解析" : "开始 AI 解析"}
          </button>
        )}
        {!job && ready && (
          <p className="muted">
            读取本条扫描证据并尝试受控公开查询，生成漏洞解释、可能影响与下一步建议。
          </p>
        )}
        {result?.narrative && (
          <>
            <p className="muted">
              {new Date(result.finishedAt ?? result.createdAt).toLocaleString(
                "zh-CN",
              )}{" "}
              · {result.model} {result.id !== job?.id ? "· 上次成功解析" : ""}
            </p>
            {!result.facts.context && (
              <p className="coverage-notice">
                此解析使用旧版事实，未包含结构化匹配依据与运行环境。可重新解析；历史结果保持原样。
              </p>
            )}
            {result.facts.context && (
              <section className="analysis-section">
                <h3>当前资产依据 · 独立于 AI 推断</h3>
                <p>{result.facts.context.basis}</p>
                <p>
                  适用性：
                  {result.facts.context.applicability.status ===
                  "conditions_not_met"
                    ? "采集时未发现适用条件"
                    : "证据不足"}
                  。{result.facts.context.applicability.reason}
                </p>
                <p>
                  运行内核：{result.facts.context.runtime?.kernel ?? "未取得"} ·
                  虚拟化：
                  {result.facts.context.runtime?.virtualization?.status ===
                  "acquired"
                    ? result.facts.context.runtime.virtualization.data
                    : "未取得"}
                </p>
                <p>
                  资料来源：{result.facts.context.runtime?.origin ?? "未知"} ·
                  环境采集时间：
                  {result.facts.context.runtime?.collectedAt ?? "未知"}
                  ；这些事实仅代表绑定的采集快照。
                </p>
                <small>
                  规则：{result.facts.context.applicability.rule}
                  ；扫描器原始匹配保留。
                </small>
              </section>
            )}
            {result.research && (
              <p
                className={
                  result.research.status === "available"
                    ? "analysis-notice"
                    : "coverage-notice"
                }
              >
                <strong>
                  {
                    {
                      available: "公开资料已取得",
                      partial: "公开查询：部分覆盖",
                      unavailable: "公开查询：不可用",
                    }[result.research.status]
                  }
                </strong>
                <br />
                {result.research.message}
                <br />
                查询时间：
                {new Date(result.research.queriedAt).toLocaleString("zh-CN")}
                {result.research.limitations?.map((text, i) => (
                  <span className="cell-subtext" key={i}>
                    {text}
                  </span>
                ))}
              </p>
            )}
            {section("漏洞说明", [result.narrative.explanation])}
            {section("系统影响 · 待核实推断", [result.narrative.impact])}
            {section("需要核实", result.narrative.checks)}
            {section("下一步计划 · 建议", result.narrative.nextSteps)}
            <section className="analysis-section">
              <h3>来源与证据</h3>
              <p>
                [扫描事实] 本次固定扫描记录；
                {result.facts.database.freshness === "fresh"
                  ? "扫描时数据库时间有效"
                  : "扫描时漏洞库过期或时间未知"}
                ，覆盖范围见扫描摘要。
              </p>
              {result.sources.map((s, i) => (
                <p key={s.id}>
                  [来源 {i + 1}]{" "}
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.title}
                  </a>
                  <br />
                  <small>
                    {new Date(s.retrievedAt).toLocaleString("zh-CN")} ·{" "}
                    {s.origin === "scanner"
                      ? "工具提供的链接，未重新抓取"
                      : "公开查询"}
                  </small>
                </p>
              ))}
            </section>
            <details>
              <summary>解析绑定信息</summary>
              <p>扫描：{result.assessmentId}</p>
              <p>记录：{result.findingId}</p>
              <p>事实 SHA-256：{result.factHash}</p>
              <p>技能：{result.skillVersion}</p>
            </details>
          </>
        )}
      </div>
    </dialog>
  );
}
