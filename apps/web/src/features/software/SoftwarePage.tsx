import "./software.css";
import { useEffect, useRef, useState } from "react";
import type { FeatureProps } from "../../features";
import { api, ApiError } from "../../api";
import type {
  Software,
  SoftwareDetail,
  SoftwareVersion,
  SbomMaterial,
} from "../../../../../packages/contracts/software";
export function SoftwarePage({
  customerId,
  token,
  onUnauthorized,
}: FeatureProps) {
  const [items, setItems] = useState<Software[]>([]),
    [name, setName] = useState(""),
    [selected, setSelected] = useState<SoftwareDetail>(),
    [snapshot, setSnapshot] = useState<SoftwareVersion>(),
    [material, setMaterial] = useState<SbomMaterial>(),
    [file, setFile] = useState<File>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const controller = useRef(new AbortController());
  const base = `/customers/${customerId}/software`;
  function fail(e: unknown) {
    if (controller.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  async function call<T>(path: string, options: RequestInit = {}) {
    return api<T>(path, token, options, controller.current.signal);
  }
  async function refresh() {
    try {
      setItems((await call<{ items: Software[] }>(base)).items);
    } catch (e) {
      fail(e);
    }
  }
  useEffect(() => {
    controller.current = new AbortController();
    refresh();
    return () => controller.current.abort();
  }, [customerId, token]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await work();
    } catch (e) {
      fail(e);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function open(id: string) {
    await run(async () => {
      setSnapshot(undefined);
      setMaterial(undefined);
      setSelected(await call<SoftwareDetail>(`${base}/${id}`));
    });
  }
  async function openSnapshot(v: SoftwareVersion) {
    await run(async () => {
      setSnapshot(v);
      setMaterial(undefined);
      setMaterial(
        await call<SbomMaterial>(
          `/customers/${customerId}/imports/${v.importId}`,
        ),
      );
    });
  }
  return (
    <section className="software-page">
      <header className="page-header">
        <div>
          <p className="eyebrow">软件输入资料</p>
          <h1>软件 SBOM</h1>
          <p>CycloneDX JSON 1.4–1.6 · 软件对象 → 输入版本 → 组件。尚未扫描。</p>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            const obj = await call<Software>(base, {
              method: "POST",
              body: JSON.stringify({ name }),
            });
            setSelected({ ...obj, versions: [] });
            setSnapshot(undefined);
            setMaterial(undefined);
            setName("");
            await refresh();
          });
        }}
      >
        <label>
          软件名称
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            maxLength={200}
            disabled={busy}
          />
        </label>
        <button disabled={busy}>建立软件对象</button>
      </form>
      <div className="panel">
        <h2>软件对象</h2>
        {items.length === 0 ? (
          <p>暂无软件对象</p>
        ) : (
          items.map((o) => (
            <button key={o.id} disabled={busy} onClick={() => open(o.id)}>
              {o.name}
            </button>
          ))
        )}
      </div>
      {selected && (
        <div className="panel">
          <h2>{selected.name}</h2>
          <p>软件对象编号：{selected.id}</p>
          <label>
            SBOM 文件
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0])}
            />
          </label>
          <button
            disabled={!file || busy}
            onClick={() =>
              run(async () => {
                if (!file) return;
                if (file.size > 500000)
                  throw new Error("SBOM 文件最多 500000 字节");
                const content = new TextDecoder("utf-8", {
                  fatal: true,
                  ignoreBOM: true,
                }).decode(await file.arrayBuffer());
                const v = await call<SoftwareVersion>(
                  `${base}/${selected.id}/sbom`,
                  {
                    method: "POST",
                    body: JSON.stringify({ fileName: file.name, content }),
                  },
                );
                setSelected(
                  await call<SoftwareDetail>(`${base}/${selected.id}`),
                );
                setSnapshot(v);
                setMaterial(
                  await call<SbomMaterial>(
                    `/customers/${customerId}/imports/${v.importId}`,
                  ),
                );
                setMessage(
                  v.replayed
                    ? "重复资料：回读原输入版本"
                    : "SBOM 已导入为新输入版本",
                );
              })
            }
          >
            上传 SBOM
          </button>
          <p>
            最多 500000 字节、1000
            个组件；缺失版本保持未知，无法保证完整漏洞匹配。新资料保留历史，相同内容回读原版本。
          </p>
          <h3>输入版本历史</h3>
          {selected.versions.map((v) => (
            <button key={v.id} disabled={busy} onClick={() => openSnapshot(v)}>
              版本 {v.version ?? "未知"} · {v.createdAt} · {v.id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}
      {snapshot && (
        <div className="panel">
          <h2>组件清单 · 版本 {snapshot.version ?? "未知"}</h2>
          <p>
            输入版本编号：{snapshot.id} · 来源资料：{snapshot.importId}
          </p>
          <p>
            采集时间：{snapshot.collectedAt ?? "未知"} · 导入时间：
            {material?.importedAt ?? snapshot.createdAt}
          </p>
          {snapshot.issues.map((i) => (
            <p key={i}>{i}</p>
          ))}
          <p>{snapshot.components.length} 个组件 · 未扫描</p>
          <table>
            <thead>
              <tr>
                <th>组件</th>
                <th>版本</th>
                <th>包生态</th>
                <th>PURL / CPE</th>
                <th>来源关系与缺口</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.components.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>{c.version ?? "未知"}</td>
                  <td>{c.ecosystem ?? "未知"}</td>
                  <td>
                    {c.purl ?? "未知"}
                    <br />
                    {c.cpe}
                  </td>
                  <td>
                    <p>
                      bom-ref：{c.bomRef ?? "未提供"} / 父组件：
                      {c.parentRef ?? "软件根"}
                    </p>
                    {c.issues.map((i) => (
                      <p key={i}>{i}</p>
                    ))}
                    <details>
                      <summary>组件扩展资料</summary>
                      <pre>{JSON.stringify(c.raw, null, 2)}</pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {material && (
            <>
              <p>
                文件：{material.fileName} · SHA-256：{material.contentHash}
              </p>
              <details>
                <summary>原始 SBOM 与扩展资料</summary>
                <pre>{material.content}</pre>
              </details>
            </>
          )}
        </div>
      )}
    </section>
  );
}
