import { useEffect, useState } from "react";
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
    [inputs, setInputs] = useState<Inputs>(),
    [snapshot, setSnapshot] = useState(""),
    [job, setJob] = useState<Assessment>(),
    [history, setHistory] = useState<AssessmentPage>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [offset, setOffset] = useState(0),
    [assetOffset, setAssetOffset] = useState(0),
    [historyOffset, setHistoryOffset] = useState(0),
    [idempotencyKey, setIdempotencyKey] = useState(requestId);
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
    setIdempotencyKey(requestId());
  }, [asset, snapshot]);
  useEffect(() => {
    setHistoryOffset(0);
  }, [asset]);
  useEffect(() => {
    setInputs(undefined);
    setHistory(undefined);
    setSnapshot("");
    setJob(undefined);
    setError("");
    if (!asset) return;
    const c = new AbortController();
    api<Inputs>(
      `${base}/assessments/linux-inputs?assetId=${asset}&offset=${offset}`,
      props.token,
      {},
      c.signal,
    )
      .then(setInputs)
      .catch((e) => {
        if (!c.signal.aborted) fail(e);
      });
    return () => c.abort();
  }, [base, props.token, asset, offset]);
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
      if (job && ["queued", "running"].includes(job.status)) {
        const v = await api<Assessment>(
          `${base}/assessments/${job.id}?findingsOffset=0`,
          props.token,
          {},
          c.signal,
        );
        if (!c.signal.aborted) setJob(v);
      }
    }
    void refresh().catch((e) => {
      if (!c.signal.aborted) fail(e);
    });
    const timer = setInterval(
      () =>
        void refresh().catch((e) => {
          if (!c.signal.aborted) fail(e);
        }),
      1500,
    );
    return () => {
      c.abort();
      clearInterval(timer);
    };
  }, [base, props.token, asset, job?.id, job?.status, historyOffset]);
  async function findingsPage(offset: number) {
    if (!job) return;
    try {
      setJob(
        await api<Assessment>(
          `${base}/assessments/${job.id}?findingsOffset=${offset}`,
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
      const full = await api<Assessment>(
        `${base}/assessments/${job.id}`,
        props.token,
      );
      if (!full.execution?.rawReport) throw new Error("原始报告不可用");
      const url = URL.createObjectURL(
        new Blob([full.execution.rawReport], { type: "application/json" }),
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
    setBusy(true);
    setError("");
    try {
      setJob(
        await api<Assessment>(`${base}/assessments`, props.token, {
          method: "POST",
          body: JSON.stringify({
            assetId: asset,
            snapshotId: snapshot,
            idempotencyKey,
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
    <section className="software-page">
      <h2>Linux系统包CVE扫描</h2>
      <p>
        支持Debian/Ubuntu的已安装dpkg系统包。目标无需Trivy；后台只扫描固定快照的发行版与包数据库，不扫描应用目录、容器、挂载卷或秘密。
      </p>
      {!props.assetId && (
        <>
          <label>
            扫描主机
            <select
              value={asset}
              onChange={(e) => {
                setAsset(e.target.value);
                setOffset(0);
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
          <label>
            Linux采集快照
            <select
              value={snapshot}
              onChange={(e) => setSnapshot(e.target.value)}
            >
              <option value="">选择固定采集版本</option>
              {inputs?.items.map((s) => (
                <option key={s.id} value={s.id} disabled={!s.supported}>
                  {s.importedAt} ·{" "}
                  {s.supported
                    ? `${s.os?.id} ${s.os?.version} · ${s.packages}包`
                    : s.reason}
                </option>
              ))}
            </select>
          </label>
          {!inputs?.items.some((s) => s.supported) && (
            <p>
              尚无可扫描资料；请在资产采集重新执行基础采集，取得完整dpkg数据库。
            </p>
          )}
          <div className="pagination">
            <button
              disabled={!offset}
              onClick={() => setOffset(Math.max(0, offset - 20))}
            >
              上一批快照
            </button>
            <button
              disabled={!inputs || offset + 20 >= inputs.total}
              onClick={() => setOffset(offset + 20)}
            >
              下一批快照
            </button>
          </div>
          <button
            className="primary"
            disabled={busy || !snapshot}
            onClick={() => void submit()}
          >
            扫描所选Linux快照
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setIdempotencyKey(requestId());
              setJob(undefined);
            }}
          >
            建立新扫描请求
          </button>
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
              {assessmentStatusLabels[h.status]} · {h.createdAt} ·{" "}
              {h.id.slice(0, 8)}
            </button>
          ))}
        </div>
      )}
      {job && (
        <AssessmentDetails
          key={job.id}
          job={job}
          onFindingsPage={(offset) => void findingsPage(offset)}
          onDownloadEvidence={() => void downloadEvidence()}
        />
      )}
    </section>
  );
}
