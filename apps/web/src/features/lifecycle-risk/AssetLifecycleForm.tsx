import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type { Asset } from "../../../../../packages/contracts";
import type { LifecycleBatch } from "../../../../../packages/contracts/lifecycle";
import {
  lifecycleAssetSchema,
  readLifecycleAsset,
  type LifecycleAsset,
} from "../../../../../packages/contracts/lifecycle-risk";
export function AssetLifecycleForm(
  props: FeatureProps & {
    assetId: string;
    onClose: () => void;
    readOnly: boolean;
    onSaved?: () => void;
  },
) {
  const [asset, setAsset] = useState<Asset>(),
    [batches, setBatches] = useState<LifecycleBatch[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const [history, setHistory] = useState<
    {
      id: string;
      actor: string;
      createdAt: string;
      source: string;
      status: string;
      before: unknown;
      after: unknown;
    }[]
  >([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const base = `/customers/${props.customerId}`;
  useEffect(() => {
    if (!historyOpen) return;
    const c = new AbortController();
    api<{ items: typeof history }>(
      `${base}/lifecycle/assets/${props.assetId}/history`,
      props.token,
      {},
      c.signal,
    )
      .then((v) => {
        if (!c.signal.aborted) setHistory(v.items);
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
          else setError(e.message);
        }
      });
    return () => c.abort();
  }, [base, props.assetId, props.token, historyOpen, notice]);
  useEffect(() => {
    const c = new AbortController();
    Promise.all([
      api<Asset>(
        `${base}/assets/${props.assetId}`,
        props.token,
        {},
        c.signal,
      ).then(setAsset),
      api<{ items: LifecycleBatch[] }>(
        `${base}/lifecycle/batches`,
        props.token,
        {},
        c.signal,
      ).then((r) => setBatches(r.items)),
    ]).catch((e) => {
      if (!c.signal.aborted) {
        if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
        else setError(e.message);
      }
    });
    return () => c.abort();
  }, [base, props.assetId, props.token]);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget),
      data: Record<string, unknown> = {
        sourceRef: String(f.get("sourceRef") ?? ""),
      };
    for (const key of ["purchasedOn", "warrantyUntil"])
      if (f.get(key)) data[key] = f.get(key);
    for (const [key, label] of [
      ["os", "OS"],
      ["device", "设备"],
    ])
      if (f.get(`${key}Batch`))
        data[key] = {
          batchId: f.get(`${key}Batch`),
          product: f.get(`${key}Product`),
          version: f.get(`${key}Version`),
          phase: f.get(`${key}Phase`),
        };
    const parsed = lifecycleAssetSchema.safeParse(data);
    if (!parsed.success) {
      setError("请检查产品名称和日期");
      return;
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const saved = await api<Asset>(
        `${base}/assets/${props.assetId}/lifecycle`,
        props.token,
        {
          method: "PATCH",
          body: JSON.stringify({
            ...parsed.data,
            expected: asset?.attributes.lifecycle ?? {},
          }),
        },
      );
      setAsset(saved);
      setNotice("生命周期资料已保存");
      props.onSaved?.();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
      else setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const { data, issues } = readLifecycleAsset(asset?.attributes.lifecycle);
  return (
    <section
      className="asset-panel asset-lifecycle"
      aria-label="资产生命周期资料"
    >
      <div className="panel-heading">
        <h2>{asset?.name} · 生命周期资料</h2>
        <button onClick={props.onClose}>关闭资料</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {issues.length > 0 && <p className="notice">{issues.join("；")}</p>}
      {notice && <p role="status">{notice}</p>}
      {asset?.source === "netbox" && (
        <p className="notice">
          此设备由NetBox管理。确认后写回ys_lifecycle并同步回读；不会修改资产身份或其他自定义字段。
        </p>
      )}
      <p className="hint">
        购买与维保是设备专属日期。留空保留原资料；厂商支持日期由共同资料来源确定。
      </p>
      {asset && (
        <form onSubmit={save} key={asset.id}>
          <fieldset disabled={busy || props.readOnly}>
            <div className="risk-form-grid">
              <label>
                购买日期
                <input
                  type="date"
                  name="purchasedOn"
                  defaultValue={data.purchasedOn}
                />
              </label>
              <label>
                维保到期日期
                <input
                  type="date"
                  name="warrantyUntil"
                  defaultValue={data.warrantyUntil}
                />
              </label>
              <label>
                日期依据
                <input
                  name="sourceRef"
                  defaultValue={data.sourceRef}
                  placeholder="合同或采购记录编号"
                  maxLength={500}
                />
              </label>
            </div>
            {(
              [
                ["os", "OS"],
                ["device", "设备"],
              ] as const
            ).map(([key, label]) => (
              <fieldset key={key}>
                <legend>{label} 支持资料</legend>
                <p>明确选择来源及阶段；不根据 EOS/EOL 缩写推断厂商含义。</p>
                <div className="risk-form-grid">
                  <label>
                    {label} 来源批次
                    <select
                      name={`${key}Batch`}
                      defaultValue={data[key]?.batchId ?? ""}
                    >
                      <option value="">未关联</option>
                      {data[key] &&
                        !batches.some((b) => b.id === data[key]!.batchId) && (
                          <option value={data[key]!.batchId}>
                            已关联批次 {data[key]!.batchId}
                          </option>
                        )}
                      {batches.map((b) => (
                        <option key={b.id} value={b.id}>
                          {b.fileName} · {b.importedAt}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    {label} 产品
                    <input
                      name={`${key}Product`}
                      defaultValue={data[key]?.product}
                      maxLength={500}
                    />
                  </label>
                  <label>
                    {label} 版本
                    <input
                      name={`${key}Version`}
                      defaultValue={data[key]?.version}
                      maxLength={500}
                    />
                  </label>
                  <label>
                    {label} 阶段
                    <select
                      name={`${key}Phase`}
                      defaultValue={data[key]?.phase ?? "eol"}
                    >
                      <option value="eos">EOS 栏位（请核对来源阶段）</option>
                      <option value="eol">EOL 栏位（请核对来源阶段）</option>
                    </select>
                  </label>
                </div>
              </fieldset>
            ))}
            <button className="primary" disabled={busy}>
              保存资产生命周期资料
            </button>
          </fieldset>
        </form>
      )}
      <details onToggle={(e) => setHistoryOpen(e.currentTarget.open)}>
        <summary>资料变更历史</summary>
        {historyOpen &&
          (history.length ? (
            history.map((item) => (
              <article key={item.id}>
                <strong>
                  {new Date(item.createdAt).toLocaleString("zh-CN")} ·{" "}
                  {item.actor}
                </strong>
                <p>
                  {item.source === "netbox" ? "NetBox写回" : "YS保存"} ·{" "}
                  {item.status === "unknown"
                    ? "写回未确认，请核对远端"
                    : "已确认"}
                </p>
                <details>
                  <summary>查看修改前后</summary>
                  <pre>
                    {JSON.stringify(
                      { before: item.before, after: item.after },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </article>
            ))
          ) : (
            <p>暂无变更记录</p>
          ))}
      </details>
    </section>
  );
}
