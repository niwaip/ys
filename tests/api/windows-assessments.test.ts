import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, directory: string;
const auth = { Authorization: "Bearer windows-assessment-test" };
const config = {
  customers: [
    { id: "acme", name: "A" },
    { id: "river", name: "R" },
  ],
  operators: [
    {
      token: "windows-assessment-test",
      name: "T",
      customerIds: ["acme", "river"],
    },
  ],
};
const host = {
  Hostname: "WIN",
  SerialNumber: "win-1",
  OS: "Windows Server 2022",
  OSBuild: "20348",
  Architecture: "x64",
  UBR: 2700,
  CollectedAt: "2026-11-18T00:00:00Z",
  InstalledKBs: [],
  KBInventoryComplete: true,
  RebootPending: false,
  CollectionStatus: { Overall: "COMPLETE" },
};
afterEach(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function start() {
  directory = await mkdtemp(join(tmpdir(), "ys-win-assess-"));
  app = await createApp({ ...config, databaseUrl: `pglite://${directory}` });
  return request(app.getHttpServer());
}
async function seed(http: ReturnType<typeof request>, h: object = host) {
  const snapshot = (
    await http
      .post("/api/customers/acme/windows/imports")
      .set(auth)
      .send({ fileName: "h.json", content: JSON.stringify(h) })
      .expect(201)
  ).body;
  return snapshot.snapshotId;
}
async function rules(http: ReturnType<typeof request>) {
  return (
    await http
      .post("/api/customers/acme/windows/rules")
      .set(auth)
      .send({
        fileName: "rules.json",
        content: await readFile("tests/fixtures/windows/rules.json", "utf8"),
      })
      .expect(201)
  ).body;
}
async function done(http: ReturnType<typeof request>, id: string) {
  for (let i = 0; i < 100; i++) {
    const r = (
      await http
        .get(`/api/customers/acme/assessments/${id}`)
        .set(auth)
        .expect(200)
    ).body;
    if (!["queued", "running"].includes(r.status)) return r;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("not settled");
}
test("固定Windows快照与源戳规则经已有任务接口形成可回读补丁证据", async () => {
  const http = await start(),
    snapshotId = await seed(http),
    rule = await rules(http);
  const job = (
    await http
      .post("/api/customers/acme/assessments")
      .set(auth)
      .send({ snapshotId, ruleImportId: rule.id, idempotencyKey: "first" })
      .expect(202)
  ).body;
  const result = await done(http, job.id);
  expect(result).toMatchObject({
    status: "succeeded",
    target: { kind: "windows", snapshotId },
    input: { ruleImportId: rule.id },
    result: {
      coverage: { status: "partial" },
      findings: [
        {
          vulnerabilityId: "CVE-2024-38063",
          applicability: "fixed",
          evidence: { basis: "same_branch_build" },
        },
      ],
    },
  });
  expect(result.result.rules.contentHash).toBe(rule.contentHash);
  expect(result.result.rules.sources[0]).toMatchObject({
    id: "fixture",
    verifiedOnline: false,
  });
});
test("替代补丁基于显式来源路径，部分采集/未知重启/错误分支不能确认修复", async () => {
  const http = await start(),
    rule = await rules(http);
  const cases = [
    {
      h: { ...host, UBR: 2600, InstalledKBs: ["KB5040000"] },
      expected: "fixed",
      basis: "qualified_supersedence",
    },
    {
      h: { ...host, UBR: 2600, InstalledKBs: ["KB9999999"] },
      expected: "affected",
      basis: "source_declared_affected_build",
    },
    {
      h: { ...host, UBR: 2600, CollectionStatus: { Overall: "PARTIAL" } },
      expected: "potentially_affected",
      basis: "lower_build_incomplete_evidence",
    },
    {
      h: { ...host, RebootPending: null },
      expected: "unknown",
      basis: "insufficient_evidence",
    },
    {
      h: { ...host, OSBuild: "25398" },
      expected: "unknown",
      basis: "insufficient_evidence",
    },
    {
      h: { ...host, KBInventoryComplete: true, InstalledKBs: undefined },
      expected: "unknown",
      basis: "insufficient_evidence",
    },
  ];
  for (const [i, c] of cases.entries()) {
    const snapshotId = await seed(http, c.h),
      job = (
        await http
          .post("/api/customers/acme/assessments")
          .set(auth)
          .send({
            snapshotId,
            ruleImportId: rule.id,
            idempotencyKey: `case-${i}`,
          })
          .expect(202)
      ).body;
    expect((await done(http, job.id)).result.findings[0]).toMatchObject({
      applicability: c.expected,
      evidence: { basis: c.basis },
    });
  }
});
test("规则来源哈希校验、客户限制、幂等冲突与重启历史", async () => {
  const http = await start(),
    snapshotId = await seed(http),
    rule = await rules(http);
  const input = {
    snapshotId,
    ruleImportId: rule.id,
    idempotencyKey: "history",
  };
  const job = (
    await http
      .post("/api/customers/acme/assessments")
      .set(auth)
      .send(input)
      .expect(202)
  ).body;
  const finished = await done(http, job.id);
  expect(
    (
      await http
        .post("/api/customers/acme/assessments")
        .set(auth)
        .send(input)
        .expect(202)
    ).body.id,
  ).toBe(job.id);
  await http
    .post("/api/customers/river/assessments")
    .set(auth)
    .send(input)
    .expect(404);
  await http
    .get(`/api/customers/river/windows/rules/${rule.id}`)
    .set(auth)
    .expect(404);
  await http
    .get(`/api/customers/river/assessments/${job.id}`)
    .set(auth)
    .expect(404);
  const second = await seed(http, { ...host, UBR: 2701 });
  await http
    .post("/api/customers/acme/assessments")
    .set(auth)
    .send({ ...input, snapshotId: second })
    .expect(409);
  const raw = JSON.parse(
    await readFile("tests/fixtures/windows/rules.json", "utf8"),
  );
  raw.sources[0].content = "tampered";
  await http
    .post("/api/customers/acme/windows/rules")
    .set(auth)
    .send({ fileName: "bad.json", content: JSON.stringify(raw) })
    .expect(400);
  await http.get("/api/customers/acme/windows/rules").expect(401);
  const listed = (
    await http.get("/api/customers/acme/assessments").set(auth).expect(200)
  ).body;
  expect(listed.items.find((x: any) => x.id === job.id)).toMatchObject({
    target: { kind: "windows" },
    findingCount: 1,
    coverage: { status: "partial" },
  });
  await app.close();
  app = await createApp({ ...config, databaseUrl: `pglite://${directory}` });
  const reloaded = (
    await request(app.getHttpServer())
      .get(`/api/customers/acme/assessments/${job.id}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(reloaded.result).toEqual(finished.result);
  expect(reloaded.input.ruleHash).toBe(rule.contentHash);
});
