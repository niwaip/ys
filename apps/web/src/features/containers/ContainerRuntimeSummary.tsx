import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type { ContainerRuntimeSummary as Summary } from "../../../../../packages/contracts/container-runtime";
import "./container-runtime.css";
export function ContainerRuntimeSummary(props: FeatureProps) {
  const [summary, setSummary] = useState<Summary>(),
    [error, setError] = useState("");
  useEffect(() => {
    const c = new AbortController();
    setSummary(undefined);
    setError("");
    api<Summary>(
      `/customers/${props.customerId}/container-runtime/summary${props.assetId ? `?assetId=${props.assetId}` : ""}`,
      props.token,
      {},
      c.signal,
    )
      .then(setSummary)
      .catch((e) => {
        if (!c.signal.aborted) {
          if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
          else setError(e.message);
        }
      });
    return () => c.abort();
  }, [props.customerId, props.token, props.assetId]);
  return (
    <section
      className="asset-panel container-runtime-summary"
      aria-label="容器镜像扫描概要"
    >
      <div className="panel-heading">
        <h2>容器镜像与扫描</h2>
        <button
          className="secondary"
          onClick={() => props.onNavigate?.("containers", props.assetId)}
        >
          选择主机生成 / 查看镜像
        </button>
      </div>
      {error ? (
        <p role="alert">{error}</p>
      ) : summary ? (
        <>
          <div className="runtime-cards">
            <div>
              镜像资料版本<strong>{summary.generatedVersions}</strong>关联{" "}
              {summary.hosts} 台主机
            </div>
            <div>
              已观测镜像<strong>{summary.observedImages}</strong>
              {summary.runningContainers} 个最近观测运行实例
            </div>
            <div>
              生成并扫描完成<strong>{summary.succeeded}</strong>后台处理中{" "}
              {summary.pending} 项
            </div>
            <div>
              未成功任务<strong>{summary.failed}</strong>可到镜像页面查看并重试
            </div>
          </div>
          <p className="subtle">
            按已有资料及最近镜像观测统计，不代表实时运行状态；镜像漏洞不自动等同主机已确认受影响。
          </p>
        </>
      ) : (
        <p>正在读取镜像扫描概要…</p>
      )}
    </section>
  );
}
