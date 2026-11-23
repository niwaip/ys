import {
  ScanConditions,
  ScanConditionsTarget,
} from "../assessments/ScanConditions";
import { AssessmentHistoryTable } from "../assessments/AssessmentHistoryTable";
import { AssessmentLiveStatus } from "../assessments/AssessmentLiveStatus";
import type { Asset, AssetPage } from "../../../../../packages/contracts";
import { LinuxAssessmentsPage } from "../assessments/LinuxAssessmentsPage";
import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import { requestId } from "../../request-id";
import type { FeatureProps } from "../../features";
import type { AssetVersionLink } from "../../../../../packages/contracts/collections";
import type {
  Assessment,
  AssessmentPage,
} from "../../../../../packages/contracts/assessments";
import { AssessmentDetails } from "../assessments/AssessmentDetails";
import { CollectionsPage } from "../collections/CollectionsPage";
import { ImportsPage } from "../imports/ImportsPage";
import { WindowsPage } from "../windows/WindowsPage";
import { AssessmentsPage } from "../assessments/AssessmentsPage";
import { WindowsAssessmentsPage } from "../windows-assessments/WindowsAssessmentsPage";
import { ContainersPage } from "../containers/ContainersPage";
import { LifecyclePage } from "../lifecycle/LifecyclePage";
import { RiskDetailsPage } from "../dashboard/RiskDetailsPage";

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
        labels={["主机采集", "Windows 采集导入", "CSV 资料导入"]}
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
  return <RiskDetailsPage {...props} />;
}

