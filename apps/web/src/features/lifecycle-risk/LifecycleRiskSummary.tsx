import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import {
  levelLabels,
  type RiskView,
} from "../../../../../packages/contracts/lifecycle-risk";
import "./lifecycle-risk.css";
export function LifecycleRiskSummary(props: FeatureProps) {
  const [view, setView] = useState<RiskView>(),
    [error, setError] = useState(""),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    setView(undefined);
    setError("");
    api<RiskView>(
      `/customers/${props.customerId}/lifecycle-risk/current`,
      props.token,
      {},
      c.signal,
    )
      .then(setView)
      .catch((e) => {
        if (!c.signal.aborted) {
          if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
          else setError(e.message);
        }
      });
    return () => c.abort();
  }, [props.customerId, props.token, revision]);
  function open(level: string) {
    location.hash = `lifecycle-risk?view=${view!.id}&level=${level}`;
  }
  return (
    <section className="asset-panel" aria-label="生命周期风险概要">
      <div className="panel-heading">
        <h2>当前生命周期风险</h2>
        <button className="secondary" onClick={() => setRevision((r) => r + 1)}>
          刷新生命周期概要
        </button>
      </div>
      <p>全部在管资产的当前期限风险；与下方所选历史评估范围分别统计。</p>
      {error ? (
        <p role="alert">{error}</p>
      ) : view ? (
        <>
          <p className="subtle">
            计算时间：{new Date(view.calculatedAt).toLocaleString("zh-CN")} ·{" "}
            {view.config.timeZone}
          </p>
          <div className="risk-cards">
            {(["critical", "warning", "reminder"] as const).map((l) => (
              <button
                key={l}
                aria-label={`${levelLabels[l]}生命周期风险 ${view.summary.byLevel[l].assets} 台资产`}
                className={`risk-card ${l}`}
                onClick={() => open(l)}
              >
                <span>{levelLabels[l]}</span>
                <strong>
                  {view.summary.byLevel[l].assets}
                  <small> 台资产</small>
                </strong>
                <span>{view.summary.byLevel[l].items} 项风险</span>
              </button>
            ))}
            <button className="risk-card" onClick={() => open("anomaly")}>
              <span>资料异常</span>
              <strong>
                {view.summary.missing + view.summary.conflict}
                <small> 项</small>
              </strong>
              <span>待补资料 / 资料冲突</span>
            </button>
          </div>
          <p>
            {view.summary.riskAssets} 台风险资产 · {view.summary.riskItems}{" "}
            项风险 · 已接受 {view.summary.acceptedItems} 项 ·{" "}
            <button className="text-button" onClick={() => open("unassessed")}>
              不评估 {view.summary.unassessed} 项
            </button>
          </p>
        </>
      ) : (
        <p>正在计算生命周期风险…</p>
      )}
    </section>
  );
}
