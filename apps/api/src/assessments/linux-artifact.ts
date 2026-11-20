import { createHash } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import type { Assessment } from "../../../../packages/contracts/assessments";
const compress = promisify(gzip),
  decompress = promisify(gunzip);
export type StoredAssessment = Assessment & {
  artifact?: { encoding: "gzip-base64"; contentHash: string; data: string };
};
/** Keep the exact tool report once; finding references point into its immutable arrays. */
export async function packLinuxAssessment(
  job: Assessment,
): Promise<StoredAssessment> {
  const raw = job.execution?.rawReport;
  if (job.target.kind !== "linux" || raw === undefined) return job;
  const contentHash = createHash("sha256").update(raw).digest("hex");
  const artifact: StoredAssessment["artifact"] = {
    encoding: "gzip-base64",
    contentHash,
    data: (await compress(raw)).toString("base64"),
  };
  let result = job.result;
  if (result) {
    const report = JSON.parse(raw) as {
      Results: {
        Vulnerabilities?: {
          VulnerabilityID: string;
          PkgName: string;
          InstalledVersion: string;
        }[];
      }[];
    };
    const references = report.Results.flatMap((r, resultIndex) =>
      (r.Vulnerabilities ?? []).map((v, vulnerabilityIndex) => ({
        v,
        resultIndex,
        vulnerabilityIndex,
      })),
    );
    if (references.length !== result.findings.length)
      throw Error("漏洞证据索引数量不一致");
    result = {
      ...result,
      findings: result.findings.map((f, i) => {
        const ref = references[i];
        if (
          ref.v.VulnerabilityID !== f.vulnerabilityId ||
          ref.v.PkgName !== f.packageName ||
          ref.v.InstalledVersion !== f.installedVersion
        )
          throw Error("漏洞证据索引身份不一致");
        return {
          ...f,
          evidence: {
            reportSha256: contentHash,
            resultIndex: ref.resultIndex,
            vulnerabilityIndex: ref.vulnerabilityIndex,
          },
        };
      }),
    };
  }
  return {
    ...job,
    execution: { ...job.execution!, rawReport: undefined },
    result,
    artifact,
  };
}
export async function linuxReportContent(
  stored: StoredAssessment,
): Promise<string | undefined> {
  if (stored.execution?.rawReport !== undefined)
    return stored.execution.rawReport;
  if (!stored.artifact) return undefined;
  const raw = (
    await decompress(Buffer.from(stored.artifact.data, "base64"))
  ).toString("utf8");
  if (
    createHash("sha256").update(raw).digest("hex") !==
    stored.artifact.contentHash
  )
    throw Error("原始报告内容校验失败");
  return raw;
}