function AssetAssessment({
  assetId,
  kind,
  ...props
}: FeatureProps & { assetId: string; kind: "software" | "container" }) {
  const [links, setLinks] = useState<AssetVersionLink[]>([]),
    [offset, setOffset] = useState(0),
    [historyOffset, setHistoryOffset] = useState(0),
    [history, setHistory] = useState<AssessmentPage>(),
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
  async function refreshHistory(signal?: AbortSignal) {
    const page = await api<AssessmentPage>(
      `${base}/assessments?assetId=${assetId}&targetKind=${kind}&limit=20&offset=${historyOffset}`,
      props.token,
      {},
      signal,
    );
    if (!signal?.aborted) setHistory(page);
  }
  useEffect(() => {
    const c = new AbortController();
    void refreshHistory(c.signal).catch((e) => {
      if (!c.signal.aborted) fail(e);
    });
    return () => c.abort();
  }, [base, props.token, assetId, kind, historyOffset, job?.id, job?.status]);
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
      <ScanConditions>
        <h3>关联输入版本 · {name}</h3>
        <p>
          Linux系统包请使用“Linux系统包扫描”；网络设备的厂商规则评估尚未接入
        </p>
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
      </ScanConditions>
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
      {job && <AssessmentDetails context={props} job={job} />}
      <h3>本资产关联版本评估历史</h3>
      {history && (
        <AssessmentHistoryTable
          items={history.items}
          job={job}
          busy={busy}
          onSelect={(id) => {
            setError("");
            void api<Assessment>(`${base}/assessments/${id}`, props.token)
              .then(setJob)
              .catch(fail);
          }}
        />
      )}
      {history && !history.total && <p>尚无本资产关联版本评估任务。</p>}
      <div className="pagination">
        <button
          disabled={!historyOffset}
          onClick={() => setHistoryOffset(Math.max(0, historyOffset - 20))}
        >
          上一批关联评估
        </button>
        <button
          disabled={!history || historyOffset + 20 >= history.total}
          onClick={() => setHistoryOffset(historyOffset + 20)}
        >
          下一批关联评估
        </button>
      </div>
    </section>
  );
}
type AssessmentSupport = {
  status: "ready" | "missing" | "failed";
  reason: string;
};
export function AssessmentWorkspace(props: FeatureProps) {
  const [conditionsTarget, setConditionsTarget] =
    useState<HTMLDivElement | null>(null);
  const [tab, setTab] = useState(0),
    [selectedAsset, setSelectedAsset] = useState(""),
    [assets, setAssets] = useState<AssetPage>(),
    [assetInfo, setAssetInfo] = useState<Asset>(),
    [error, setError] = useState(""),
    [offset, setOffset] = useState(0),
    [capabilityVersion, setCapabilityVersion] = useState(0),
    [capabilities, setCapabilities] = useState<{
      assetId: string;
      customerId: string;
      linux: AssessmentSupport;
      windows: AssessmentSupport;
      linuxInput?: {
        id: string;
        importedAt: string;
        os?: { id: string; version: string };
        packages?: number;
      };
    }>();
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
  useEffect(() => {
    setCapabilities(undefined);
    if (!assetId) return;
    const c = new AbortController();
    const base = `/customers/${props.customerId}`;
    Promise.allSettled([
      api<{
        items: {
          id: string;
          importedAt: string;
          os?: { id: string; version: string };
          packages?: number;
          supported: boolean;
          reason?: string;
        }[];
      }>(
        `${base}/assessments/linux-inputs?assetId=${assetId}&offset=0`,
        props.token,
        {},
        c.signal,
      ),
      api<{ items: { assetId?: string; snapshotId?: string }[] }>(
        `${base}/windows/imports?assetId=${assetId}`,
        props.token,
        {},
        c.signal,
      ),
    ]).then(([linux, windows]) => {
      if (c.signal.aborted) return;
      if (
        [linux, windows].some(
          (r) =>
            r.status === "rejected" &&
            r.reason instanceof ApiError &&
            r.reason.status === 401,
        )
      ) {
        props.onUnauthorized();
        return;
      }
      const linuxReady =
        linux.status === "fulfilled" &&
        linux.value.items[0]?.supported === true;
      const windowsReady =
        windows.status === "fulfilled" &&
        windows.value.items.some(
          (x) => x.assetId === assetId && !!x.snapshotId,
        );
      setCapabilities({
        assetId,
        customerId: props.customerId,
        linuxInput:
          linux.status === "fulfilled" ? linux.value.items[0] : undefined,
        linux:
          linux.status === "rejected"
            ? { status: "failed", reason: "Linux资料读取失败，请刷新后重试。" }
            : {
                status: linuxReady ? "ready" : "missing",
                reason: linuxReady
                  ? "Linux系统包资料可用于评估；执行前仍会校验最新资料。"
                  : (linux.value.items[0]?.reason ??
                    "没有采集资料，请先执行资产基础采集。"),
              },
        windows:
          windows.status === "rejected"
            ? {
                status: "failed",
                reason: "Windows资料读取失败，请刷新后重试。",
              }
            : {
                status: windowsReady ? "ready" : "missing",
                reason: windowsReady
                  ? "已取得绑定资产的Windows资料，评估仍需有效补丁规则。"
                  : "没有绑定本资产的Windows采集资料。",
              },
      });
    });
    return () => c.abort();
  }, [assetId, props.customerId, props.token, capabilityVersion]);
  const capability =
    capabilities?.assetId === assetId &&
    capabilities.customerId === props.customerId
      ? capabilities
      : undefined;
  const assetReady =
    assetInfo?.id === assetId && assetInfo.customerId === props.customerId;
  const isNetwork = assetReady && assetInfo.hardwareType === "network";
  const labels = assetId
    ? [
        "Linux系统包扫描",
        "本资产关联SBOM",
        "Windows 补丁评估",
        "本资产关联镜像",
      ]
    : ["Linux系统包扫描", "软件漏洞评估", "Windows 补丁评估", "镜像漏洞评估"];
  return (
    <ScanConditionsTarget.Provider value={conditionsTarget}>
      <div className="assessment-workspace">
        <div className="page-heading">
          <div>
            <h1>CVE评估</h1>
            <p>
              在扫描条件中选择对象、扫描内容与输入资料，再开始评估。结果和历史记录显示在下方。
            </p>
          </div>
        </div>
        <section
          className="asset-panel scan-conditions"
          aria-labelledby="scan-conditions-title"
        >
          <h2 id="scan-conditions-title">扫描条件</h2>
          {!props.assetId && (
            <div className="scan-object">
              <label>
                评估对象
                <select
                  aria-label="评估对象"
                  value={selectedAsset}
                  onChange={(e) => {
                    setSelectedAsset(e.target.value);
                    setTab(0);
                  }}
                >
                  <option value="">选择资产（独立软件或镜像可直接进入）</option>
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
              {(!!offset || (assets?.total ?? 0) > 100) && (
                <details className="scan-object-pages">
                  <summary>
                    更多资产（当前第 {Math.floor(offset / 100) + 1} 批）
                  </summary>
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
                </details>
              )}
            </div>
          )}
          {assetId && (
            <div className="scan-object-summary">
              <h3>当前资产：{assetInfo?.name ?? "正在读取…"}</h3>
              <p>仅使用本资产的快照或明确关联的组件资料。</p>
              <details>
                <summary>对象资料</summary>
                <p>资产编号：{assetId}</p>
              </details>
              {props.assetId && (
                <button
                  onClick={() => props.onNavigate?.("assessment-workspace")}
                >
                  切换评估对象
                </button>
              )}
              {assetInfo?.hardwareType === "network" && (
                <p>
                  网络设备厂商固件CVE规则尚未接入。可评估明确关联的软件/镜像SBOM，不将未知显示为无风险。
                </p>
              )}
            </div>
          )}
          {error && <p role="alert">{error}</p>}
          <h3>扫描内容</h3>
          <Tabs labels={labels} active={tab} change={setTab} />
          {assetId && (
            <div className="assessment-capabilities" role="status">
              <p>
                {tab === 0
                  ? (capability?.linux.reason ?? "正在检查Linux评估资料…")
                  : tab === 2
                    ? (capability?.windows.reason ?? "正在检查Windows评估资料…")
                    : "仅评估明确关联到本资产的固定SBOM版本。"}
              </p>
              {tab === 0 && capability?.linuxInput && (
                <dl className="scan-input-summary">
                  <div>
                    <dt>输入策略</dt>
                    <dd>执行时固定最新采集资料；不会重新采集主机</dd>
                  </div>
                  <div>
                    <dt>当前最新资料</dt>
                    <dd>{capability.linuxInput.id}</dd>
                  </div>
                  <div>
                    <dt>导入时间</dt>
                    <dd>{capability.linuxInput.importedAt}</dd>
                  </div>
                  <div>
                    <dt>系统 / 包数量</dt>
                    <dd>
                      {capability.linuxInput.os
                        ? `${capability.linuxInput.os.id} ${capability.linuxInput.os.version}`
                        : "系统未知"}{" "}
                      · {capability.linuxInput.packages ?? "未知"} 个包
                    </dd>
                  </div>
                </dl>
              )}
              {tab === 0 && capability?.linuxInput && (
                <p>当前预览可能在提交前更新，最终以任务绑定的快照为准。</p>
              )}
              {isNetwork && (
                <p>
                  厂商固件评估尚未接入。设备分类不会被当作操作系统；只有明确支持的系统包资料或关联SBOM可评估。
                </p>
              )}
              <button onClick={() => setCapabilityVersion((v) => v + 1)}>
                刷新资料状态
              </button>
            </div>
          )}
          <div ref={setConditionsTarget} className="scan-type-conditions" />
        </section>
        <div key={`${props.customerId}:${assetId || "all"}:${tab}`}>
          {assetId && !assetReady ? (
            <ScanConditions>
              <p>
                {error
                  ? "评估对象读取失败，请刷新页面或重新选择。"
                  : "正在读取评估对象与设备分类…"}
              </p>
            </ScanConditions>
          ) : tab === 0 ? (
            !assetId ? (
              <ScanConditions>
                <p>请先选择评估对象。此入口不会批量扫描全部资产。</p>
              </ScanConditions>
            ) : (
              <LinuxAssessmentsPage
                {...scoped}
                hideScan={isNetwork && capability?.linux.status !== "ready"}
                scanUnavailable={
                  capability?.linux.status === "ready"
                    ? undefined
                    : (capability?.linux.reason ?? "正在检查Linux评估资料…")
                }
              />
            )
          ) : tab === 2 ? (
            <WindowsAssessmentsPage
              {...scoped}
              hideScan={
                !!assetId && isNetwork && capability?.windows.status !== "ready"
              }
              scanUnavailable={
                assetId
                  ? capability?.windows.status === "ready"
                    ? undefined
                    : (capability?.windows.reason ?? "正在检查Windows评估资料…")
                  : undefined
              }
            />
          ) : assetId ? (
            <AssetAssessment
              {...scoped}
              assetId={assetId}
              kind={tab === 1 ? "software" : "container"}
            />
          ) : tab === 1 ? (
            <AssessmentsPage {...props} />
          ) : (
            <ContainersPage {...props} assessmentOnly />
          )}
        </div>
      </div>
    </ScanConditionsTarget.Provider>
  );
}
