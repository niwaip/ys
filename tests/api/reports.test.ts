import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, directory: string;
const auth = { Authorization: "Bearer report-test-secret" };
const config = {
  customers: [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ],
  operators: [
    {
      token: "report-test-secret",
      name: "Report author",
      customerIds: ["a", "b"],
    },
  ],
};
afterEach(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("report binds explicit CVE and lifecycle snapshots, protected facts, independent coverage and immutable HTML draft", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-"));
  const options = { ...config, databaseUrl: `pglite://${directory}` };
  app = await createApp(options, [], {
    trivyExecutor: {
      execute: async () => ({
        status: "succeeded",
        toolVersion: "fixture",
        argv: ["sbom"],
        startedAt: "2026-11-18T01:00:00Z",
        finishedAt: "2026-11-18T01:00:01Z",
        exitCode: 0,
        signal: null,
        stderr: "fixture only",
        databaseBefore: null,
        databaseAfter: null,
        rawReport: JSON.stringify({
          SchemaVersion: 2,
          Results: [
            {
              Target: "fixture",
              Type: "npm",
              Packages: [],
              Vulnerabilities: [
                {
                  VulnerabilityID: "CVE-2026-12345",
                  PkgName: "widget-lib",
                  InstalledVersion: "1",
                  FixedVersion: "2",
                  Severity: "HIGH",
                },
              ],
            },
          ],
        }),
      }),
    },
  });
  const http = request(app.getHttpServer());
  const software = (
    await http
      .post("/api/customers/a/software")
      .set(auth)
      .send({ name: "Widget" })
  ).body;
  const snapshot = (
    await http
      .post(`/api/customers/a/software/${software.id}/sbom`)
      .set(auth)
      .send({
        fileName: "bom.json",
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          metadata: {
            component: { type: "application", name: "Widget", version: "1" },
          },
          components: [
            {
              type: "library",
              name: "widget-lib",
              version: "1",
              purl: "pkg:npm/widget-lib@1",
            },
          ],
        }),
      })
  ).body;
  const job = (
    await http.post("/api/customers/a/assessments").set(auth).send({
      softwareId: software.id,
      versionId: snapshot.id,
      idempotencyKey: "report-fixture",
    })
  ).body;
  await expect
    .poll(
      async () =>
        (await http.get(`/api/customers/a/assessments/${job.id}`).set(auth))
          .body.status,
    )
    .toBe("succeeded");
  const batch = (
    await http.post("/api/customers/a/lifecycle/batches").set(auth).send({
      fileName: "lifecycle.csv",
      content:
        "source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nFixture,<script>bad()</script>,Widget,1,Sales,2020-01-01,Support,2026-02-30",
    })
  ).body;
  const lifecycle = (
    await http
      .post("/api/customers/a/lifecycle/assessments")
      .set(auth)
      .send({
        batchId: batch.id,
        softwareTargets: [{ softwareId: software.id, versionId: snapshot.id }],
      })
  ).body;
  const report = (
    await http
      .post("/api/customers/a/reports")
      .set(auth)
      .send({ assessmentRefs: [job.id], lifecycleRefs: [lifecycle.id] })
      .expect(201)
  ).body;
  expect(report.revision).toMatchObject({
    status: "draft",
    createdBy: "Report author",
    facts: {
      statistics: {
        findingInstances: 1,
        uniqueCveCount: 1,
        severityCounts: { HIGH: 1 },
      },
      assessmentSnapshots: [{ id: job.id, status: "succeeded" }],
      lifecycleSnapshots: [{ id: lifecycle.id }],
      scope: [
        { objectId: software.id, versionId: snapshot.id, kind: "software" },
      ],
    },
  });
  expect(report.revision.factHash).toMatch(/^[a-f0-9]{64}$/);
  const html = (
    await http
      .get(`/api/customers/a/reports/${report.id}/preview`)
      .set(auth)
      .expect(200)
  ).text;
  expect(html).toContain("CVE-2026-12345");
  expect(html).toContain("2020-01-01");
  expect(html).toContain("2026-02-30");
  expect(html).toContain("未知");
  expect(html).toContain("草稿");
  expect(html).toContain("&lt;script&gt;bad()&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(
    (
      await http
        .get(
          `/api/customers/a/reports/${report.id}/revisions/${report.revision.id}/preview`,
        )
        .set(auth)
        .expect(200)
    ).text,
  ).toBe(html);
  await http
    .get(
      `/api/customers/b/reports/${report.id}/revisions/${report.revision.id}`,
    )
    .set(auth)
    .expect(404);

  await http.get(`/api/customers/b/reports/${report.id}`).set(auth).expect(404);
  await http
    .post("/api/customers/b/reports")
    .set(auth)
    .send({ assessmentRefs: [job.id], lifecycleRefs: [lifecycle.id] })
    .expect(404);
  await http
    .post("/api/customers/a/reports")
    .set(auth)
    .send({ assessmentRefs: [job.id], facts: { findingInstances: 0 } })
    .expect(400);
  await http.post("/api/customers/a/reports").set(auth).send({}).expect(400);
  await app.close();
  app = await createApp(options);
  expect(
    (
      await request(app.getHttpServer())
        .get(`/api/customers/a/reports/${report.id}`)
        .set(auth)
        .expect(200)
    ).body,
  ).toEqual(report);
  expect(
    (
      await request(app.getHttpServer())
        .get(`/api/customers/a/reports/${report.id}/preview`)
        .set(auth)
    ).text,
  ).toBe(html);
});
test("missing and failed assessment coverage never becomes a zero-risk report, and overlapping histories are rejected", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-missing-"));
  app = await createApp({ ...config, databaseUrl: `pglite://${directory}` });
  const http = request(app.getHttpServer());
  const software = (
    await http
      .post("/api/customers/a/software")
      .set(auth)
      .send({ name: "Unassessed" })
  ).body;
  const version = (
    await http
      .post(`/api/customers/a/software/${software.id}/sbom`)
      .set(auth)
      .send({
        fileName: "unknown.json",
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          components: [],
        }),
      })
  ).body;
  const submit = async (key: string) =>
    (
      await http.post("/api/customers/a/assessments").set(auth).send({
        softwareId: software.id,
        versionId: version.id,
        idempotencyKey: key,
      })
    ).body;
  const job = await submit("unavailable");
  await expect
    .poll(
      async () =>
        (await http.get(`/api/customers/a/assessments/${job.id}`).set(auth))
          .body.status,
    )
    .toBe("unavailable");
  const report = (
    await http
      .post("/api/customers/a/reports")
      .set(auth)
      .send({ assessmentRefs: [job.id] })
      .expect(201)
  ).body;
  expect(report.revision.facts.statistics).toMatchObject({
    findingInstances: null,
    uniqueCveCount: null,
    lifecycleExact: null,
  });
  expect(report.revision.facts.coverageIssues.join(" ")).toContain(
    "未选择生命周期评估",
  );
  expect(
    (await http.get(`/api/customers/a/reports/${report.id}/preview`).set(auth))
      .text,
  ).toContain("未取得可用 CVE 结果");
  const another = await submit("new-unavailable");
  await expect
    .poll(
      async () =>
        (await http.get(`/api/customers/a/assessments/${another.id}`).set(auth))
          .body.status,
    )
    .toBe("unavailable");
  await http
    .post("/api/customers/a/reports")
    .set(auth)
    .send({ assessmentRefs: [job.id, another.id] })
    .expect(409);
  expect(
    (await http.get(`/api/customers/a/reports/${report.id}`).set(auth)).body,
  ).toEqual(report);
});
