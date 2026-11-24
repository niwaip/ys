import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, dir: string;
const auth = { Authorization: "Bearer dashboard-test-secret" };
const cfg = {
  customers: [
    { id: "acme", name: "A" },
    { id: "river", name: "R" },
  ],
  operators: [
    {
      token: "dashboard-test-secret",
      name: "T",
      customerIds: ["acme", "river"],
    },
  ],
};
afterEach(async () => {
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
async function start() {
  dir = await mkdtemp(join(tmpdir(), "ys-dashboard-"));
  app = await createApp({ ...cfg, databaseUrl: `pglite://${dir}` });
  return request(app.getHttpServer());
}
test("客户概览空数据保持未知，未选当前批次不隐式使用旧评估", async () => {
  const h = await start();
  const empty = (
    await h
      .post("/api/customers/acme/dashboard/view")
      .set(auth)
      .send({})
      .expect(200)
  ).body;
  expect(empty.metrics.cve.uniqueObserved).toBeNull();
  expect(empty.metrics.lifecycle.status).toBe("unselected");
  const s = (
    await h
      .post("/api/customers/acme/software")
      .set(auth)
      .send({ name: "Bill" })
      .expect(201)
  ).body;
  const v = (
    await h
      .post(`/api/customers/acme/software/${s.id}/sbom`)
      .set(auth)
      .send({
        fileName: "b.json",
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          metadata: {
            component: { type: "application", name: "Bill", version: "1" },
          },
          components: [
            {
              type: "library",
              name: "express",
              version: "1",
              purl: "pkg:npm/express@1",
            },
          ],
        }),
      })
      .expect(201)
  ).body;
  await h
    .put(`/api/customers/acme/software/${s.id}/history/current`)
    .set(auth)
    .send({ versionId: v.id })
    .expect(200);
  const result = (
    await h
      .post("/api/customers/acme/dashboard/view")
      .set(auth)
      .send({})
      .expect(200)
  ).body;
  expect(result).toMatchObject({
    metrics: {
      inventory: { software: 1 },
      components: { known: 1 },
      cve: { uniqueObserved: null },
      coverage: { unselected: 1 },
    },
    objects: [
      { id: s.id, inputId: v.id, assessmentId: null, status: "unselected" },
    ],
  });
});
async function settle(h: ReturnType<typeof request>, id: string) {
  for (let n = 0; n < 100; n++) {
    const x = (
      await h.get(`/api/customers/acme/assessments/${id}`).set(auth).expect(200)
    ).body;
    if (!["queued", "running"].includes(x.status)) return x;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw Error("not settled");
}
test("按固定软件输入去重CVE并保留实例，明确范围与趋势覆盖，不累加历史", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-dashboard-facts-"));
  app = await createApp({ ...cfg, databaseUrl: `pglite://${dir}` }, [], {
    trivyExecutor: {
      execute: async (input) => {
        const v = JSON.parse(input.content).components[0].version;
        return {
          status: "succeeded",
          toolVersion: "fixture",
          argv: [],
          startedAt: "2026-11-18T00:00:00Z",
          finishedAt: "2026-11-18T00:00:01Z",
          exitCode: 0,
          signal: null,
          stderr: "fixture only",
          databaseBefore: null,
          databaseAfter: null,
          rawReport: JSON.stringify({
            SchemaVersion: 2,
            Results: [
              {
                Target: "first",
                Type: "npm",
                Packages:
                  v === "1"
                    ? [
                        {
                          Name: "express",
                          Version: v,
                          Identifier: { PURL: `pkg:npm/express@${v}` },
                        },
                      ]
                    : [],
                Vulnerabilities: (v === "1"
                  ? ["CVE-2026-0001", "CVE-2026-0001", "CVE-2026-0002"]
                  : ["CVE-2026-0001"]
                ).map((id) => ({
                  VulnerabilityID: id,
                  PkgName: "express",
                  InstalledVersion: v,
                  PkgIdentifier: { PURL: `pkg:npm/express@${v}` },
                  Severity: "HIGH",
                })),
              },
            ],
          }),
        };
      },
    },
  });
  const h = request(app.getHttpServer()),
    s = (
      await h
        .post("/api/customers/acme/software")
        .set(auth)
        .send({ name: "Bill" })
    ).body;
  const version = async (v: string) =>
    (
      await h
        .post(`/api/customers/acme/software/${s.id}/sbom`)
        .set(auth)
        .send({
          fileName: `${v}.json`,
          content: JSON.stringify({
            bomFormat: "CycloneDX",
            specVersion: "1.5",
            metadata: {
              component: { type: "application", name: "Bill", version: v },
            },
            components: [
              {
                type: "library",
                name: "express",
                version: v,
                purl: `pkg:npm/express@${v}`,
              },
            ],
          }),
        })
        .expect(201)
    ).body;
  const v1 = await version("1"),
    first = await settle(
      h,
      (
        await h
          .post("/api/customers/acme/assessments")
          .set(auth)
          .send({ softwareId: s.id, versionId: v1.id, idempotencyKey: "one" })
      ).body.id,
    );
  await h
    .put(`/api/customers/acme/software/${s.id}/history/current`)
    .set(auth)
    .send({ versionId: v1.id, assessmentId: first.id })
    .expect(200);
  const v2 = await version("2"),
    second = await settle(
      h,
      (
        await h
          .post("/api/customers/acme/assessments")
          .set(auth)
          .send({ softwareId: s.id, versionId: v2.id, idempotencyKey: "two" })
      ).body.id,
    );
  const view = async (body: object) =>
    (
      await h
        .post("/api/customers/acme/dashboard/view")
        .set(auth)
        .send(body)
        .expect(200)
    ).body;
  const current = await view({ trendMode: "object_history" });
  expect(current.metrics.cve).toMatchObject({
    uniqueObserved: 2,
    uniqueCves: 2,
    instances: 3,
    confirmedAffectedObjects: null,
    toolReportedObjects: 1,
  });
  expect(current.objects[0].assessmentId).toBe(first.id);
  expect(current.trend).toMatchObject({
    total: 2,
    items: [
      { assessmentId: first.id, instances: 3 },
      {
        assessmentId: second.id,
        instances: 1,
        inputChanged: true,
        coverageChanged: true,
        comparableWithPrevious: false,
      },
    ],
  });
  const frozen = (
    await h
      .post("/api/customers/acme/dashboard/overview")
      .set(auth)
      .send({})
      .expect(201)
  ).body;
  await h
    .put(`/api/customers/acme/software/${s.id}/history/current`)
    .set(auth)
    .send({ versionId: v2.id, assessmentId: second.id })
    .expect(200);
  const frozenHigh = (
    await h
      .post("/api/customers/acme/dashboard/findings")
      .set(auth)
      .send({ scopeId: frozen.id, severity: "high", offset: 1, limit: 2 })
      .expect(200)
  ).body;
  expect(frozenHigh).toMatchObject({
    total: 3,
    offset: 1,
    limit: 2,
    assessmentRefs: [first.id],
  });
  expect(frozenHigh.items).toHaveLength(2);
  expect(
    frozenHigh.items.every(
      (f: { assessmentId: string }) => f.assessmentId === first.id,
    ),
  ).toBe(true);
  expect(
    (
      await h
        .post("/api/customers/acme/dashboard/findings")
        .set(auth)
        .send({ scopeId: frozen.id, severity: "critical" })
        .expect(200)
    ).body.total,
  ).toBe(0);
  await h
    .post("/api/customers/acme/dashboard/findings")
    .set(auth)
    .send({ scopeId: frozen.id, severity: "invalid" })
    .expect(400);
  await h
    .post("/api/customers/acme/dashboard/findings")
    .set(auth)
    .send({ scopeId: frozen.id, assessmentRefs: [first.id] })
    .expect(400);
  await h
    .put(`/api/customers/acme/software/${s.id}/history/current`)
    .set(auth)
    .send({ versionId: v1.id, assessmentId: first.id })
    .expect(200);
  const selected = await view({
    assessmentRefs: [second.id],
    object: { kind: "software", id: s.id },
  });
  expect(selected.metrics.cve).toMatchObject({
    uniqueObserved: 1,
    instances: 1,
  });
  expect(selected.objects[0].inputId).toBe(v2.id);
  const objectScope = { object: { kind: "software", id: s.id } };
  const implicitDetail = (
    await h
      .post("/api/customers/acme/dashboard/findings")
      .set(auth)
      .send(objectScope)
      .expect(200)
  ).body;
  expect(implicitDetail).toMatchObject({
    total: 3,
    assessmentRefs: [first.id],
  });
  const other = (
    await h
      .post("/api/customers/acme/software")
      .set(auth)
      .send({ name: "Other" })
  ).body;
  for (const endpoint of ["view", "findings"]) {
    await h
      .post(`/api/customers/acme/dashboard/${endpoint}`)
      .set(auth)
      .send({
        object: { kind: "software", id: other.id },
        assessmentRefs: [first.id],
      })
      .expect(400);
    await h
      .post(`/api/customers/acme/dashboard/${endpoint}`)
      .set(auth)
      .send({ assessmentRefs: [first.id, first.id] })
      .expect(400);
  }
  const detail = (
    await h
      .post("/api/customers/acme/dashboard/findings")
      .set(auth)
      .send({ assessmentRefs: [first.id], limit: 1, offset: 1 })
      .expect(200)
  ).body;
  expect(detail).toMatchObject({ total: 3, limit: 1, offset: 1 });
  expect(detail.items[0].assessmentId).toBe(first.id);
  await h
    .post("/api/customers/river/dashboard/view")
    .set(auth)
    .send({ assessmentRefs: [first.id] })
    .expect(404);
  await h
    .post("/api/customers/acme/dashboard/view")
    .set(auth)
    .send({ assessmentRefs: [first.id, second.id] })
    .expect(400);
  const excluded = await view({ ...objectScope, from: "2099-01-01T00:00:00Z" });
  expect(excluded.metrics.cve.uniqueObserved).toBeNull();
  expect(excluded.objects[0].status).toBe("outside_time_range");
  const excludedDetail = (
    await h
      .post("/api/customers/acme/dashboard/findings")
      .set(auth)
      .send({ ...objectScope, from: "2099-01-01T00:00:00Z" })
      .expect(200)
  ).body;
  expect(excludedDetail).toMatchObject({
    items: [],
    total: 0,
    assessmentRefs: excluded.scope.assessmentRefs,
  });
  await h
    .post("/api/customers/river/dashboard/findings")
    .set(auth)
    .send({ assessmentRefs: [first.id] })
    .expect(404);
});

