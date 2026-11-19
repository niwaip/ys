import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type { CustomerConversation } from "../../../../../packages/contracts/conversations";
import type { AssessmentSummary } from "../../../../../packages/contracts/assessments";
type Summary = Pick<
  CustomerConversation,
  "id" | "message" | "createdAt" | "status"
>;
export function ConversationsPage({
  customerId,
  token,
  onUnauthorized,
}: FeatureProps) {
  const [message, setMessage] = useState("");
  const [ids, setIds] = useState<string[]>([]);
  const [assessments, setAssessments] = useState<AssessmentSummary[]>([]);
  const [history, setHistory] = useState<Summary[]>([]);
  const [selected, setSelected] = useState<CustomerConversation>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const base = `/customers/${customerId}/conversations`;
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  useEffect(() => {
    const c = new AbortController();
    let active = true;
    const refresh = async () => {
      try {
        const h = await api<{ items: Summary[] }>(base, token, {}, c.signal);
        if (!active) return;
        setHistory(h.items);
        if (selected) {
          const d = await api<CustomerConversation>(
            `${base}/${selected.id}`,
            token,
            {},
            c.signal,
          );
          if (active) setSelected(d);
        }
      } catch (e) {
        if (!c.signal.aborted) fail(e);
      }
    };
    void refresh();
    api<{ items: AssessmentSummary[] }>(
      `/customers/${customerId}/assessments?targetKind=software&limit=100`,
      token,
      {},
      c.signal,
    )
      .then((r) => {
        if (active) setAssessments(r.items);
      })
      .catch((e) => {
        if (!c.signal.aborted) fail(e);
      });
    const timer = setInterval(refresh, 1000);
    return () => {
      active = false;
      c.abort();
      clearInterval(timer);
    };
  }, [customerId, token, selected?.id]);
  async function send() {
    setBusy(true);
    setError("");
    try {
      const d = await api<CustomerConversation>(base, token, {
        method: "POST",
        body: JSON.stringify({
          message,
          assessmentIds: ids,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setSelected(d);
      setHistory((old) => [d, ...old]);
      setMessage("");
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    try {
      setSelected(await api<CustomerConversation>(`${base}/${id}`, token));
    } catch (e) {
      fail(e);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">CUSTOMER EVIDENCE</div>
          <h1>客户风险对话</h1>
          <p>只读当前客户明确选择的软件评估；不会发起扫描或修改判定。</p>
        </div>
      </div>
      <section className="asset-panel import-upload">
        <h2>选择本次证据范围</h2>
        <p>
          显示最近100条软件任务。支持单个CVE编号；未给编号时列出所选评估全部发现，复杂条件不自动执行。明确选择版本与批次，历史任务不自动累加为当前风险。
        </p>
        {assessments.length ? (
          <ul>
            {assessments.map((a) => (
              <li key={a.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={ids.includes(a.id)}
                    onChange={(e) =>
                      setIds((old) =>
                        e.target.checked
                          ? [...old, a.id]
                          : old.filter((id) => id !== a.id),
                      )
                    }
                  />
                  {a.id} · {a.status} · 版本 {a.input.version ?? "未知"} · 发现{" "}
                  {a.findingCount ?? "未知"}
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p>暂无已保存的软件评估；当前范围未评估。</p>
        )}
        <label>
          客户问题
          <textarea
            rows={3}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={4000}
            placeholder="该客户哪些组件涉及 CVE-2024-4577？"
          />
        </label>
        <button
          className="primary"
          onClick={send}
          disabled={busy || !message.trim()}
        >
          查询已保存评估
        </button>
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {selected && (
        <section className="asset-panel import-preview">
          <h2>固定证据答复</h2>
          <p>{selected.message}</p>
          <p>{selected.answer}</p>
          <p role="status">Pi任务：{selected.status}</p>
          {selected.error && <p>{selected.error}</p>}
          <p>{selected.facts.scopeNote}</p>
          <pre>{JSON.stringify(selected.facts.matches, null, 2)}</pre>
          <details>
            <summary>评估引用、覆盖与事实哈希</summary>
            <pre>{JSON.stringify(selected.facts, null, 2)}</pre>
          </details>
          <ol>
            {selected.events.map((e, i) => (
              <li key={i}>
                {e.at} · {e.message}
              </li>
            ))}
          </ol>
        </section>
      )}
      <section className="asset-panel import-history">
        <h2>当前客户的只读对话</h2>
        <ul>
          {history.map((h) => (
            <li key={h.id}>
              <button className="text-button" onClick={() => open(h.id)}>
                {h.message}
              </button>{" "}
              · {h.status}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
