import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PiPublicQueryExecutor } from "../../apps/api/src/agent/pi-process";
test("Pi RPC 请求接受和agent_end不提前完成，固定工具结果保留来源范围与partial语义", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ys-pi-rpc-"));
  try {
    const executor = new PiPublicQueryExecutor({
      executable: process.execPath,
      prefixArgs: [resolve("tests/fixtures/pi-rpc.mjs")],
      artifactRoot: dir,
      scriptPath: resolve("tests/fixtures/pi-rpc.mjs"),
      pythonExecutable: process.execPath,
      timeoutMs: 2000,
    });
    const events: string[] = [];
    const result = await executor.execute(
      { id: "d4550a52-6146-44b1-8b86-403ff08b0b0d", message: "PHP 最新 CVE" },
      async (type) => {
        events.push(type);
      },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: "partial",
      targetAssessment: "not_assessed",
      targetVerification: "not_executed",
      results: [{ cve_id: "CVE-2024-4577" }],
      coverage: { has_more: "unknown" },
    });
    expect(events).toContain("tool_completed");
    expect(events).toContain("agent_settled");
    await expect(
      executor.execute(
        { id: "785ed126-3484-4775-b5d2-92a65b5904c7", message: "PHP timeout" },
        async () => {},
        AbortSignal.timeout(150),
      ),
    ).rejects.toMatchObject({ status: "timed_out" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
