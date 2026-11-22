import { useEffect, useState, type FormEvent } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import {
  riskConfigSchema,
  riskTypeLabels,
  riskTypes,
  levelLabels,
  handlingLabels,
  type RiskConfig,
  type RiskView,
  type RiskItem,
} from "../../../../../packages/contracts/lifecycle-risk";
import "./lifecycle-risk.css";
const categories = {
  all: "全部类别",
  server: "服务器",
  network: "网络设备",
  unknown: "未分类",
};
const activeRisk = (i: RiskItem) =>
  ["critical", "warning", "reminder"].includes(i.level);
export function LifecycleRiskPage(props: FeatureProps) {
  return <RiskPage key={props.customerId} {...props} />;
}
function RiskPage(props: FeatureProps) {
  const params = new URLSearchParams(location.hash.split("?")[1]);
  const [tab, setTab] = useState(0),
    [view, setView] = useState<RiskView>(),
    [config, setConfig] = useState<RiskConfig>(),
    [preview, setPreview] = useState<{
      before: RiskView["summary"];
      after: RiskView;
      changes: number;
    }>(),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [detail, setDetail] = useState<RiskItem>();
  const [search, setSearch] = useState(""),
    [level, setLevel] = useState(params.get("level") ?? "attention"),
    [type, setType] = useState(""),
    [category, setCategory] = useState(""),
    [handling, setHandling] = useState(""),
    [owner, setOwner] = useState(""),
    [page, setPage] = useState(0);
  const [snapshot, setSnapshot] = useState(params.get("view"));
  const base = `/customers/${props.customerId}/lifecycle-risk`;
  const call = <T,>(
    path: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ) =>
    api<T>(
      `${base}${path}`,
      props.token,
      { method, ...(body ? { body: JSON.stringify(body) } : {}) },
      signal,
    );
  const fail = (e: unknown) => {
    if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
    else setError((e as Error).message);
  };
  useEffect(() => {
    const c = new AbortController();
    setView(undefined);
    setError("");
    Promise.all([
      call<RiskView>(
        snapshot ? `/views/${snapshot}` : "/current",
        "GET",
        undefined,
        c.signal,
      ).then(setView),
      call<RiskConfig>("/config", "GET", undefined, c.signal).then(setConfig),
    ]).catch((e) => {
      if (!c.signal.aborted) fail(e);
    });
    return () => c.abort();
  }, [props.customerId, props.token, snapshot]);
  useEffect(() => setPage(0), [search, level, type, category, handling, owner]);
  useEffect(() => {
    if (!detail) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetail(undefined);
      if (event.key !== "Tab") return;
      const elements = Array.from(
        document.querySelectorAll<HTMLElement>(
          ".risk-drawer button:not(:disabled), .risk-drawer input:not(:disabled), .risk-drawer select:not(:disabled), .risk-drawer textarea:not(:disabled)",
        ),
      );
      const first = elements[0],
        last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [detail?.id]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  function edit(next: RiskConfig) {
    setConfig(next);
    setPreview(undefined);
  }
  function ruleEditor(
    rule: RiskConfig["defaultRule"],
    change: (r: RiskConfig["defaultRule"]) => void,
    prefix: string,
  ) {
    return (
      <div className="risk-form-grid">
        <label>
          <input
            aria-label={`${prefix}启用`}
            type="checkbox"
            checked={rule.enabled}
            onChange={(e) => change({ ...rule, enabled: e.target.checked })}
          />
          启用规则
        </label>
        <label>
          {prefix}提醒提前月数
          <input
            type="number"
            min="1"
            max="120"
            value={rule.reminderMonths}
            onChange={(e) =>
              change({ ...rule, reminderMonths: Number(e.target.value) })
            }
          />
        </label>
        <label>
          {prefix}警告提前月数
          <input
            type="number"
            min="0"
            max="120"
            value={rule.warningMonths}
            onChange={(e) =>
              change({ ...rule, warningMonths: Number(e.target.value) })
            }
          />
        </label>
        <p>到期当天起致命</p>
      </div>
    );
  }
  async function saveTreatment(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!detail) return;
    const f = new FormData(e.currentTarget);
    await run(async () => {
      const result = await call<RiskView>(
        `/treatments/${detail.assetId}/${detail.type}`,
        "PUT",
        {
          status: f.get("status"),
          owner: f.get("owner"),
          note: f.get("note"),
          acceptedUntil: f.get("acceptedUntil") || null,
        },
      );
      setView(result);
      setDetail(result.items.find((i) => i.id === detail.id));
      setNotice("处理记录已保存");
    });
  }
  const filtered =
    view?.items.filter(
      (i) =>
        (!props.assetId || i.assetId === props.assetId) &&
        (!search ||
          `${i.assetName} ${i.assetId}`
            .toLowerCase()
            .includes(search.toLowerCase())) &&
        (!type || i.type === type) &&
        (!category || i.category === category) &&
        (!owner || i.treatment.owner.includes(owner)) &&
        (!handling || i.treatment.status === handling) &&
        (level === "all" ||
          (level === "attention" && i.level !== "normal") ||
          (level === "anomaly" && ["missing", "conflict"].includes(i.level)) ||
          i.level === level),
    ) ?? [];
  return (
    <div className="lifecycle-risk">
      <div className="page-heading">
        <div>
          <div className="eyebrow">LIFECYCLE RISK</div>
          <h1>生命周期风险</h1>
          <p>管理支持期限、维保与使用年限，查看风险依据和处理进展。</p>
        </div>
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              setSnapshot(null);
              const next = await call<RiskView>("/current");
              setView(next);
              setDetail(undefined);
              history.replaceState(null, "", "#lifecycle-risk");
              setNotice("当前风险已更新");
            })
          }
        >
          更新当前风险
        </button>
      </div>
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
      <div className="workspace-tabs" role="tablist">
        {["风险明细", "规则配置"].map((label, n) => (
          <button
            key={label}
            role="tab"
            aria-selected={tab === n}
            className={tab === n ? "primary" : "secondary"}
            onClick={() => setTab(n)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 0 ? (
        <>
          {view ? (
            <>
              <p className="subtle">
                计算时间：{new Date(view.calculatedAt).toLocaleString("zh-CN")}{" "}
                · {view.config.timeZone}
                {snapshot ? " · Dashboard 固定快照" : ""} · 每日自动更新
              </p>
              <div className="risk-cards">
                {(["critical", "warning", "reminder"] as const).map((l) => (
                  <button
                    className={`risk-card ${l}`}
                    key={l}
                    onClick={() => setLevel(l)}
                  >
                    <span>{levelLabels[l]}</span>
                    <strong>
                      {view.summary.byLevel[l].assets}
                      <small> 台资产</small>
                    </strong>
                    <span>{view.summary.byLevel[l].items} 项风险</span>
                  </button>
                ))}
                <button
                  className="risk-card"
                  onClick={() => setLevel("anomaly")}
                >
                  <span>资料异常</span>
                  <strong>
                    {view.summary.missing + view.summary.conflict}
                    <small> 项</small>
                  </strong>
                  <span>
                    待补 {view.summary.missing} · 冲突 {view.summary.conflict}
                  </span>
                </button>
              </div>
              <p>
                共 {view.summary.riskAssets} 台风险资产 ·{" "}
                {view.summary.riskItems} 项风险 · 已接受{" "}
                {view.summary.acceptedItems} 项 ·{" "}
                <button
                  className="text-button"
                  onClick={() => setLevel("unassessed")}
                >
                  不评估 {view.summary.unassessed} 项
                </button>
              </p>
            </>
          ) : (
            <p>正在读取生命周期风险…</p>
          )}
          <section className="asset-panel">
            <div className="risk-filters">
              <label>
                搜索资产
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="名称或资产编号"
                />
              </label>
              <label>
                风险类型
                <select value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">全部</option>
                  {riskTypes.map((t) => (
                    <option key={t} value={t}>
                      {riskTypeLabels[t]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                设备类别
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  <option value="">全部</option>
                  {Object.entries(categories)
                    .filter(([k]) => k !== "all")
                    .map(([k, v]) => (
                      <option key={k} value={k}>
                        {v}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                风险等级
                <select
                  value={level}
                  onChange={(e) => setLevel(e.target.value)}
                >
                  <option value="attention">风险与资料异常</option>
                  <option value="all">全部含正常</option>
                  <option value="anomaly">资料异常</option>
                  {Object.entries(levelLabels).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                处理状态筛选
                <select
                  value={handling}
                  onChange={(e) => setHandling(e.target.value)}
                >
                  <option value="">全部</option>
                  {Object.entries(handlingLabels).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                负责人筛选
                <input
                  value={owner}
                  onChange={(e) => setOwner(e.target.value)}
                />
              </label>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>资产</th>
                    <th>风险对象</th>
                    <th>到期日期</th>
                    <th>剩余时间</th>
                    <th>等级</th>
                    <th>处理状态 / 负责人</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.slice(page * 30, (page + 1) * 30).map((i) => (
                    <tr key={i.id}>
                      <td>
                        {i.assetName}
                        <small className="block subtle">
                          {categories[i.category]}
                        </small>
                      </td>
                      <td>{riskTypeLabels[i.type]}</td>
                      <td>{i.dueDate ?? "待确认"}</td>
                      <td>
                        {i.daysRemaining === null
                          ? "未知"
                          : i.daysRemaining < 0
                            ? `已过期 ${-i.daysRemaining} 天`
                            : `${i.daysRemaining} 天`}
                      </td>
                      <td>
                        <span className={`risk-badge ${i.level}`}>
                          {levelLabels[i.level]}
                        </span>
                      </td>
                      <td>
                        {activeRisk(i)
                          ? handlingLabels[i.treatment.status]
                          : i.level === "normal" && i.history.length
                            ? "已解除"
                            : "—"}
                        <small className="block">{i.treatment.owner}</small>
                      </td>
                      <td>
                        <button onClick={() => setDetail(i)}>查看详情</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {view && !filtered.length && (
              <p className="empty">没有符合条件的项目</p>
            )}
            <div className="pagination">
              <span>
                共 {filtered.length} 项 · 第 {page + 1} 页
              </span>
              <button disabled={!page} onClick={() => setPage(page - 1)}>
                上一页
              </button>
              <button
                disabled={(page + 1) * 30 >= filtered.length}
                onClick={() => setPage(page + 1)}
              >
                下一页
              </button>
            </div>
          </section>
        </>
      ) : config ? (
        <section className="asset-panel">
          <h2>客户默认规则</h2>
          <p>
            类别规则优先于同风险类型的全部类别规则，其余使用客户默认。阈值按自然月计算，月底取目标月最后一天。
          </p>
          <fieldset disabled={busy}>
            <label>
              客户时区
              <input
                value={config.timeZone}
                onChange={(e) => edit({ ...config, timeZone: e.target.value })}
              />
            </label>
            {ruleEditor(
              config.defaultRule,
              (r) => edit({ ...config, defaultRule: r }),
              "默认",
            )}
            <h2>设备使用年限</h2>
            <p>
              不设置统一报废标准。空值表示未配置，缺少年限或购买日期显示待补资料。
            </p>
            <div className="risk-form-grid">
              {(["server", "network", "unknown"] as const).map((c) => (
                <label key={c}>
                  {categories[c]}使用年限
                  <input
                    type="number"
                    min="1"
                    max="100"
                    value={config.serviceYears[c] ?? ""}
                    onChange={(e) =>
                      edit({
                        ...config,
                        serviceYears: {
                          ...config.serviceYears,
                          [c]: e.target.value ? Number(e.target.value) : null,
                        },
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <h2>类别覆盖规则</h2>
            {config.overrides.map((o, n) => (
              <fieldset key={n}>
                <legend>覆盖规则 {n + 1}</legend>
                <div className="risk-form-grid">
                  <label>
                    覆盖风险类型
                    <select
                      value={o.type}
                      onChange={(e) =>
                        edit({
                          ...config,
                          overrides: config.overrides.map((v, j) =>
                            j === n
                              ? { ...v, type: e.target.value as typeof o.type }
                              : v,
                          ),
                        })
                      }
                    >
                      {riskTypes.map((t) => (
                        <option value={t} key={t}>
                          {riskTypeLabels[t]}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    覆盖设备类别
                    <select
                      value={o.category}
                      onChange={(e) =>
                        edit({
                          ...config,
                          overrides: config.overrides.map((v, j) =>
                            j === n
                              ? {
                                  ...v,
                                  category: e.target.value as typeof o.category,
                                }
                              : v,
                          ),
                        })
                      }
                    >
                      {Object.entries(categories).map(([k, v]) => (
                        <option value={k} key={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                {ruleEditor(
                  o.rule,
                  (r) =>
                    edit({
                      ...config,
                      overrides: config.overrides.map((v, j) =>
                        j === n ? { ...v, rule: r } : v,
                      ),
                    }),
                  `规则${n + 1}`,
                )}
                <button
                  onClick={() =>
                    edit({
                      ...config,
                      overrides: config.overrides.filter((_, j) => j !== n),
                    })
                  }
                >
                  删除覆盖
                </button>
              </fieldset>
            ))}
            <button
              disabled={config.overrides.length >= 40}
              onClick={() =>
                edit({
                  ...config,
                  overrides: [
                    ...config.overrides,
                    {
                      type: "os_support",
                      category: "all",
                      rule: { ...config.defaultRule },
                    },
                  ],
                })
              }
            >
              添加覆盖规则
            </button>
          </fieldset>
          <div className="form-actions">
            <button
              className="primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const p = riskConfigSchema.safeParse(config);
                  if (!p.success)
                    throw new Error(
                      p.error.issues.map((i) => i.message).join("；"),
                    );
                  setPreview(await call("/preview", "POST", p.data));
                })
              }
            >
              预览影响
            </button>
          </div>
          {preview && (
            <section className="risk-preview">
              <h3>变更影响预览</h3>
              <p>
                {preview.changes} 项发生变化；风险项 {preview.before.riskItems}{" "}
                → {preview.after.summary.riskItems}；不评估{" "}
                {preview.before.unassessed} → {preview.after.summary.unassessed}
              </p>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const v = await call<RiskView>("/config", "PUT", config);
                    setView(v);
                    setPreview(undefined);
                    setSnapshot(null);
                    setNotice("规则已保存，当前风险已重算");
                  })
                }
              >
                确认保存规则
              </button>
            </section>
          )}
        </section>
      ) : (
        <p>正在读取规则…</p>
      )}
      {detail && (
        <div className="risk-overlay">
          <section
            className="risk-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="风险详情"
          >
            <div className="panel-heading">
              <h2>
                {detail.assetName} · {riskTypeLabels[detail.type]}
              </h2>
              <button autoFocus onClick={() => setDetail(undefined)}>
                关闭详情
              </button>
            </div>
            <p>
              <span className={`risk-badge ${detail.level}`}>
                {levelLabels[detail.level]}
              </span>{" "}
              · {detail.dueDate ?? "日期待确认"}
            </p>
            <h3>日期依据</h3>
            <p>{detail.basis}</p>
            {detail.evidence.map((e, n) => (
              <p key={n}>
                {e.stage} · {e.rawDate || "未知日期"}
                <br />
                {e.source} · {e.sourceRef}
                {e.batchId && (
                  <>
                    <br />
                    批次 {e.batchId} · 来源行 {e.row}
                  </>
                )}
              </p>
            ))}
            {!detail.evidence.length && (
              <p>缺少可靠来源，请补充资产资料或关联生命周期批次。</p>
            )}
            <h3>命中规则</h3>
            <p>
              {detail.ruleSource} · 提前 {detail.rule.reminderMonths} 个月提醒 /{" "}
              {detail.rule.warningMonths} 个月警告 / 到期致命
            </p>
            <button
              onClick={() => props.onNavigate?.("assets", detail.assetId)}
            >
              查看资产并修正资料
            </button>
            {activeRisk(detail) && !snapshot ? (
              <form
                key={`${detail.id}:${detail.history.length}`}
                onSubmit={saveTreatment}
              >
                <h3>处理风险</h3>
                <fieldset disabled={busy}>
                  <label>
                    负责人
                    <input
                      name="owner"
                      defaultValue={detail.treatment.owner}
                      maxLength={200}
                    />
                  </label>
                  <label>
                    处理状态
                    <select
                      aria-label="处理状态"
                      name="status"
                      defaultValue={detail.treatment.status}
                    >
                      {Object.entries(handlingLabels).map(([k, v]) => (
                        <option key={k} value={k}>
                          {v}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    处理备注
                    <textarea
                      name="note"
                      defaultValue={detail.treatment.note}
                      maxLength={2000}
                    />
                  </label>
                  <label>
                    接受有效期
                    <input
                      type="date"
                      name="acceptedUntil"
                      defaultValue={detail.treatment.acceptedUntil ?? ""}
                    />
                  </label>
                  <p>接受风险需原因和有效期，不降低风险等级。</p>
                  <button className="primary" disabled={busy}>
                    保存处理
                  </button>
                </fieldset>
              </form>
            ) : snapshot ? (
              <p>当前查看固定快照；更新当前风险后可处理。</p>
            ) : null}
            <h3>处理记录</h3>
            {detail.history.length ? (
              detail.history.map((h, n) => (
                <p key={n}>
                  {h.at} · {h.actor} · {h.action} · {handlingLabels[h.status]}
                  <br />
                  {h.owner} · {h.note}
                  {h.acceptedUntil ? ` · 接受至 ${h.acceptedUntil}` : ""}
                </p>
              ))
            ) : (
              <p>暂无处理记录</p>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