test("容器失败与Windows fixed单独披露，EOS固定评估匹配同一对象范围并分页目录", async () => {
  const h = await start();
  const manual = (
    await h
      .post("/api/customers/acme/assets")
      .set(auth)
      .send({
        name: "Lifecycle host",
        kind: "host",
        attributes: { product: "Widget", version: "1" },
      })
      .expect(201)
  ).body;
  const win = (
    await h
      .post("/api/customers/acme/windows/imports")
      .set(auth)
      .send({
        fileName: "win.json",
        content: JSON.stringify({
          Hostname: "Windows",
          SerialNumber: "unique-win",
          OS: "Windows Server 2022",
          OSBuild: "20348",
          UBR: 2700,
          Architecture: "x64",
          CollectedAt: "2026-11-18T00:00:00Z",
          InstalledKBs: [],
          KBInventoryComplete: true,
          RebootPending: false,
          CollectionStatus: { Overall: "COMPLETE" },
        }),
      })
      .expect(201)
  ).body;
  const { readFile } = await import("node:fs/promises");
  const rule = (
    await h
      .post("/api/customers/acme/windows/rules")
      .set(auth)
      .send({
        fileName: "rules.json",
        content: await readFile("tests/fixtures/windows/rules.json", "utf8"),
      })
      .expect(201)
  ).body;
  const windows = await settle(
    h,
    (
      await h
        .post("/api/customers/acme/assessments")
        .set(auth)
        .send({
          snapshotId: win.snapshotId,
          ruleImportId: rule.id,
          idempotencyKey: "win",
        })
        .expect(202)
    ).body.id,
  );
  const image = (
    await h
      .post("/api/customers/acme/containers")
      .set(auth)
      .send({ name: "image", source: "test-pipeline" })
      .expect(201)
  ).body;
  const version = (
    await h
      .post(`/api/customers/acme/containers/${image.id}/sbom`)
      .set(auth)
      .send({
        fileName: "image.json",
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          metadata: {
            component: { type: "container", name: "image", version: "1" },
          },
          components: [{ type: "library", name: "openssl", version: "1" }],
        }),
      })
      .expect(201)
  ).body;
  const container = await settle(
    h,
    (
      await h
        .post("/api/customers/acme/assessments")
        .set(auth)
        .send({
          containerId: image.id,
          versionId: version.id,
          idempotencyKey: "container",
        })
        .expect(202)
    ).body.id,
  );
  expect(container.status).toBe("unavailable");
  const batch = (
    await h
      .post("/api/customers/acme/lifecycle/batches")
      .set(auth)
      .send({
        fileName: "dates.csv",
        content:
          "source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nfixture,fixture-doc,Widget,1,end sales,2020-01-01,end support,",
      })
      .expect(201)
  ).body;
  const lifecycle = (
    await h
      .post("/api/customers/acme/lifecycle/assessments")
      .set(auth)
      .send({ batchId: batch.id, assetIds: [manual.id] })
      .expect(201)
  ).body;
  const view = (
    await h
      .post("/api/customers/acme/dashboard/view")
      .set(auth)
      .send({
        assessmentRefs: [windows.id, container.id],
        lifecycleAssessmentId: lifecycle.id,
      })
      .expect(200)
  ).body;
  expect(view.metrics).toMatchObject({
    inventory: { host: 2, container: 1 },
    cve: {
      uniqueObserved: 1,
      instances: 1,
      confirmedAffectedObjects: 0,
      byApplicability: { fixed: 1 },
    },
    coverage: { failed: 1, unselected: 1 },
    lifecycle: {
      status: "selected",
      coveredObjects: 1,
      eos: { reached: 1, unknown: 2 },
      eol: { unknown: 3 },
    },
  });
  expect(view.objects.find((x: any) => x.id === image.id)).toMatchObject({
    status: "unavailable",
    inputId: version.id,
  });
  const catalog = (
    await h
      .get("/api/customers/acme/dashboard/catalog?limit=1&offset=1")
      .set(auth)
      .expect(200)
  ).body;
  expect(catalog).toMatchObject({
    objectTotal: 3,
    objectLimit: 1,
    objectOffset: 1,
    inventory: { host: 2, container: 1 },
  });
  expect(catalog.objects).toHaveLength(1);
  const outsideLifecycle = (
    await h
      .post("/api/customers/acme/dashboard/view")
      .set(auth)
      .send({
        lifecycleAssessmentId: lifecycle.id,
        from: "2099-01-01T00:00:00Z",
      })
      .expect(200)
  ).body;
  expect(outsideLifecycle.metrics.lifecycle).toMatchObject({
    status: "outside_time_range",
    assessmentId: lifecycle.id,
    eos: null,
  });
  await h
    .post("/api/customers/river/dashboard/view")
    .set(auth)
    .send({ lifecycleAssessmentId: lifecycle.id })
    .expect(404);
  await h.post("/api/customers/acme/dashboard/view").send({}).expect(401);
});

