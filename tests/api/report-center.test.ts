import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";

let app: Awaited<ReturnType<typeof createApp>>, directory: string;
const auth = { Authorization: "Bearer report-center-test" };
const config = {
  customers: [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ],
  operators: [
    {
      token: "report-center-test",
      name: "Report author",
      customerIds: ["a", "b"],
    },
  ],
};
afterEach(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function linuxHost(
  http: ReturnType<typeof request>,
  name: string,
  version = "1",
) {
  const asset = (
    await http
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name, kind: "host" })
      .expect(201)
  ).body;
  await http
    .patch(`/api/customers/a/assets/${asset.id}/classification`)
    .set(auth)
    .send({ hardwareType: "server" })
    .expect(200);
  return {
    asset,
    snapshot: await linuxSnapshot(http, asset.id, name, version),
  };
}
async function linuxSnapshot(
  http: ReturnType<typeof request>,
  assetId: string,
  name: string,
  version: string,
  confirm = true,
) {
  const data = {
    schemaVersion: "ys-host/1",
    identity: { hostname: name },
    collectedAt: "2026-10-01T00:00:00Z",
    sections: {
      os: {
        status: "acquired",
        data: {
          id: "ubuntu",
          version: "24.04",
          architecture: "amd64",
          kernel: null,
        },
      },
      packages: {
        status: "acquired",
        data: [
          {
            manager: "dpkg",
            name: "libssl3",
            version,
            architecture: "amd64",
            state: "installed",
          },
        ],
      },
    },
    extensions: {
      rawSections: {
        os: "ID=ubuntu\nVERSION_ID=24.04\n",
        lsbRelease: "DISTRIB_ID=Ubuntu\nDISTRIB_RELEASE=24.04\n",
        dpkgStatus: `Package: libssl3\nStatus: install ok installed\nArchitecture: amd64\nVersion: ${version}\n\n`,
      },
    },
  };
  const snapshot = (
    await http
      .post("/api/customers/a/collections/manual")
      .set(auth)
      .send({ assetId, note: "report fixture", data })
      .expect(201)
  ).body;
  if (!confirm) return snapshot;
  const baseline = (
    await http
      .get(`/api/customers/a/assets/${assetId}/baseline`)
      .set(auth)
      .expect(200)
  ).body;
  await http
    .post(`/api/customers/a/assets/${assetId}/baseline/confirm`)
    .set(auth)
    .send({
      snapshotId: snapshot.id,
      expectedBaselineId: baseline.current?.id ?? null,
      idempotencyKey: `adopt-${snapshot.id}`,
      sections: ["os", "packages"],
      writeMasterData: false,
    })
    .expect(201);
  return snapshot;
}

