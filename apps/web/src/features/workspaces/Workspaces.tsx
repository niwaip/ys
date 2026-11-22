import { AssessmentLiveStatus } from "../assessments/AssessmentLiveStatus";
import type { Asset, AssetPage } from "../../../../../packages/contracts";
import { LinuxAssessmentsPage } from "../assessments/LinuxAssessmentsPage";
import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import { requestId } from "../../request-id";
import type { FeatureProps } from "../../features";
import type { AssetVersionLink } from "../../../../../packages/contracts/collections";
import type { Assessment } from "../../../../../packages/contracts/assessments";
import { AssessmentDetails } from "../assessments/AssessmentDetails";
import { CollectionsPage } from "../collections/CollectionsPage";
import { ImportsPage } from "../imports/ImportsPage";
import { WindowsPage } from "../windows/WindowsPage";
import { AssessmentsPage } from "../assessments/AssessmentsPage";
import { WindowsAssessmentsPage } from "../windows-assessments/WindowsAssessmentsPage";
import { ContainersPage } from "../containers/ContainersPage";
import { LifecyclePage } from "../lifecycle/LifecyclePage";
import { DashboardPage } from "../dashboard/DashboardPage";

function Tabs({
  labels,
  active,
  change,
}: {
  labels: string[];
  active: number;
  change: (n: number) => void;
}) {
  return (
    <div className="workspace-tabs" role="tablist">
      {labels.map((label, n) => (
        <button
          key={label}
          role="tab"
          aria-selected={active === n}
          className={active === n ? "primary" : "secondary"}
          onClick={() => change(n)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
export function CollectionWorkspace(props: FeatureProps) {
  const [tab, setTab] = useState(0);
  return (
    <>
      <Tabs
        labels={["基础与Docker采集", "Windows 采集导入", "CSV 资料导入"]}
        active={tab}
        change={setTab}
      />
      {tab === 0 ? (
        <CollectionsPage {...props} />
      ) : tab === 1 ? (
        <WindowsPage {...props} />
      ) : (
        <ImportsPage {...props} />
      )}
    </>
  );
}
export function LifecycleMaterials(props: FeatureProps) {
  return <LifecyclePage {...props} mode="materials" />;
}
export function LifecycleEvaluation(props: FeatureProps) {
  return <LifecyclePage {...props} mode="assessment" />;
}
export function RiskWorkspace(props: FeatureProps) {
  return <DashboardPage {...props} title="风险结果" />;
}

function AssetAssessment({
  assetId,
  kind,
  ...props
}: FeatureProps & { assetId: string; kind: "software" | "container" }) {
  const [links, setLinks] = useState<AssetVersionLink[]>([]),
    [offset, setOffset] = useState(0),
    [job, setJob] = useState<Assessment>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [name, setName] = useState("正在读取资产…");
  const base = `/customers/${props.customerId}`;
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
    else setError((e as Error).message);
  }
  useEffect(() => {
    const c = new AbortController();
    Promise.all([
      api<{ items: AssetVersionLink[] }>(
        `${base}/collections/links?assetId=${assetId}&offset=${offset}`,
        props.token,
        {},
        c.signal,
      ).then((v) => setLinks(v.items)),
      api<{ name: string }>(
        `${base}/assets/${assetId}`,
        props.token,
        {},
        c.signal,
      ).then((v) => setName(v.name)),
    ]).catch((e) => {
      if (!c.signal.aborted) fail(e);
    });
    return () => c.abort();
  }, [base, assetId, props.token, offset]);
  async function assess(link: AssetVersionLink) {
    setBusy(true);
    setError("");
    try {
      setJob(
        await api<Assessment>(`${base}/assessments`, props.token, {
          method: "POST",
          body: JSON.stringify({
            [link.kind === "software" ? "softwareId" : "containerId"]:
              link.objectId,
            versionId: link.versionId,
            linkId: link.id,
            idempotencyKey: requestId(),
          }),
        }),
      );
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="asset-panel workspace-panel">
      <h2>资产评估 · {name}</h2>
      <p>Linux系统包请使用“Linux系统包扫描”；网络设备的厂商规则评估尚未接入</p>
      <p>
        仅以下明确关联本资产的固定SBOM版本可独立评估；镜像结果不覆盖运行容器可写层或挂载卷。
      </p>
      {error && <p role="alert">{error}</p>}
      {!links.some((link) => link.kind === kind) && (
        <p>尚无关联SBOM，请先在采集资料详情关联软件或镜像输入版本。</p>
      )}
      {links
        .filter((link) => link.kind === kind)
        .map((link) => (
          <article key={link.id}>
            <strong>
              {link.kind === "software" ? "软件" : "镜像"} · {link.basis}
            </strong>
            <p>
              固定版本 {link.versionId} · 采集时间 {link.snapshot.importedAt}
            </p>
            <button disabled={busy} onClick={() => void assess(link)}>
              评估此关联版本
            </button>
          </article>
        ))}
      <div className="pagination">
        <button
          disabled={!offset}
          onClick={() => setOffset(Math.max(0, offset - 100))}
        >
          上一批关联
        </button>
        <button
          disabled={links.length < 100}
          onClick={() => setOffset(offset + 100)}
        >
          下一批关联
        </button>
      </div>
      {job && (
        <AssessmentLiveStatus
          {...props}
          jobId={job.id}
          onComplete={async () => {
            setJob(
              await api<Assessment>(
                `${base}/assessments/${job.id}`,
                props.token,
              ),
            );
          }}
        />
      )}
      {job && <AssessmentDetails job={job} />}
    </section>
  );
}
export function AssessmentWorkspace(props: FeatureProps) {
  const [tab, setTab] = useState(0),
    [selectedAsset, setSelectedAsset] = useState(""),
    [assets, setAssets] = useState<AssetPage>(),
    [assetInfo, setAssetInfo] = useState<Asset>(),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(0);
  useEffect(() => {
    setSelectedAsset("");
    setTab(0);
    setAssets(undefined);
  }, [props.customerId, props.assetId]);
  const assetId = props.assetId || selectedAsset;
  const scoped = { ...props, assetId: assetId || undefined };
  useEffect(() => {
    const c = new AbortController();
    setError("");
    setAssetInfo(undefined);
    const base = `/customers/${props.customerId}`;
    const work = assetId
      ? api<Asset>(`${base}/assets/${assetId}`, props.token, {}, c.signal).then(
          setAssetInfo,
        )
      : Promise.resolve();
    const list = !props.assetId
      ? api<AssetPage>(
          `${base}/assets?limit=100&offset=${offset}`,
          props.token,
          {},
          c.signal,
        ).then(setAssets)
      : Promise.resolve();
    Promise.all([work, list]).catch((e) => {
      if (!c.signal.aborted) {
        if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
        else setError(e.message);
      }
    });
    return () => c.abort();
  }, [props.customerId, props.token, props.assetId, assetId, offset]);
  const labels = assetId
    ? [
        "Linux系统包扫描",
        "本资产关联SBOM",
        "Windows 补丁评估",
        "本资产关联镜像",
      ]
    : ["Linux系统包扫描", "软件漏洞评估", "Windows 补丁评估", "镜像漏洞评估"];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>CVE评估</h1>
          <p>
            先选择资产范围和扫描内容，再配置固定资料版本；任务通过SSE实时显示状态。
          </p>
        </div>
      </div>
      {!props.assetId && (
        <section className="asset-panel">
          <label>
            评估资产范围
            <select
              value={selectedAsset}
              onChange={(e) => {
                setSelectedAsset(e.target.value);
                setTab(0);
              }}
            >
              <option value="">全部对象（按类型选择）</option>
              {assetInfo &&
                !assets?.items.some((a) => a.id === assetInfo.id) && (
                  <option value={assetInfo.id}>{assetInfo.name}</option>
                )}
              {assets?.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} ·{" "}
                  {a.hardwareType === "network"
                    ? "网络设备"
                    : a.hardwareType === "server"
                      ? "服务器"
                      : "主机"}
                </option>
              ))}
            </select>
          </label>
          <div className="pagination">
            <button
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 100))}
            >
              上一批资产
            </button>
            <button
              disabled={!assets || offset + 100 >= assets.total}
              onClick={() => setOffset(offset + 100)}
            >
              下一批资产
            </button>
          </div>
        </section>
      )}
      {assetId && (
        <section className="asset-panel">
          <h2>当前资产：{assetInfo?.name ?? "正在读取…"}</h2>
          <p>
            资产编号：{assetId}
            ；以下扫描只使用该资产的快照或明确关联的组件资料。
          </p>
          {props.assetId && (
            <button onClick={() => props.onNavigate?.("assessment-workspace")}>
              切换到全部对象
            </button>
          )}
          {assetInfo?.hardwareType === "network" && (
            <p>
              网络设备厂商固件CVE规则尚未接入。可评估明确关联的软件/镜像SBOM，不将未知显示为无风险。
            </p>
          )}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      <Tabs labels={labels} active={tab} change={setTab} />
      <div key={`${props.customerId}:${assetId || "all"}:${tab}`}>
        {tab === 0 ? (
          <LinuxAssessmentsPage {...scoped} />
        ) : tab === 2 ? (
          <WindowsAssessmentsPage {...scoped} />
        ) : assetId ? (
          <AssetAssessment
            {...scoped}
            assetId={assetId}
            kind={tab === 1 ? "software" : "container"}
          />
        ) : tab === 1 ? (
          <AssessmentsPage {...props} />
        ) : (
          <ContainersPage {...props} />
        )}
      </div>
    </>
  );
}