test("当前概览默认解析每对象单批次，删除主机排除当前统计但可读取历史", async () => {
  const h = await start();
  const base = "/api/customers/acme";
  const host = (
    await h
      .post(base + "/assets")
      .set(auth)
      .send({
        name: "在管主机",
        kind: "host",
        attributes: { product: "Device", version: "1" },
      })
      .expect(201)
  ).body;
  const sw = (
    await h
      .post(base + "/software")
      .set(auth)
      .send({ name: "当前软件" })
      .expect(201)
  ).body;
  const v = (
    await h
      .post(base + `/software/${sw.id}/sbom`)
      .set(auth)
      .send({
        fileName: "current.json",
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          metadata: {
            component: { type: "application", name: "当前软件", version: "1" },
          },
          components: [],
        }),
      })
      .expect(201)
  ).body;
  const first = (
    await h
      .post(base + "/assessments")
      .set(auth)
      .send({ softwareId: sw.id, versionId: v.id, idempotencyKey: "first" })
      .expect(202)
  ).body;
  await settle(h, first.id);
  const second = (
    await h
      .post(base + "/assessments")
      .set(auth)
      .send({ softwareId: sw.id, versionId: v.id, idempotencyKey: "second" })
      .expect(202)
  ).body;
  await settle(h, second.id);
  let view = (
    await h
      .post(base + "/dashboard/view")
      .set(auth)
      .send({ selectionMode: "current" })
      .expect(200)
  ).body;
  expect(view.scope.assessmentRefs).toEqual([second.id]);
  expect(view.metrics.coverage.failed).toBe(1);
  expect(view.metrics.cve.uniqueCves).toBeNull();
  await h
    .patch(base + `/assets/${host.id}/classification`)
    .set(auth)
    .send({ hardwareType: "network" })
    .expect(200);
  const endDate = new Date(Date.now() + 30 * 86400000)
    .toISOString()
    .slice(0, 10);
  const batch = (
    await h
      .post(base + "/lifecycle/batches")
      .set(auth)
      .send({
        fileName: "eosl.csv",
        content: `source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nVendor,fixture,Device,1,Sales,,Support,${endDate}`,
      })
      .expect(201)
  ).body;
  await h
    .post(base + "/lifecycle/assessments")
    .set(auth)
    .send({ batchId: batch.id, assetIds: [host.id], softwareTargets: [] })
    .expect(201);
  const network = (
    await h
      .post(base + "/dashboard/view")
      .set(auth)
      .send({ selectionMode: "current", hardwareType: "network" })
      .expect(200)
  ).body;
  expect(network.metrics.inventory.network).toBe(1);
  expect(network.metrics.lifecycle.upcoming90d).toBe(1);
  expect(network.objects.map((v: { id: string }) => v.id)).toEqual([host.id]);
  const drill = (
    await h
      .post(base + "/dashboard/findings")
      .set(auth)
      .send({
        hardwareType: "network",
        assessmentRefs: network.scope.assessmentRefs,
      })
      .expect(200)
  ).body;
  expect(drill.items).toEqual([]);
  await h
    .delete(base + `/assets/${host.id}`)
    .set(auth)
    .expect(200);
  view = (
    await h
      .post(base + "/dashboard/view")
      .set(auth)
      .send({ selectionMode: "current" })
      .expect(200)
  ).body;
  expect(view.metrics.inventory.host).toBe(0);
  expect(view.metrics.inventory.software).toBe(1);
  expect(
    (await h.get(base + "/dashboard/catalog").set(auth)).body.inventory.host,
  ).toBe(0);
  await h
    .get(base + `/assets/${host.id}`)
    .set(auth)
    .expect(200);
});