test("当前资料匹配与历史批次显式选择互相独立", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-selection-"));
  app = await createApp(
    { ...config, databaseUrl: `pglite://${directory}` },
    [],
    {
      trivyExecutor: {
        execute: async () => ({
          status: "succeeded",
          toolVersion: "fixture",
          argv: ["fixture"],
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          exitCode: 0,
          signal: null,
          stderr: "",
          databaseBefore: null,
          databaseAfter: null,
          rawReport: JSON.stringify({
            SchemaVersion: 2,
            Metadata: { OS: { Family: "ubuntu", Name: "24.04" } },
            Results: [
              {
                Target: "ubuntu",
                Class: "os-pkgs",
                Type: "ubuntu",
                Packages: [{ Name: "libssl3", Version: "1", Arch: "amd64" }],
                Vulnerabilities: [
                  {
                    VulnerabilityID: "CVE-2026-12345",
                    PkgName: "libssl3",
                    InstalledVersion: "1",
                    Severity: "HIGH",
                  },
                ],
              },
            ],
          }),
        }),
      },
    },
  );
  const http = request(app.getHttpServer());
  const { asset, snapshot } = await linuxHost(http, "versioned-host");
  const job = (
    await http
      .post("/api/customers/a/assessments")
      .set(auth)
      .send({
        assetId: asset.id,
        snapshotId: snapshot.id,
        idempotencyKey: "version-one",
      })
      .expect(202)
  ).body;
  await expect
    .poll(
      async () =>
        (await http.get(`/api/customers/a/assessments/${job.id}`).set(auth))
          .body.status,
    )
    .toBe("succeeded");
  const create = async (key: string, extra: Record<string, unknown> = {}) =>
    (
      await http
        .post("/api/customers/a/report-center/tasks")
        .set(auth)
        .send({
          name: key,
          scope: { kind: "selected", assetIds: [asset.id] },
          mode: "existing",
          idempotencyKey: key,
          ...extra,
        })
        .expect(202)
    ).body;
  const first = await create("current-version-one");
  expect(first.hosts[0].freshness).toEqual({
    collection: "stale",
    assessment: "fresh",
  });
  const relaxed = await create("relaxed-freshness", { freshnessDays: 365 });
  expect(relaxed.hosts[0].freshness.collection).toBe("fresh");
  const choices = (
    await http
      .get(`/api/customers/a/report-center/hosts/${asset.id}/assessments`)
      .set(auth)
      .expect(200)
  ).body;
  expect(choices.items.map((item: { id: string }) => item.id)).toContain(
    job.id,
  );
  expect(first.hosts[0].assessmentRefs).toEqual([job.id]);
  const hardwareOnly = (
    await http
      .post("/api/customers/a/collections/manual")
      .set(auth)
      .send({
        assetId: asset.id,
        note: "hardware-only",
        data: {
          schemaVersion: "ys-host/1",
          identity: { hostname: "versioned-host" },
          collectedAt: "2026-11-24T00:00:00Z",
          sections: {
            hardware: { status: "acquired", data: { vendor: "fixture" } },
          },
        },
      })
      .expect(201)
  ).body;
  const baseline = (
    await http
      .get(`/api/customers/a/assets/${asset.id}/baseline`)
      .set(auth)
      .expect(200)
  ).body;
  await http
    .post(`/api/customers/a/assets/${asset.id}/baseline/confirm`)
    .set(auth)
    .send({
      snapshotId: hardwareOnly.id,
      expectedBaselineId: baseline.current.id,
      idempotencyKey: "hardware-adopt",
      sections: ["hardware"],
      writeMasterData: false,
    })
    .expect(201);
  expect((await create("after-hardware-only")).hosts[0].assessmentRefs).toEqual(
    [job.id],
  );
  await linuxSnapshot(http, asset.id, "versioned-host", "2");
  const current = await create("current-version-two");
  expect(current.hosts[0].assessmentRefs).toEqual([]);
  const historical = await create("explicit-history", {
    overrides: [{ objectId: asset.id, assessmentId: job.id }],
  });
  expect(historical.hosts[0].assessmentRefs).toEqual([job.id]);
  expect(historical.hosts[0].issues.join(" ")).toContain("历史");
  const frozen = (
    await http
      .get(`/api/customers/a/reports/${first.reportId}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(frozen.revision.facts.assessmentSnapshots[0].target.snapshotId).toBe(
    snapshot.id,
  );
});

test("单台 Windows 报告匹配已发布资料，生命周期批次只纳入所选主机", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-windows-"));
  app = await createApp({ ...config, databaseUrl: `pglite://${directory}` });
  const http = request(app.getHttpServer());
  const imported = (
    await http
      .post("/api/customers/a/windows/imports")
      .set(auth)
      .send({
        fileName: "windows.json",
        content: JSON.stringify({
          Hostname: "report-windows",
          SerialNumber: "report-windows-1",
          OS: "Windows Server 2022",
          OSBuild: "20348",
          Architecture: "x64",
          CollectedAt: "2026-11-18T00:00:00Z",
          UBR: 2700,
          InstalledKBs: [],
          KBInventoryComplete: true,
          RebootPending: false,
          CollectionStatus: { Overall: "COMPLETE" },
        }),
      })
      .expect(201)
  ).body;
  await http
    .patch(`/api/customers/a/assets/${imported.assetId}/classification`)
    .set(auth)
    .send({ hardwareType: "server" })
    .expect(200);
  const other = (
    await http
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "not-selected", kind: "host" })
      .expect(201)
  ).body;
  const rules = (
    await http
      .post("/api/customers/a/windows/rules")
      .set(auth)
      .send({
        fileName: "rules.json",
        content: await readFile("tests/fixtures/windows/rules.json", "utf8"),
      })
      .expect(201)
  ).body;
  const assessment = (
    await http
      .post("/api/customers/a/assessments")
      .set(auth)
      .send({
        snapshotId: imported.snapshotId,
        ruleImportId: rules.id,
        idempotencyKey: "windows-report",
      })
      .expect(202)
  ).body;
  await expect
    .poll(
      async () =>
        (
          await http
            .get(`/api/customers/a/assessments/${assessment.id}`)
            .set(auth)
        ).body.status,
    )
    .toBe("succeeded");
  const batch = (
    await http
      .post("/api/customers/a/lifecycle/batches")
      .set(auth)
      .send({
        fileName: "lifecycle.csv",
        content:
          "source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nVendor,fixture,Windows,2022,Sales,2020-01-01,Support,2030-01-01",
      })
      .expect(201)
  ).body;
  await http
    .post("/api/customers/a/lifecycle/assessments")
    .set(auth)
    .send({ batchId: batch.id, assetIds: [imported.assetId, other.id] })
    .expect(201);
  const task = (
    await http
      .post("/api/customers/a/report-center/tasks")
      .set(auth)
      .send({
        name: "Windows report",
        scope: { kind: "selected", assetIds: [imported.assetId] },
        mode: "existing",
        idempotencyKey: "windows-with-lifecycle",
      })
      .expect(202)
  ).body;
  expect(task.hosts[0].assessmentRefs).toEqual([assessment.id]);
  const report = (
    await http
      .get(`/api/customers/a/reports/${task.reportId}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(
    report.revision.facts.lifecycleSnapshots.flatMap(
      (a: { items: { assetId: string }[] }) =>
        a.items.map((item) => item.assetId),
    ),
  ).toEqual([imported.assetId]);
  expect(JSON.stringify(report.revision.facts)).not.toContain(other.id);
});

test("租户全部范围完整跨过旧列表上限，范围创建后不随新增主机扩张", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-tenant-"));
  app = await createApp({ ...config, databaseUrl: `pglite://${directory}` });
  const http = request(app.getHttpServer()),
    ids: string[] = [];
  for (let i = 0; i < 101; i++) {
    const asset = (
      await http
        .post("/api/customers/a/assets")
        .set(auth)
        .send({ name: `server-${i}`, kind: "host" })
        .expect(201)
    ).body;
    await http
      .patch(`/api/customers/a/assets/${asset.id}/classification`)
      .set(auth)
      .send({ hardwareType: "server" })
      .expect(200);
    ids.push(asset.id);
  }
  const network = (
    await http
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "network-only", kind: "host" })
      .expect(201)
  ).body;
  await http
    .patch(`/api/customers/a/assets/${network.id}/classification`)
    .set(auth)
    .send({ hardwareType: "network" })
    .expect(200);
  const task = (
    await http
      .post("/api/customers/a/report-center/tasks")
      .set(auth)
      .send({
        name: "全部服务器",
        scope: { kind: "tenant" },
        mode: "existing",
        idempotencyKey: "all-servers",
      })
      .expect(202)
  ).body;
  expect(task.hosts).toHaveLength(101);
  expect(
    task.hosts.map((host: { assetId: string }) => host.assetId).sort(),
  ).toEqual(ids.sort());
  const after = (
    await http
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "added-later", kind: "host" })
      .expect(201)
  ).body;
  await http
    .patch(`/api/customers/a/assets/${after.id}/classification`)
    .set(auth)
    .send({ hardwareType: "server" })
    .expect(200);
  const frozen = (
    await http
      .get(`/api/customers/a/reports/${task.reportId}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(frozen.revision.facts.center.hosts).toHaveLength(101);
  expect(JSON.stringify(frozen)).not.toContain(after.id);
  const selected = (
    await http
      .post("/api/customers/a/report-center/tasks")
      .set(auth)
      .send({
        name: "两台",
        scope: { kind: "selected", assetIds: ids.slice(0, 2) },
        mode: "existing",
        idempotencyKey: "two-servers",
      })
      .expect(202)
  ).body;
  expect(selected.hosts).toHaveLength(2);
});

test("超过旧引用上限的真实评估能完整生成及预览，不被保护段落上限截断", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-many-assessments-"));
  app = await createApp({ ...config, databaseUrl: `pglite://${directory}` });
  const http = request(app.getHttpServer());
  const rules = (
    await http
      .post("/api/customers/a/windows/rules")
      .set(auth)
      .send({
        fileName: "rules.json",
        content: await readFile("tests/fixtures/windows/rules.json", "utf8"),
      })
      .expect(201)
  ).body;
  const jobs: string[] = [];
  for (let i = 0; i < 46; i++) {
    const snapshot = (
      await http
        .post("/api/customers/a/windows/imports")
        .set(auth)
        .send({
          fileName: `win-${i}.json`,
          content: JSON.stringify({
            Hostname: `WIN-${i}`,
            SerialNumber: `WIN-bulk-${i}`,
            OS: "Windows Server 2022",
            OSBuild: "20348",
            Architecture: "x64",
            UBR: 2700,
            InstalledKBs: [],
            KBInventoryComplete: true,
            RebootPending: false,
            CollectionStatus: { Overall: "COMPLETE" },
          }),
        })
        .expect(201)
    ).body;
    await http
      .patch(`/api/customers/a/assets/${snapshot.assetId}/classification`)
      .set(auth)
      .send({ hardwareType: "server" })
      .expect(200);
    const job = (
      await http
        .post("/api/customers/a/assessments")
        .set(auth)
        .send({
          snapshotId: snapshot.snapshotId,
          ruleImportId: rules.id,
          idempotencyKey: `bulk-${i}`,
        })
        .expect(202)
    ).body;
    jobs.push(job.id);
  }
  await expect
    .poll(
      async () =>
        Promise.all(
          jobs.map(
            async (id) =>
              (await http.get(`/api/customers/a/assessments/${id}`).set(auth))
                .body.status,
          ),
        ),
      { timeout: 15000 },
    )
    .toEqual(Array(46).fill("succeeded"));
  const task = (
    await http
      .post("/api/customers/a/report-center/tasks")
      .set(auth)
      .send({
        name: "46台完整评估",
        scope: { kind: "tenant" },
        mode: "existing",
        idempotencyKey: "bulk-46",
      })
      .expect(202)
  ).body;
  const report = (
    await http
      .get(`/api/customers/a/reports/${task.reportId}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(report.revision.facts.assessmentSnapshots).toHaveLength(46);
  const html = (
    await http
      .get(`/api/customers/a/reports/${task.reportId}/preview`)
      .set(auth)
      .expect(200)
  ).text;
  expect(html).toContain("WIN-45");
  expect(html).toContain("WIN-0");
});

test("共享镜像发现只计一次、涉及三台主机，未关联资料排除且期限风险冻结", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-shared-"));
  app = await createApp(
    { ...config, databaseUrl: `pglite://${directory}` },
    [],
    {
      trivyExecutor: {
        execute: async () => ({
          status: "succeeded",
          toolVersion: "fixture",
          argv: ["sbom"],
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          exitCode: 0,
          signal: null,
          stderr: "",
          databaseBefore: null,
          databaseAfter: null,
          rawReport: JSON.stringify({
            SchemaVersion: 2,
            Results: [
              {
                Target: "shared-image",
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
    },
  );
  const http = request(app.getHttpServer());
  const hosts: Awaited<ReturnType<typeof linuxHost>>[] = [];
  for (let i = 0; i < 3; i++)
    hosts.push(await linuxHost(http, `shared-host-${i}`));
  const image = (
    await http
      .post("/api/customers/a/containers")
      .set(auth)
      .send({ name: "shared-image", source: "fixture" })
      .expect(201)
  ).body;
  const version = (
    await http
      .post(`/api/customers/a/containers/${image.id}/sbom`)
      .set(auth)
      .send({
        fileName: "image.json",
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          metadata: {
            component: {
              type: "container",
              name: "shared-image",
              version: "1",
            },
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
      .expect(201)
  ).body;
  for (const { asset, snapshot } of hosts)
    await http
      .post("/api/customers/a/collections/links")
      .set(auth)
      .send({
        assetId: asset.id,
        snapshotId: snapshot.id,
        kind: "container",
        objectId: image.id,
        versionId: version.id,
        basis: "explicit shared deployment",
        imageId: `sha256:${"a".repeat(64)}`,
      })
      .expect(201);
  const unrelated = (
    await http
      .post("/api/customers/a/containers")
      .set(auth)
      .send({ name: "unrelated-image", source: "fixture" })
      .expect(201)
  ).body;
  const assessment = (
    await http
      .post("/api/customers/a/assessments")
      .set(auth)
      .send({
        containerId: image.id,
        versionId: version.id,
        idempotencyKey: "shared-once",
      })
      .expect(202)
  ).body;
  await expect
    .poll(
      async () =>
        (
          await http
            .get(`/api/customers/a/assessments/${assessment.id}`)
            .set(auth)
        ).body.status,
    )
    .toBe("succeeded");
  await http
    .patch(`/api/customers/a/assets/${hosts[0].asset.id}/lifecycle`)
    .set(auth)
    .send({ warrantyUntil: "2020-01-01", sourceRef: "contract-fixture" })
    .expect(200);
  const task = (
    await http
      .post("/api/customers/a/report-center/tasks")
      .set(auth)
      .send({
        name: "共享镜像",
        scope: { kind: "tenant" },
        mode: "existing",
        idempotencyKey: "shared-report",
      })
      .expect(202)
  ).body;
  const report = (
    await http
      .get(`/api/customers/a/reports/${task.reportId}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(report.revision.facts.statistics).toMatchObject({
    findingInstances: 1,
    uniqueCveCount: 1,
    involvedHostCount: 3,
    confirmedAffectedHostCount: 0,
  });
  expect(report.revision.facts.center.objects).toEqual([
    expect.objectContaining({
      objectId: image.id,
      versionId: version.id,
      hostIds: expect.arrayContaining(hosts.map((h) => h.asset.id)),
    }),
  ]);
  expect(JSON.stringify(report.revision.facts)).not.toContain(unrelated.id);
  const warranty = report.revision.facts.center.lifecycle.items.find(
    (item: { assetId: string; type: string }) =>
      item.assetId === hosts[0].asset.id && item.type === "warranty",
  );
  expect(warranty).toMatchObject({ dueDate: "2020-01-01", level: "critical" });
  const preview = (
    await http
      .get(`/api/customers/a/reports/${task.reportId}/preview`)
      .set(auth)
      .expect(200)
  ).text;
  expect(preview).toContain("关联软件与镜像");
  expect(preview).toContain("维保到期");
  expect(preview).toContain("contract-fixture");
  expect(preview).toContain("涉及服务器 3");
  await http
    .patch(`/api/customers/a/assets/${hosts[0].asset.id}/lifecycle`)
    .set(auth)
    .send({ warrantyUntil: "2035-01-01", sourceRef: "renewed" })
    .expect(200);
  expect(
    (
      await http
        .get(`/api/customers/a/reports/${task.reportId}`)
        .set(auth)
        .expect(200)
    ).body.revision.factHash,
  ).toBe(report.revision.factHash);
});

test("单台服务器无扫描结果仍形成可回读的固定覆盖草稿，不冒充零风险", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-center-"));
  const options = { ...config, databaseUrl: `pglite://${directory}` };
  app = await createApp(options);
  const http = request(app.getHttpServer());
  const asset = (
    await http
      .post("/api/customers/a/assets")
      .set(auth)
      .send({
        name: "unassessed-server",
        kind: "host",
        attributes: { hardwareType: "server" },
      })
      .expect(201)
  ).body;
  await http
    .patch(`/api/customers/a/assets/${asset.id}/classification`)
    .set(auth)
    .send({ hardwareType: "server" })
    .expect(200);
  const input = {
    name: "服务器巡检",
    scope: { kind: "selected", assetIds: [asset.id] },
    mode: "existing",
    idempotencyKey: "single-no-results",
  };
  const task = (
    await http
      .post("/api/customers/a/report-center/tasks")
      .set(auth)
      .send(input)
      .expect(202)
  ).body;
  expect(task.status).toBe("completed");
  const report = (
    await http
      .get(`/api/customers/a/reports/${task.reportId}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(report.name).toBe("服务器巡检");
  expect(report.revision.facts.center.hosts).toEqual([
    expect.objectContaining({
      assetId: asset.id,
      name: "unassessed-server",
      status: "unassessed",
    }),
  ]);
  expect(report.revision.facts.statistics.findingInstances).toBeNull();
  const html = (
    await http
      .get(`/api/customers/a/reports/${report.id}/preview`)
      .set(auth)
      .expect(200)
  ).text;
  expect(html).toContain("执行与覆盖说明");
  expect(html).toContain("unassessed-server");
  expect(html).toContain("尚未内部复核");
  await http
    .get(`/api/customers/b/report-center/tasks/${task.id}`)
    .set(auth)
    .expect(404);
  expect(
    (
      await http
        .post("/api/customers/a/report-center/tasks")
        .set(auth)
        .send(input)
        .expect(202)
    ).body.id,
  ).toBe(task.id);
  await app.close();
  app = await createApp(options);
  const reopened = request(app.getHttpServer());
  expect(
    (
      await reopened
        .get(`/api/customers/a/report-center/tasks/${task.id}`)
        .set(auth)
        .expect(200)
    ).body.reportId,
  ).toBe(report.id);
  expect(
    (
      await reopened
        .get(`/api/customers/a/reports/${report.id}`)
        .set(auth)
        .expect(200)
    ).body,
  ).toEqual(report);
});

test("专题和章节配置固定到修订，调整呈现保留事实并重新复核", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-template-"));
  app = await createApp({ ...config, databaseUrl: `pglite://${directory}` });
  const http = request(app.getHttpServer());
  const { asset } = await linuxHost(http, "template-server");
  const task = (
    await http
      .post("/api/customers/a/report-center/tasks")
      .set(auth)
      .send({
        name: "生命周期专题",
        scope: { kind: "selected", assetIds: [asset.id] },
        mode: "existing",
        presentation: {
          topic: "lifecycle",
          optionalChapters: ["summary", "recommendations"],
        },
        idempotencyKey: "template",
      })
      .expect(202)
  ).body;
  const url = `/api/customers/a/reports/${task.reportId}`;
  const original = (await http.get(url).set(auth).expect(200)).body.revision;
  expect(original.narrative.presentation.topic).toBe("lifecycle");
  let html = (await http.get(`${url}/preview`).set(auth).expect(200)).text;
  expect(html).toContain("管理摘要");
  expect(html).toContain("生命周期风险");
  expect(html).not.toContain("<h2>CVE 软件评估</h2>");
  expect(html).toContain("覆盖缺口与未知");
  expect(html).toContain("来源证据");
  let current = original;
  for (const action of ["submit-review", "approve", "deliver"])
    await http
      .post(`${url}/revisions/${original.id}/${action}`)
      .set(auth)
      .send({})
      .expect(201);
  const delivered = (
    await http
      .get(`${url}/revisions/${original.id}/export`)
      .set(auth)
      .expect(200)
  ).text;
  current = (
    await http
      .post(`${url}/revisions`)
      .set(auth)
      .send({
        baseRevisionId: original.id,
        narrative: {
          ...original.narrative,
          presentation: { topic: "vulnerability", optionalChapters: [] },
        },
      })
      .expect(201)
  ).body;
  expect(current.status).toBe("draft");
  expect(current.factHash).toBe(original.factHash);
  expect(current.facts).toEqual(original.facts);
  html = (await http.get(`${url}/preview`).set(auth).expect(200)).text;
  expect(html).toContain("<h2>CVE 软件评估</h2>");
  expect(html).not.toContain("<h2>生命周期风险</h2>");
  expect(html).not.toContain("<h2>管理摘要</h2>");
  expect(html).toContain("覆盖缺口与未知");
  expect(html).toContain("来源证据");
  await http
    .post(`${url}/revisions`)
    .set(auth)
    .send({
      baseRevisionId: current.id,
      narrative: {
        ...current.narrative,
        presentation: { topic: "combined", optionalChapters: ["coverage"] },
      },
    })
    .expect(400);
  expect(
    (
      await http
        .get(`${url}/revisions/${original.id}/export`)
        .set(auth)
        .expect(200)
    ).text,
  ).toBe(delivered);
  await http.get(`${url}/revisions/${current.id}/export`).set(auth).expect(409);
});

test("新评估任务持久绑定固定输入，失败保留缺口且只重试失败项", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-run-"));
  let calls = 0;
  app = await createApp(
    { ...config, databaseUrl: `pglite://${directory}` },
    [],
    {
      trivyExecutor: {
        execute: async () => {
          calls++;
          if (calls === 1) throw new Error("fixture unavailable");
          return {
            status: "succeeded",
            toolVersion: "fixture",
            argv: ["fixture"],
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            exitCode: 0,
            signal: null,
            stderr: "",
            databaseBefore: null,
            databaseAfter: null,
            rawReport: JSON.stringify({
              SchemaVersion: 2,
              Metadata: { OS: { Family: "ubuntu", Name: "24.04" } },
              Results: [
                {
                  Target: "ubuntu",
                  Class: "os-pkgs",
                  Type: "ubuntu",
                  Packages: [{ Name: "libssl3", Version: "1", Arch: "amd64" }],
                  Vulnerabilities: [],
                },
              ],
            }),
          };
        },
      },
    },
  );
  const http = request(app.getHttpServer());
  const { asset, snapshot } = await linuxHost(http, "new-scan");
  const input = {
    name: "新评估",
    scope: { kind: "selected", assetIds: [asset.id] },
    mode: "assess",
    idempotencyKey: "assess",
  };
  const task = (
    await http
      .post("/api/customers/a/report-center/tasks")
      .set(auth)
      .send(input)
      .expect(202)
  ).body;
  expect(task.reportId).toBeUndefined();
  expect(
    (
      await http
        .post("/api/customers/a/report-center/tasks")
        .set(auth)
        .send(input)
        .expect(202)
    ).body.id,
  ).toBe(task.id);
  const url = `/api/customers/a/report-center/tasks/${task.id}`;
  await expect
    .poll(async () => (await http.get(url).set(auth)).body.status)
    .toBe("needs_attention");
  const failed = (await http.get(url).set(auth).expect(200)).body;
  expect(failed.items[0].snapshotId).toBe(snapshot.id);
  expect(failed.items[0].status).toBe("failed");
  expect(calls).toBe(1);
  await http
    .post(`${url}/retry`)
    .set(auth)
    .send({ itemIds: [failed.items[0].id] })
    .expect(201);
  await expect
    .poll(async () => (await http.get(url).set(auth)).body.status)
    .toBe("completed");
  const complete = (await http.get(url).set(auth).expect(200)).body;
  expect(calls).toBe(2);
  const report = (
    await http
      .get(`/api/customers/a/reports/${complete.reportId}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(report.revision.facts.statistics.findingInstances).toBe(0);
  expect(report.revision.facts.center.hosts[0].freshness.collection).toBe(
    "stale",
  );
  await http
    .post(`${url}/retry`)
    .set(auth)
    .send({ itemIds: [complete.items[0].id] })
    .expect(409);
});

test("报告重新采集复用配置，上传绑定同一目标并等待既有资料确认", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-collect-"));
  app = await createApp(
    { ...config, databaseUrl: `pglite://${directory}` },
    [],
    {
      trivyExecutor: {
        execute: async () => {
          throw new Error("fixture failure");
        },
      },
    },
  );
  const http = request(app.getHttpServer());
  const { asset } = await linuxHost(http, "collect-host");
  await http
    .post(`/api/customers/a/collections/configurations/${asset.id}`)
    .set(auth)
    .send({
      category: "server",
      platform: "linux",
      items: [{ content: "basic", enabled: true, method: "manual" }],
    })
    .expect(201);
  const task = (
    await http
      .post("/api/customers/a/report-center/tasks")
      .set(auth)
      .send({
        name: "重新采集报告",
        scope: { kind: "selected", assetIds: [asset.id] },
        mode: "collect",
        idempotencyKey: "collect",
      })
      .expect(202)
  ).body;
  const url = `/api/customers/a/report-center/tasks/${task.id}`;
  await expect
    .poll(async () => {
      const body = (await http.get(url).set(auth)).body;
      return body.status === "waiting" ? "waiting" : JSON.stringify(body.items);
    })
    .toBe("waiting");
  const waiting = (await http.get(url).set(auth)).body;
  expect(waiting.items[0].status).toBe("waiting_upload");
  const runId = waiting.items[0].collectionRunId;
  const snapshot = await linuxSnapshot(
    http,
    asset.id,
    "collect-host",
    "2",
    false,
  );
  await http
    .post(`/api/customers/a/collections/configuration-runs/${runId}/result`)
    .set(auth)
    .send({ content: "basic", snapshotId: snapshot.id })
    .expect(201);
  await http.post(`${url}/resume`).set(auth).send({}).expect(201);
  await expect
    .poll(async () => (await http.get(url).set(auth)).body.items[0].status)
    .toBe("waiting_confirmation");
  const baseline = (
    await http.get(`/api/customers/a/assets/${asset.id}/baseline`).set(auth)
  ).body;
  await http
    .post(`/api/customers/a/assets/${asset.id}/baseline/confirm`)
    .set(auth)
    .send({
      snapshotId: snapshot.id,
      expectedBaselineId: baseline.current.id,
      idempotencyKey: "collect-adopt",
      sections: ["os", "packages"],
      writeMasterData: false,
    })
    .expect(201);
  await http.post(`${url}/resume`).set(auth).send({}).expect(201);
  await expect
    .poll(async () => (await http.get(url).set(auth)).body.status)
    .toBe("needs_attention");
  const failed = (await http.get(url).set(auth)).body;
  expect(failed.items[0].snapshotId).toBe(snapshot.id);
  expect(failed.items[0].collectionRunId).toBe(runId);
  await http.post(`${url}/finish`).set(auth).send({}).expect(201);
});

test("报告包固定修订并持久保存完整 XLSX 与 HTML，正式文件不能绕过交付", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-package-"));
  app = await createApp({ ...config, databaseUrl: `pglite://${directory}` });
  const http = request(app.getHttpServer());
  const { asset } = await linuxHost(http, "package-host");
  const task = (
    await http
      .post("/api/customers/a/report-center/tasks")
      .set(auth)
      .send({
        name: "报告包",
        scope: { kind: "selected", assetIds: [asset.id] },
        mode: "existing",
        idempotencyKey: "package",
      })
      .expect(202)
  ).body;
  const report = (
    await http.get(`/api/customers/a/reports/${task.reportId}`).set(auth)
  ).body;
  const base = `/api/customers/a/reports/${report.id}/revisions/${report.revision.id}/packages`;
  await http.post(base).set(auth).send({ audience: "official" }).expect(409);
  const bundle = (
    await http.post(base).set(auth).send({ audience: "draft" }).expect(202)
  ).body;
  await expect
    .poll(
      async () =>
        (await http.get(`${base}/${bundle.id}`).set(auth)).body.status,
      { timeout: 20000 },
    )
    .toMatch(/complete|partial/);
  const ready = (await http.get(`${base}/${bundle.id}`).set(auth).expect(200))
    .body;
  expect(ready.files.map((f: { format: string }) => f.format).sort()).toEqual([
    "html",
    "pdf",
    "xlsx",
  ]);
  expect(
    ready.files.find((f: { format: string }) => f.format === "xlsx").status,
  ).toBe("ready");
  expect(
    ready.files.find((f: { format: string }) => f.format === "html").status,
  ).toBe("ready");
  if (process.env.REPORT_PDF_CHANNEL)
    expect(
      ready.files.find((f: { format: string }) => f.format === "pdf").status,
    ).toBe("ready");
  const xlsxFile = ready.files.find(
    (f: { format: string }) => f.format === "xlsx",
  );
  const download = await http
    .get(`${base}/${bundle.id}/files/${xlsxFile.id}`)
    .set(auth)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    })
    .expect(200);
  const ExcelJS = (await import("exceljs")).default;
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(download.body);
  expect(book.getWorksheet("说明")!.getCell("B3").value).toBe("草稿 · 未复核");
  expect(book.getWorksheet("服务器")!.getCell("B2").value).toBe("package-host");
  expect(book.getWorksheet("漏洞明细")!.rowCount).toBe(1);
  await http
    .get(
      `/api/customers/b/reports/${report.id}/revisions/${report.revision.id}/packages/${bundle.id}`,
    )
    .set(auth)
    .expect(404);
  const archive = await http
    .get(`${base}/${bundle.id}/download?partial=true`)
    .set(auth)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    })
    .expect(200);
  const { unzipSync, strFromU8 } = await import("fflate");
  const files = unzipSync(archive.body);
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  expect(manifest.revisionId).toBe(report.revision.id);
  expect(manifest.factHash).toBe(report.revision.factHash);
  expect(
    manifest.files.find((f: { format: string }) => f.format === "xlsx").sha256,
  ).toBe(xlsxFile.sha256);
});

test("显式比较冻结历史修订，范围缩减保留说明且不宣称修复", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-compare-"));
  app = await createApp({ ...config, databaseUrl: `pglite://${directory}` });
  const http = request(app.getHttpServer());
  const first = await linuxHost(http, "compare-first"),
    second = await linuxHost(http, "compare-second");
  const create = async (ids: string[], key: string, extra = {}) =>
    (
      await http
        .post("/api/customers/a/report-center/tasks")
        .set(auth)
        .send({
          name: key,
          scope: { kind: "selected", assetIds: ids },
          mode: "existing",
          idempotencyKey: key,
          ...extra,
        })
        .expect(202)
    ).body;
  const before = await create([first.asset.id, second.asset.id], "before");
  const after = await create([first.asset.id], "after", {
    comparisonReportId: before.reportId,
    sourceReportId: before.reportId,
  });
  const report = (
    await http.get(`/api/customers/a/reports/${after.reportId}`).set(auth)
  ).body;
  expect(report.revision.facts.center.sourceReport.reportId).toBe(
    before.reportId,
  );
  expect(report.revision.facts.center.comparison.removedHostIds).toEqual([
    second.asset.id,
  ]);
  expect(report.revision.facts.center.comparison.notObserved).toEqual([]);
  const html = (
    await http
      .get(`/api/customers/a/reports/${after.reportId}/preview`)
      .set(auth)
  ).text;
  expect(html).toContain("历史对比");
  expect(html).toContain("未再观察到不等于已修复");
  await http
    .post("/api/customers/b/report-center/tasks")
    .set(auth)
    .send({
      name: "cross",
      scope: { kind: "selected", assetIds: [first.asset.id] },
      mode: "existing",
      comparisonReportId: before.reportId,
      idempotencyKey: "cross",
    })
    .expect(404);
});

test(
  "两万条发现完整导出、证据原字节与单台分报告使用同一修订",
  { timeout: 60000 },
  async () => {
    directory = await mkdtemp(join(tmpdir(), "ys-report-large-"));
    const raw = JSON.stringify({
      SchemaVersion: 2,
      Metadata: { OS: { Family: "ubuntu", Name: "24.04" } },
      Results: [
        {
          Target: "ubuntu",
          Class: "os-pkgs",
          Type: "ubuntu",
          Packages: [{ Name: "libssl3", Version: "1", Arch: "amd64" }],
          Vulnerabilities: Array.from({ length: 20000 }, (_, i) => ({
            VulnerabilityID: `CVE-2026-${String(10000 + i)}`,
            PkgName: "libssl3",
            InstalledVersion: "1",
            Severity: i % 2 ? "HIGH" : "LOW",
            FixedVersion: "1.1",
            PrimaryURL: "https://example.invalid/advisory",
          })),
        },
      ],
    });
    app = await createApp(
      { ...config, databaseUrl: `pglite://${directory}` },
      [],
      {
        trivyExecutor: {
          execute: async () => ({
            status: "succeeded",
            toolVersion: "fixture",
            argv: ["fixture"],
            startedAt: new Date().toISOString(),
            finishedAt: new Date().toISOString(),
            exitCode: 0,
            signal: null,
            stderr: "",
            databaseBefore: null,
            databaseAfter: null,
            rawReport: raw,
          }),
        },
      },
    );
    const http = request(app.getHttpServer());
    const { asset, snapshot } = await linuxHost(http, "=1+1");
    const job = (
      await http
        .post("/api/customers/a/assessments")
        .set(auth)
        .send({
          assetId: asset.id,
          snapshotId: snapshot.id,
          idempotencyKey: "large",
        })
        .expect(202)
    ).body;
    await expect
      .poll(
        async () =>
          (
            await http
              .get(`/api/customers/a/assessments/${job.id}?findingsOffset=0`)
              .set(auth)
          ).body.status,
        { timeout: 10000 },
      )
      .toBe("succeeded");
    const task = (
      await http
        .post("/api/customers/a/report-center/tasks")
        .set(auth)
        .send({
          name: "大规模报告",
          scope: { kind: "selected", assetIds: [asset.id] },
          mode: "existing",
          idempotencyKey: "large-report",
        })
        .expect(202)
    ).body;
    const report = (
      await http.get(`/api/customers/a/reports/${task.reportId}`).set(auth)
    ).body;
    expect(report.revision.facts.statistics.findingInstances).toBe(20000);
    const base = `/api/customers/a/reports/${report.id}/revisions/${report.revision.id}/packages`;
    const bundle = (
      await http
        .post(base)
        .set(auth)
        .send({
          audience: "draft",
          perHostIds: [asset.id],
          evidenceAssessmentIds: [job.id],
        })
        .expect(202)
    ).body;
    await expect
      .poll(
        async () =>
          (await http.get(`${base}/${bundle.id}`).set(auth)).body.status,
        { timeout: 45000 },
      )
      .toMatch(/complete|partial/);
    const ready = (await http.get(`${base}/${bundle.id}`).set(auth)).body;
    const get = async (id: string) =>
      (
        await http
          .get(`${base}/${bundle.id}/files/${id}`)
          .set(auth)
          .buffer(true)
          .parse((res, done) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => done(null, Buffer.concat(chunks)));
          })
          .expect(200)
      ).body as Buffer;
    const excelFile = ready.files.find(
      (f: { format: string }) => f.format === "xlsx",
    );
    const bytes = await get(excelFile.id);
    const ExcelJS = (await import("exceljs")).default;
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(bytes as never);
    expect(book.getWorksheet("漏洞明细")!.rowCount).toBe(20001);
    expect(book.getWorksheet("漏洞明细")!.getCell("C20001").value).toBe(
      "CVE-2026-29999",
    );
    expect(book.getWorksheet("服务器")!.getCell("B2").value).toBe("=1+1");
    expect(book.getWorksheet("整改建议")!.rowCount).toBe(20001);
    const evidence = ready.files.find(
      (f: { format: string }) => f.format === "evidence",
    );
    expect(evidence.status).toBe("ready");
    expect((await get(evidence.id)).toString("utf8")).toBe(raw);
    if (process.env.REPORT_PDF_CHANNEL) {
      expect(ready.status).toBe("complete");
      const pdfFile = ready.files.find(
        (f: { format: string; hostId?: string }) =>
          f.format === "pdf" && !f.hostId,
      );
      const pdfBytes = await get(pdfFile.id);
      expect(pdfBytes.subarray(0, 4).toString()).toBe("%PDF");
      if (process.env.REPORT_QA_OUTPUT) {
        await mkdir(process.env.REPORT_QA_OUTPUT, { recursive: true });
        await writeFile(
          join(process.env.REPORT_QA_OUTPUT, "large-summary.pdf"),
          pdfBytes,
        );
        await writeFile(
          join(process.env.REPORT_QA_OUTPUT, "large.xlsx"),
          bytes,
        );
      }
    }
  },
);

test("取消停止后续服务器派发，执行中项不作为已固定扫描结果", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-cancel-"));
  let calls = 0;
  app = await createApp(
    { ...config, databaseUrl: `pglite://${directory}` },
    [],
    {
      trivyExecutor: {
        execute: async (_input, signal) => {
          calls++;
          await new Promise<void>((_, reject) =>
            signal.addEventListener(
              "abort",
              () => reject(new Error("fixture aborted")),
              { once: true },
            ),
          );
          throw new Error("unreachable");
        },
      },
    },
  );
  const http = request(app.getHttpServer());
  const a = await linuxHost(http, "cancel-a"),
    b = await linuxHost(http, "cancel-b");
  const input = {
    name: "取消任务",
    scope: { kind: "selected", assetIds: [a.asset.id, b.asset.id] },
    mode: "assess",
    idempotencyKey: "cancel",
  };
  const check = (
    await http
      .post("/api/customers/a/report-center/preflight")
      .set(auth)
      .send(input)
      .expect(201)
  ).body;
  expect(check.total).toBe(2);
  expect(calls).toBe(0);
  const task = (
    await http
      .post("/api/customers/a/report-center/tasks")
      .set(auth)
      .send(input)
      .expect(202)
  ).body;
  const url = `/api/customers/a/report-center/tasks/${task.id}`;
  await expect
    .poll(
      async () => (await http.get(url).set(auth)).body.items[0].assessmentId,
    )
    .toBeTruthy();
  await http.post(`${url}/cancel`).set(auth).send({}).expect(201);
  await expect
    .poll(
      async () => (await http.post(`${url}/finish`).set(auth).send({})).status,
    )
    .toBe(201);
  expect(calls).toBe(1);
  const done = (await http.get(url).set(auth)).body;
  const report = (
    await http.get(`/api/customers/a/reports/${done.reportId}`).set(auth)
  ).body;
  expect(report.revision.facts.center.hosts).toHaveLength(2);
  expect(report.revision.facts.assessmentSnapshots).toHaveLength(0);
  expect(report.revision.facts.statistics.findingInstances).toBeNull();
});

test("服务重启保留任务且不自动重放扫描，显式重试才提交新评估", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-restart-"));
  let calls = 0;
  const options = { ...config, databaseUrl: `pglite://${directory}` };
  app = await createApp(options, [], {
    trivyExecutor: {
      execute: async (_input, signal) => {
        calls++;
        await new Promise<void>((_, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("fixture aborted")),
            { once: true },
          ),
        );
        throw new Error("unreachable");
      },
    },
  });
  let http = request(app.getHttpServer());
  const { asset } = await linuxHost(http, "restart-host");
  const task = (
    await http
      .post("/api/customers/a/report-center/tasks")
      .set(auth)
      .send({
        name: "重启任务",
        scope: { kind: "selected", assetIds: [asset.id] },
        mode: "assess",
        idempotencyKey: "restart",
      })
      .expect(202)
  ).body;
  const url = `/api/customers/a/report-center/tasks/${task.id}`;
  await expect
    .poll(
      async () => (await http.get(url).set(auth)).body.items[0].assessmentId,
    )
    .toBeTruthy();
  await app.close();
  app = await createApp(options, [], {
    trivyExecutor: {
      execute: async () => {
        calls++;
        throw new Error("fixture retry");
      },
    },
  });
  http = request(app.getHttpServer());
  const reopened = (await http.get(url).set(auth).expect(200)).body;
  expect(reopened.status).toBe("interrupted");
  expect(calls).toBe(1);
  await http
    .post(`${url}/retry`)
    .set(auth)
    .send({ itemIds: [reopened.items[0].id] })
    .expect(201);
  await expect
    .poll(async () => (await http.get(url).set(auth)).body.status)
    .toBe("needs_attention");
  expect(calls).toBe(2);
});
