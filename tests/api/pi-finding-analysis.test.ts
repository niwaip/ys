import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PiFindingAnalysisExecutor } from "../../apps/api/src/finding-analysis/pi-analysis";
import type { FindingAnalysisInput } from "../../packages/contracts/finding-analysis";
test("Pi固定解析工具读取绑定事实并保存结构化产物，缺少保存工具不能成功", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ys-finding-pi-"));
  try {
    const input: FindingAnalysisInput = {
      id: "00000000-0000-4000-8000-000000000027",
      factHash: "a".repeat(64),
      facts: {
        assessmentId: "00000000-0000-4000-8000-000000000001",
        findingId: "00000000-0000-4000-8000-000000000002",
        target: {
          kind: "software",
          softwareId: "00000000-0000-4000-8000-000000000003",
          versionId: "00000000-0000-4000-8000-000000000004",
        },
        input: {
          importId: "00000000-0000-4000-8000-000000000005",
          contentHash: "b".repeat(64),
          version: "1",
        },
        outputHash: "c".repeat(64),
        finding: {
          id: "00000000-0000-4000-8000-000000000002",
          componentId: null,
          target: "test",
          ecosystem: "npm",
          packageName: "express",
          installedVersion: "4.18.0",
          vulnerabilityId: "CVE-2024-12345",
          severity: "HIGH",
          fixedVersion: null,
          primaryUrl: null,
          applicability: "tool_reported",
          evidence: {},
        },
        coverage: {
          status: "partial",
          inputComponents: 1,
          matchedComponents: 1,
          issues: ["fixture only"],
        },
        database: {
          freshness: "unknown",
          updatedAt: null,
          nextUpdate: null,
          changedDuringScan: false,
        },
        advisory: {},
      },
      sources: [],
    };
    const config = {
      executable: process.execPath,
      prefixArgs: [resolve("tests/fixtures/finding-pi.mjs")],
      artifactRoot: directory,
      timeoutMs: 2000,
    };
    const output = await new PiFindingAnalysisExecutor(config).execute(
      input,
      async () => {},
      new AbortController().signal,
    );
    expect(output).toMatchObject({
      schemaVersion: "finding-analysis-v1",
      factHash: input.factHash,
      narrative: { explanation: { sourceIds: ["finding"] } },
    });
    await expect(
      new PiFindingAnalysisExecutor({
        ...config,
        env: { YS_FINDING_FIXTURE_MODE: "missing_tool" },
      }).execute(
        { ...input, id: "00000000-0000-4000-8000-000000000028" },
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: "failed" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
