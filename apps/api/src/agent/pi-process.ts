import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AgentExecutionError, type PublicQueryExecutor } from "./agent.module";
import type { PublicIntelligenceResult } from "../../../../packages/contracts/agent";
export type PiProcessConfig = {
  executable: string;
  prefixArgs?: string[];
  artifactRoot: string;
  scriptPath: string;
  pythonExecutable: string;
  timeoutMs?: number;
  terminalEvent?: "agent_settled" | "agent_end";
  provider?: string;
  model?: string;
  env?: Record<string, string>;
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const object = z.record(z.string(), z.unknown());
const documentSchema = z.object({
  schema_version: z.literal("2.2"),
  status: z.enum(["complete_for_declared_sources", "partial", "unavailable"]),
  query: object,
  coverage: object,
  sources: z.array(object),
  agent_view: z.object({
    scope: z.string(),
    summary: z.string(),
    results: z.array(object),
  }),
  target_assessment: z.literal("not_assessed"),
  target_verification: z.literal("not_executed"),
});
/** Executes only the reviewed tool; the model's prose is never the result data. */
export class PiPublicQueryExecutor implements PublicQueryExecutor {
  constructor(private config: PiProcessConfig) {}
  async execute(
    input: { id: string; message: string },
    emit: Parameters<PublicQueryExecutor["execute"]>[1],
    signal: AbortSignal,
  ): Promise<PublicIntelligenceResult> {
    const jobDir = resolve(this.config.artifactRoot, input.id);
    const outputDir = join(jobDir, "output");
    try {
      await mkdir(jobDir, { recursive: true, mode: 0o700 });
      await mkdir(outputDir, { recursive: true, mode: 0o700 });
      await stat(this.config.scriptPath);
    } catch {
      throw new AgentExecutionError(
        "unavailable",
        "固定 CVE 查询脚本或任务目录不可用",
      );
    }
    const requestFile = join(jobDir, "request.json");
    await writeFile(
      requestFile,
      JSON.stringify({
        original: input.message,
        outputDir,
        scriptPath: resolve(this.config.scriptPath),
        pythonExecutable: this.config.pythonExecutable,
        cacheDir: resolve(this.config.artifactRoot, "public-cache"),
      }),
      { mode: 0o600 },
    );
    const extension = join(root, "tools/pi/public-cve-extension.mjs");
    const skill = join(root, "tools/pi/skills/public-cve/SKILL.md");
    const args = [
      ...(this.config.prefixArgs ?? []),
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-mcp",
      "--tools",
      "ys_public_cve_query",
      "-e",
      extension,
      "--skill",
      skill,
      ...(this.config.provider ? ["--provider", this.config.provider] : []),
      ...(this.config.model ? ["--model", this.config.model] : []),
    ];
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: jobDir,
      XDG_CONFIG_HOME: join(jobDir, "config"),
      PI_CODING_AGENT_DIR: join(jobDir, "pi"),
      YS_AGENT_REQUEST_FILE: requestFile,
      ...this.config.env,
    };
    for (const key of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
    ])
      if (process.env[key] && !env[key]) env[key] = process.env[key]!;
    const terminal = this.config.terminalEvent ?? "agent_settled";
    await new Promise<void>((ok, fail) => {
      if (signal.aborted) {
        fail(new AgentExecutionError("timed_out", "Pi 任务已中止"));
        return;
      }
      const child = spawn(this.config.executable, args, {
        cwd: jobDir,
        env,
        shell: false,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      });
      let finished = false,
        buffer = "",
        bytes = 0,
        accepted = false,
        toolStarted = false,
        toolCompleted = false;
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
          new AgentExecutionError(
            "timed_out",
            "Pi 任务超时或被中止；未自动重试",
          ),
        );
      const timer = setTimeout(abort, this.config.timeoutMs ?? 60000);
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
            finish(
              new AgentExecutionError("failed", "Pi RPC 返回非 JSON 消息"),
            );
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
            if (message.toolName !== "ys_public_cve_query") {
              finish(new AgentExecutionError("failed", "Pi 请求了未授权工具"));
              return;
            }
            toolStarted = true;
            event("tool_started", "固定 CVE 查询脚本开始执行");
          }
          if (message.type === "tool_execution_end") {
            if (
              message.toolName !== "ys_public_cve_query" ||
              !toolStarted ||
              message.isError
            ) {
              finish(
                new AgentExecutionError("failed", "固定 CVE 查询脚本执行失败"),
              );
              return;
            }
            toolCompleted = true;
            event("tool_completed", "固定查询脚本已完成，等待 Pi 结束");
          }
          if (message.type === terminal) {
            if (!accepted || !toolCompleted) {
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
          message:
            "/skill:ys-public-cve 请使用固定工具处理完整原始问题。原始问题已由后端绑定，请勿改写查询范围。",
        }) + "\n",
      );
    });
    try {
      for (const name of ["result.json", "report.html"]) {
        const path = await realpath(join(outputDir, name));
        if (
          !path.startsWith((await realpath(outputDir)) + sep) ||
          (await stat(path)).size > 5_000_000
        )
          throw new Error("artifact");
      }
      const raw = await readFile(join(outputDir, "result.json"), "utf8");
      const doc = documentSchema.parse(JSON.parse(raw));
      if (
        doc.query.original !== input.message ||
        doc.coverage.status !== doc.status ||
        doc.coverage.displayed !== doc.agent_view.results.length
      )
        throw new Error("scope");
      const ids = new Set(doc.sources.map((s) => s.source_id));
      for (const row of doc.agent_view.results) {
        if (
          typeof row.cve_id !== "string" ||
          !/^CVE-\d{4}-\d{4,}$/.test(row.cve_id) ||
          !Array.isArray(row.source_ids) ||
          !row.source_ids.length ||
          row.source_ids.some((id) => !ids.has(id))
        )
          throw new Error("source");
      }
      return {
        schemaVersion: "2.2",
        status: doc.status,
        query: doc.query,
        coverage: doc.coverage,
        summary: doc.agent_view.summary,
        scope: doc.agent_view.scope,
        results: doc.agent_view.results,
        sources: doc.sources,
        targetAssessment: "not_assessed",
        targetVerification: "not_executed",
        evidence: {
          contentHash: createHash("sha256").update(raw).digest("hex"),
          scriptContract: "yata-cve-research/2.2",
        },
      };
    } catch {
      throw new AgentExecutionError(
        "failed",
        "固定脚本输出不符合 2.2 契约、查询范围或证据文件校验",
      );
    }
  }
}
export function configuredPublicExecutor(
  config?: import("../config").AppConfig["pi"],
): PublicQueryExecutor {
  if (!config?.executable || !config.scriptPath)
    return {
      async execute() {
        throw new AgentExecutionError(
          "unavailable",
          "Pi 或固定 CVE 查询脚本尚未配置，未执行查询",
        );
      },
    };
  return new PiPublicQueryExecutor({
    executable: config.executable,
    artifactRoot: resolve(config.artifactRoot ?? ".data/agent"),
    scriptPath: config.scriptPath,
    pythonExecutable: config.pythonExecutable ?? "python3",
    provider: config.provider,
    model: config.model,
    terminalEvent: config.terminalEvent,
  });
}
