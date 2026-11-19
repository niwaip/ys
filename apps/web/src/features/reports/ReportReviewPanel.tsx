import { useEffect, useRef, useState } from "react";
import type {
  Report,
  ReportRevision,
  ReportNarrative,
  ReportAudit,
} from "../../../../../packages/contracts/reports";
import { api, ApiError } from "../../api";
import type { FeatureProps } from "../../features";
export function ReportReviewPanel({
  report,
  customerId,
  token,
  onUnauthorized,
  onRevision,
}: FeatureProps & {
  report: Report;
  onRevision: (revision: ReportRevision) => Promise<void>;
}) {
  const [narrative, setNarrative] = useState(report.revision.narrative),
    [revisions, setRevisions] = useState<ReportRevision[]>([]),
    [audit, setAudit] = useState<ReportAudit[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const controller = useRef(new AbortController());
  const base = `/customers/${customerId}/reports/${report.id}`;
  const call = <T,>(path: string, options: RequestInit = {}) =>
    api<T>(path, token, options, controller.current.signal);
  function fail(e: unknown) {
    if (controller.current.signal.aborted) return;
    if (e instanceof ApiError && e.status === 401) onUnauthorized();
    else setError((e as Error).message);
  }
  useEffect(() => {
    controller.current = new AbortController();
    setBusy(false);
    setNarrative(report.revision.narrative);
    Promise.all([
      call<{ items: ReportRevision[] }>(`${base}/revisions`),
      call<{ items: ReportAudit[] }>(`${base}/audit`),
    ])
      .then(([v, a]) => {
        setRevisions(v.items);
        setAudit(a.items);
      })
      .catch(fail);
    return () => controller.current.abort();
  }, [report.id, report.revision.id, report.revision.status]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      fail(e);
    } finally {
      if (!controller.current.signal.aborted) setBusy(false);
    }
  }
  async function transition(action: "submit-review" | "approve" | "deliver") {
    await call(`${base}/revisions/${report.revision.id}/${action}`, {
      method: "POST",
      body: "{}",
    });
    const current = await call<Report>(base);
    await onRevision(current.revision);
  }
  function move(index: number, delta: number) {
    const blocks = [...narrative.blocks];
    [blocks[index], blocks[index + delta]] = [
      blocks[index + delta],
      blocks[index],
    ];
    setNarrative({ ...narrative, blocks });
  }
  async function download() {
    const response = await fetch(
      `/api${base}/revisions/${report.revision.id}/export`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.current.signal,
      },
    );
    if (!response.ok) throw new ApiError("正式HTML尚未可用", response.status);
    const url = URL.createObjectURL(await response.blob());
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `ys-report-${report.id}-r${report.revision.number}.html`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section>
      <h3>内部复核与受控编辑</h3>
      <p>
        只编辑受控表述、结构和呈现，事实与判定保持保护。保存后产生新草稿，必须重新复核。当前修订{" "}
        {report.revision.number}：<strong>{report.revision.status}</strong>。
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <label>
        版面密度
        <select
          value={narrative.density}
          disabled={busy}
          onChange={(e) =>
            setNarrative({
              ...narrative,
              density: e.target.value as ReportNarrative["density"],
            })
          }
        >
          <option value="standard">标准</option>
          <option value="compact">紧凑</option>
        </select>
      </label>
      {narrative.blocks.map((block, index) => (
        <div key={`${block.templateId}:${block.factRef ?? ""}`}>
          <label>
            {block.templateId} {block.factRef ?? ""} 措辞
            <select
              value={block.wording}
              disabled={busy}
              onChange={(e) =>
                setNarrative({
                  ...narrative,
                  blocks: narrative.blocks.map((b, i) =>
                    i === index
                      ? {
                          ...b,
                          wording: e.target.value as "standard" | "concise",
                        }
                      : b,
                  ),
                })
              }
            >
              <option value="standard">标准表述</option>
              <option value="concise">简洁表述</option>
            </select>
          </label>
          <button
            disabled={busy || index === 0}
            onClick={() => move(index, -1)}
          >
            上移 {block.templateId}
          </button>
          <button
            disabled={busy || index === narrative.blocks.length - 1}
            onClick={() => move(index, 1)}
          >
            下移 {block.templateId}
          </button>
        </div>
      ))}
      <button
        disabled={busy}
        onClick={() =>
          run(async () =>
            onRevision(
              await call<ReportRevision>(`${base}/revisions`, {
                method: "POST",
                body: JSON.stringify({
                  baseRevisionId: report.revision.id,
                  narrative,
                }),
              }),
            ),
          )
        }
      >
        保存为新草稿
      </button>
      <div>
        <button
          disabled={busy || report.revision.status !== "draft"}
          onClick={() => run(() => transition("submit-review"))}
        >
          提交复核
        </button>
        <button
          disabled={busy || report.revision.status !== "in_review"}
          onClick={() => run(() => transition("approve"))}
        >
          复核通过
        </button>
        <button
          disabled={busy || report.revision.status !== "approved"}
          onClick={() => run(() => transition("deliver"))}
        >
          正式交付该修订
        </button>
        <button
          disabled={busy || report.revision.status !== "delivered"}
          onClick={() => run(download)}
        >
          下载正式 HTML
        </button>
      </div>
      <h3>修订历史</h3>
      {revisions.map((v) => (
        <p key={v.id}>
          <button disabled={busy} onClick={() => run(() => onRevision(v))}>
            修订 {v.number} · {v.status}
          </button>{" "}
          · {v.createdBy} · {v.createdAt}
        </p>
      ))}
      <h3>操作审计</h3>
      <p>
        建档：{report.createdBy} · {report.createdAt}
      </p>
      {audit.map((event) => (
        <p key={event.id}>
          {event.action} · {event.actor.name} · {event.createdAt} · 修订{" "}
          {event.revisionId}
        </p>
      ))}
    </section>
  );
}
