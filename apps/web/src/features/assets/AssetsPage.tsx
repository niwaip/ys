import { ImportsPage } from "../imports/ImportsPage";
import "./assets.css";
import { ContainerRuntimeSummary } from "../containers/ContainerRuntimeSummary";
import { AssetLifecycleForm } from "../lifecycle-risk/AssetLifecycleForm";
import "../lifecycle-risk/lifecycle-risk.css";
import { AssetBaseline } from "../collections/AssetBaseline";
import { NetBoxPanel } from "./NetBoxPanel";
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type {
  AssetPage,
  AssetSummary,
} from "../../../../../packages/contracts";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
export function AssetsPage({
  customerId,
  token,
  onUnauthorized,
  onNavigate,
  assetId,
  collectionContext,
}: FeatureProps) {
  const [lifecycleAsset, setLifecycleAsset] = useState<string | undefined>(
    assetId,
  );
  const [bulkImport, setBulkImport] = useState(
    !!collectionContext?.assetImport,
  );
  const [status, setStatus] = useState("active");
  const [deleting, setDeleting] = useState<{ id: string; name: string }>();
  const [detailAsset, setDetailAsset] = useState<{
    id: string;
    name: string;
  }>();
  const [netboxMode, setNetboxMode] = useState<boolean | undefined>();
  const refresh = useCallback(() => setRevision((x) => x + 1), []);
  const [data, setData] = useState<AssetPage>();
  const [summary, setSummary] = useState<AssetSummary>();
  const [summaryError, setSummaryError] = useState("");
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
      `/customers/${customerId}/assets?limit=20&offset=${offset}&status=${status}`,
      token,
      {},
      controller.signal,
    )
      .then((value) => {
        if (!controller.signal.aborted) setData(value);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
        else setError(e.message);
      });
    return () => controller.abort();
  }, [customerId, token, offset, status, revision, onUnauthorized]);
  useEffect(() => {
    const c = new AbortController();
    setSummary(undefined);
    setSummaryError("");
    api<AssetSummary>(
      `/customers/${customerId}/assets/summary`,
      token,
      {},
      c.signal,
    )
      .then((value) => {
        if (!c.signal.aborted) setSummary(value);
      })
      .catch((e) => {
        if (c.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
        else setSummaryError(e.message);
      });
    return () => c.abort();
  }, [customerId, token, revision, onUnauthorized]);
  async function change(path: string, method: string, body?: object) {
    setSaving(true);
    setError("");
    try {
      await api(`/customers/${customerId}/assets/${path}`, token, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      setDeleting(undefined);
      setOffset(0);
      refresh();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
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
    <div className="asset-inventory">
      <div className="page-heading inventory-heading">
        <div>
          <div className="eyebrow">ASSET INVENTORY</div>
          <h1>资产台账</h1>
          <p>掌握资产分布，集中查看主机资料与评估入口。</p>
        </div>
        <div className="inventory-heading-actions">
          <button
            className="secondary"
            onClick={() => setBulkImport((v) => !v)}
          >
            批量导入资产清单
          </button>
          <button className="secondary" aria-label="刷新资产" onClick={refresh}>
            ↻ 刷新
          </button>
          {netboxMode !== true && (
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
          )}
        </div>
      </div>
      <section className="inventory-overview" aria-label="资产概览">
        <div className="inventory-section-title">
          <h2>资产概览</h2>
          <span>当前客户 · 全部在管资产</span>
        </div>
        {summaryError && (
          <p role="alert" className="error">
            {summaryError}
          </p>
        )}
        <div className="inventory-metrics">
          {(
            [
              ["纳管资产", summary?.active, "▦", "全部在管主机"],
              ["服务器", summary?.server, "▤", "服务器类硬件"],
              ["网络设备", summary?.network, "⌘", "交换机、路由器等"],
              ["未分类硬件", summary?.unclassified, "◇", "待完善硬件类型"],
            ] as const
          ).map(([label, value, icon, description]) => (
            <article
              className="inventory-metric"
              key={label}
              aria-label={`${label} ${value ?? "未知"}`}
            >
              <div className="inventory-metric-top">
                <span>{label}</span>
                <span className="inventory-metric-icon" aria-hidden="true">
                  {icon}
                </span>
              </div>
              <strong>
                {value ?? "—"}
                <small>台</small>
              </strong>
              <p>{description}</p>
            </article>
          ))}
        </div>
      </section>
      {bulkImport && (
        <section className="asset-panel" aria-label="批量导入资产清单">
          <button onClick={() => setBulkImport(false)}>关闭批量导入</button>
          <ImportsPage
            customerId={customerId}
            token={token}
            onUnauthorized={onUnauthorized}
            onImported={refresh}
          />
        </section>
      )}
      <details className="inventory-source">
        <summary>
          <span className="inventory-source-mark" aria-hidden="true">
            ⇄
          </span>
          <strong>资产来源与同步</strong>
          <small>
            {netboxMode === true
              ? "NetBox 主数据 · 同步缓存"
              : netboxMode === false
                ? "本地资产模式"
                : "正在检查来源…"}
          </small>
          <span className="inventory-source-toggle">管理与同步</span>
        </summary>
        <div className="inventory-source-body">
          <NetBoxPanel
            key={customerId}
            customerId={customerId}
            token={token}
            onUnauthorized={onUnauthorized}
            onMode={setNetboxMode}
            onChange={refresh}
          />
        </div>
      </details>
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
      {lifecycleAsset && (
        <AssetLifecycleForm
          key={`${customerId}:${lifecycleAsset}`}
          customerId={customerId}
          token={token}
          onUnauthorized={onUnauthorized}
          assetId={lifecycleAsset}
          readOnly={netboxMode !== false}
          onClose={() => setLifecycleAsset(undefined)}
        />
      )}
      <section className="asset-panel inventory-detail" aria-label="资产明细">
        <div className="inventory-detail-heading">
          <div>
            <h2>
              资产明细 <span>{data?.total ?? "—"}</span>
            </h2>
            <p>查看资产信息、配置分类并进入评估</p>
          </div>{" "}
          <div className="inventory-tabs">
            <button
              className={status === "active" ? "is-active" : ""}
              aria-pressed={status === "active"}
              onClick={() => {
                setStatus("active");
                setOffset(0);
              }}
            >
              在管资产
            </button>
            <button
              className={status === "deleted" ? "is-active" : ""}
              aria-pressed={status === "deleted"}
              onClick={() => {
                setStatus("deleted");
                setOffset(0);
              }}
            >
              已删除资产
            </button>
          </div>
        </div>
        {!data ? (
          <div className="empty">
            {error ? "暂时无法读取资产" : "正在读取资产…"}
          </div>
        ) : !data.total && status === "deleted" ? (
          <div className="empty">暂无已删除资产</div>
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
              <table className="inventory-table">
                <thead>
                  <tr>
                    <th>资产名称 / 内部编号</th>
                    <th>类型</th>
                    <th>来源标识</th>
                    <th>扩展属性</th>
                    <th>建档时间</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {data.items.map((asset) => (
                    <tr key={asset.id}>
                      <td data-label="资产名称 / 内部编号">
                        <button
                          className="text-button inventory-name"
                          onClick={() =>
                            setDetailAsset({ id: asset.id, name: asset.name })
                          }
                        >
                          {asset.name}
                        </button>
                        <code title={asset.id}>{asset.id}</code>
                      </td>
                      <td data-label="类型">
                        <select
                          aria-label="硬件类型"
                          value={asset.hardwareType ?? "unknown"}
                          disabled={saving || status === "deleted"}
                          onChange={(e) =>
                            void change(`${asset.id}/classification`, "PATCH", {
                              hardwareType: e.target.value,
                            })
                          }
                        >
                          <option value="unknown">未分类硬件</option>
                          <option value="server">服务器</option>
                          <option value="network">网络设备</option>
                        </select>
                      </td>
                      <td data-label="来源标识">
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
                      <td data-label="扩展属性">
                        <details>
                          <summary>
                            {Object.keys(asset.attributes).length} 项属性
                          </summary>
                          <pre>{JSON.stringify(asset.attributes, null, 2)}</pre>
                        </details>
                      </td>
                      <td className="date" data-label="建档时间">
                        {new Date(asset.createdAt).toLocaleString("zh-CN")}
                      </td>
                      <td data-label="操作">
                        {status === "active" ? (
                          <div className="inventory-row-actions">
                            <button
                              className="secondary"
                              onClick={() =>
                                onNavigate?.("assessment-workspace", asset.id)
                              }
                            >
                              CVE评估
                            </button>
                            <button
                              className="secondary"
                              onClick={() =>
                                onNavigate?.("lifecycle", asset.id)
                              }
                            >
                              EOSL评估
                            </button>
                            <button
                              className="secondary"
                              onClick={() =>
                                onNavigate?.("containers", asset.id)
                              }
                            >
                              容器镜像
                            </button>
                            <button
                              className="secondary"
                              onClick={() => setLifecycleAsset(asset.id)}
                            >
                              生命周期资料
                            </button>
                            <button
                              className="secondary"
                              disabled={saving}
                              onClick={() =>
                                setDeleting({ id: asset.id, name: asset.name })
                              }
                            >
                              删除
                            </button>
                          </div>
                        ) : (
                          <>
                            <small>
                              删除于{" "}
                              {asset.deletedAt
                                ? new Date(asset.deletedAt).toLocaleString(
                                    "zh-CN",
                                  )
                                : "未知"}{" "}
                              · {asset.deletedBy}
                            </small>
                            <button
                              disabled={saving}
                              onClick={() =>
                                void change(`${asset.id}/restore`, "POST", {})
                              }
                            >
                              恢复
                            </button>
                          </>
                        )}
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
              <ContainerRuntimeSummary
                customerId={customerId}
                token={token}
                onUnauthorized={onUnauthorized}
                assetId={detailAsset.id}
                onNavigate={onNavigate}
              />
              <AssetBaseline
                customerId={customerId}
                token={token}
                onUnauthorized={onUnauthorized}
                assetId={detailAsset.id}
                readOnly
              />
            </section>
          </div>
        </div>
      )}
      {deleting && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label="删除资产"
          >
            <h2>删除资产：{deleting.name}</h2>
            <p>
              从YS移除纳管，保留历史采集、评估和报告，可在已删除资产中恢复。不会删除NetBox原对象，同步不会自动恢复。
            </p>
            <div className="form-actions">
              <button disabled={saving} onClick={() => setDeleting(undefined)}>
                取消
              </button>
              <button
                className="primary"
                disabled={saving}
                onClick={() => void change(deleting.id, "DELETE")}
              >
                确认删除
              </button>
            </div>
            {error && <p role="alert">{error}</p>}
          </section>
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
    </div>
  );
}
