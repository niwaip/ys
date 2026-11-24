import { useEffect, useRef, useState } from "react";
import type { ImportMaterial } from "../../../../../packages/contracts";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
const labels = {
  ready: "可导入",
  invalid: "无效",
  duplicate: "重复 / 歧义",
  imported: "已导入",
};
export function ImportsPage({
  customerId,
  token,
  onUnauthorized,
  onImported,
}: FeatureProps & { onImported?: () => void }) {
  const [file, setFile] = useState<File>();
  const [material, setMaterial] = useState<ImportMaterial>();
  const [history, setHistory] = useState<ImportMaterial[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const controller = useRef(new AbortController());
  const selection = useRef(0);
  const base = `/customers/${customerId}/imports`;
  function fail(e: unknown) {
    if (controller.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  function refresh() {
    api<{ items: ImportMaterial[] }>(base, token, {}, controller.current.signal)
      .then((r) => setHistory(r.items.filter((item) => item.format === "csv")))
      .catch(fail);
  }
  useEffect(() => {
    controller.current = new AbortController();
    refresh();
    return () => controller.current.abort();
  }, [customerId, token]);
  async function preview() {
    if (!file) return;
    setBusy(true);
    setError("");
    const revision = selection.current;
    try {
      if (file.size > 500000) throw new Error("CSV 文件最多 500000 字节");
      const bytes = await file.arrayBuffer();
      const content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      const result = await api<ImportMaterial>(
        `${base}/csv/preview`,
        token,
        {
          method: "POST",
          body: JSON.stringify({ fileName: file.name, content }),
        },
        controller.current.signal,
      );
      if (revision === selection.current) setMaterial(result);
      refresh();
    } catch (e) {
      fail(e);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function commit() {
    if (!material) return;
    setBusy(true);
    setError("");
    try {
      setMaterial(
        await api<ImportMaterial>(
          `${base}/${material.id}/commit`,
          token,
          { method: "POST" },
          controller.current.signal,
        ),
      );
      refresh();
      onImported?.();
    } catch (e) {
      fail(e);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function open(id: string) {
    setError("");
    setBusy(true);
    try {
      setMaterial(
        await api<ImportMaterial>(
          `${base}/${id}`,
          token,
          {},
          controller.current.signal,
        ),
      );
    } catch (e) {
      fail(e);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">CSV IMPORT</div>
          <h1>CSV 资料导入</h1>
          <p>检查来源与对象标识，整批确认后建立主机资产。</p>
        </div>
      </div>
      <section className="asset-panel import-upload">
        <h2>上传资产清单</h2>
        <p>
          UTF-8
          CSV，逗号分隔。必填列：source、sourceRef、name、kind（host）。可选
          collectedAt 使用带时区 ISO 时间；其余列保留为扩展属性。最多 1000
          条记录、500000 字节。
        </p>
        <p className="hint">
          整批原子提交：任一缺失、无效或重复记录会阻止整批导入。相同内容在同客户下返回原记录；已有来源对象不会被覆盖。未知采集时间保留未知。
        </p>
        <p className="hint">
          缺失来源或对象标识无法可靠关联资产，必须补齐。采集时间未知时无法判断资料新鲜度；导入成功也不代表已完成风险评估。
        </p>
        <label>
          CSV 文件
          <input
            type="file"
            accept=".csv,text/csv"
            disabled={busy}
            onChange={(e) => {
              selection.current++;
              setFile(e.target.files?.[0]);
              setMaterial(undefined);
              setError("");
            }}
          />
        </label>
        <button className="primary" disabled={!file || busy} onClick={preview}>
          {busy ? "处理中…" : "预览映射"}
        </button>
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {material && (
        <section className="asset-panel import-preview">
          <div className="panel-heading">
            <h2>预览与处理结果</h2>
            <button
              className="primary"
              disabled={!material.canCommit || busy}
              onClick={commit}
            >
              整批提交
            </button>
          </div>
          <p role="status">
            {material.status === "committed"
              ? "整批提交完成"
              : material.canCommit
                ? "全部记录可导入"
                : "整批提交被阻止，请修正问题记录后重新上传"}
          </p>
          <dl>
            <dt>资料编号</dt>
            <dd>
              <code>{material.id}</code>
            </dd>
            <dt>原文件</dt>
            <dd>{material.fileName}</dd>
            <dt>内容 SHA-256</dt>
            <dd>
              <code>{material.contentHash}</code>
            </dd>
            <dt>资料接入时间</dt>
            <dd>{new Date(material.importedAt).toLocaleString("zh-CN")}</dd>
            {material.committedAt && (
              <>
                <dt>资产提交时间</dt>
                <dd>
                  {new Date(material.committedAt).toLocaleString("zh-CN")}
                </dd>
              </>
            )}
          </dl>
          <details open>
            <summary>字段映射</summary>
            <pre>
              {Object.entries(material.mapping)
                .map(([k, v]) => `${k} → ${v}`)
                .join("\n")}
            </pre>
          </details>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>记录</th>
                  <th>对象 / 来源</th>
                  <th>采集时间</th>
                  <th>扩展资料</th>
                  <th>处理结果 / 问题</th>
                </tr>
              </thead>
              <tbody>
                {material.rows.map((row) => (
                  <tr key={row.row}>
                    <td>{row.row}</td>
                    <td>
                      <strong>{row.mapped?.name}</strong>
                      <small className="block">
                        {row.mapped?.source} / {row.mapped?.sourceRef}
                      </small>
                      {row.assetId && <code>{row.assetId}</code>}
                    </td>
                    <td>{row.mapped?.collectedAt ?? "未知"}</td>
                    <td>
                      <pre>
                        {JSON.stringify(row.mapped?.attributes, null, 2)}
                      </pre>
                    </td>
                    <td>
                      <strong>{labels[row.status]}</strong>
                      {row.issues.map((issue, i) => (
                        <p key={i}>{issue}</p>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>原始 CSV</summary>
            <pre>{material.content}</pre>
          </details>
        </section>
      )}
      <section className="asset-panel import-history">
        <div className="panel-heading">
          <h2>导入历史</h2>
          <span className="subtle">最近 100 份资料</span>
        </div>
        {!history.length ? (
          <p>暂无导入资料</p>
        ) : (
          <ul>
            {history.map((item) => (
              <li key={item.id}>
                <button
                  className="text-button"
                  disabled={busy}
                  onClick={() => open(item.id)}
                >
                  {item.fileName}
                </button>{" "}
                · {item.status === "committed" ? "已提交" : "预览"} ·{" "}
                {new Date(item.importedAt).toLocaleString("zh-CN")}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
