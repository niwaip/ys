import { SeverityControls, defaultSeverities } from "./SeverityControls";
import { AssessmentLiveStatus } from "./AssessmentLiveStatus";
import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import { requestId } from "../../request-id";
import type { FeatureProps } from "../../features";
import type { AssetPage } from "../../../../../packages/contracts";
import type {
  Assessment,
  AssessmentPage,
} from "../../../../../packages/contracts/assessments";
import { AssessmentDetails, assessmentStatusLabels } from "./AssessmentDetails";
type Inputs = {
  items: {
    id: string;
    importedAt: string;
    supported: boolean;
    reason: string | null;
    packages?: number;
    os?: { id: string; version: string };
  }[];
  total: number;
  offset: number;
};
export function LinuxAssessmentsPage(props: FeatureProps) {
  const [assets, setAssets] = useState<AssetPage>(),
    [asset, setAsset] = useState(props.assetId ?? ""),
    [job, setJob] = useState<Assessment>(),
    [history, setHistory] = useState<AssessmentPage>(),
    [error, setError] = useState(""),
    [severities, setSeverities] = useState(defaultSeverities),
    [busy, setBusy] = useState(false),
    [assetOffset, setAssetOffset] = useState(0),
    [historyOffset, setHistoryOffset] = useState(0);
  const pending = useRef<
    { assetId: string; snapshotId: string; idempotencyKey: string } | undefined
  >(undefined);
  const submission = useRef<AbortController | undefined>(undefined);
  const submitting = useRef(false);
  const base = `/customers/${props.customerId}`;
  function fail(e: unknown) {
    if (e instanceof ApiError && e.status === 401) props.onUnauthorized();
    else setError((e as Error).message);
  }
  useEffect(() => {
    if (props.assetId) return;
    const c = new AbortController();
    api<AssetPage>(
      `${base}/assets?limit=100&offset=${assetOffset}`,
      props.token,
      {},
      c.signal,
    )
      .then(setAssets)
      .catch((e) => {
        if (!c.signal.aborted) fail(e);
      });
    return () => c.abort();
  }, [base, props.token, props.assetId, assetOffset]);
  useEffect(() => {
    setHistoryOffset(0);
    setJob(undefined);
    setHistory(undefined);
    setError("");
    setBusy(false);
    submitting.current = false;
    pending.current = undefined;
    return () => submission.current?.abort();
  }, [asset, base, props.token]);
  useEffect(() => {
    if (!asset) return;
    const c = new AbortController();
    async function refresh() {
      const h = await api<AssessmentPage>(
        `${base}/assessments?targetKind=linux&targetId=${asset}&limit=20&offset=${historyOffset}`,
        props.token,
        {},
        c.signal,
      );
      if (!c.signal.aborted) setHistory(h);
    }
    void refresh().catch((e) => {
      if (!c.signal.aborted) fail(e);
    });
    return () => c.abort();
  }, [base, props.token, asset, job?.id, job?.status, historyOffset]);

  async function findingsPage(offset: number, levels = severities) {
    if (!job) return;
    try {
      setJob(
        await api<Assessment>(
          `${base}/assessments/${job.id}?findingsOffset=${offset}&severities=${levels.join(",")}`,
          props.token,
        ),
      );
    } catch (e) {
      fail(e);
    }
  }
  async function downloadEvidence() {
    if (!job) return;
    try {
      const full = await api<{ content: string }>(
        `${base}/assessments/${job.id}/report`,
        props.token,
      );
      const url = URL.createObjectURL(
        new Blob([full.content], { type: "application/json" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `trivy-${job.id}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      fail(e);
    }
  }
  async function submit() {
    if (submitting.current || !asset) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setJob(undefined);
    const c = new AbortController();
    submission.current = c;
    try {
      if (!pending.current) {
        const inputs = await api<Inputs>(
          `${base}/assessments/linux-inputs?assetId=${asset}&offset=0`,
          props.token,
          {},
          c.signal,
        );
        if (c.signal.aborted) return;
        const latest = inputs.items[0];
        if (!latest) throw Error("没有采集资料，请先执行资产基础采集。");
        if (!latest.supported)
          throw Error(
            `最新采集资料无法扫描：${latest.reason ?? "缺少Linux系统包资料"}。请重新采集后再扫描。`,
          );
        pending.current = {
          assetId: asset,
          snapshotId: latest.id,
          idempotencyKey: requestId(),
        };
      }
      const result = await api<Assessment>(
        `${base}/assessments`,
        props.token,
        { method: "POST", body: JSON.stringify(pending.current) },
        c.signal,
      );
      if (!c.signal.aborted) {
        pending.current = undefined;
        setJob(result);
      }
    } catch (e) {
      if (!c.signal.aborted) {
        if (e instanceof ApiError && e.status < 500)
          pending.current = undefined;
        fail(e);
      }
    } finally {
      if (submission.current === c) {
        submitting.current = false;
        if (!c.signal.aborted) setBusy(false);
      }
    }
  }
  return (
    <section className="software-page">
      <h2>Linux系统包CVE扫描</h2>
      <p>
        支持Debian/Ubuntu的已安装dpkg系统包。目标无需Trivy；后台只扫描最新采集资料中的发行版与包数据库，不扫描应用目录、容器、挂载卷或秘密。
      </p>
      {!props.assetId && (
        <>
          <label>
            扫描主机
            <select
              disabled={busy}
              value={asset}
              onChange={(e) => {
                setAsset(e.target.value);
              }}
            >
              <option value="">选择在管资产</option>
              {assets?.items.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
          <div className="pagination">
            <button
              disabled={!assetOffset}
              onClick={() => setAssetOffset(Math.max(0, assetOffset - 100))}
            >
              上一批主机
            </button>
            <button
              disabled={!assets || assetOffset + 100 >= assets.total}
              onClick={() => setAssetOffset(assetOffset + 100)}
            >
              下一批主机
            </button>
          </div>
        </>
      )}
      {error && <p role="alert">{error}</p>}
      {asset && (
        <div className="panel">
          <p>扫描时自动使用最新采集资料，不会重新采集主机。</p>
          <SeverityControls value={severities} onChange={setSeverities} />
          <button
            className="primary"
            disabled={
              busy || (!!job && ["queued", "running"].includes(job.status))
            }
            onClick={() => void submit()}
          >
            {busy || (!!job && ["queued", "running"].includes(job.status))
              ? "扫描中…"
              : "扫描"}
          </button>
          <div
            aria-label="扫描任务进度"
            className="panel"
            style={{ border: "2px solid #20735f", background: "#f0f8f5" }}
          >
            {!job && (
              <>
                <h3>{busy ? "正在准备扫描" : "等待开始扫描"}</h3>
                {busy && (
                  <progress
                    aria-label="扫描进度"
                    style={{ width: "100%", height: "1rem" }}
                  />
                )}
                <p>
                  {busy
                    ? "正在读取最新资料并提交任务…"
                    : "配置完成后点击“扫描”开始。"}
                </p>
              </>
            )}
            {job && (
              <AssessmentLiveStatus
                {...props}
                jobId={job.id}
                onComplete={async () => {
                  setJob(
                    await api<Assessment>(
                      `${base}/assessments/${job.id}?findingsOffset=0`,
                      props.token,
                    ),
                  );
                }}
              />
            )}
          </div>
          <p>
            扫描只读取资料，不确认基线或写回NetBox。过期库与不足的覆盖会在结果中披露。
          </p>
        </div>
      )}
      {history && (
        <div className="panel">
          <h3>本主机Linux扫描历史</h3>
          {!history.total && <p>尚未扫描</p>}
          <div className="pagination">
            <button
              disabled={!historyOffset}
              onClick={() => setHistoryOffset(Math.max(0, historyOffset - 20))}
            >
              上一批扫描
            </button>
            <span>共 {history.total} 项</span>
            <button
              disabled={historyOffset + 20 >= history.total}
              onClick={() => setHistoryOffset(historyOffset + 20)}
            >
              下一批扫描
            </button>
          </div>
          {history.items.map((h) => (
            <button
              key={h.id}
              onClick={() =>
                void api<Assessment>(
                  `${base}/assessments/${h.id}?findingsOffset=0`,
                  props.token,
                )
                  .then(setJob)
                  .catch(fail)
              }
            >
              {assessmentStatusLabels[job?.id === h.id ? job.status : h.status]}{" "}
              · {h.createdAt} · {h.id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}
      {job && (
        <AssessmentDetails
          key={job.id}
          job={job}
          onFindingsPage={(offset, levels) => void findingsPage(offset, levels)}
          selectedSeverities={severities}
          onSeveritiesChange={setSeverities}
          onDownloadEvidence={() => void downloadEvidence()}
        />
      )}
    </section>
  );
}