test("概览固定范围跨刷新和重启保持不变，客户隔离且响应不包含明细", async () => {
  const h = await start();
  await h
    .post("/api/customers/acme/assets")
    .set(auth)
    .send({ name: "first", kind: "host" })
    .expect(201);
  const summary = (
    await h
      .post("/api/customers/acme/dashboard/overview")
      .set(auth)
      .send({})
      .expect(201)
  ).body;
  expect(summary.metrics.inventory.host).toBe(1);
  expect(summary.objects).toBeUndefined();
  await h
    .post("/api/customers/acme/assets")
    .set(auth)
    .send({ name: "later", kind: "host" })
    .expect(201);
  const fixed = (
    await h
      .get(`/api/customers/acme/dashboard/scopes/${summary.id}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(fixed.metrics.inventory.host).toBe(1);
  expect(fixed.objects.map((o: { name: string }) => o.name)).toEqual(["first"]);
  await h
    .get(`/api/customers/river/dashboard/scopes/${summary.id}`)
    .set(auth)
    .expect(404);
  await h
    .post("/api/customers/river/dashboard/findings")
    .set(auth)
    .send({ scopeId: summary.id })
    .expect(404);
  await h
    .get(`/api/customers/acme/dashboard/scopes/not-a-uuid`)
    .set(auth)
    .expect(400);
  await app.close();
  app = await createApp({ ...cfg, databaseUrl: `pglite://${dir}` });
  expect(
    (
      await request(app.getHttpServer())
        .get(`/api/customers/acme/dashboard/scopes/${summary.id}`)
        .set(auth)
        .expect(200)
    ).body.metrics.inventory.host,
  ).toBe(1);
});

test("生命周期概要只返回数字及固定视图，接受风险不会消除等级", async () => {
  const h = await start();
  const asset = (
    await h
      .post("/api/customers/acme/assets")
      .set(auth)
      .send({ name: "summary-lifetime", kind: "host" })
      .expect(201)
  ).body;
  await h
    .patch(`/api/customers/acme/assets/${asset.id}/lifecycle`)
    .set(auth)
    .send({ warrantyUntil: "2020-01-01", sourceRef: "fixture contract" })
    .expect(200);
  const summary = (
    await h
      .get("/api/customers/acme/lifecycle-risk/summary")
      .set(auth)
      .expect(200)
  ).body;
  expect(summary.items).toBeUndefined();
  expect(summary.pendingItems).toBe(1);
  expect(summary.summary.byLevel.critical.assets).toBe(1);
  const fixed = (
    await h
      .get(`/api/customers/acme/lifecycle-risk/views/${summary.id}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(
    fixed.items.find((i: { type: string }) => i.type === "warranty").treatment
      .status,
  ).toBe("pending");
  await h
    .put(`/api/customers/acme/lifecycle-risk/treatments/${asset.id}/warranty`)
    .set(auth)
    .send({
      status: "accepted",
      owner: "T",
      note: "fixture acceptance",
      acceptedUntil: "2099-01-01",
    })
    .expect(200);
  const after = (
    await h
      .get("/api/customers/acme/lifecycle-risk/summary")
      .set(auth)
      .expect(200)
  ).body;
  expect(after.pendingItems).toBe(0);
  expect(after.summary.byLevel.critical.assets).toBe(1);
  expect(after.summary.acceptedItems).toBe(1);
  await h
    .get(`/api/customers/river/lifecycle-risk/views/${summary.id}`)
    .set(auth)
    .expect(404);
});
