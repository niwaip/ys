import { levelLabels } from "../../../../../packages/contracts/lifecycle-risk";
import { useEffect, useState, type ReactNode } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type {
  LifecycleWorkspace,
  LifecycleWorkspaceItem,
} from "../../../../../packages/contracts/lifecycle-workspace";
import { deviceCategories } from "../../../../../packages/contracts/device-collection";
import { AssetLifecycleForm } from "../lifecycle-risk/AssetLifecycleForm";
import "./lifecycle-workspace.css";
const states = { empty: "未填写", partial: "待补充", complete: "已完整" };
const matches = {
  matched: "已引用",
  unmatched: "未匹配",
  missing: "缺产品/版本",
  conflict: "待确认来源",
};
export function LifecycleWorkspacePage(
  props: FeatureProps & { referenceLibrary: ReactNode },
) {
  const [view, setView] = useState<"assets" | "shared">("assets"),
    [data, setData] = useState<LifecycleWorkspace>(),
    [category, setCategory] = useState(""),
    [state, setState] = useState(""),
    [missing, setMissing] = useState(""),
    [q, setQ] = useState(""),
    [offset, setOffset] = useState(0),
    [editing, setEditing] = useState<LifecycleWorkspaceItem>(),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setData(undefined);
    setError("");
    const params = new URLSearchParams({
      q,
      offset: String(offset),
      limit: "25",
    });
    if (category) params.set("category", category);
    if (state) params.set("state", state);
    if (missing) params.set("missing", missing);
    api<LifecycleWorkspace>(
      `/customers/${props.customerId}/lifecycle/workspace?${params}`,
      props.token,
      {},
      c.signal,
    )
      .then((value) => {
        if (!c.signal.aborted) setData(value);
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
          else setError(e.message);
        }
      });
    return () => c.abort();
  }, [
    props.customerId,
    props.token,
    category,
    state,
    missing,
    q,
    offset,
    revision,
  ]);
  function filter(setter: (v: string) => void, value: string) {
    setter(value);
    setOffset(0);
    setEditing(undefined);
  }
  return (
    <div className="lifecycle-workspace">
      <header className="page-heading">
        <div>
          <div className="eyebrow">LIFECYCLE</div>
          <h1>生命周期资料</h1>
          <p>厂商共同期限导入一次；设备购买与维保日期按资产维护。</p>
        </div>
        <button
          type="button"
          className="secondary"
          onClick={() => setRevision((v) => v + 1)}
        >
          刷新资料
        </button>
      </header>
      <section className="lifecycle-metrics" aria-label="生命周期覆盖概要">
        {(
          [
            ["total", "在管资产"],
            ["complete", "资料完整"],
            ["partial", "待补充"],
            ["empty", "未填写"],
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            key={key}
            onClick={() => {
              setView("assets");
              filter(setState, key === "total" ? "" : key);
            }}
          >
            <span>{label}</span>
            <strong>{data?.summary[key] ?? "—"}</strong>
          </button>
        ))}
      </section>
      <section className="lifecycle-metrics" aria-label="当前期限风险概要">
        <p>
          当前期限风险 <strong>{data?.summary.riskAssets ?? "—"}</strong>{" "}
          台需关注
        </p>
        <p>
          已到期 <strong>{data?.summary.expiredAssets ?? "—"}</strong>{" "}
          台；未知资料另计
        </p>
      </section>
      <div
        className="lifecycle-view-tabs"
        role="tablist"
        aria-label="生命周期资料类型"
      >
        <button
          role="tab"
          aria-selected={view === "assets"}
          onClick={() => setView("assets")}
        >
          设备专属期限
        </button>
        <button
          role="tab"
          aria-selected={view === "shared"}
          onClick={() => setView("shared")}
        >
          厂商共同资料 · CSV
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {view === "shared" ? (
        <section className="lifecycle-shared">
          <div className="lifecycle-section-heading">
            <div>
              <h2>厂商共同资料</h2>
              <p>
                OS、软件、设备型号及硬件产品的支持期限。相同产品版本可共用，不包含单台设备的购买与维保日期。
              </p>
            </div>
            <button
              className="secondary"
              onClick={() => {
                const csv =
                  "source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate,category,phase,supportTier\n厂商公告,公告地址或编号,产品或型号,明确版本,销售终止,,支持终止,,device,eol,standard\n";
                const url = URL.createObjectURL(
                  new Blob(["\ufeff" + csv], {
                    type: "text/csv;charset=utf-8",
                  }),
                );
                const a = document.createElement("a");
                a.href = url;
                a.download = "ys-lifecycle-template.csv";
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              下载 CSV 模板
            </button>
          </div>
          <p className="lifecycle-help">
            category：os / software / device / hardware；phase：eos /
            eol，明确指定引用哪一个来源阶段；supportTier：standard /
            extended，保留厂商原始阶段，扩展支持须登记适用依据。精确且唯一匹配时自动引用；缺版本和多来源冲突保持待确认。导入不会启动风险评估。
          </p>
          {props.referenceLibrary}
        </section>
      ) : (
        <>
          <section className="lifecycle-inventory" aria-label="设备期限明细">
            <header className="lifecycle-section-heading">
              <div>
                <h2>设备专属期限</h2>
                <p>
                  填写后直接确认保存。空白项不清除已有资料；“厂商未匹配”不等于“设备未填写”。
                </p>
              </div>
              <span>{data?.total ?? "—"} 台设备</span>
            </header>
            <div className="lifecycle-filters">
              <label>
                设备类型
                <select
                  aria-label="设备类型"
                  value={category}
                  onChange={(e) => filter(setCategory, e.target.value)}
                >
                  <option value="">全部设备</option>
                  {Object.entries(deviceCategories).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                填写状态
                <select
                  aria-label="填写状态"
                  value={state}
                  onChange={(e) => filter(setState, e.target.value)}
                >
                  <option value="">全部状态</option>
                  {Object.entries(states).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                缺失项
                <select
                  aria-label="缺失项"
                  value={missing}
                  onChange={(e) => filter(setMissing, e.target.value)}
                >
                  <option value="">不限</option>
                  <option value="purchasedOn">缺购买日期</option>
                  <option value="warrantyUntil">缺维保日期</option>
                  <option value="support">缺支持期限</option>
                  <option value="unmatched">厂商资料未匹配</option>
                  <option value="conflict">厂商来源冲突</option>
                </select>
              </label>
              <label>
                搜索设备
                <input
                  value={q}
                  onChange={(e) => filter(setQ, e.target.value)}
                  placeholder="资产名称"
                />
              </label>
            </div>
            {!data ? (
              <p role="status">正在读取生命周期资料…</p>
            ) : (
              <>
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>资产 / 类型</th>
                        <th>购买日期</th>
                        <th>维保到期</th>
                        <th>厂商支持资料</th>
                        <th>填写状态</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.items.map((item) => (
                        <tr key={item.id}>
                          <td>
                            <strong>{item.name}</strong>
                            <small>{deviceCategories[item.category]}</small>
                          </td>
                          <td>
                            {item.applicability.purchasedOn ? (
                              <>
                                {item.data.purchasedOn ?? "未填写"}
                                {item.dateRisks
                                  .filter((r) => r.type === "service_age")
                                  .map((r) => (
                                    <small key={r.type}>
                                      使用年限到期：
                                      {r.dueDate ?? "未配置 / 资料缺失"} ·{" "}
                                      {levelLabels[r.level]}
                                    </small>
                                  ))}
                              </>
                            ) : (
                              "不适用"
                            )}
                          </td>
                          <td>
                            {item.applicability.warrantyUntil ? (
                              <>
                                {item.data.warrantyUntil ?? "未填写"}
                                {item.dateRisks
                                  .filter((r) => r.type === "warranty")
                                  .map((r) => (
                                    <small key={r.type}>
                                      维保风险：{levelLabels[r.level]}
                                    </small>
                                  ))}
                              </>
                            ) : (
                              "不适用"
                            )}
                          </td>
                          <td>
                            {item.support.map((ref, i) => (
                              <div className="lifecycle-support" key={i}>
                                <strong>
                                  {ref.kind === "os"
                                    ? "OS"
                                    : ref.kind === "software"
                                      ? "软件"
                                      : "硬件 / 型号"}{" "}
                                  · {ref.rawProduct || ref.product || "缺产品"}{" "}
                                  {ref.version}
                                </strong>
                                <p>
                                  {ref.supportTier === "extended"
                                    ? "扩展支持"
                                    : "标准支持"}{" "}
                                  · {ref.date ?? "期限未知"} ·{" "}
                                  {ref.riskLevel
                                    ? levelLabels[ref.riskLevel]
                                    : matches[ref.status]}
                                </p>
                                {ref.standardDate &&
                                  ref.supportTier === "extended" && (
                                    <p>标准支持截止：{ref.standardDate}</p>
                                  )}
                                {ref.supportTier === "extended" &&
                                  ref.standardStatus !== "matched" && (
                                    <p>
                                      标准支持：
                                      {ref.standardStatus === "conflict"
                                        ? "多来源待核对"
                                        : "资料缺失"}
                                    </p>
                                  )}
                                <details className="lifecycle-reference">
                                  <summary>
                                    <span
                                      className={`lifecycle-match ${ref.status}`}
                                    >
                                      {matches[ref.status]}
                                    </span>{" "}
                                    {ref.kind === "os"
                                      ? "OS"
                                      : ref.kind === "software"
                                        ? "软件"
                                        : "设备"}{" "}
                                    · {ref.date ?? "期限未知"}
                                  </summary>
                                  <p>
                                    {ref.product || "未知产品"} /{" "}
                                    {ref.version || "未知版本"} ·{" "}
                                    {ref.stage ?? "未指定阶段"}
                                  </p>
                                  <p>{ref.basis}</p>
                                  {ref.source && (
                                    <p>
                                      {ref.source} · {ref.sourceRef}
                                    </p>
                                  )}
                                  {ref.batchId && (
                                    <small>批次 {ref.batchId}</small>
                                  )}
                                  {ref.entitlement && (
                                    <p>适用依据：{ref.entitlement}</p>
                                  )}
                                  {ref.mappingBasis && (
                                    <p>
                                      产品别名：{ref.rawProduct} → {ref.product}
                                      ；{ref.mappingBasis}
                                    </p>
                                  )}
                                  {ref.stages?.map((stage, j) => (
                                    <p key={j}>
                                      {stage.supportTier === "extended"
                                        ? "扩展支持"
                                        : "标准 / 原始支持"}{" "}
                                      · {stage.stage} ·{" "}
                                      {stage.date ?? "期限未知"} ·{" "}
                                      {stage.source} · {stage.sourceRef}
                                    </p>
                                  ))}
                                </details>
                              </div>
                            ))}
                            {item.applicability.os && (
                              <div className="lifecycle-reference">
                                <strong>
                                  OS 来源 ·{" "}
                                  {item.osIdentity.status === "conflict"
                                    ? "待核对"
                                    : item.osIdentity.confirmed
                                      ? "已确认OS"
                                      : "待确认采集"}
                                </strong>
                                <p>
                                  NetBox登记平台：
                                  {item.osIdentity.platform?.product ??
                                    "未登记"}{" "}
                                  {item.osIdentity.platform?.version} ·{" "}
                                  {item.osIdentity.platform?.at}
                                </p>
                                <p>
                                  已确认OS：
                                  {item.osIdentity.confirmed
                                    ? `${item.osIdentity.confirmed.product} ${item.osIdentity.confirmed.version} · ${item.osIdentity.confirmed.source} · ${item.osIdentity.confirmed.actor} · ${item.osIdentity.confirmed.at}`
                                    : "无已确认OS；未确认观测不用于期限判断"}
                                </p>
                                {item.osIdentity.confirmed && (
                                  <small>
                                    快照 {item.osIdentity.confirmed.snapshotId}
                                  </small>
                                )}
                              </div>
                            )}
                          </td>
                          <td>
                            <span
                              className={`lifecycle-state state-${item.state}`}
                            >
                              {states[item.state]}
                            </span>
                          </td>
                          <td>
                            <button
                              type="button"
                              className="secondary"
                              onClick={() => setEditing(item)}
                            >
                              {item.category === "vm"
                                ? "关联OS厂商资料"
                                : "填写设备期限"}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {!data.items.length && (
                    <div className="lifecycle-empty">
                      没有符合筛选条件的设备
                    </div>
                  )}
                </div>
                <footer className="lifecycle-pagination">
                  <span>共 {data.total} 台</span>
                  <div>
                    <button
                      disabled={!offset}
                      onClick={() => setOffset((v) => Math.max(0, v - 25))}
                    >
                      上一页
                    </button>
                    <button
                      disabled={offset + 25 >= data.total}
                      onClick={() => setOffset((v) => v + 25)}
                    >
                      下一页
                    </button>
                  </div>
                </footer>
              </>
            )}
          </section>
          {editing && (
            <AssetLifecycleForm
              {...props}
              key={editing.id}
              assetId={editing.id}
              workspaceItem={editing}
              readOnly={false}
              onClose={() => {
                setEditing(undefined);
                setRevision((v) => v + 1);
              }}
              onSaved={() => setRevision((v) => v + 1)}
            />
          )}
        </>
      )}
    </div>
  );
}
