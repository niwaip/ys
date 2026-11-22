import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, dir: string;
const auth = { Authorization: "Bearer finding-test-secret" },
  base = "/api/customers/a";
const config = {
  customers: [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ],
  operators: [
    { name: "Test", token: "finding-test-secret", customerIds: ["a", "b"] },
  ],
};
afterEach(async () => {
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function boot(
  execute: NonNullable<
    Parameters<typeof createApp>[2]
  >["findingAnalysisExecutor"],
  timeout = 10000,
) {
  dir = await mkdtemp(join(tmpdir(), "ys-finding-"));
  const options = { ...config, databaseUrl: `pglite://${dir}` };
  app = await createApp(options, [], {
    findingAnalysisExecutor: execute,
    findingAnalysisTimeoutMs: timeout,
    findingResearchExecutor: {
      execute: async () => ({
        schemaVersion: "2.2",
        status: "partial",
        query: {},
        coverage: {},
        summary: "fixture",
        scope: "single",
        results: [{ cve_id: "CVE-2024-12345", source_ids: ["vendor"] }],
        sources: [
          {
            source_id: "vendor",
            url: "https://example.test/vendor",
            title: "Vendor fixture",
          },
        ],
        targetAssessment: "not_assessed",
        targetVerification: "not_executed",
        evidence: {
          contentHash: "a".repeat(64),
          scriptContract: "yata-cve-research/2.2",
        },
      }),
    },
    trivyExecutor: {
      execute: async () => ({
        status: "succeeded",
        toolVersion: "fixture",
        argv: [],
        startedAt: "2026-11-20T00:00:00Z",
        finishedAt: "2026-11-20T00:00:01Z",
        exitCode: 0,
        signal: null,
        stderr: "",
        databaseBefore: null,
        databaseAfter: null,
        rawReport: JSON.stringify({
          SchemaVersion: 2,
          Results: [
            {
              Target: "test",
              Type: "npm",
              Packages: [{ Name: "express", Version: "4.18.0" }],
              Vulnerabilities: [12345, 12346].map((n) => ({
                VulnerabilityID: `CVE-2024-${n}`,
                PkgName: "express",
                InstalledVersion: "4.18.0",
                Severity: "HIGH",
                FixedVersion: "4.19.2",
                PrimaryURL: "https://example.test/advisory",
                Title: "Fixture advisory",
                Description: "Fixture description",
              })),
            },
          ],
        }),
      }),
    },
  });
  return options;
}
async function seed() {
  const h = request(app.getHttpServer());
  const obj = (
    await h
      .post(base + "/software")
      .set(auth)
      .send({ name: "Test software" })
      .expect(201)
  ).body;
  const v = (
    await h
      .post(`${base}/software/${obj.id}/sbom`)
      .set(auth)
      .send({
        fileName: "sbom.json",
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          components: [
            {
              type: "library",
              name: "express",
              version: "4.18.0",
              purl: "pkg:npm/express@4.18.0",
            },
          ],
        }),
      })
      .expect(201)
  ).body;
  const job = (
    await h
      .post(base + "/assessments")
      .set(auth)
      .send({ softwareId: obj.id, versionId: v.id, idempotencyKey: "scan" })
      .expect(202)
  ).body;
  let result: any;
  await expect
    .poll(async () => {
      result = (await h.get(`${base}/assessments/${job.id}`).set(auth)).body;
      return result.status;
    })
    .toBe("succeeded");
  return {
    scan: result,
    path: `${base}/assessments/${job.id}/findings/${result.result.findings[0].id}/analyses`,
  };
}
async function finish(path: string, id: string) {
  let job: any;
  await expect
    .poll(async () => {
      job = (
        await request(app.getHttpServer())
          .get(path + "/" + id)
          .set(auth)
          .expect(200)
      ).body;
      return ["queued", "running"].includes(job.status);
    })
    .toBe(false);
  return job;
}
const narrative = {
  explanation: {
    text: "本条为工具报告的漏洞，依据安装组件进一步核实。",
    sourceIds: ["finding"],
  },
  impact: {
    text: "可能影响使用该组件的业务，运行状态未知，需核实。",
    sourceIds: ["finding"],
  },
  checks: [{ text: "核实调用路径与对外暴露情况。", sourceIds: ["finding"] }],
  nextSteps: [
    { text: "建议测试修复版本并准备回滚后重扫。", sourceIds: ["finding"] },
  ],
};
test("单条解析持久绑定客户、扫描、组件与来源，幂等重开且不改扫描事实", async () => {
  let seen: any,
    calls = 0;
  const options = await boot({
    execute: async (input, emit) => {
      calls++;
      seen = input;
      await emit("analysis", "fixture analysis");
      return {
        schemaVersion: "finding-analysis-v1",
        factHash: input.factHash,
        narrative,
      };
    },
  });
  const { scan, path } = await seed(),
    h = request(app.getHttpServer());
  const started = (
    await h.post(path).set(auth).send({ idempotencyKey: "one" }).expect(202)
  ).body;
  const done = await finish(path, started.id);
  expect(done.status).toBe("succeeded");
  expect(done.facts).toMatchObject({
    assessmentId: scan.id,
    findingId: scan.result.findings[0].id,
    input: { contentHash: scan.input.contentHash },
    finding: { applicability: "tool_reported" },
  });
  expect(seen.facts.advisory.description).toBe("Fixture description");
  expect(done.sources.map((s: any) => s.url)).toContain(
    "https://example.test/vendor",
  );
  expect(done.research.status).toBe("partial");
  expect(
    (await h.post(path).set(auth).send({ idempotencyKey: "one" }).expect(202))
      .body.id,
  ).toBe(started.id);
  expect(calls).toBe(1);
  const other = path.replace(
    scan.result.findings[0].id,
    scan.result.findings[1].id,
  );
  await h.post(other).set(auth).send({ idempotencyKey: "one" }).expect(409);
  await h.get(path + "/" + done.id).expect(401);
  await h
    .get(path.replace("/customers/a/", "/customers/b/") + "/" + done.id)
    .set(auth)
    .expect(404);
  await h
    .post(path.replace("/customers/a/", "/customers/b/"))
    .set(auth)
    .send({ idempotencyKey: "cross" })
    .expect(404);
  expect(
    (await h.get(`${base}/assessments/${scan.id}`).set(auth)).body.result,
  ).toEqual(scan.result);
  await app.close();
  app = await createApp(options);
  const persisted = (
    await request(app.getHttpServer()).get(path).set(auth).expect(200)
  ).body.items[0];
  expect(persisted.narrative).toEqual(narrative);
});
test("AI解析拒绝空引用、虚构来源与错绑，失败不覆盖旧成功结果", async () => {
  let mode = "normal";
  await boot({
    execute: async (input) => {
      const n = structuredClone(narrative);
      if (mode === "empty") n.explanation.sourceIds = [];
      if (mode === "source") n.impact.sourceIds = ["invented"];
      return {
        schemaVersion: "finding-analysis-v1",
        factHash: mode === "hash" ? "b".repeat(64) : input.factHash,
        narrative: n,
      };
    },
  });
  const { path } = await seed(),
    h = request(app.getHttpServer());
  const normal = (
    await h.post(path).set(auth).send({ idempotencyKey: "normal" })
  ).body;
  expect((await finish(path, normal.id)).status).toBe("succeeded");
  for (const value of ["empty", "source", "hash"]) {
    mode = value;
    const next = (
      await h.post(path).set(auth).send({ idempotencyKey: value }).expect(202)
    ).body;
    expect((await finish(path, next.id)).status).toBe("failed");
  }
  expect(
    (await h.get(path + "/" + normal.id).set(auth)).body.narrative,
  ).toEqual(narrative);
});
test("重复点击复用活动解析，超时有明确终态并保留记录", async () => {
  await boot({ execute: async () => new Promise(() => {}) }, 80);
  const { path } = await seed(),
    h = request(app.getHttpServer());
  const first = (
    await h.post(path).set(auth).send({ idempotencyKey: "first" }).expect(202)
  ).body;
  const repeated = (
    await h.post(path).set(auth).send({ idempotencyKey: "first" }).expect(202)
  ).body;
  expect(repeated.id).toBe(first.id);
  const result = await finish(path, first.id);
  expect(result.status).toBe("timed_out");
  expect(result.narrative).toBeUndefined();
  await h
    .post(path)
    .set(auth)
    .send({ idempotencyKey: "bad", facts: {} })
    .expect(400);
});
