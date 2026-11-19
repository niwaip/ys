import { test, expect } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PiReportNarrationExecutor } from "../../apps/api/src/reports/pi-narration";
import type { ReportNarrationInput } from "../../packages/contracts/report-narration";
test("fixed Pi report capability reads scoped input and writes bound proposal; missing tool and timeout fail", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ys-pi-report-"));
  try {
    const input: ReportNarrationInput = {
      id: "00000000-0000-4000-8000-000000000014",
      reportId: "00000000-0000-4000-8000-000000000015",
      baseRevisionId: "00000000-0000-4000-8000-000000000016",
      factHash: "a".repeat(64),
      scope: [],
      statistics: {
        findingInstances: null,
        uniqueCveCount: null,
        severityCounts: {},
        lifecycleExact: null,
        lifecycleWeak: null,
        lifecycleUnmatched: null,
      },
      coverageIssues: ["fixture only"],
      allowedNarrative: {
        schemaVersion: "controlled-paragraphs-v1",
        density: "standard",
        blocks: [{ templateId: "scope", wording: "standard" }],
      },
      optionalTemplates: ["summary", "recommendations"],
    };
    const config = {
      executable: process.execPath,
      prefixArgs: [resolve("tests/fixtures/report-pi.mjs")],
      artifactRoot: directory,
      timeoutMs: 2000,
    };
    const events: string[] = [];
    expect(
      await new PiReportNarrationExecutor(config).execute(
        input,
        async (type) => {
          events.push(type);
        },
        new AbortController().signal,
      ),
    ).toMatchObject({
      schemaVersion: "report-proposal-v1",
      baseRevisionId: input.baseRevisionId,
      factHash: input.factHash,
      narrative: {
        blocks: expect.arrayContaining([
          expect.objectContaining({
            text: "针对【scope】，请结合保护事实解读。接下来，建议复核来源证据，以便保留复核依据。",
          }),
        ]),
      },
    });
    expect(events).toContain("agent_settled");
    await expect(
      new PiReportNarrationExecutor({
        ...config,
        env: { YS_REPORT_FIXTURE_MODE: "missing_tool" },
      }).execute(
        { ...input, id: "00000000-0000-4000-8000-000000000017" },
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: "failed" });
    await expect(
      new PiReportNarrationExecutor({
        ...config,
        env: { YS_REPORT_FIXTURE_MODE: "timeout" },
        timeoutMs: 100,
      }).execute(
        { ...input, id: "00000000-0000-4000-8000-000000000018" },
        async () => {},
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: "timed_out" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
