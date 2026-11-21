import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { PublicQueryExecutor } from "./agent.module";
import { AgentExecutionError } from "./errors";
import { runPiCapability } from "./pi-rpc";
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
    await runPiCapability(
      this.config,
      {
        jobDir,
        requestFile,
        extension,
        skill,
        tools: ["ys_public_cve_query"],
        requiredTools: ["ys_public_cve_query"],
        prompt:
          "/skill:ys-public-cve 请使用固定工具处理完整原始问题。原始问题已由后端绑定，请勿改写查询范围。",
      },
      emit,
      signal,
    );
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
