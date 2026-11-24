import type { LifecycleRiskOverview } from "../../../../../packages/contracts/lifecycle-risk";
import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type { DashboardOverview } from "../../../../../packages/contracts/dashboard";
import "./overview.css";
function Metric({
  label,
  value,
  unit = "个",
  icon,
  tone = "",
  open,
}: {
  label: string;
  value: number | null;
  unit?: string;
  icon: string;
  tone?: string;
  open: () => void;
}) {
  return (
    <button
      className={`overview-metric ${tone}`}
      aria-label={`${label} ${value ?? "未知"}`}
      onClick={open}
    >
      <span className="overview-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="overview-metric-body">
        <span>{label}</span>
        <strong>
          {value ?? "未知"}
          <small>{value === null ? "" : unit}</small>
        </strong>
      </span>
      <span className="overview-arrow" aria-hidden="true">
        ↗
      </span>
    </button>
  );
}
export function DashboardPage(props: FeatureProps) {
  const [data, setData] = useState<DashboardOverview>(),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false);
  const [life, setLife] = useState<LifecycleRiskOverview>(),
    [lifeError, setLifeError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    setData(undefined);
    setError("");
    setBusy(true);
    setLife(undefined);
    setLifeError("");
    api<LifecycleRiskOverview>(
      `/customers/${props.customerId}/lifecycle-risk/summary`,
      props.token,
      {},
      c.signal,
    )
      .then((v) => {
        if (!c.signal.aborted) setLife(v);
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
          else setLifeError(e.message);
        }
      });
    api<DashboardOverview>(
      `/customers/${props.customerId}/dashboard/overview`,
      props.token,
      { method: "POST", body: "{}" },
      c.signal,
    )
      .then((v) => {
        if (!c.signal.aborted) setData(v);
      })
      .catch((e) => {
        if (!c.signal.aborted) {
          if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
          else setError(e.message);
        }
      })
      .finally(() => {
        if (!c.signal.aborted) setBusy(false);
      });
    return () => c.abort();
  }, [props.customerId, props.token, revision]);
  const risk = (filter: Record<string, string> = {}) => {
    if (!data) return;
    location.hash =
      "risk?" + new URLSearchParams({ scope: data.id, ...filter }).toString();
  };
  const openLife = (level: string, handling?: string) => {
    if (!life) {
      props.onNavigate?.("lifecycle-risk");
      return;
    }
    location.hash =
      "lifecycle-risk?" +
      new URLSearchParams({
        view: life.id,
        level,
        ...(["critical", "warning", "reminder"].includes(level)
          ? { assetLevel: level }
          : {}),
        ...(handling ? { handling } : {}),
      }).toString();
  };
  const navigate = (page: string) => props.onNavigate?.(page);
  const m = data?.metrics;
  const severityCount = (level: string) =>
    m?.cve.instances == null
      ? null
      : Object.entries(m.cve.bySeverity).reduce(
          (sum, [key, value]) =>
            sum + (key.toLowerCase() === level ? value : 0),
          0,
        );
  return (
    <section className="overview-page" aria-label="客户风险概览">
      <header className="overview-heading">
        <div>
          <div className="overview-eyebrow">CUSTOMER OVERVIEW</div>
          <h2>客户风险概览</h2>
          <p>当前客户 · 资产与风险概要</p>
        </div>
        <div className="overview-actions">
          <span>
            {data
              ? new Date(data.generatedAt).toLocaleString("zh-CN")
              : "正在读取…"}
          </span>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => setRevision((v) => v + 1)}
          >
            刷新概览
          </button>
        </div>
      </header>
      {error && <p role="alert">{error}</p>}
      {!m && !error && <p role="status">正在汇总资产与评估资料…</p>}
      {m && (
        <div className="overview-groups">
          <section className="overview-group" aria-label="资产规模">
            <h3>
              资产规模<span>点击查看对象</span>
            </h3>
            <div className="overview-grid">
              <Metric
                label="主机资产"
                value={m.inventory.host}
                unit="台"
                icon="▦"
                open={() => navigate("assets")}
              />
              <Metric
                label="网络设备"
                value={m.inventory.network ?? 0}
                unit="台"
                icon="⌘"
                open={() => risk({ hardware: "network" })}
              />
              <Metric
                label="软件对象"
                value={m.inventory.software}
                icon="◇"
                open={() => navigate("software")}
              />
              <Metric
                label="镜像对象"
                value={m.inventory.container}
                icon="⬡"
                open={() => navigate("containers")}
              />
            </div>
          </section>
          <section className="overview-group" aria-label="CVE 概要">
            <h3>
              CVE 概要<span>工具匹配不等同确认影响</span>
            </h3>
            <div className="overview-grid">
              <Metric
                label="唯一 CVE"
                value={m.cve.uniqueCves}
                icon="◈"
                open={() => risk()}
              />
              <Metric
                label="致命匹配记录"
                value={severityCount("critical")}
                unit="条"
                icon="!"
                tone="critical"
                open={() => risk({ severity: "critical" })}
              />
              <Metric
                label="高危匹配记录"
                value={severityCount("high")}
                unit="条"
                icon="△"
                tone="warning"
                open={() => risk({ severity: "high" })}
              />
              <Metric
                label="全部匹配记录"
                value={m.cve.instances}
                unit="条"
                icon="≋"
                open={() => risk()}
              />
            </div>
          </section>
          <section className="overview-group" aria-label="生命周期风险概要">
            <h3>
              生命周期风险<span>资产按最高风险等级归类</span>
            </h3>
            {lifeError && <p role="alert">{lifeError}</p>}
            <div className="overview-grid">
              <Metric
                label="致命生命周期风险"
                value={life?.summary.byLevel.critical.assets ?? null}
                unit="台"
                icon="!"
                tone="critical"
                open={() => openLife("critical")}
              />
              <Metric
                label="警告生命周期风险"
                value={life?.summary.byLevel.warning.assets ?? null}
                unit="台"
                icon="△"
                tone="warning"
                open={() => openLife("warning")}
              />
              <Metric
                label="提醒生命周期风险"
                value={life?.summary.byLevel.reminder.assets ?? null}
                unit="台"
                icon="◷"
                open={() => openLife("reminder")}
              />
              <Metric
                label="待处理风险项"
                value={life?.pendingItems ?? null}
                unit="项"
                icon="◫"
                open={() => openLife("active", "pending")}
              />
            </div>
          </section>
          <section className="overview-group" aria-label="评估覆盖与待处理">
            <h3>
              评估覆盖与待处理<span>单位：对象</span>
            </h3>
            <div className="overview-grid overview-coverage">
              <Metric
                label="已完成评估"
                value={m.coverage.succeeded}
                icon="✓"
                open={() => risk({ state: "succeeded" })}
              />
              <Metric
                label="未评估对象"
                value={m.coverage.unselected}
                icon="○"
                open={() => risk({ state: "unselected" })}
              />
              <Metric
                label="评估未成功"
                value={m.coverage.failed}
                icon="!"
                tone="warning"
                open={() => risk({ state: "failed" })}
              />
              <Metric
                label="漏洞库过期"
                value={m.freshness.stale}
                icon="◷"
                tone="warning"
                open={() => risk({ state: "stale" })}
              />
              <Metric
                label="覆盖未知"
                value={m.coverage.unknown}
                icon="?"
                open={() => risk({ state: "coverage_unknown" })}
              />
              <Metric
                label="库时间未知"
                value={m.freshness.unknown}
                icon="?"
                open={() => risk({ state: "freshness_unknown" })}
              />
            </div>
          </section>
        </div>
      )}
      <footer className="overview-footer">
        未评估、失败与未知不表示安全。详细记录、筛选和证据请点击对应卡片查看。
      </footer>
    </section>
  );
}
