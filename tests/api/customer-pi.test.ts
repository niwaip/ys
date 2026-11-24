import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PiCustomerReadExecutor } from "../../apps/api/src/conversations/pi-customer";
test("客户 Pi 仅执行已授权快照读取能力，非允许工具导致失败", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ys-customer-pi-"));
  try {
    const executor = new PiCustomerReadExecutor({
      executable: process.execPath,
      prefixArgs: [resolve("tests/fixtures/customer-rpc.mjs")],
      artifactRoot: dir,
      timeoutMs: 2000,
    });
    const facts = {
      coverage: "not_assessed" as const,
      cveId: null,
      scopeNote: "fixture",
      assessments: [],
      matches: [],
      hash: "fixture",
    };
    const events: string[] = [];
    await executor.execute(
      {
        id: "e8c774b7-a980-4ea9-a57d-ed779bdb3b42",
        customerId: "acme",
        message: "PHP",
        facts,
      },
      async (type) => {
        events.push(type);
      },
      new AbortController().signal,
    );
    expect(events).toContain("tool_completed");
    await expect(
      executor.execute(
        {
          id: "e8c774b7-a980-4ea9-a57d-ed779bdb3b43",
          customerId: "acme",
          message: "forbidden",
          facts,
        },
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: "failed" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
