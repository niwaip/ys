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
  ...props
}: FeatureProps & { assetId: string }) {
  const [links, setLinks] = useState<AssetVersionLink[]>([]),
    [offset, setOffset] = useState(0),
    [job, setJob] = useState<Assessment>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [name, setName] = useState(assetId);
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
  useEffect(() => {
    if (!job || !["queued", "running"].includes(job.status)) return;
    const c = new AbortController();
    const timer = setInterval(
      () =>
        api<Assessment>(
          `${base}/assessments/${job.id}`,
          props.token,
          {},
          c.signal,
        )
          .then(setJob)
          .catch((e) => {
            if (!c.signal.aborted) fail(e);
          }),
      1000,
    );
    return () => {
      clearInterval(timer);
      c.abort();
    };
  }, [job?.id, job?.status, base, props.token]);
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
    <section className="asset-panel">
      <h2>资产评估 · {name}</h2>
      <p>Linux主机与网络设备直接CVE评估尚未接入</p>
      <p>
        仅以下明确关联本资产的固定SBOM版本可独立评估；镜像结果不覆盖运行容器可写层或挂载卷。
      </p>
      {error && <p role="alert">{error}</p>}
      {!links.length && (
        <p>尚无关联SBOM，请先在采集资料详情关联软件或镜像输入版本。</p>
      )}
      {links.map((link) => (
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
      {job && <AssessmentDetails job={job} />}
    </section>
  );
}
export function AssessmentWorkspace(props: FeatureProps) {
  const [tab, setTab] = useState(0);
  const labels = props.assetId
    ? ["本资产关联SBOM", "Windows 补丁评估"]
    : ["软件漏洞评估", "Windows 补丁评估", "镜像漏洞评估"];
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>CVE评估</h1>
          <p>
            选择明确的对象与固定资料版本。未配置执行器、资料不足或不支持不代表零风险。
          </p>
        </div>
      </div>
      <Tabs labels={labels} active={tab} change={setTab} />
      {props.assetId ? (
        tab === 0 ? (
          <AssetAssessment {...props} assetId={props.assetId} />
        ) : (
          <WindowsAssessmentsPage {...props} />
        )
      ) : tab === 0 ? (
        <AssessmentsPage {...props} />
      ) : tab === 1 ? (
        <WindowsAssessmentsPage {...props} />
      ) : (
        <ContainersPage {...props} />
      )}
    </>
  );
}
