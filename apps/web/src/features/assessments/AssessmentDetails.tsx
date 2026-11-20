import { useState } from "react";
import type { Assessment } from "../../../../../packages/contracts/assessments";
export const assessmentStatusLabels = {
  queued: "等待执行",
  running: "正在执行",
  succeeded: "执行成功",
  failed: "执行失败",
  unavailable: "工具或数据库不可用",
  timed_out: "执行超时",
  interrupted: "执行中断",
};
const coverageLabels = {
  complete_for_declared_input: "已覆盖声明组件",
  partial: "部分覆盖",
  unknown: "覆盖未知",
};
const freshLabels = {
  fresh: "库时间有效",
  stale: "漏洞数据库已过期",
  unknown: "库时间未知",
};

export function AssessmentDetails({
  job,
  onFindingsPage,
  onDownloadEvidence,
}: {
  job: Assessment;
  onFindingsPage?: (offset: number) => void;
  onDownloadEvidence?: () => void;
}) {
  const labels = assessmentStatusLabels;
  const [page, setPage] = useState(0);
  const pageSize = 50;
  const total = job.findingsPage?.total ?? job.result?.findings.length ?? 0;
  const currentPage = job.findingsPage
    ? Math.floor(job.findingsPage.offset / pageSize)
    : Math.min(
        page,
        Math.max(
          0,
          Math.ceil((job.result?.findings.length ?? 0) / pageSize) - 1,
        ),
      );
  return (
    <div className="panel">
      <h2>任务详情</h2>
      <p>
        状态：<strong>{labels[job.status]}</strong>
      </p>
      <p>任务编号：{job.id}</p>
      <p>
        对象（{job.target.kind}）：
        {job.target.kind === "software"
          ? job.target.softwareId
          : job.target.kind === "container"
            ? job.target.containerId
            : job.target.assetId}{" "}
        · 输入版本：{job.target.versionId}
      </p>
      <p>
        来源资料：{job.input.importId} · SHA-256：{job.input.contentHash}
      </p>
      <p>
        开始：{job.startedAt ?? "未开始"} · 完成：
        {job.finishedAt ?? "未完成"}
      </p>
      {job.input.scope && <p>{job.input.scope}</p>}
      {job.error && <p role="alert">{job.error}</p>}
      {!job.result && <p>尚无有效评估结果；不可解读为零发现。</p>}
      {job.result && (
        <>
          <h3>
            {job.result.outcome === "findings"
              ? `发现 ${total} 条漏洞记录`
              : "本次工具未报告漏洞"}
          </h3>
          <p>
            覆盖：{coverageLabels[job.result.coverage.status]}（
            {job.result.coverage.matchedComponents}/
            {job.result.coverage.inputComponents} 个声明组件） ·{" "}
            {freshLabels[job.result.database.freshness]}
          </p>
          <p>
            库更新：{job.result.database.updatedAt ?? "未知"} · 下次更新：
            {job.result.database.nextUpdate ?? "未知"}
          </p>
          {job.result.coverage.issues.map((issue, i) => (
            <p key={i}>{issue}</p>
          ))}
          <table>
            <thead>
              <tr>
                <th>组件 / 安装版本</th>
                <th>漏洞 / 严重程度</th>
                <th>修复与工具依据</th>
              </tr>
            </thead>
            <tbody>
              {job.result.findings
                .slice(
                  job.findingsPage ? 0 : currentPage * pageSize,
                  job.findingsPage ? pageSize : (currentPage + 1) * pageSize,
                )
                .map((f) => (
                  <tr key={f.id}>
                    <td>
                      {f.packageName}
                      <br />
                      {f.installedVersion}
                      <p>
                        {f.ecosystem} · {f.target}
                      </p>
                      <p>
                        {f.componentId ? "已关联输入组件" : "无法唯一关联组件"}
                      </p>
                    </td>
                    <td>
                      <strong>{f.vulnerabilityId}</strong>
                      <p>{f.severity}</p>
                    </td>
                    <td>
                      <p>
                        工具报告修复版本：
                        {f.fixedVersion ?? "未知，不能据此认定无补丁"}
                      </p>
                      <p>适用性：工具报告；未人工改判</p>
                      {f.primaryUrl && /^https?:\/\//.test(f.primaryUrl) && (
                        <a href={f.primaryUrl} target="_blank" rel="noreferrer">
                          工具来源
                        </a>
                      )}
                      <details>
                        <summary>漏洞原始证据</summary>
                        <pre>{JSON.stringify(f.evidence, null, 2)}</pre>
                      </details>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <div className="pagination">
            <button
              disabled={!currentPage}
              onClick={() =>
                onFindingsPage
                  ? onFindingsPage((currentPage - 1) * pageSize)
                  : setPage(currentPage - 1)
              }
            >
              上一页漏洞
            </button>
            <span>
              第 {currentPage + 1} 页 · 共 {total} 条
            </span>
            <button
              disabled={(currentPage + 1) * pageSize >= total}
              onClick={() =>
                onFindingsPage
                  ? onFindingsPage((currentPage + 1) * pageSize)
                  : setPage(currentPage + 1)
              }
            >
              下一页漏洞
            </button>
          </div>
        </>
      )}
      {job.execution && (
        <>
          <h3>执行证据</h3>
          <p>
            Trivy：{job.execution.toolVersion ?? "版本未知"} · 退出码：
            {job.execution.exitCode ?? "未知"} · 信号：
            {job.execution.signal ?? "无"}
          </p>
          <details>
            <summary>命令、数据库与标准错误</summary>
            <pre>
              {JSON.stringify(
                { ...job.execution, rawReport: undefined },
                null,
                2,
              )}
            </pre>
          </details>
          {job.execution.outputHash && (
            <p>报告 SHA-256：{job.execution.outputHash}</p>
          )}
          {onDownloadEvidence && job.execution.outputHash && (
            <button onClick={onDownloadEvidence}>下载原始Trivy报告</button>
          )}
          {job.execution.rawReport && (
            <details>
              <summary>原始 Trivy 报告</summary>
              <pre>
                {job.execution.rawReport.slice(0, 20000)}
                {job.execution.rawReport.length > 20000
                  ? "\n页面仅预览前20000字符；完整证据保存在任务中。"
                  : ""}
              </pre>
            </details>
          )}
        </>
      )}
    </div>
  );
}
