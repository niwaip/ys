import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../api";
import { requestId } from "../../request-id";
import type { FeatureProps } from "../../features";
type Catalog = Record<
  "roles" | "deviceTypes" | "sites" | "clusters",
  { id: number; name: string }[]
>;
export function NewCollectionAsset({
  customerId,
  token,
  onUnauthorized,
  onClose,
  onCreated,
}: FeatureProps & { onClose: () => void; onCreated: (id: string) => void }) {
  const [mode, setMode] = useState<boolean>();
  const [catalog, setCatalog] = useState<Catalog>();
  const [type, setType] = useState("device");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [key] = useState(requestId);
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  useEffect(() => {
    const c = new AbortController();
    setCatalog(undefined);
    api<{ configured: boolean }>(
      `/customers/${customerId}/netbox/status`,
      token,
      {},
      c.signal,
    )
      .then(async (s) => {
        if (c.signal.aborted) return;
        setMode(s.configured);
        if (s.configured) {
          const data = await api<Catalog>(
            `/customers/${customerId}/netbox/catalog?objectType=${type}`,
            token,
            {},
            c.signal,
          );
          if (!c.signal.aborted) setCatalog(data);
        }
      })
      .catch((e) => {
        if (!c.signal.aborted) fail(e);
      });
    return () => c.abort();
  }, [customerId, token, type]);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const data = new FormData(e.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (mode) {
        const body: Record<string, unknown> = {
          idempotencyKey: key,
          objectType: type,
          name: data.get("name"),
        };
        if (type === "device" && data.get("serial"))
          body.serial = data.get("serial");
        for (const field of ["site", "role", "deviceType", "cluster"])
          if (data.get(field)) body[field] = Number(data.get(field));
        const result = await api<{ assetId: string }>(
          `/customers/${customerId}/netbox/assets`,
          token,
          { method: "POST", body: JSON.stringify(body) },
        );
        onCreated(result.assetId);
      } else {
        const result = await api<{ id: string }>(
          `/customers/${customerId}/assets`,
          token,
          {
            method: "POST",
            body: JSON.stringify({
              name: data.get("name"),
              kind: "host",
              attributes: { serial: String(data.get("serial") || "") || null },
            }),
          },
        );
        onCreated(result.id);
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  const fields =
    type === "device"
      ? [
          ["deviceType", "设备型号", "deviceTypes"],
          ["role", "设备角色", "roles"],
          ["site", "站点", "sites"],
        ]
      : [
          ["site", "站点", "sites"],
          ["cluster", "集群", "clusters"],
        ];
  return (
    <div className="collect-overlay">
      <section
        className="collect-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="新增采集资产"
      >
        <header>
          <h2>新增资产</h2>
          <button type="button" disabled={busy} onClick={onClose}>
            关闭
          </button>
        </header>
        <p>
          {mode
            ? "在NetBox建档，成功同步后继续采集。"
            : "本地资产建档后继续采集。"}
        </p>
        {error && <p role="alert">{error}</p>}
        {mode && !catalog && (
          <p>
            无法加载目录时，请检查NetBox令牌的设备角色、型号、站点及集群读取权限；也可在NetBox维护后从资产台账同步。
          </p>
        )}
        <form onSubmit={submit}>
          <label>
            资产名称
            <input name="name" required maxLength={200} />
          </label>
          {mode && (
            <label>
              对象类型
              <select value={type} onChange={(e) => setType(e.target.value)}>
                <option value="device">物理设备（服务器、网络、存储等）</option>
                <option value="virtual-machine">虚拟机</option>
              </select>
            </label>
          )}
          {type === "device" && (
            <label>
              序列号
              <input name="serial" maxLength={200} />
            </label>
          )}
          {mode &&
            fields.map(([field, label, source]) => (
              <label key={field}>
                {label}
                <select
                  aria-label={label}
                  name={field}
                  required={type === "device"}
                  defaultValue=""
                >
                  <option value="">
                    {type === "device" ? "请选择" : "站点或集群至少选择一项"}
                  </option>
                  {catalog?.[source as keyof Catalog]?.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          <button
            className="primary"
            disabled={busy || mode === undefined || (mode && !catalog)}
          >
            {busy ? "正在建档…" : "保存并选择资产"}
          </button>
        </form>
      </section>
    </div>
  );
}
