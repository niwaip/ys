import { useEffect, useState } from "react";
import type { WindowsSnapshot } from "../../../../../packages/contracts/windows";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
type Preview = {
  snapshot: Omit<WindowsSnapshot, "extensions" | "software" | "kbs">;
  software: { items: WindowsSnapshot["software"]; total: number | null };
  kbs: { items: string[] | null; total: number | null };
};
const completeness = (v: boolean | null) =>
  v === null ? "未知" : v ? "完整" : "部分 / 不完整";
export function WindowsCollectionPreview({
  customerId,
  token,
  onUnauthorized,
  snapshotId,
}: FeatureProps & { snapshotId: string }) {
  const [data, setData] = useState<Preview>(),
    [offset, setOffset] = useState(0),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    setData(undefined);
    setError("");
    api<Preview>(
      `/customers/${customerId}/collections/snapshots/${snapshotId}/windows?offset=${offset}`,
      token,
      {},
      c.signal,
    )
      .then((v) => {
        if (!c.signal.aborted) setData(v);
      })
      .catch((e) => {
        if (c.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
        else setError(e.message);
      });
    return () => c.abort();
  }, [customerId, token, snapshotId, offset]);
  return (
    <details className="collect-options">
      <summary>Windows软件与补丁资料</summary>
      {error ? (
        <p role="alert">{error}</p>
      ) : !data ? (
        <p role="status">正在读取Windows资料…</p>
      ) : (
        <>
          <p>
            Build：{data.snapshot.fullBuild ?? data.snapshot.osBuild ?? "未知"}{" "}
            · 软件清单：{completeness(data.snapshot.softwareInventoryComplete)}{" "}
            · 补丁清单：{completeness(data.snapshot.kbInventoryComplete)} ·
            待重启：
            {data.snapshot.rebootPending === null
              ? "未知"
              : data.snapshot.rebootPending
                ? "是"
                : "否"}
          </p>
          <h3>软件（{data.software.total ?? "未知"}）</h3>
          {data.software.items ? (
            <div className="collect-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>版本</th>
                    <th>发布者</th>
                  </tr>
                </thead>
                <tbody>
                  {data.software.items.map((s, i) => (
                    <tr key={i}>
                      <td>{s.name ?? "未知"}</td>
                      <td>{s.version ?? "未知"}</td>
                      <td>{s.publisher ?? "未知"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>未取得软件清单</p>
          )}
          <h3>补丁（{data.kbs.total ?? "未知"}）</h3>
          {data.kbs.items ? (
            <p>{data.kbs.items.join(" · ") || "已取得的清单为空"}</p>
          ) : (
            <p>未取得补丁清单</p>
          )}
          <div className="pagination">
            <button
              type="button"
              disabled={!offset}
              onClick={() => setOffset((v) => Math.max(0, v - 50))}
            >
              上一批资料
            </button>
            <span>第 {Math.floor(offset / 50) + 1} 批 · 每批最多50项</span>
            <button
              type="button"
              disabled={
                offset + 50 >=
                Math.max(data.software.total ?? 0, data.kbs.total ?? 0)
              }
              onClick={() => setOffset((v) => v + 50)}
            >
              下一批资料
            </button>
          </div>
        </>
      )}
    </details>
  );
}
