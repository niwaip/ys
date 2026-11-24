import { useEffect, useRef } from "react";
import type { FeatureProps } from "../../features";
import type { VulnerabilityFinding } from "../../../../../packages/contracts/assessments";
import { FindingEvidenceDetails } from "./FindingEvidenceDetails";
export function FindingSourcePanel({
  finding,
  assessmentId,
  context,
  scannedAt,
  onClose,
}: {
  finding: VulnerabilityFinding;
  assessmentId: string;
  context?: FeatureProps;
  scannedAt?: string;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="finding-dialog"
      aria-label="漏洞来源与依据"
      onCancel={onClose}
      onClose={onClose}
    >
      <header className="analysis-header">
        <div>
          <h2>漏洞来源与依据</h2>
          <p>
            {finding.vulnerabilityId} · {finding.packageName}
          </p>
        </div>
        <button aria-label="关闭来源详情" onClick={onClose}>
          ×
        </button>
      </header>
      <div className="analysis-body">
        <p>以下是已保存的扫描摘要与匹配依据，未重新抓取完整来源原文。</p>
        <p>
          扫描完成时间：
          {scannedAt ? new Date(scannedAt).toLocaleString("zh-CN") : "未知"}
          。该时间不代表来源网页的最新更新时间。
        </p>
        <FindingEvidenceDetails
          finding={finding}
          assessmentId={assessmentId}
          context={context}
          initialOpen
        />
        {finding.primaryUrl && /^https?:\/\//i.test(finding.primaryUrl) ? (
          <p>
            <a href={finding.primaryUrl} target="_blank" rel="noreferrer">
              打开来源原文 ↗
            </a>
          </p>
        ) : (
          <p>扫描结果未提供可访问的来源链接。</p>
        )}
      </div>
    </dialog>
  );
}
