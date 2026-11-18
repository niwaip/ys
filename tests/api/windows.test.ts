import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, dir: string;
const auth = { Authorization: "Bearer windows-test-secret" };
afterEach(async () => {
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
test("Windows资料保存独立快照、原文、未知字段和跨客户隔离", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-win-"));
  app = await createApp({
    databaseUrl: `pglite://${dir}`,
    customers: [
      { id: "acme", name: "A" },
      { id: "river", name: "R" },
    ],
    operators: [
      {
        token: "windows-test-secret",
        name: "T",
        customerIds: ["acme", "river"],
      },
    ],
  });
  const http = request(app.getHttpServer());
  const raw = {
    Hostname: "WIN-1",
    SerialNumber: "serial-1",
    OS: "Windows Server 2022",
    OSBuild: "20348",
    UBR: 2402,
    InstalledSoftware: [{ Name: "Example", Version: "" }],
    InstalledKBs: ["KB5030216"],
    CollectionStatus: { Overall: "PARTIAL" },
    KBInventoryComplete: false,
    VendorExtension: { x: 1 },
  };
  const upload = (data: object, customer = "acme") =>
    http
      .post(`/api/customers/${customer}/windows/imports`)
      .set(auth)
      .send({ fileName: "host.json", content: JSON.stringify(data) });
  const first = (await upload(raw).expect(201)).body;
  expect(first).toMatchObject({
    status: "imported",
    customerId: "acme",
    snapshot: {
      osBuild: "20348",
      ubr: 2402,
      collectedAt: null,
      kbInventoryComplete: false,
      software: [{ name: "Example", version: null }],
    },
  });
  expect(first.snapshot.extensions.VendorExtension).toEqual({ x: 1 });
  expect(first.content).toBe(JSON.stringify(raw));
  const concurrent = await Promise.all([upload(raw), upload(raw)]);
  expect(concurrent.every((x) => x.body.snapshotId === first.snapshotId)).toBe(
    true,
  );
  expect((await upload(raw).expect(201)).body).toMatchObject({
    id: first.id,
    replayed: true,
  });
  const newer = (await upload({ ...raw, UBR: 2500 }).expect(201)).body;
  expect(newer.assetId).toBe(first.assetId);
  expect(newer.snapshotId).not.toBe(first.snapshotId);
  expect(
    (
      await http
        .get(`/api/customers/acme/windows/imports/${first.id}`)
        .set(auth)
        .expect(200)
    ).body.snapshot.ubr,
  ).toBe(2402);
  await http
    .get(`/api/customers/river/windows/imports/${first.id}`)
    .set(auth)
    .expect(404);
  expect((await upload(raw, "river").expect(201)).body.assetId).not.toBe(
    first.assetId,
  );
});
test("身份歧义与不支持的采集版本保留待确认资料，不冒充成功资产", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-win-invalid-"));
  app = await createApp({
    databaseUrl: `pglite://${dir}`,
    customers: [{ id: "acme", name: "A" }],
    operators: [
      { token: "windows-test-secret", name: "T", customerIds: ["acme"] },
    ],
  });
  const http = request(app.getHttpServer());
  const upload = (data: object) =>
    http
      .post("/api/customers/acme/windows/imports")
      .set(auth)
      .send({ fileName: "x.json", content: JSON.stringify(data) });
  expect(
    (
      await upload({
        Hostname: "unknown",
        CollectorVersion: "future-99",
      }).expect(201)
    ).body,
  ).toMatchObject({ status: "unsupported_version", snapshotId: null });
  expect(
    (await upload({ Hostname: "unknown" }).expect(201)).body,
  ).toMatchObject({ status: "pending_confirmation", snapshotId: null });
  await http
    .post("/api/customers/acme/assets")
    .set(auth)
    .send({ name: "same", kind: "host" })
    .expect(201);
  expect(
    (await upload({ Hostname: "same", SerialNumber: "different" }).expect(201))
      .body.status,
  ).toBe("pending_confirmation");
  expect(
    (await http.get("/api/customers/acme/assets").set(auth)).body.total,
  ).toBe(1);
  await upload({ Hostname: "invalid", UBR: -1 }).expect(400);
  await http.post("/api/customers/acme/windows/imports").send({}).expect(401);
});
test("下游按快照编号读取固定证据，重启后不改写", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-win-snapshot-"));
  const config = {
    databaseUrl: `pglite://${dir}`,
    customers: [
      { id: "acme", name: "A" },
      { id: "river", name: "R" },
    ],
    operators: [
      {
        token: "windows-test-secret",
        name: "T",
        customerIds: ["acme", "river"],
      },
    ],
  };
  app = await createApp(config);
  const input = {
    Hostname: "evidence",
    SerialNumber: "e-1",
    CollectorVersion: "1",
    OSBuild: "20348",
    UBR: 0,
    InstalledKBs: [],
    CollectionStatus: { Overall: "FAILED" },
    KBInventoryComplete: false,
  };
  const imported = (
    await request(app.getHttpServer())
      .post("/api/customers/acme/windows/imports")
      .set(auth)
      .send({ fileName: "e.json", content: JSON.stringify(input) })
      .expect(201)
  ).body;
  await app.close();
  app = await createApp(config);
  const http = request(app.getHttpServer());
  const detail = (
    await http
      .get(`/api/customers/acme/windows/snapshots/${imported.snapshotId}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(detail).toMatchObject({
    id: imported.snapshotId,
    assetId: imported.assetId,
    importId: imported.id,
    snapshot: { ubr: 0, kbs: [], collectionStatus: { Overall: "FAILED" } },
  });
  await http
    .get(`/api/customers/river/windows/snapshots/${imported.snapshotId}`)
    .set(auth)
    .expect(404);
});
