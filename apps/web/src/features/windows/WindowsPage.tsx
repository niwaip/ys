import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type { WindowsMaterial } from "../../../../../packages/contracts/windows";
const show = (v: unknown) =>
  v === null || v === undefined
    ? "未知"
    : typeof v === "object"
      ? JSON.stringify(v)
      : String(v);
export function WindowsPage({
  customerId,
  token,
  onUnauthorized,
}: FeatureProps) {
  const [items, setItems] = useState<WindowsMaterial[]>([]),
    [selected, setSelected] = useState<WindowsMaterial | null>(null),
    [file, setFile] = useState<File | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const base = `/customers/${customerId}/windows/imports`;
  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : "请求失败");
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
  };
  useEffect(() => {
    const abort = new AbortController();
    api<{ items: WindowsMaterial[] }>(base, token, {}, abort.signal)
      .then((x) => setItems(x.items))
      .catch((e) => {
        if (e.name !== "AbortError") fail(e);
      });
    return () => abort.abort();
  }, [customerId, token]);
  async function submit() {
    if (!file) return;
    setBusy(true);
    setError("");
    try {
      const bytes = await file.arrayBuffer();
      const content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      const result = await api<WindowsMaterial>(base, token, {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, content }),
      });
      setSelected(result);
      setItems((await api<{ items: WindowsMaterial[] }>(base, token)).items);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="windows-import">
      <h2>Windows 主机采集资料</h2>
      <p>
        支持 Windows BAT 资料字段适配器 windows-bat/1。上传本地
        JSON，保存独立快照；没有执行扫描。序列号缺失或同名冲突进入待确认。
      </p>
      <label>
        Windows JSON 文件
        <input
          type="file"
          accept=".json"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </label>
      <button disabled={!file || busy} onClick={submit}>
        导入采集资料
      </button>
      {error && <p role="alert">{error}</p>}
      <h3>资料历史</h3>
      {items.map((x) => (
        <button
          key={x.id}
          onClick={() =>
            api<WindowsMaterial>(`${base}/${x.id}`, token)
              .then(setSelected)
              .catch(fail)
          }
        >
          {x.fileName} · {x.importedAt}
        </button>
      ))}
      {selected && (
        <article>
          <h3>{selected.snapshot.hostname}</h3>
          <p>
            {selected.status === "imported"
              ? "已导入独立快照"
              : selected.status === "unsupported_version"
                ? "不支持的采集器版本"
                : "身份待确认"}
          </p>
          {selected.issues.map((x) => (
            <p key={x}>{x}</p>
          ))}
          <p>
            客户 {selected.customerId} · 资产 {show(selected.assetId)} · 快照{" "}
            {show(selected.snapshotId)}
          </p>
          <p>
            采集时间 {show(selected.snapshot.collectedAt)} · 导入时间{" "}
            {selected.importedAt}
          </p>
          <p>
            来源资料 {selected.id} · SHA-256 {selected.contentHash}
          </p>
          <dl>
            {(
              [
                "os",
                "osVersion",
                "osBuild",
                "fullBuild",
                "ubr",
                "architecture",
                "collectorVersion",
                "collectionStatus",
                "kbInventoryComplete",
                "softwareInventoryComplete",
                "rebootPending",
              ] as const
            ).map((key) => (
              <div key={key}>
                <dt>
                  {
                    {
                      os: "操作系统",
                      osVersion: "系统版本",
                      osBuild: "Build",
                      fullBuild: "完整 Build",
                      ubr: "UBR",
                      architecture: "架构",
                      collectorVersion: "采集器版本",
                      collectionStatus: "来源采集状态",
                      kbInventoryComplete: "KB 清单完整性",
                      softwareInventoryComplete: "软件清单完整性",
                      rebootPending: "待重启",
                    }[key]
                  }
                </dt>
                <dd>{show(selected.snapshot[key])}</dd>
              </div>
            ))}
          </dl>
          <h4>已安装软件</h4>
          {selected.snapshot.software === null ? (
            <p>未知</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>软件</th>
                  <th>版本</th>
                  <th>厂商</th>
                </tr>
              </thead>
              <tbody>
                {selected.snapshot.software.map((s, i) => (
                  <tr key={i}>
                    <td>{show(s.name)}</td>
                    <td>{show(s.version)}</td>
                    <td>{show(s.publisher)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h4>KB 清单</h4>
          <p>
            {selected.snapshot.kbs === null
              ? "未知"
              : selected.snapshot.kbs.join(", ") || "空清单；完整性须另行核实"}
          </p>
          {selected.snapshot.assessmentSupport.limitations.map((x) => (
            <p key={x}>{x}</p>
          ))}
          <details>
            <summary>原始 JSON 与扩展字段</summary>
            <pre>
              {selected.content ??
                JSON.stringify(selected.snapshot.extensions, null, 2)}
            </pre>
          </details>
        </article>
      )}
    </section>
  );
}
