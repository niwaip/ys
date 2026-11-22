import { useEffect, useRef, useState } from "react";
import type { FeatureProps } from "../../features";
import { assessmentStatusLabels } from "./AssessmentDetails";
import type { AssessmentStatus } from "../../../../../packages/contracts/assessments";

// Fetch streaming keeps bearer credentials in headers, unlike native EventSource URLs.
export function AssessmentLiveStatus({
  customerId,
  token,
  onUnauthorized,
  jobId,
  onComplete,
}: FeatureProps & { jobId: string; onComplete: () => Promise<void> }) {
  const complete = useRef(onComplete);
  complete.current = onComplete;
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const box = useRef<HTMLDivElement>(null);
  const [sawRunning, setSawRunning] = useState(false);
  const [status, setStatus] = useState<AssessmentStatus>();
  const [message, setMessage] = useState("连接实时状态…");
  useEffect(() => {
    box.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    setStatus(undefined);
    setSawRunning(false);
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    async function connect() {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        setMessage("连接实时状态…");
        const response = await fetch(
          `/api/customers/${customerId}/assessments/${jobId}/events`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "text/event-stream",
            },
            signal: controller.signal,
          },
        );
        if (response.status === 401) {
          unauthorized.current();
          return;
        }
        if (response.status === 403 || response.status === 404) {
          setMessage("任务不存在或无权访问；请重新选择客户和任务");
          return;
        }
        if (!response.ok || !response.body) throw Error("实时连接不可用");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder
            .decode(value, { stream: true })
            .replaceAll("\r\n", "\n");
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const event = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            if (!event.startsWith("event: progress\n")) continue;
            const data = JSON.parse(
              event
                .split("\n")
                .filter((l) => l.startsWith("data: "))
                .map((l) => l.slice(6))
                .join("\n"),
            );
            if (data.id !== jobId || !(data.status in assessmentStatusLabels))
              throw Error("实时状态无效");
            const status = data.status as AssessmentStatus;
            setStatus(status);
            if (status === "running") setSawRunning(true);
            setMessage(assessmentStatusLabels[status]);
            if (!["queued", "running"].includes(status)) {
              await complete.current();
              return;
            }
          }
        }
        throw Error("实时连接已断开");
      } catch {
        if (!controller.signal.aborted) {
          setMessage("连接中断，正在重连；扫描仍在后台执行");
          retry = setTimeout(() => void connect(), 2000);
        }
      } finally {
        await reader?.cancel().catch(() => {});
      }
    }
    void connect();
    return () => {
      controller.abort();
      if (retry) clearTimeout(retry);
    };
  }, [customerId, token, jobId]);
  const stage = !status
    ? 0
    : status === "queued"
      ? 1
      : status === "running"
        ? 2
        : 3;
  return (
    <div ref={box}>
      <ol
        aria-label="扫描阶段"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "1.5rem",
          paddingLeft: "1.5rem",
        }}
      >
        {[
          "任务已提交",
          "排队等待",
          "正在扫描",
          status === "succeeded"
            ? "扫描完成"
            : stage === 3
              ? "任务已结束"
              : "等待结果",
        ].map((label, i) => (
          <li
            key={i}
            aria-current={stage === i ? "step" : undefined}
            style={{
              fontWeight: stage === i ? 700 : 400,
              color: i <= stage ? "#17604c" : "#64746e",
            }}
          >
            {i < stage && (i !== 2 || status === "succeeded" || sawRunning)
              ? "✓ "
              : stage === i && stage < 3
                ? "● "
                : ""}
            {label}
          </li>
        ))}
      </ol>
      <p role="status" aria-live="polite">
        实时状态（SSE）：{message}
      </p>
    </div>
  );
}
