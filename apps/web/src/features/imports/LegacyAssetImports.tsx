import type { FeatureProps } from "../../features";
export function LegacyAssetImports(props: FeatureProps) {
  return (
    <section className="asset-panel">
      <h1>资产清单批量导入</h1>
      <p>
        CSV入口已移至资产台账，用于批量建档或关联；脚本结果请在资产采集上传。
      </p>
      <button
        onClick={() =>
          props.onNavigate?.("assets", undefined, { assetImport: true })
        }
      >
        前往台账批量导入
      </button>
    </section>
  );
}
