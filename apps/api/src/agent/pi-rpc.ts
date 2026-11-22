import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { AgentExecutionError } from "./errors";
import type { PiProcessConfig } from "./pi-process";
export type PiRpcConfig = Omit<
  PiProcessConfig,
  "artifactRoot" | "scriptPath" | "pythonExecutable"
>;
export type PiCapabilityRequest = {
  jobDir: string;
  requestFile: string;
  extension: string;
  skill: string;
  tools: string[];
  requiredTools: string[];
  parameterRecoveryTools?: string[];
  prompt: string;
};
export async function runPiCapability(
  config: PiRpcConfig,
  request: PiCapabilityRequest,
  emit: (type: string, message: string) => Promise<void>,
  signal: AbortSignal,
): Promise<void> {
  const args = [
    ...(config.prefixArgs ?? []),
    "--mode",
    "rpc",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-mcp",
    "--tools",
    request.tools.join(","),
    "-e",
    request.extension,
    "--skill",
    request.skill,
    ...(config.provider ? ["--provider", config.provider] : []),
    ...(config.model ? ["--model", config.model] : []),
  ];
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: request.jobDir,
    XDG_CONFIG_HOME: join(request.jobDir, "config"),
    PI_CODING_AGENT_DIR: join(request.jobDir, "pi"),
    YS_AGENT_REQUEST_FILE: request.requestFile,
    ...config.env,
  };
  for (const key of [
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
  ])
    if (process.env[key] && !env[key]) env[key] = process.env[key]!;
  const terminal = config.terminalEvent ?? "agent_settled";
  await new Promise<void>((ok, fail) => {
    if (signal.aborted) {
      fail(new AgentExecutionError("timed_out", "Pi 任务已中止"));
      return;
    }
    const child = spawn(config.executable, args, {
      cwd: request.jobDir,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let finished = false,
      buffer = "",
      bytes = 0,
      accepted = false;
    const started = new Map<string, string>();
    const completed = new Set<string>();
    const ended = new Set<string>();
    let parameterErrors = 0;
    let events = Promise.resolve();
    const commandId = randomUUID();
    const kill = () => {
      try {
        if (child.pid && process.platform !== "win32")
          process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {}
    };
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      kill();
      events.then(
        () => (error ? fail(error) : ok()),
        () => fail(new AgentExecutionError("failed", "工具事件保存失败")),
      );
    };
    const event = (type: string, message: string) => {
      events = events.then(() => emit(type, message));
    };
    const abort = () =>
      finish(
        new AgentExecutionError("timed_out", "Pi 任务超时或被中止；未自动重试"),
      );
    const timer = setTimeout(abort, config.timeoutMs ?? 60000);
    signal.addEventListener("abort", abort, { once: true });
    child.on("error", () =>
      finish(new AgentExecutionError("unavailable", "Pi 可执行程序不可用")),
    );
    child.stderr.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 5_000_000)
        finish(new AgentExecutionError("failed", "Pi 输出超出限制"));
    });
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > 5_000_000) {
        finish(new AgentExecutionError("failed", "Pi 输出超出限制"));
        return;
      }
      buffer += chunk.toString("utf8");
      let at: number;
      while ((at = buffer.indexOf("\n")) >= 0 && !finished) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let message: any;
        try {
          message = JSON.parse(line);
        } catch {
          finish(new AgentExecutionError("failed", "Pi RPC 返回非 JSON 消息"));
          return;
        }
        if (message.type === "response" && message.id === commandId) {
          if (message.success !== true) {
            finish(new AgentExecutionError("failed", "Pi 拒绝查询请求"));
            return;
          }
          accepted = true;
          event("accepted", "Pi 已接受请求，尚未完成");
        }
        if (message.type === "tool_execution_start") {
          if (!request.tools.includes(message.toolName)) {
            finish(new AgentExecutionError("failed", "Pi 请求了未授权工具"));
            return;
          }
          if (
            typeof message.toolCallId !== "string" ||
            started.has(message.toolCallId)
          ) {
            finish(new AgentExecutionError("failed", "工具调用编号无效"));
            return;
          }
          started.set(message.toolCallId, message.toolName);
          event("tool_started", `工具 ${message.toolName} 开始执行`);
        }
        if (message.type === "tool_execution_end") {
          if (
            !request.tools.includes(message.toolName) ||
            started.get(message.toolCallId) !== message.toolName ||
            ended.has(message.toolCallId)
          ) {
            finish(new AgentExecutionError("failed", "工具结束事件与调用不符"));
            return;
          }
          ended.add(message.toolCallId);
          if (message.isError) {
            completed.delete(message.toolName);
            const text = Array.isArray(message.result?.content)
              ? message.result.content.find(
                  (c: { type?: string; text?: unknown }) =>
                    c.type === "text" && typeof c.text === "string",
                )?.text
              : undefined;
            const parameterError =
              typeof text === "string" &&
              (text.startsWith(
                `Invalid arguments for tool "${message.toolName}":`,
              ) ||
                text.startsWith(
                  `Validation failed for tool "${message.toolName}":`,
                ));
            if (
              parameterError &&
              request.parameterRecoveryTools?.includes(message.toolName)
            ) {
              parameterErrors++;
              if (parameterErrors <= 2) {
                event(
                  "tool_arguments_invalid",
                  `工具 ${message.toolName} 参数格式不符，等待模型修正（${parameterErrors}/2）`,
                );
                continue;
              }
              finish(
                new AgentExecutionError(
                  "failed",
                  "工具参数连续校验失败，请重新解析",
                ),
              );
            } else {
              event(
                "tool_failed",
                parameterError
                  ? "工具参数校验失败"
                  : "固定工具执行失败；未取得有效产物",
              );
              finish(new AgentExecutionError("failed", "固定工具执行失败"));
            }
            return;
          }
          completed.add(message.toolName);
          event(
            "tool_completed",
            `工具 ${message.toolName} 已完成，等待 Pi 结束`,
          );
        }
        if (message.type === terminal) {
          if (
            !accepted ||
            [...started.keys()].some((id) => !ended.has(id)) ||
            request.requiredTools.some((tool) => !completed.has(tool))
          ) {
            finish(
              new AgentExecutionError(
                "failed",
                "Pi 结束但没有成功执行固定查询工具",
              ),
            );
            return;
          }
          event(terminal, "Pi 任务结束，核验固定脚本输出");
          finish();
        }
      }
    });
    child.on("close", () => {
      if (!finished)
        finish(new AgentExecutionError("failed", "Pi 在任务完成前退出"));
    });
    child.stdin.on("error", () =>
      finish(new AgentExecutionError("failed", "Pi 请求通道关闭")),
    );
    child.stdin.write(
      JSON.stringify({
        id: commandId,
        type: "prompt",
        message: request.prompt,
      }) + "\n",
    );
  });
}
