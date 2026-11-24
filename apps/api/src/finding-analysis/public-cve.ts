import { createHash } from "node:crypto";
import { z } from "zod";
import type { PublicQueryExecutor } from "../agent/agent.module";
import { AgentExecutionError } from "../agent/errors";
const record = z.object({
  cveMetadata: z.object({ cveId: z.string(), state: z.literal("PUBLISHED") }),
  containers: z.object({
    cna: z.object({
      title: z.string().optional(),
      descriptions: z.array(z.object({ lang: z.string(), value: z.string() })),
      affected: z.array(z.unknown()).optional(),
      references: z.array(z.object({ url: z.string() })).optional(),
      solutions: z.array(z.unknown()).optional(),
    }),
  }),
});
/** One fixed public host and a validated CVE id; no customer data or caller URLs. */
export class CveRecordResearch implements PublicQueryExecutor {
  async execute(
    input: { id: string; message: string },
    _emit: (type: string, message: string) => Promise<void>,
    signal: AbortSignal,
  ) {
    const ids = input.message.match(/CVE-\d{4}-\d{4,}/g);
    if (!ids || new Set(ids).size !== 1)
      throw new AgentExecutionError("unavailable", "仅支持单个有效 CVE 编号");
    const id = ids[0],
      url = `https://cveawg.mitre.org/api/cve/${id}`;
    const response = await fetch(url, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(12000)]),
      redirect: "error",
      headers: { Accept: "application/json" },
    });
    if (!response.ok || !response.body)
      throw new AgentExecutionError("unavailable", "公开 CVE 记录暂不可用");
    const decoder = new TextDecoder();
    let raw = "";
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 1000000) {
        throw Error("CVE record too large");
      }
      raw += decoder.decode(chunk, { stream: true });
    }
    raw += decoder.decode();
    const doc = record.parse(JSON.parse(raw));
    if (doc.cveMetadata.cveId !== id) throw Error("CVE scope mismatch");
    const cna = doc.containers.cna,
      description =
        cna.descriptions.find((d) => d.lang === "en") ?? cna.descriptions[0];
    const result = {
      cve_id: id,
      title: cna.title,
      description: description?.value.slice(0, 8000),
      affected: cna.affected?.slice(0, 20),
      solutions: cna.solutions?.slice(0, 5),
      source_ids: ["cve-record"],
    };
    return {
      schemaVersion: "2.2" as const,
      status: "partial" as const,
      query: { original: input.message },
      coverage: {
        status: "partial",
        limitations: [
          "仅查询 CVE Program CNA 记录，未重新抓取厂商页面或验证目标适用性",
        ],
      },
      summary: "取得单条 CVE CNA 公开记录",
      scope: id,
      results: [result],
      sources: [
        {
          source_id: "cve-record",
          title: "CVE Program CNA 记录",
          url,
          fetched_at: new Date().toISOString(),
        },
      ],
      targetAssessment: "not_assessed" as const,
      targetVerification: "not_executed" as const,
      evidence: {
        contentHash: createHash("sha256").update(raw).digest("hex"),
        scriptContract: "yata-cve-research/2.2" as const,
      },
    };
  }
}
