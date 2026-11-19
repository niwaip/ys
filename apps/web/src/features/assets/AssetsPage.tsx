import { AssetBaseline } from "../collections/AssetBaseline";
import { NetBoxPanel } from "./NetBoxPanel";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { AssetPage } from "../../../../../packages/contracts";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
export function AssetsPage({
  customerId,
  token,
  onUnauthorized,
}: FeatureProps) {
  const [detailAsset, setDetailAsset] = useState<{
    id: string;
    name: string;
  }>();
  const [netboxMode, setNetboxMode] = useState<boolean | undefined>();
  const refresh = useCallback(() => setRevision((x) => x + 1), []);
  const [data, setData] = useState<AssetPage>();
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setData(undefined);
    setError("");
    api<AssetPage>(
      `/customers/${customerId}/assets?limit=20&offset=${offset}`,
      token,
      {},
      controller.signal,
    )
      .then(setData)
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
        else setError(e.message);
      });
    return () => controller.abort();
  }, [customerId, token, offset, revision, onUnauthorized]);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    let attributes: unknown;
    try {
      attributes = JSON.parse(String(values.get("attributes") || "{}"));
    } catch {
      setError("扩展属性需填写有效的 JSON 对象");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await api(`/customers/${customerId}/assets`, token, {
        method: "POST",
        body: JSON.stringify({
          name: values.get("name"),
          kind: "host",
          sourceRef: String(values.get("sourceRef") || "") || undefined,
          attributes,
        }),
      });
      setCreating(false);
      setNotice("资产已保存");
      setOffset(0);
      setRevision((x) => x + 1);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">ASSET INVENTORY</div>
          <h1>资产台账</h1>
          <p>统一记录每一项资产，让风险分析有据可依。</p>
        </div>
        <button
          className="primary"
          disabled={netboxMode !== false}
          onClick={() => {
            setCreating(true);
            setError("");
          }}
        >
          ＋ 新建资产
        </button>
      </div>
      <NetBoxPanel
        key={customerId}
        customerId={customerId}
        token={token}
        onUnauthorized={onUnauthorized}
        onMode={setNetboxMode}
        onChange={refresh}
      />
      <div className="stats">
        <div className="stat">
          <span>纳管资产</span>
          <strong>
            {data?.total ?? "—"}
            <small> 项</small>
          </strong>
          <p>当前客户的独立资产记录</p>
        </div>
        <div className="stat">
          <span>资产类型</span>
          <strong className="stat-word">主机</strong>
          <p>人工建档 · 持续补充资料</p>
        </div>
        <div className="stat">
          <span>评估覆盖</span>
          <strong className="stat-word muted">尚未评估</strong>
          <p>建立台账后接入评估依据</p>
        </div>
      </div>
      {error && (
        <div role="alert" className="error">
          {error}{" "}
          <button
            className="text-button"
            onClick={() => setRevision((x) => x + 1)}
          >
            重试读取
          </button>
        </div>
      )}
      {notice && (
        <div role="status" className="notice">
          ✓ {notice}
        </div>
      )}
      <section className="asset-panel">
        <div className="panel-heading">
          <h2>
            全部资产 <span>{data?.total ?? "—"}</span>
          </h2>
          <span className="subtle">按建档时间排序</span>
        </div>
        {!data ? (
          <div className="empty">
            {error ? "暂时无法读取资产" : "正在读取资产…"}
          </div>
        ) : !data.total ? (
          <div className="empty">
            <div className="empty-icon">▦</div>
            <h3>还没有资产</h3>
            <p>
              为当前客户建立第一项主机资产。
              <br />
              名称、来源标识和扩展资料将一并保存。
            </p>
            <button
              className="secondary"
              disabled={netboxMode !== false}
              onClick={() => setCreating(true)}
            >
              建立第一项资产
            </button>
          </div>
        ) : (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>资产名称 / 内部编号</th>
                    <th>类型</th>
                    <th>来源标识</th>
                    <th>扩展属性</th>
                    <th>建档时间</th>
                    <th>评估状态</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((asset) => (
                    <tr key={asset.id}>
                      <td>
                        <button
                          className="text-button"
                          onClick={() =>
                            setDetailAsset({ id: asset.id, name: asset.name })
                          }
                        >
                          {asset.name}
                        </button>
                        <code title={asset.id}>{asset.id}</code>
                      </td>
                      <td>
                        <span className="badge">主机</span>
                      </td>
                      <td>
                        {asset.sourceRef || (
                          <span className="subtle">未提供</span>
                        )}
                        <small className="block subtle">
                          {asset.source === "manual"
                            ? "人工录入"
                            : asset.source}
                        </small>
                        {asset.importId && (
                          <small className="block subtle">
                            导入资料 <code>{asset.importId}</code>
                          </small>
                        )}
                      </td>
                      <td>
                        <details>
                          <summary>
                            {Object.keys(asset.attributes).length} 项属性
                          </summary>
                          <pre>{JSON.stringify(asset.attributes, null, 2)}</pre>
                        </details>
                      </td>
                      <td className="date">
                        {new Date(asset.createdAt).toLocaleString("zh-CN")}
                      </td>
                      <td>
                        <span className="status-dot" />
                        未评估
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pagination">
              <span>
                显示 {offset + 1}–{Math.min(offset + 20, data.total)} /{" "}
                {data.total} 项
              </span>
              <div>
                <button
                  className="secondary"
                  disabled={!offset}
                  onClick={() => setOffset((x) => x - 20)}
                >
                  上一页
                </button>
                <button
                  className="secondary"
                  disabled={offset + 20 >= data.total}
                  onClick={() => setOffset((x) => x + 20)}
                >
                  下一页
                </button>
              </div>
            </div>
          </>
        )}
      </section>
      <div className="footnote">
        ◈ 客户数据独立保存 · 名称不作为全局身份 · 未评估不代表无风险
      </div>
      {detailAsset && (
        <div className="collection-page">
          <div className="collect-overlay">
            <section
              className="collect-dialog baseline-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="资产详情"
            >
              <header>
                <h2>
                  资产详情 ·{" "}
                  {data?.items.find((item) => item.id === detailAsset.id)
                    ?.name ?? detailAsset.name}
                </h2>
                <button
                  className="collect-icon-button"
                  aria-label="关闭资产详情"
                  onClick={() => setDetailAsset(undefined)}
                >
                  ×
                </button>
              </header>
              <AssetBaseline
                customerId={customerId}
                token={token}
                onUnauthorized={onUnauthorized}
                assetId={detailAsset.id}
                onConfirmed={refresh}
              />
            </section>
          </div>
        </div>
      )}
      {creating && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-title"
          >
            <div className="panel-heading">
              <div>
                <div className="eyebrow">NEW ASSET</div>
                <h2 id="create-title">新建主机资产</h2>
              </div>
              <button
                className="close"
                aria-label="关闭"
                disabled={saving}
                onClick={() => setCreating(false)}
              >
                ×
              </button>
            </div>
            <p className="subtle">
              资产将归属于当前客户，系统自动分配独立编号。
            </p>
            <form onSubmit={save}>
              <label>
                资产名称
                <input
                  name="name"
                  required
                  maxLength={200}
                  autoFocus
                  placeholder="例如：生产数据库服务器"
                />
              </label>
              <label>
                来源标识
                <input
                  name="sourceRef"
                  maxLength={500}
                  placeholder="可选，例如 CMDB-001 或主机名"
                />
              </label>
              <label>
                扩展属性（JSON）
                <textarea
                  name="attributes"
                  defaultValue="{}"
                  rows={4}
                  spellCheck={false}
                />
              </label>
              <p className="hint">
                保留来源特有信息，例如{" "}
                {JSON.stringify({ ip: "10.0.0.12", environment: "production" })}
              </p>
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <div className="form-actions">
                <button
                  type="button"
                  className="secondary"
                  onClick={() => setCreating(false)}
                  disabled={saving}
                >
                  取消
                </button>
                <button className="primary" disabled={saving}>
                  {saving ? "正在保存…" : "保存资产"}
                </button>
              </div>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
