import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, dir: string;
const auth = { Authorization: "Bearer linux-assessment-test" },
  base = "/api/customers/a";
afterEach(async () => {
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
test("Linux固定快照经真实任务队列扫描，Dashboard和报告冻结结果并保持客户及删除隔离", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-linux-"));
  let calls = 0;
  app = await createApp(
    {
      databaseUrl: `pglite://${dir}`,
      customers: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      operators: [
        { name: "T", token: "linux-assessment-test", customerIds: ["a", "b"] },
      ],
    },
    [],
    {
      trivyExecutor: {
        execute: async (input) => {
          calls++;
          expect(input.kind).toBe("linux");
          expect(JSON.parse(input.content).dpkgStatus).toContain(
            "Source: openssl",
          );
          const at = new Date().toISOString(),
            metadata = {
              UpdatedAt: at,
              NextUpdate: new Date(Date.now() + 86400000).toISOString(),
            };
          return {
            status: "succeeded",
            toolVersion: "fixture",
            argv: ["rootfs", "--pkg-types", "os"],
            startedAt: at,
            finishedAt: at,
            exitCode: 0,
            signal: null,
            stderr: "",
            databaseBefore: metadata,
            databaseAfter: metadata,
            rawReport: JSON.stringify({
              SchemaVersion: 2,
              Metadata: { OS: { Family: "ubuntu", Name: "24.04" } },
              Results: [
                {
                  Target: "ubuntu",
                  Class: "os-pkgs",
                  Type: "ubuntu",
                  Packages: [{ Name: "libssl3", Version: "3.0.1" }],
                  Vulnerabilities: [
                    {
                      VulnerabilityID: "CVE-2026-12345",
                      PkgName: "libssl3",
                      InstalledVersion: "3.0.1",
                      Severity: "HIGH",
                      FixedVersion: "3.0.2",
                    },
                  ],
                },
              ],
            }),
          };
        },
      },
    },
  );
  const h = request(app.getHttpServer());
  const asset = (
    await h
      .post(base + "/assets")
      .set(auth)
      .send({ name: "Linux", kind: "host" })
      .expect(201)
  ).body;
  const data = {
    schemaVersion: "ys-host/1",
    identity: { hostname: "Linux" },
    collectedAt: null,
    sections: {
      os: {
        status: "acquired",
        data: {
          id: "ubuntu",
          version: "24.04",
          kernel: "6.8",
          architecture: "x86_64",
        },
      },
      packages: {
        status: "acquired",
        data: [
          {
            manager: "dpkg",
            name: "libssl3",
            version: "3.0.1",
            architecture: "amd64",
            state: "installed",
          },
        ],
      },
    },
    extensions: {
      rawSections: {
        os: 'ID=ubuntu\nVERSION_ID="24.04"\n',
        lsbRelease: "DISTRIB_ID=Ubuntu\nDISTRIB_RELEASE=24.04\n",
        dpkgStatus:
          "Package: libssl3\nStatus: install ok installed\nArchitecture: amd64\nVersion: 3.0.1\nSource: openssl\n\n",
      },
    },
  };
  const snapshot = (
    await h
      .post(base + "/collections/manual")
      .set(auth)
      .send({ assetId: asset.id, note: "fixed input", data })
      .expect(201)
  ).body;
  const inconsistent = structuredClone(data);
  inconsistent.extensions.rawSections.dpkgStatus +=
    inconsistent.extensions.rawSections.dpkgStatus;
  inconsistent.sections.packages.data.push({
    ...inconsistent.sections.packages.data[0],
    name: "unscanned",
  });
  const bad = (
    await h
      .post(base + "/collections/manual")
      .set(auth)
      .send({
        assetId: asset.id,
        note: "Inconsistent package input",
        data: inconsistent,
      })
      .expect(201)
  ).body;
  await h
    .post(base + "/assessments")
    .set(auth)
    .send({
      assetId: asset.id,
      snapshotId: bad.id,
      idempotencyKey: "invalid-inventory",
    })
    .expect(400);
  const missing = structuredClone(data);
  missing.extensions.rawSections.lsbRelease = "";
  const old = (
    await h
      .post(base + "/collections/manual")
      .set(auth)
      .send({ assetId: asset.id, note: "Missing release input", data: missing })
      .expect(201)
  ).body;
  await h
    .post(base + "/assessments")
    .set(auth)
    .send({
      assetId: asset.id,
      snapshotId: old.id,
      idempotencyKey: "missing-release",
    })
    .expect(400);
  const body = {
    assetId: asset.id,
    snapshotId: snapshot.id,
    idempotencyKey: "linux-1",
  };
  const job = (
    await h
      .post(base + "/assessments")
      .set(auth)
      .send(body)
      .expect(202)
  ).body;
  let done = job;
  for (let i = 0; i < 100 && ["queued", "running"].includes(done.status); i++) {
    await new Promise((r) => setTimeout(r, 10));
    done = (
      await h
        .get(base + `/assessments/${job.id}`)
        .set(auth)
        .expect(200)
    ).body;
  }
  expect(done).toMatchObject({
    status: "succeeded",
    target: { kind: "linux", assetId: asset.id, snapshotId: snapshot.id },
    result: {
      findings: [{ vulnerabilityId: "CVE-2026-12345" }],
      coverage: { matchedComponents: 1, inputComponents: 1, status: "partial" },
    },
  });
  await h
    .post(base + "/assessments")
    .set(auth)
    .send(body)
    .expect(202);
  expect(calls).toBe(1);
  const paged = (
    await h
      .get(base + `/assessments/${job.id}?findingsOffset=0`)
      .set(auth)
      .expect(200)
  ).body;
  expect(paged.findingsPage).toEqual({ total: 1, offset: 0, limit: 50 });
  expect(paged.execution.rawReport).toBeUndefined();
  expect(paged.execution.outputHash).toBeTruthy();
  const next = (
    await h
      .get(base + `/assessments/${job.id}?findingsOffset=50`)
      .set(auth)
      .expect(200)
  ).body;
  expect(next.result.findings).toHaveLength(0);
  expect(next.findingsPage.total).toBe(1);
  await h
    .get(base + `/assessments/${job.id}?findingsOffset=-1`)
    .set(auth)
    .expect(400);
  await h.post("/api/customers/b/assessments").set(auth).send(body).expect(404);
  const overview = (
    await h
      .post(base + "/dashboard/view")
      .set(auth)
      .send({ selectionMode: "current" })
      .expect(200)
  ).body;
  expect(overview.metrics.cve.uniqueCves).toBe(1);
  expect(overview.objects[0].id).toBe(asset.id);
  expect(overview.objects[0].toolVersion).toBe("fixture");
  const report = (
    await h
      .post(base + "/reports")
      .set(auth)
      .send({ assessmentRefs: [job.id] })
      .expect(201)
  ).body;
  expect(report.revision.facts.assessmentSnapshots[0].input.snapshotHash).toBe(
    snapshot.contentHash,
  );
  await h
    .delete(base + `/assets/${asset.id}`)
    .set(auth)
    .expect(200);
  await h
    .post(base + "/assessments")
    .set(auth)
    .send({ ...body, idempotencyKey: "linux-2" })
    .expect(409);
  await h
    .get(base + `/assessments/${job.id}`)
    .set(auth)
    .expect(200);
});
