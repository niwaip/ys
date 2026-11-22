import { useEffect, useState } from "react";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
import type { VulnerabilityFinding } from "../../../../../packages/contracts/assessments";
import type { FindingEvidence } from "../../../../../packages/contracts/finding-context";

export function FindingEvidenceDetails({
  finding,
  assessmentId,
  context,
}: {
  finding: VulnerabilityFinding;
  assessmentId: string;
  context?: FeatureProps;
}) {
  const [open, setOpen] = useState(false),
    [evidence, setEvidence] = useState<FindingEvidence>(),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open || !context || evidence) return;
    setError("");
    const c = new AbortController();
    api<FindingEvidence>(
      `/customers/${context.customerId}/assessments/${assessmentId}/findings/${finding.id}/evidence`,
      context.token,
      {},
      c.signal,
    )
      .then(setEvidence)
      .catch((e) => {
        if (c.signal.aborted) return;
        if (e instanceof ApiError && e.status === 401) context.onUnauthorized();
        else setError((e as Error).message);
      });
    return () => c.abort();
  }, [open, context?.customerId, context?.token, assessmentId, finding.id]);
  return (
    <details onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>查看证据</summary>
      <p>
        扫描匹配：{finding.packageName} · {finding.installedVersion}
      </p>
      <p>
        适用性：
        {evidence?.applicability.status === "conditions_not_met"
          ? "采集时未发现适用条件"
          : "证据不足，尚未确认受影响"}
      </p>
      {error && <p role="alert">证据读取失败：{error}</p>}
      {open && context && !evidence && !error && (
        <p role="status">正在读取匹配依据…</p>
      )}
      {evidence && (
        <>
          <p>匹配依据：{evidence.basis}</p>
          <p>
            源码包：{evidence.sourcePackage ?? "扫描结果未提供"}
            {evidence.sourceVersion ? ` · ${evidence.sourceVersion}` : ""}
          </p>
          <p>
            情报来源：{evidence.source?.name ?? "扫描结果未提供"} · 原始状态：
            {evidence.scannerStatus ?? "未知"}
          </p>
          {evidence.title && <p>漏洞说明：{evidence.title}</p>}
          <p>{evidence.applicability.reason}</p>
          <p>
            运行内核：
            {evidence.runtime?.kernel ?? "未采集，不能用安装包版本推断"}
          </p>
          <p>
            虚拟化类型：
            {evidence.runtime?.virtualization?.status === "acquired"
              ? evidence.runtime.virtualization.data
              : "未取得"}{" "}
            · xen-netback：
            {evidence.runtime?.xenNetback?.status === "acquired"
              ? evidence.runtime.xenNetback.data === true
                ? "发现"
                : evidence.runtime.xenNetback.data === false
                  ? "未发现"
                  : "未知"
              : "未取得"}
          </p>
          <p>
            资料来源：{evidence.runtime?.origin ?? "未知"} · 环境采集时间：
            {evidence.runtime?.collectedAt
              ? new Date(evidence.runtime.collectedAt).toLocaleString("zh-CN")
              : "未知，不能代表当前环境"}
          </p>
          <details>
            <summary>漏洞原始说明</summary>
            <p>{evidence.description ?? "扫描结果未提供"}</p>
          </details>
        </>
      )}
      <details>
        <summary>技术追溯信息</summary>
        <p>
          扫描器目标：{finding.target}（可能是扫描临时目录，不代表漏洞文件位置）
        </p>
        <p>
          {finding.componentId
            ? "已关联输入组件；关联不等于确认受影响"
            : "无法唯一关联输入组件"}
        </p>
        <p>报告哈希用于校验原件；结果与漏洞索引从 0 开始计数。</p>
        <pre>{JSON.stringify(finding.evidence, null, 2)}</pre>
      </details>
    </details>
  );
}
