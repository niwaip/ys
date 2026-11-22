import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { requestId } from "../../request-id";
import type { FeatureProps } from "../../features";
import type { VulnerabilityFinding } from "../../../../../packages/contracts/assessments";
import type {
  FindingAnalysis,
  AnalysisSection,
} from "../../../../../packages/contracts/finding-analysis";
const AnalysisMarkdown = lazy(() =>
  import("./AnalysisMarkdown").then((m) => ({ default: m.AnalysisMarkdown })),
);
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
    [ready, setReady] = useState(false),
    [copyState, setCopyState] = useState("");
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
          <div key={i}>
            <Suspense fallback={<p>{s.text}</p>}>
              <AnalysisMarkdown>{s.text}</AnalysisMarkdown>
            </Suspense>
            <small className="muted">
              {s.sourceIds
                .map((id) =>
                  id === "finding"
                    ? "[扫描事实]"
                    : `[来源 ${(result?.sources.findIndex((s) => s.id === id) ?? -1) + 1}]`,
                )
                .join(" ")}
            </small>
          </div>
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
          <div role="alert" className="analysis-failure">
            <h3>解析未完成</h3>
            <p>
              失败阶段：
              {job.events.some(
                (e) =>
                  e.type === "tool_started" &&
                  e.message.includes("ys_finding_analysis"),
              )
                ? "生成并保存解析"
                : job.events.some((e) => e.type === "analysis")
                  ? "AI解析执行"
                  : job.events.some((e) => e.type === "research")
                    ? "公开资料查询或准备"
                    : "任务准备"}
            </p>
            <p>原因：{job.error ?? job.status}</p>
            {job.error === "固定工具执行失败" && (
              <p>此历史任务没有保存更细的错误分类，无法还原具体原因。</p>
            )}
            <p>
              下一步：
              {job.status === "unavailable"
                ? "请先联系管理员配置或恢复解析运行能力，再重新解析。"
                : job.status === "timed_out"
                  ? "请检查服务连接或稍后重新解析。"
                  : "可重新解析；若重复失败，请提供下方任务编号以便核查。"}
              {previous
                ? "上次成功的解析仍然保留。"
                : "尚未生成可用解析，不代表未发现漏洞。"}
            </p>
            <details>
              <summary>失败任务详情</summary>
              <p>任务编号：{job.id}</p>
              <p>
                最后进展：{job.events.at(-1)?.message ?? "没有已保存的进展记录"}
              </p>
            </details>
          </div>
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
            <button
              onClick={async () => {
                const n = result.narrative!;
                const sections: [string, AnalysisSection[]][] = [
                  ["当前系统影响 · 待核实推断", [n.impact]],
                  ["漏洞说明", [n.explanation]],
                  ["需要核实", n.checks],
                  ["下一步计划", n.nextSteps],
                ];
                const markdown =
                  `# ${finding.vulnerabilityId}\n\n${finding.packageName} · ${finding.installedVersion}\n\n` +
                  sections
                    .map(
                      ([title, rows]) =>
                        `## ${title}\n\n` +
                        rows
                          .map(
                            (r) =>
                              `${r.text}\n\n引用：${r.sourceIds.join(", ")}`,
                          )
                          .join("\n\n"),
                    )
                    .join("\n\n") +
                  "\n\n## 来源\n\n" +
                  result.sources
                    .map((s, i) => `${i + 1}. ${s.title} — ${s.url}`)
                    .join("\n");
                try {
                  await navigator.clipboard.writeText(markdown);
                  setCopyState("Markdown 已复制");
                } catch {
                  setCopyState("复制未成功，请使用浏览器选择并复制正文。");
                }
              }}
            >
              复制 Markdown
            </button>
            <span role="status">{copyState}</span>
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
            {section("系统影响 · 待核实推断", [result.narrative.impact])}
            {section("漏洞说明", [result.narrative.explanation])}
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
                  [来源 {i + 1}] <strong>{s.title}</strong>
                  <br />
                  <small>
                    {new Date(s.retrievedAt).toLocaleString("zh-CN")} ·{" "}
                    {s.origin === "scanner"
                      ? "工具提供的链接，未重新抓取"
                      : "公开查询"}{" "}
                    · 仅展示已保存来源信息，未抓取完整原文。
                  </small>
                  {/^https?:\/\//i.test(s.url) && (
                    <>
                      <br />
                      <a href={s.url} target="_blank" rel="noreferrer">
                        打开来源原文 ↗
                      </a>
                    </>
                  )}
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
