import { LifecycleWorkspacePage } from "./LifecycleWorkspacePage";
import { useEffect, useRef, useState } from "react";
import type {
  Software,
  SoftwareDetail,
} from "../../../../../packages/contracts/software";
import type { AssetPage, Asset } from "../../../../../packages/contracts";
import type {
  LifecycleAssessment,
  LifecycleBatch,
} from "../../../../../packages/contracts/lifecycle";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
const matchLabels = {
  exact: "精确匹配",
  weak: "弱匹配 / 待核实",
  unmatched: "未匹配 / 未知",
};
const stageLabels = {
  reached: "阶段日期已到",
  future: "阶段日期未到",
  unknown: "未知",
};
function LifecycleReferencePage({
  customerId,
  token,
  onUnauthorized,
  mode = "both",
  assetId,
  embedded = false,
}: FeatureProps & {
  mode?: "both" | "materials" | "assessment";
  embedded?: boolean;
}) {
  const [batches, setBatches] = useState<LifecycleBatch[]>([]),
    [assessments, setAssessments] = useState<LifecycleAssessment[]>([]),
    [selected, setSelected] = useState<LifecycleBatch>(),
    [result, setResult] = useState<LifecycleAssessment>(),
    [assets, setAssets] = useState<AssetPage["items"]>([]),
    [ids, setIds] = useState<string[]>(assetId ? [assetId] : []),
    [file, setFile] = useState<File>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [software, setSoftware] = useState<SoftwareDetail[]>([]),
    [softwareIds, setSoftwareIds] = useState<string[]>([]);
  const controller = useRef(new AbortController());
  const base = `/customers/${customerId}/lifecycle`;
  function fail(e: unknown) {
    if (controller.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  const call = <T,>(path: string, options: RequestInit = {}) =>
    api<T>(path, token, options, controller.current.signal);
  async function refresh() {
    const [b, a] = await Promise.all([
      call<{ items: LifecycleBatch[] }>(`${base}/batches`),
      call<{ items: LifecycleAssessment[] }>(`${base}/assessments`),
    ]);
    setBatches(b.items);
    setAssessments(a.items);
  }
  useEffect(() => {
    controller.current = new AbortController();
    refresh().catch(fail);
    call<{ items: Software[] }>(`/customers/${customerId}/software`)
      .then(async (x) =>
        setSoftware(
          await Promise.all(
            x.items.map((o) =>
              call<SoftwareDetail>(`/customers/${customerId}/software/${o.id}`),
            ),
          ),
        ),
      )
      .catch(fail);
    call<AssetPage | Asset>(
      assetId
        ? `/customers/${customerId}/assets/${assetId}`
        : `/customers/${customerId}/assets?limit=100`,
    )
      .then((x) => setAssets("items" in x ? x.items : [x]))
      .catch(fail);
    return () => controller.current.abort();
  }, [customerId, token]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      fail(e);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function upload() {
    if (!file) return;
    await run(async () => {
      if (file.size > 500000) throw new Error("CSV最多500000字节");
      const content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(await file.arrayBuffer());
      setSelected(
        await call<LifecycleBatch>(`${base}/batches`, {
          method: "POST",
          body: JSON.stringify({ fileName: file.name, content }),
        }),
      );
      await refresh();
    });
  }
  return (
    <>
      {!embedded && (
        <div className="page-heading">
          <div>
            <div className="eyebrow">LIFECYCLE</div>
            <h1>{mode === "materials" ? "生命周期资料" : "EOSL评估"}</h1>
            <p>独立导入有来源的阶段资料，按指定批次保存评估依据。</p>
            {assetId && (
              <p>本次仅评估台账选中的资产：{assets[0]?.name ?? assetId}</p>
            )}
          </div>
        </div>
      )}
      {mode !== "assessment" && (
        <section className="asset-panel import-upload">
          <h2>上传生命周期 CSV</h2>
          <p>
            UTF-8，最多1000条、500000字节。必需表头
            source、sourceRef、product、version、eosStage、eosDate、eolStage、eolDate。版本及日期可空；日期为
            YYYY-MM-DD。阶段名称按来源原意填写，不自动合并厂商缩写。
          </p>
          <p className="hint">
            坏日期单独保留为无效 /
            未知。相同内容复用批次，更新资料产生新批次。系统不自动获取厂商资料，导入不表示完整覆盖。
          </p>
          <label>
            生命周期 CSV 文件
            <input
              type="file"
              accept=".csv,text/csv"
              disabled={busy}
              onChange={(e) => setFile(e.target.files?.[0])}
            />
          </label>
          <button className="primary" disabled={!file || busy} onClick={upload}>
            导入生命周期批次
          </button>
        </section>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section className="asset-panel">
        <h2>来源批次</h2>
        {batches.length === 0 && <p>暂无生命周期资料</p>}
        {batches.map((b) => (
          <p key={b.id}>
            <button
              disabled={busy}
              onClick={() =>
                run(async () =>
                  setSelected(
                    await call<LifecycleBatch>(`${base}/batches/${b.id}`),
                  ),
                )
              }
            >
              {b.fileName}
            </button>{" "}
            · {b.importedAt} · <code>{b.id}</code>
          </p>
        ))}
      </section>
      {selected && (
        <section className="asset-panel">
          <h2>批次证据：{selected.fileName}</h2>
          <p>
            批次 <code>{selected.id}</code>
          </p>
          <p>
            SHA-256 <code>{selected.contentHash}</code>
          </p>
          <p>接入时间 {selected.importedAt}</p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>产品 / 版本</th>
                  <th>来源</th>
                  <th>EOS</th>
                  <th>EOL</th>
                  <th>问题</th>
                </tr>
              </thead>
              <tbody>
                {selected.rows.map((r) => (
                  <tr key={r.row}>
                    <td>
                      {r.product} / {r.version ?? "未知版本"}
                    </td>
                    <td>
                      {r.source}
                      <br />
                      {r.sourceRef}
                    </td>
                    <td>
                      {r.eos.name}: {r.eos.date ?? "未知"}{" "}
                      {r.eos.dateStatus === "invalid" &&
                        `（无效原值 ${r.eos.rawDate}）`}
                    </td>
                    <td>
                      {r.eol.name}: {r.eol.date ?? "未知"}{" "}
                      {r.eol.dateStatus === "invalid" &&
                        `（无效原值 ${r.eol.rawDate}）`}
                    </td>
                    <td>{r.issues.join("；")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details>
            <summary>原始生命周期 CSV</summary>
            <pre>{selected.content}</pre>
          </details>
          {mode !== "materials" && (
            <>
              <h3>选择客户资产</h3>
              <p>
                以资产扩展属性 product / version
                匹配，未知版本需核实。这里只列出最近100个资产。
              </p>
              {assets.map((a) => (
                <label className="block" key={a.id}>
                  <input
                    type="checkbox"
                    checked={ids.includes(a.id)}
                    onChange={(e) =>
                      setIds(
                        e.target.checked
                          ? [...ids, a.id]
                          : ids.filter((id) => id !== a.id),
                      )
                    }
                  />
                  {a.name} · {String(a.attributes.product ?? "未知产品")} /{" "}
                  {String(a.attributes.version ?? "未知版本")}
                </label>
              ))}
              {!assetId && (
                <>
                  <h3>选择软件输入版本</h3>
                  <p>
                    按软件对象名称和明确选择的 SBOM
                    版本匹配，不自动采用最新版本。
                  </p>
                  {software.flatMap((o) =>
                    o.versions.map((v) => (
                      <label className="block" key={v.id}>
                        <input
                          type="checkbox"
                          checked={softwareIds.includes(v.id)}
                          onChange={(e) =>
                            setSoftwareIds(
                              e.target.checked
                                ? [...softwareIds, v.id]
                                : softwareIds.filter((id) => id !== v.id),
                            )
                          }
                        />
                        {o.name} / {v.version ?? "未知版本"} · 输入版本 {v.id}
                      </label>
                    )),
                  )}
                </>
              )}
              <button
                className="primary"
                disabled={busy || (!ids.length && !softwareIds.length)}
                onClick={() =>
                  run(async () => {
                    setResult(
                      await call<LifecycleAssessment>(`${base}/assessments`, {
                        method: "POST",
                        body: JSON.stringify({
                          batchId: selected.id,
                          assetIds: ids,
                          softwareTargets: software.flatMap((o) =>
                            o.versions
                              .filter((v) => softwareIds.includes(v.id))
                              .map((v) => ({
                                softwareId: o.id,
                                versionId: v.id,
                              })),
                          ),
                        }),
                      }),
                    );
                    await refresh();
                  })
                }
              >
                保存生命周期评估
              </button>
            </>
          )}
        </section>
      )}
      {mode !== "materials" && (
        <section className="asset-panel">
          <h2>评估历史</h2>
          {assessments.length === 0 && <p>尚未评估，不能解释为无风险</p>}
          {assessments.map((a) => (
            <p key={a.id}>
              <button
                disabled={busy}
                onClick={() =>
                  run(async () =>
                    setResult(
                      await call<LifecycleAssessment>(
                        `${base}/assessments/${a.id}`,
                      ),
                    ),
                  )
                }
              >
                {a.evaluatedAt} · {a.id}
              </button>
            </p>
          ))}
        </section>
      )}
      {result && mode !== "materials" && (
        <section className="asset-panel">
          <h2>生命周期评估结果</h2>
          <p>
            评估 {result.id} · 批次 {result.batchId} · 规则 {result.ruleVersion}
          </p>
          <p>
            评估时间 {result.evaluatedAt}
            ；阶段日期未知时保持未知，不使用评估时间替代。
          </p>
          {result.items.map((item) => (
            <article key={`${item.assetId}:${item.versionId ?? ""}`}>
              <h3>
                {item.name} · {matchLabels[item.match]}
              </h3>
              {item.versionId && (
                <p>
                  输入版本 {item.versionId} · 来源资料 {item.importId}
                </p>
              )}
              <p>
                {item.basis} · 输入 {item.inputSource} ·{" "}
                {item.product ?? "未知产品"} / {item.version ?? "未知版本"}
              </p>
              {item.evidence.map((r) => (
                <div key={r.row}>
                  <p>
                    {r.source} / {r.sourceRef} · 来源行 {r.row}
                  </p>
                  <p>
                    EOS · {r.eos.name} · {r.eos.date ?? "未知日期"} ·{" "}
                    {stageLabels[r.eos.status]}
                  </p>
                  <p>
                    EOL · {r.eol.name} · {r.eol.date ?? "未知日期"} ·{" "}
                    {stageLabels[r.eol.status]}
                  </p>
                  {r.issues.map((x) => (
                    <p key={x}>{x}</p>
                  ))}
                </div>
              ))}
            </article>
          ))}
        </section>
      )}
    </>
  );
}

export function LifecyclePage(
  props: FeatureProps & { mode?: "both" | "materials" | "assessment" },
) {
  return props.mode === "materials" ? (
    <LifecycleWorkspacePage
      {...props}
      referenceLibrary={
        <LifecycleReferencePage {...props} mode="materials" embedded />
      }
    />
  ) : (
    <LifecycleReferencePage {...props} />
  );
}
