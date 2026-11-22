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
          await new Promise((resolve) => setTimeout(resolve, 150));
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
                  Packages: [
                    {
                      Name: "libssl3",
                      Version: "3.0.1",
                      Epoch: 1,
                      Release: "0ubuntu1",
                      Arch: "amd64",
                    },
                  ],
                  Vulnerabilities: [
                    {
                      VulnerabilityID: "CVE-2026-12345",
                      PkgName: "libssl3",
                      InstalledVersion: "1:3.0.1-0ubuntu1",
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
            version: "1:3.0.1-0ubuntu1",
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
          "Package: libssl3\nStatus: hold ok installed\nArchitecture: amd64\nVersion: 1:3.0.1-0ubuntu1\nSource: openssl\n\n",
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
  const liveStream = h
    .get(base + `/assessments/${job.id}/events`)
    .set(auth)
    .timeout(5000)
    .then((r) => r);
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
  const stream = await liveStream;
  expect(stream.status).toBe(200);
  expect(stream.text).toMatch(/"status":"(queued|running)"/);
  expect(stream.headers["content-type"]).toContain("text/event-stream");
  expect(stream.text).toContain("event: progress");
  expect(stream.text).toContain('"status":"succeeded"');
  expect(stream.text).not.toContain("findings");
  expect(stream.text).not.toContain("rawReport");
  await h
    .get(`/api/customers/b/assessments/${job.id}/events`)
    .set(auth)
    .expect(404);
  await h.get(base + `/assessments/${job.id}/events`).expect(401);

  const paged = (
    await h
      .get(base + `/assessments/${job.id}?findingsOffset=0`)
      .set(auth)
      .expect(200)
  ).body;
  expect(paged.findingsPage).toEqual({ total: 1, offset: 0, limit: 50 });
  for (const [search, count] of [
    ["LiBSSL3", 1],
    ["CVE-2026-12345", 1],
    ["1:3.0.1", 1],
    ["missing", 0],
    ["%", 0],
    ["_", 0],
  ] as const) {
    const found = (
      await h
        .get(
          base +
            `/assessments/${job.id}?findingsOffset=0&severities=HIGH&search=${encodeURIComponent(search)}`,
        )
        .set(auth)
        .expect(200)
    ).body;
    expect(found.findingsPage).toMatchObject({
      total: count,
      unfilteredTotal: 1,
      search,
    });
    expect(found.result.findings).toHaveLength(count);
  }
  const high = (
    await h
      .get(
        base +
          `/assessments/${job.id}?findingsOffset=0&severities=CRITICAL,HIGH`,
      )
      .set(auth)
      .expect(200)
  ).body;
  expect(high.findingsPage).toMatchObject({
    total: 1,
    unfilteredTotal: 1,
    severities: ["CRITICAL", "HIGH"],
  });
  const low = (
    await h
      .get(base + `/assessments/${job.id}?findingsOffset=0&severities=LOW`)
      .set(auth)
      .expect(200)
  ).body;
  expect(low.findingsPage).toMatchObject({ total: 0, unfilteredTotal: 1 });
  expect(low.result.findings).toEqual([]);
  expect(low.execution.outputHash).toBe(paged.execution.outputHash);
  await h
    .get(base + `/assessments/${job.id}?findingsOffset=0&severities=INVALID`)
    .set(auth)
    .expect(400);
  await h
    .get(base + `/assessments/${job.id}?severities=HIGH`)
    .set(auth)
    .expect(400);
  expect(paged.execution.rawReport).toBeUndefined();
  expect(paged.artifact).toBeUndefined();
  const ref = paged.result.findings[0].evidence;
  expect(ref).toMatchObject({
    reportSha256: done.execution.outputHash,
    resultIndex: 0,
    vulnerabilityIndex: 0,
  });
  expect(
    JSON.parse(done.execution.rawReport).Results[ref.resultIndex]
      .Vulnerabilities[ref.vulnerabilityIndex].VulnerabilityID,
  ).toBe("CVE-2026-12345");
  expect(paged.execution.outputHash).toBeTruthy();
  const evidence = (
    await h
      .get(base + `/assessments/${job.id}/report`)
      .set(auth)
      .expect(200)
  ).body;
  expect(evidence.content).toBe(done.execution.rawReport);
  expect(evidence.contentHash).toBe(done.execution.outputHash);
  await h
    .get(`/api/customers/b/assessments/${job.id}/report`)
    .set(auth)
    .expect(404);
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
  expect(
    report.revision.facts.assessmentSnapshots[0].execution.rawReport,
  ).toBeUndefined();
  expect(report.revision.facts.sourceRefs[0].outputHash).toBe(
    done.execution.outputHash,
  );
  const preview = await h
    .get(base + `/reports/${report.id}/preview`)
    .set(auth)
    .expect(200);
  expect(preview.text).toContain("CVE Linux系统包评估");
  expect(preview.text).toContain(done.execution.outputHash);
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
  // Seed the old on-disk representation to exercise upgrade/restart compaction.
  await app.close();
  const { PGlite } = await import("@electric-sql/pglite");
  const seed = new PGlite(dir);
  const legacy = structuredClone(done);
  legacy.result.findings[0].evidence = JSON.parse(
    legacy.execution.rawReport,
  ).Results[0].Vulnerabilities[0];
  await seed.query(
    "UPDATE vulnerability_jobs SET details=$2::jsonb WHERE id=$1",
    [job.id, JSON.stringify(legacy)],
  );
  await seed.close();
  for (let restart = 0; restart < 2; restart++) {
    app = await createApp({
      databaseUrl: `pglite://${dir}`,
      customers: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      operators: [
        { name: "T", token: "linux-assessment-test", customerIds: ["a", "b"] },
      ],
    });
    const restored = (
      await request(app.getHttpServer())
        .get(base + `/assessments/${job.id}`)
        .set(auth)
        .expect(200)
    ).body;
    expect(restored.id).toBe(job.id);
    expect(restored.status).toBe("succeeded");
    expect(restored.result.findings).toHaveLength(1);
    expect(restored.execution.rawReport).toBe(done.execution.rawReport);
    expect(restored.execution.outputHash).toBe(done.execution.outputHash);
    expect(restored.artifact).toBeUndefined();
    expect(restored.result.findings[0].evidence).toEqual(ref);
    const history = (
      await request(app.getHttpServer())
        .get(base + `/assessments?targetKind=linux&targetId=${asset.id}`)
        .set(auth)
        .expect(200)
    ).body;
    expect(history.items[0]).toMatchObject({
      id: job.id,
      status: "succeeded",
      findingCount: 1,
    });
    if (restart === 0) await app.close();
  }
});
