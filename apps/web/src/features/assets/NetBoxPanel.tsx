import { requestId } from "../../request-id";
import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
type Status = {
  mode: "legacy" | "netbox";
  configured: boolean;
  tenantId: number | null;
};
type Mapping = {
  assetId: string;
  name: string;
  objectType: string | null;
  externalId: number | null;
  syncedAt: string | null;
  active: boolean | null;
};
export function NetBoxPanel({
  customerId,
  token,
  onUnauthorized,
  onChange,
  onMode,
}: FeatureProps & {
  onChange: () => void;
  onMode: (enabled: boolean) => void;
}) {
  const [createKey, setCreateKey] = useState(requestId);
  const [updateKey, setUpdateKey] = useState(requestId);
  const [nativeType, setNativeType] = useState("device");
  const [status, setStatus] = useState<Status>();
  const [items, setItems] = useState<Mapping[]>([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus(undefined);
    setItems([]);
    setError("");
    api<Status>(
      `/customers/${customerId}/netbox/status`,
      token,
      {},
      controller.signal,
    )
      .then(async (value) => {
        if (controller.signal.aborted) return;
        setStatus(value);
        onMode(value.configured);
        if (value.configured) {
          const page = await api<{ items: Mapping[] }>(
            `/customers/${customerId}/netbox/mappings`,
            token,
            {},
            controller.signal,
          );
          if (!controller.signal.aborted) setItems(page.items);
        }
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) onUnauthorized();
        else setError(e.message);
      });
    return () => controller.abort();
  }, [customerId, token, onUnauthorized, onMode, revision]);
  async function run(
    path: string,
    body: unknown,
    message: string,
    method = "POST",
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/customers/${customerId}/netbox/${path}`, token, {
        method,
        body: JSON.stringify(body),
      });
      setRevision((x) => x + 1);
      onChange();
      setNotice(message);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      idempotencyKey: createKey,
      objectType: nativeType,
      name: values.get("name"),
    };
    for (const field of ["deviceType", "role", "site", "cluster"])
      if (values.get(field)) body[field] = Number(values.get(field));
    if (values.get("serial")) body.serial = values.get("serial");
    if (await run("assets", body, "资产已在NetBox创建并缓存"))
      setCreateKey(requestId());
  }
  async function update(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    if (
      await run(
        `assets/${values.get("assetId")}`,
        {
          idempotencyKey: updateKey,
          name: values.get("name"),
          serial: String(values.get("serial") || "") || undefined,
        },
        "已更新NetBox名称/序列号并刷新缓存",
        "PATCH",
      )
    )
      setUpdateKey(requestId());
  }
  function map(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    void run(
      "mappings",
      {
        assetId: values.get("assetId"),
        objectType: values.get("objectType"),
        externalId: Number(values.get("externalId")),
      },
      "历史资产已关联，YS编号及历史引用保留",
    );
  }
  if (status?.mode === "legacy")
    return <p className="footnote">当前为本地资产模式；NetBox连接尚未配置。</p>;
  return (
    <section className="asset-panel" aria-label="NetBox资产来源">
      <div className="panel-heading">
        <h2>NetBox 资产主数据</h2>
        <button
          className="secondary"
          disabled={busy || !status?.tenantId}
          onClick={() => void run("sync", {}, "已同步客户资产缓存")}
        >
          {busy ? "处理中…" : "同步客户资产"}
        </button>
      </div>
      <p>
        客户 Tenant：{status?.tenantId ?? "未配置"}
        。下方台账展示同步缓存，离线时不代表 NetBox
        当前状态。已删除或移出客户的映射保留为历史记录。
      </p>
      <p>资产当前配置以NetBox为准。本地手工建档入口在此模式停用。</p>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      <details>
        <summary>修改NetBox资产名称 / 序列号</summary>
        <form onSubmit={update}>
          <label>
            YS资产编号
            <input name="assetId" required />
          </label>
          <label>
            新名称
            <input name="name" required maxLength={200} />
          </label>
          <label>
            新序列号（留空保持）
            <input name="serial" maxLength={200} />
          </label>
          <button className="secondary" disabled={busy}>
            写入NetBox修改
          </button>
        </form>
      </details>
      <details>
        <summary>在NetBox新增资产</summary>
        <p>
          使用NetBox原生对象ID。若写入失去确认，请先在NetBox核对对象并同步，不能重复新建。
        </p>
        <form onSubmit={create}>
          <label>
            类型
            <select
              value={nativeType}
              onChange={(e) => setNativeType(e.target.value)}
            >
              <option value="device">Device</option>
              <option value="virtual-machine">Virtual Machine</option>
            </select>
          </label>
          <label>
            名称
            <input name="name" required maxLength={200} />
          </label>
          <label>
            序列号
            <input name="serial" maxLength={200} />
          </label>
          {nativeType === "device" && (
            <>
              <label>
                设备类型ID
                <input type="number" name="deviceType" min="1" required />
              </label>
              <label>
                角色ID
                <input type="number" name="role" min="1" required />
              </label>
            </>
          )}
          <label>
            站点ID
            <input
              type="number"
              name="site"
              min="1"
              required={nativeType === "device"}
            />
          </label>
          {nativeType === "virtual-machine" && (
            <label>
              集群ID
              <input type="number" name="cluster" min="1" />
            </label>
          )}
          <button className="primary" disabled={busy || !status?.tenantId}>
            写入NetBox
          </button>
        </form>
      </details>
      <details>
        <summary>映射历史资产与查看同步状态</summary>
        <p>
          先映射需要保留编号的历史资产，再同步；不会按名称或IP合并。下列最多显示100项，可填写完整历史资产编号。
        </p>
        <form onSubmit={map}>
          <label>
            历史资产编号
            <input name="assetId" required placeholder="YS资产 UUID" />
          </label>
          <label>
            NetBox类型
            <select name="objectType">
              <option value="device">Device</option>
              <option value="virtual-machine">Virtual Machine</option>
            </select>
          </label>
          <label>
            NetBox对象ID
            <input name="externalId" type="number" min="1" required />
          </label>
          <button className="secondary" disabled={busy || !status?.tenantId}>
            确认关联
          </button>
        </form>
        <table>
          <thead>
            <tr>
              <th>资产 / YS编号</th>
              <th>NetBox身份</th>
              <th>缓存状态 / 同步时间</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.assetId}>
                <td>
                  {item.name}
                  <code>{item.assetId}</code>
                </td>
                <td>
                  {item.objectType
                    ? `${item.objectType}:${item.externalId}`
                    : "待映射"}
                </td>
                <td>
                  {item.active
                    ? "最近同步可见"
                    : item.externalId
                      ? "历史映射，最近同步不可见"
                      : "未关联"}
                  <small>
                    {item.syncedAt
                      ? new Date(item.syncedAt).toLocaleString()
                      : "—"}
                  </small>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  );
}
