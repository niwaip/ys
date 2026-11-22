import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { runPiCapability, type PiRpcConfig } from "../agent/pi-rpc";
import { AgentExecutionError } from "../agent/errors";
import type { AppConfig } from "../config";
import type { FindingAnalysisInput } from "../../../../packages/contracts/finding-analysis";
export interface FindingAnalysisExecutor {
  execute(
    input: FindingAnalysisInput,
    emit: (type: string, message: string) => Promise<void>,
    signal: AbortSignal,
  ): Promise<unknown>;
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
export class PiFindingAnalysisExecutor implements FindingAnalysisExecutor {
  constructor(private config: PiRpcConfig & { artifactRoot: string }) {}
  async execute(
    input: FindingAnalysisInput,
    emit: (type: string, message: string) => Promise<void>,
    signal: AbortSignal,
  ) {
    const jobDir = resolve(this.config.artifactRoot, input.id),
      outputDir = join(jobDir, "output");
    const outputFile = join(outputDir, "analysis.json"),
      requestFile = join(jobDir, "request.json");
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    await writeFile(
      requestFile,
      JSON.stringify({
        input,
        outputFile,
        readReceipt: join(jobDir, "facts-read.json"),
      }),
      { mode: 0o600 },
    );
    await runPiCapability(
      this.config,
      {
        jobDir,
        requestFile,
        extension: join(root, "tools/pi/finding-analysis-extension.mjs"),
        skill: join(root, "tools/pi/skills/finding-analysis/SKILL.md"),
        tools: ["ys_finding_facts", "ys_finding_analysis"],
        requiredTools: ["ys_finding_facts", "ys_finding_analysis"],
        prompt:
          "/skill:ys-finding-analysis 读取绑定单条漏洞事实与来源，生成中文漏洞说明、可能的系统影响、待核实条件和下一步建议。通过固定工具保存解析。",
      },
      emit,
      signal,
    );
    try {
      const path = await realpath(outputFile),
        base = await realpath(outputDir),
        info = await stat(path);
      if (!path.startsWith(base + sep) || !info.isFile() || info.size > 100000)
        throw Error();
      return JSON.parse(await readFile(path, "utf8"));
    } catch {
      throw new AgentExecutionError("failed", "AI解析产物缺失或格式错误");
    }
  }
}
export function configuredFindingAnalyst(
  config?: AppConfig["pi"],
): FindingAnalysisExecutor {
  if (!config?.executable)
    return {
      execute: async () => {
        throw new AgentExecutionError("unavailable", "Pi未配置，未执行AI解析");
      },
    };
  return new PiFindingAnalysisExecutor({
    ...config,
    executable: config.executable,
    artifactRoot: resolve(config.artifactRoot ?? ".data/agent", "findings"),
  });
}
