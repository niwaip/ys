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
  const [status, setStatus] = useState<AssessmentStatus>();
  const [message, setMessage] = useState("正在读取任务状态…");
  useEffect(() => {
    box.current?.scrollIntoView({ block: "center", behavior: "smooth" });
    setStatus(undefined);
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    async function connect() {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        setMessage("正在读取任务状态…");
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
            setMessage(
              status === "succeeded"
                ? "扫描完成，结果已生成。"
                : status === "running"
                  ? "正在扫描，请稍候…"
                  : status === "queued"
                    ? "任务已提交，正在排队…"
                    : assessmentStatusLabels[status],
            );
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
  const ended = !!status && !["queued", "running"].includes(status);
  const succeeded = status === "succeeded";
  return (
    <div ref={box}>
      <h3>
        {succeeded
          ? "扫描完成"
          : ended
            ? "扫描未完成"
            : status === "queued"
              ? "正在排队"
              : "正在扫描"}
      </h3>
      <progress
        aria-label="扫描进度"
        max={100}
        value={ended ? (succeeded ? 100 : 0) : undefined}
        style={{
          width: "100%",
          height: "1.25rem",
          accentColor: succeeded ? "#17604c" : ended ? "#a32929" : "#20735f",
        }}
      />
      <p role="status" aria-live="polite">
        {message}
      </p>
    </div>
  );
}
