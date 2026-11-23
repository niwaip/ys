import type { FeatureProps } from "../../features";
import { SoftwarePage } from "../software/SoftwarePage";
import { ContainersPage } from "../containers/ContainersPage";
export function LegacyComponentMaterials({
  kind,
  ...props
}: FeatureProps & { kind: "software" | "container" }) {
  return (
    <>
      <section className="asset-panel">
        <h1>
          {kind === "software" ? "软件资料入口已整合" : "容器资料入口已整合"}
        </h1>
        <p>
          请先选择资产类型和具体主机，再进入操作系统与配置。下方保留客户组件资料库；未明确关联的资料不计入任何主机配置。
        </p>
        <button
          className="primary"
          onClick={() =>
            props.onNavigate?.("collections", props.assetId, {
              configurationContent: kind === "software" ? "software" : "docker",
            })
          }
        >
          前往主机配置
        </button>
      </section>
      <details open>
        <summary>待关联及共享资料库（保留历史）</summary>
        {kind === "software" ? (
          <SoftwarePage {...props} />
        ) : (
          <ContainersPage {...props} />
        )}
      </details>
    </>
  );
}
