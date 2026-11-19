import { useEffect, useRef, useState } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type { WindowsMaterial } from "../../../../../packages/contracts/windows";
import type {
  WindowsAssessment,
  WindowsRuleMaterial,
} from "../../../../../packages/contracts/windows-assessments";
import "./windows-assessments.css";
const states = {
  queued: "等待执行",
  running: "正在执行",
  succeeded: "执行成功",
  failed: "执行失败",
  unavailable: "不可用",
  timed_out: "超时",
  interrupted: "执行中断",
};
const evidenceLabels: Record<string, string> = {
  same_branch_build: "同分支 Build 达到修复版本",
  installed_exact_kb: "已安装公告指定 KB",
  qualified_supersedence: "已核实规则中的补丁替代链",
  source_declared_affected_build: "公告明确受影响的较低构建",
  lower_build_incomplete_evidence: "较低构建但证据不足",
  insufficient_evidence: "证据不足",
};
const applicability = {
  unknown: "未知",
  potentially_affected: "可能受影响",
  affected: "受影响",
  fixed: "已修复",
};
export function WindowsAssessmentsPage({
  customerId,
  token,
  onUnauthorized,
}: FeatureProps) {
  const [snapshots, setSnapshots] = useState<WindowsMaterial[]>([]),
    [rules, setRules] = useState<WindowsRuleMaterial[]>([]),
    [snapshotId, setSnapshotId] = useState(""),
    [ruleId, setRuleId] = useState(""),
    [file, setFile] = useState<File | null>(null),
    [history, setHistory] = useState<WindowsAssessment[]>([]),
    [job, setJob] = useState<WindowsAssessment>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [requestKey, setRequestKey] = useState(() => crypto.randomUUID());
  const abort = useRef(new AbortController()),
    selected = useRef<string | undefined>(undefined);
  const base = `/customers/${customerId}`;
  function call<T>(path: string, options: RequestInit = {}) {
    return api<T>(`${base}${path}`, token, options, abort.current.signal);
  }
  function fail(e: unknown) {
    if (abort.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError(e instanceof Error ? e.message : "请求失败");
  }
  async function refresh() {
    const list = await call<{ items: WindowsAssessment[] }>(
      "/assessments?limit=100&targetKind=windows",
    );
    setHistory(list.items.filter((x) => x.target.kind === "windows"));
    const id = selected.current;
    if (id) {
      const detail = await call<WindowsAssessment>(`/assessments/${id}`);
      if (selected.current === id) setJob(detail);
    }
  }
  useEffect(() => {
    abort.current = new AbortController();
    Promise.all([
      call<{ items: WindowsMaterial[] }>("/windows/imports").then((x) =>
        setSnapshots(x.items.filter((x) => !!x.snapshotId)),
      ),
      call<{ items: WindowsRuleMaterial[] }>("/windows/rules").then((x) =>
        setRules(x.items),
      ),
      refresh(),
    ]).catch(fail);
    const timer = setInterval(() => refresh().catch(fail), 1000);
    return () => {
      clearInterval(timer);
      abort.current.abort();
    };
  }, [customerId, token]);
  async function upload() {
    if (!file) return;
    setError("");
    setBusy(true);
    try {
      const content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(await file.arrayBuffer());
      const r = await call<WindowsRuleMaterial>("/windows/rules", {
        method: "POST",
        body: JSON.stringify({ fileName: file.name, content }),
      });
      setRuleId(r.id);
      setRules(
        (await call<{ items: WindowsRuleMaterial[] }>("/windows/rules")).items,
      );
      setRequestKey(crypto.randomUUID());
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  async function submit() {
    setError("");
    setBusy(true);
    try {
      const created = await call<WindowsAssessment>("/assessments", {
        method: "POST",
        body: JSON.stringify({
          snapshotId,
          ruleImportId: ruleId,
          idempotencyKey: requestKey,
        }),
      });
      selected.current = created.id;
      setJob(created);
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="windows-assessments">
      <h2>Windows 补丁证据评估</h2>
      <p>
        首片仅支持 Windows Server 2022 LTSC · Build 20348 ·
        x64。读取固定快照，按上传的来源规则离线评估；规则清单不代表完整或最新的
        Windows 漏洞库。
      </p>
      <div className="windows-assessments-input">
        <h3>准备源戳规则</h3>
        <p>
          JSON 必须附微软来源 URL、抓取时间、来源内容及
          SHA-256。系统校验内容哈希，上传内容真实性由操作人员核实。
        </p>
        <label>
          Windows 规则 JSON
          <input
            type="file"
            accept=".json"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>
        <button disabled={!file || busy} onClick={upload}>
          导入源戳规则
        </button>
        <h3>选择固定评估输入</h3>
        <label>
          主机快照
          <select
            value={snapshotId}
            onChange={(e) => {
              setSnapshotId(e.target.value);
              setRequestKey(crypto.randomUUID());
            }}
          >
            <option value="">请选择快照</option>
            {snapshots.map((s) => (
              <option key={s.id} value={s.snapshotId!}>
                {s.snapshot.hostname} · {s.snapshot.osBuild ?? "未知 Build"} /{" "}
                {s.snapshot.ubr ?? "未知 UBR"} ·{" "}
                {s.snapshot.collectedAt ?? "未知采集时间"} · {s.snapshotId}
              </option>
            ))}
          </select>
        </label>
        <label>
          Windows 规则版本
          <select
            value={ruleId}
            onChange={(e) => {
              setRuleId(e.target.value);
              setRequestKey(crypto.randomUUID());
            }}
          >
            <option value="">请选择规则</option>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fileName} · {r.rules.ruleVersion} ·{" "}
                {r.contentHash.slice(0, 12)}
              </option>
            ))}
          </select>
        </label>
        <button disabled={!snapshotId || !ruleId || busy} onClick={submit}>
          开始 Windows 评估
        </button>
        <button onClick={() => setRequestKey(crypto.randomUUID())}>
          新建评估请求
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <h3>Windows 评估历史</h3>
      {history.map((j) => (
        <button
          key={j.id}
          onClick={() => {
            selected.current = j.id;
            call<WindowsAssessment>(`/assessments/${j.id}`)
              .then(setJob)
              .catch(fail);
          }}
        >
          {j.createdAt} · {states[j.status]} · {j.id}
        </button>
      ))}
      {job && (
        <article>
          <h3>任务 {job.id}</h3>
          <p>{states[job.status]}</p>
          <p>
            客户 {job.customerId} · 资产 {job.target.assetId} · 快照{" "}
            {job.target.snapshotId}
          </p>
          <p>
            输入资料 {job.input.importId} · 哈希 {job.input.contentHash}
          </p>
          <p>
            规则资料 {job.input.ruleImportId} · 哈希 {job.input.ruleHash}
          </p>
          <p>
            执行 {job.startedAt ?? "尚未开始"} — {job.finishedAt ?? "尚未结束"}
          </p>
          {job.error && <p role="alert">{job.error}</p>}
          {job.result ? (
            <>
              <p>覆盖：部分 · {job.result.rules.scope}</p>
              {job.result.coverage.issues.map((i) => (
                <p key={i}>{i}</p>
              ))}
              <p>
                工具 {job.execution?.toolVersion} · 规则{" "}
                {job.result.rules.version} · 解析 {job.result.parserVersion}
              </p>
              <table>
                <thead>
                  <tr>
                    <th>CVE</th>
                    <th>严重程度</th>
                    <th>适用性</th>
                    <th>当前 Build</th>
                    <th>修复 Build / KB</th>
                    <th>判定依据</th>
                  </tr>
                </thead>
                <tbody>
                  {job.result.findings.map((f) => (
                    <tr key={f.id}>
                      <td>
                        <a href={f.primaryUrl} target="_blank" rel="noreferrer">
                          {f.vulnerabilityId}
                        </a>
                      </td>
                      <td>{f.severity}</td>
                      <td>{applicability[f.applicability]}</td>
                      <td>{f.installedVersion}</td>
                      <td>
                        {f.fixedVersion}
                        <br />
                        {f.evidence.fixedKbs.join(", ")}
                      </td>
                      <td>
                        {evidenceLabels[f.evidence.basis] ?? f.evidence.basis}
                        <br />
                        {f.evidence.matchedKb ?? "无已安装补丁匹配"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h4>规则来源</h4>
              {job.result.rules.sources.map((s) => (
                <p key={s.id}>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.id}
                  </a>{" "}
                  · 抓取 {s.retrievedAt} · SHA-256 {s.sha256} · 未联网核实
                </p>
              ))}
              <details>
                <summary>固定判定证据与补丁替代路径</summary>
                <pre>
                  {JSON.stringify(
                    job.result.findings.map((f) => ({
                      cve: f.vulnerabilityId,
                      applicability: f.applicability,
                      evidence: f.evidence,
                    })),
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          ) : (
            <p>尚无评估结果；不代表零发现。</p>
          )}
        </article>
      )}
    </section>
  );
}
