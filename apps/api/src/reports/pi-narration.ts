import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReportNarrationExecutor } from "./narration";
import { runPiCapability, type PiRpcConfig } from "../agent/pi-rpc";
import { AgentExecutionError } from "../agent/errors";
import type { AppConfig } from "../config";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export class PiReportNarrationExecutor implements ReportNarrationExecutor {
  constructor(private config: PiRpcConfig & { artifactRoot: string }) {}
  async execute(
    input: Parameters<ReportNarrationExecutor["execute"]>[0],
    emit: Parameters<ReportNarrationExecutor["execute"]>[1],
    signal: AbortSignal,
  ) {
    const jobDir = resolve(this.config.artifactRoot, input.id),
      outputDir = join(jobDir, "output"),
      outputFile = join(outputDir, "proposal.json"),
      requestFile = join(jobDir, "request.json");
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    await writeFile(
      requestFile,
      JSON.stringify({
        input,
        outputFile,
        readReceipt: join(jobDir, "facts-read.json"),
        scriptPath: join(root, "tools/pi/report-narration.mjs"),
      }),
      { mode: 0o600 },
    );
    await runPiCapability(
      this.config,
      {
        jobDir,
        requestFile,
        extension: join(root, "tools/pi/report-narration-extension.mjs"),
        skill: join(root, "tools/pi/skills/report-narration/SKILL.md"),
        tools: ["ys_report_facts", "ys_report_proposal"],
        requiredTools: ["ys_report_facts", "ys_report_proposal"],
        prompt:
          "/skill:ys-report-narration 读取绑定报告事实，再组织受控段落提案。保留全部保护事实、覆盖缺口与来源引用。",
      },
      emit,
      signal,
    );
    try {
      const path = await realpath(outputFile),
        base = await realpath(outputDir),
        info = await stat(path);
      if (!path.startsWith(base + sep) || !info.isFile() || info.size > 200000)
        throw Error("artifact");
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new AgentExecutionError(
        "failed",
        "报告提案文件缺失、越界或无法解析；固定事实草稿保留",
      );
    }
  }
}
export function configuredReportNarrator(
  config?: AppConfig["pi"],
): ReportNarrationExecutor {
  if (!config?.executable)
    return {
      execute: async () => {
        throw new AgentExecutionError(
          "unavailable",
          "Pi报告叙述未配置，固定事实草稿保留",
        );
      },
    };
  return new PiReportNarrationExecutor({
    executable: config.executable,
    artifactRoot: resolve(config.artifactRoot ?? ".data/agent", "reports"),
    provider: config.provider,
    model: config.model,
    terminalEvent: config.terminalEvent,
    timeoutMs: config.timeoutMs,
  });
}
