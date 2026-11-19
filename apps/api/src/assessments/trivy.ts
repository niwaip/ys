import { spawn } from "node:child_process";
import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  stat,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { TrivyExecution } from "../../../../packages/contracts/assessments";
export type TrivyInput = { content: string; contentHash: string };
export interface TrivyExecutor {
  execute(input: TrivyInput, signal: AbortSignal): Promise<TrivyExecution>;
}
export type TrivyConfig = {
  executable?: string;
  cacheDir?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
};
export class ProcessTrivyExecutor implements TrivyExecutor {
  constructor(private readonly config: TrivyConfig = {}) {}
  async execute(
    input: TrivyInput,
    signal: AbortSignal,
  ): Promise<TrivyExecution> {
    const startedAt = new Date().toISOString();
    const execution: TrivyExecution = {
      status: "unavailable",
      toolVersion: null,
      argv: [],
      startedAt,
      finishedAt: startedAt,
      exitCode: null,
      signal: null,
      stderr: "",
      databaseBefore: null,
      databaseAfter: null,
    };
    if (
      createHash("sha256").update(input.content).digest("hex") !==
      input.contentHash
    )
      return { ...execution, status: "failed", error: "输入资料内容校验失败" };
    if (!this.config.executable || !this.config.cacheDir)
      return {
        ...execution,
        error: "Trivy 未配置：需设置可执行文件与离线数据库目录",
      };
    const executable = this.config.executable,
      cacheDir = resolve(this.config.cacheDir);
    const cwd = await mkdtemp(join(tmpdir(), "ys-trivy-"));
    let timedOut = false;
    const abort = new AbortController();
    const relay = () => abort.abort();
    signal.addEventListener("abort", relay, { once: true });
    if (signal.aborted) abort.abort();
    const timer = setTimeout(() => {
      timedOut = true;
      abort.abort();
    }, this.config.timeoutMs ?? 120000);
    const cap = this.config.maxOutputBytes ?? 5000000;
    async function metadata() {
      try {
        return JSON.parse(
          await readFile(join(cacheDir, "db", "metadata.json"), "utf8"),
        ) as Record<string, unknown>;
      } catch {
        return null;
      }
    }
    async function run(argv: string[]) {
      return new Promise<{
        code: number | null;
        signal: string | null;
        stdout: string;
        stderr: string;
      }>((accept, reject) => {
        if (abort.signal.aborted) {
          reject(new Error("执行已中断"));
          return;
        }
        let stdout = "",
          stderr = "",
          bytes = 0,
          overflow = false;
        const child = spawn(executable, argv, {
          cwd,
          shell: false,
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: cwd,
            TMPDIR: cwd,
            LANG: "C.UTF-8",
          },
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const send = (sig: NodeJS.Signals) => {
          try {
            if (process.platform !== "win32" && child.pid)
              process.kill(-child.pid, sig);
            else child.kill(sig);
          } catch {}
        };
        const kill = () => {
          send("SIGTERM");
          killTimer = setTimeout(() => send("SIGKILL"), 200);
        };
        abort.signal.addEventListener("abort", kill, { once: true });
        const data = (kind: "stdout" | "stderr", chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > cap) {
            overflow = true;
            kill();
            return;
          }
          if (kind === "stdout") stdout += chunk.toString("utf8");
          else stderr += chunk.toString("utf8");
        };
        child.stdout.on("data", (b) => data("stdout", b));
        child.stderr.on("data", (b) => data("stderr", b));
        child.once("error", (error) => {
          abort.signal.removeEventListener("abort", kill);
          if (killTimer) clearTimeout(killTimer);
          reject(error);
        });
        child.once("close", (code, sig) => {
          abort.signal.removeEventListener("abort", kill);
          if (killTimer) clearTimeout(killTimer);
          if (overflow) reject(new Error("工具输出超过限制"));
          else accept({ code, signal: sig, stdout, stderr });
        });
      });
    }
    try {
      const info = await run(["--version"]);
      execution.stderr = info.stderr;
      execution.exitCode = info.code;
      execution.signal = info.signal;
      if (info.code !== 0) throw new Error("无法读取 Trivy 版本");
      execution.toolVersion = info.stdout.trim().slice(0, 2000) || null;
      if (!execution.toolVersion) throw new Error("Trivy 版本为空");
      execution.databaseBefore = await metadata();
      if (!execution.databaseBefore)
        throw Object.assign(new Error("Trivy 漏洞数据库元数据不可用"), {
          code: "ENOENT",
        });
      await access(join(cacheDir, "db", "trivy.db"));
      const inputPath = join(cwd, "input.cdx.json"),
        reportPath = join(cwd, "report.json"),
        configPath = join(cwd, "trivy.yaml"),
        ignorePath = join(cwd, ".trivyignore");
      await Promise.all([
        writeFile(inputPath, input.content, { mode: 0o600 }),
        writeFile(configPath, "{}\n"),
        writeFile(ignorePath, ""),
      ]);
      execution.argv = [
        "sbom",
        "--format",
        "json",
        "--scanners",
        "vuln",
        "--list-all-pkgs",
        "--no-progress",
        "--skip-db-update",
        "--skip-java-db-update",
        "--offline-scan",
        "--skip-version-check",
        "--exit-code",
        "0",
        "--config",
        configPath,
        "--ignorefile",
        ignorePath,
        "--cache-dir",
        cacheDir,
        "--output",
        reportPath,
        inputPath,
      ];
      const result = await run(execution.argv);
      execution.exitCode = result.code;
      execution.signal = result.signal;
      execution.stderr += result.stderr;
      execution.databaseAfter = await metadata();
      if (abort.signal.aborted)
        throw new Error(timedOut ? "Trivy 执行超时" : "Trivy 执行中断");
      try {
        if ((await stat(reportPath)).size > cap)
          throw new Error("工具报告超过限制");
        execution.rawReport = await readFile(reportPath, "utf8");
        execution.outputHash = createHash("sha256")
          .update(execution.rawReport)
          .digest("hex");
      } catch (error) {
        if (result.code === 0) throw error;
      }
      if (result.code !== 0)
        throw new Error(`Trivy 非零退出：${result.code ?? result.signal}`);
      execution.status = "succeeded";
    } catch (error) {
      const e = error as Error & { code?: string };
      execution.status = timedOut
        ? "timed_out"
        : signal.aborted
          ? "interrupted"
          : e.code === "ENOENT"
            ? "unavailable"
            : "failed";
      execution.error = timedOut
        ? "Trivy 执行超时"
        : signal.aborted
          ? "Trivy 执行中断"
          : e.message;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", relay);
      execution.finishedAt = new Date().toISOString();
      await rm(cwd, { recursive: true, force: true });
    }
    return execution;
  }
}
