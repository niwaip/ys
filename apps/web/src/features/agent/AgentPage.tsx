import { requestId } from "../../request-id";
import { useEffect, useState } from "react";
import type { AgentQuery } from "../../../../../packages/contracts/agent";
import type { FeatureProps } from "../../features";
import { api, ApiError } from "../../api";
const labels: Record<AgentQuery["status"], string> = {
  queued: "等待执行",
  running: "执行中",
  succeeded: "声明来源查询完成",
  partial: "部分完成",
  failed: "失败",
  timed_out: "超时",
  unavailable: "不可用",
  interrupted: "已中断",
};
export function AgentPage({ token, onUnauthorized }: FeatureProps) {
  const [message, setMessage] = useState("");
  const [items, setItems] = useState<AgentQuery[]>([]);
  const [selected, setSelected] = useState<AgentQuery>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const refresh = async () => {
      try {
        const result = await api<{ items: AgentQuery[] }>(
          "/intelligence/queries",
          token,
          {},
          controller.signal,
        );
        if (!active) return;
        setItems(result.items);
        if (selected) {
          const detail = await api<AgentQuery>(
            `/intelligence/queries/${selected.id}`,
            token,
            {},
            controller.signal,
          );
          if (active) setSelected(detail);
        }
      } catch (e) {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
        else setError((e as Error).message);
      }
    };
    void refresh();
    const timer = setInterval(refresh, 1000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [token, selected?.id]);
  async function send() {
    setBusy(true);
    setError("");
    try {
      const result = await api<AgentQuery>("/intelligence/queries", token, {
        method: "POST",
        body: JSON.stringify({ message, idempotencyKey: requestId() }),
      });
      setSelected(result);
      setItems((old) => [result, ...old.filter((i) => i.id !== result.id)]);
      setMessage("");
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">PUBLIC INTELLIGENCE</div>
          <h1>公开 CVE 对话</h1>
          <p>查询公开情报，不读取所选客户的资产，也不生成客户受影响判定。</p>
        </div>
      </div>
      <section className="asset-panel import-upload">
        <h2>公开情报上下文</h2>
        <p>
          支持已有固定脚本的 PHP 查询或单个 CVE
          查询。工具未执行或来源失败时保留原因。
        </p>
        <label>
          原始问题
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            maxLength={4000}
          />
        </label>
        <button
          className="primary"
          disabled={busy || !message.trim()}
          onClick={send}
        >
          发送公开查询
        </button>
      </section>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {selected && (
        <section className="asset-panel import-preview">
          <h2>任务与工具结果</h2>
          <p>{selected.originalMessage}</p>
          <p role="status">{labels[selected.status]}</p>
          <p>未评估客户资产</p>
          <code>{selected.id}</code>
          {selected.error && <p className="error">{selected.error}</p>}
          <ol>
            {selected.events.map((e, i) => (
              <li key={i}>
                {e.at} · {e.message}
              </li>
            ))}
          </ol>
          {selected.result && (
            <>
              <h3>{selected.result.scope}</h3>
              <p>{selected.result.summary}</p>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>CVE</th>
                      <th>来源固定结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.result.results.map((r, i) => (
                      <tr key={i}>
                        <td>{String(r.cve_id)}</td>
                        <td>
                          <pre>{JSON.stringify(r, null, 2)}</pre>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <details>
                <summary>查询条件、覆盖与来源时间</summary>
                <pre>
                  {JSON.stringify(
                    {
                      query: selected.result.query,
                      coverage: selected.result.coverage,
                      sources: selected.result.sources,
                      evidence: selected.result.evidence,
                    },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          )}
        </section>
      )}
      <section className="asset-panel import-history">
        <h2>我的公开查询记录</h2>
        <p className="hint">最近 100 条；与客户评估记录分别保存。</p>
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <button className="text-button" onClick={() => setSelected(item)}>
                {item.originalMessage}
              </button>{" "}
              · {labels[item.status]}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
