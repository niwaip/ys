import type {
  Assessment,
  AssessmentSummary,
} from "../../../../../packages/contracts/assessments";
import { assessmentStatusLabels } from "./AssessmentDetails";
export function AssessmentHistoryTable({
  items,
  job,
  onSelect,
  busy = false,
  prefix = "",
}: {
  items: AssessmentSummary[];
  job?: Assessment;
  onSelect: (id: string) => void;
  busy?: boolean;
  prefix?: string;
}) {
  return (
    <div className="findings-table-scroll history-scroll">
      <table className="scan-history-table">
        <thead>
          <tr>
            <th>扫描时间</th>
            <th>状态</th>
            <th>漏洞记录</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {items.map((h) => {
            const status =
              assessmentStatusLabels[job?.id === h.id ? job.status : h.status];
            return (
              <tr key={h.id}>
                <td>{new Date(h.createdAt).toLocaleString("zh-CN")}</td>
                <td>{status}</td>
                <td>{h.findingCount ?? "—"}</td>
                <td>
                  <button
                    disabled={busy}
                    aria-current={job?.id === h.id ? "true" : undefined}
                    aria-label={`${prefix}${status} · ${new Date(h.createdAt).toLocaleString("zh-CN")}`}
                    onClick={() => onSelect(h.id)}
                  >
                    {job?.id === h.id ? "当前结果" : "查看结果"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
