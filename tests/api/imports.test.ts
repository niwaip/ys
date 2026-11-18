import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>;
let directory: string;
const config = {
  customers: [
    { id: "acme", name: "A" },
    { id: "river", name: "R" },
  ],
  operators: [
    {
      token: "test-import-secret",
      name: "Tester",
      customerIds: ["acme", "river"],
    },
  ],
};
const auth = { Authorization: "Bearer test-import-secret" };
const csv =
  "source,sourceRef,name,kind,collectedAt,ip\ncmdb,host-1,数据库,host,2026-10-01T08:00:00Z,10.0.0.1";
afterEach(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("预览CSV映射，原子导入并在重启后回读原始资料及对象来源", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-import-"));
  const options = { ...config, databaseUrl: `pglite://${directory}` };
  app = await createApp(options);
  const http = request(app.getHttpServer());
  const preview = await http
    .post("/api/customers/acme/imports/csv/preview")
    .set(auth)
    .send({ fileName: "hosts.csv", content: csv })
    .expect(201);
  expect(preview.body).toMatchObject({
    status: "preview",
    canCommit: true,
    policy: "atomic",
    rows: [
      {
        row: 2,
        status: "ready",
        mapped: {
          source: "cmdb",
          sourceRef: "host-1",
          attributes: { ip: "10.0.0.1" },
        },
      },
    ],
  });
  const committed = await http
    .post(`/api/customers/acme/imports/${preview.body.id}/commit`)
    .set(auth)
    .expect(201);
  expect(committed.body).toMatchObject({
    status: "committed",
    rows: [{ status: "imported" }],
  });
  const id = committed.body.rows[0].assetId;
  await app.close();
  app = await createApp(options);
  const detail = await request(app.getHttpServer())
    .get(`/api/customers/acme/imports/${preview.body.id}`)
    .set(auth)
    .expect(200);
  expect(detail.body.content).toBe(csv);
  expect(detail.body.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(detail.body.rows[0].assetId).toBe(id);
  const asset = await request(app.getHttpServer())
    .get(`/api/customers/acme/assets/${id}`)
    .set(auth)
    .expect(200);
  expect(asset.body).toMatchObject({
    source: "cmdb",
    sourceRef: "host-1",
    importId: preview.body.id,
    collectedAt: "2026-10-01T08:00:00.000Z",
  });
});
test("问题记录阻止整批提交，重复、并发及客户范围均有明确结果", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-import-policy-"));
  app = await createApp({
    ...config,
    databaseUrl: `pglite://${directory}`,
    operators: [
      ...config.operators,
      {
        token: "limited-import-secret",
        name: "Limited",
        customerIds: ["acme"],
      },
    ],
  });
  const http = request(app.getHttpServer());
  const preview = (content: string, customer = "acme") =>
    http
      .post(`/api/customers/${customer}/imports/csv/preview`)
      .set(auth)
      .send({ fileName: "x.csv", content });
  const mixed = await preview(csv + "\n,host-2,bad,host,,").expect(201);
  expect(mixed.body).toMatchObject({
    canCommit: false,
    rows: [{ status: "ready" }, { status: "invalid", issues: ["缺失 source"] }],
  });
  await http
    .post(`/api/customers/acme/imports/${mixed.body.id}/commit`)
    .set(auth)
    .expect(409);
  expect(
    (await http.get("/api/customers/acme/assets").set(auth)).body.total,
  ).toBe(0);
  const invalid = await preview(
    "source,sourceRef,name,kind,collectedAt\ncmdb,x,invalid,host,2026-02-30T00:00:00Z",
  ).expect(201);
  expect(invalid.body.canCommit).toBe(false);
  const duplicate = await preview(csv + "\ncmdb,host-1,other,host,,").expect(
    201,
  );
  expect(duplicate.body.rows[1].status).toBe("duplicate");
  await preview("source,source,name\nx,y,z").expect(400);
  await preview('source,sourceRef,name,kind\ncmdb,x,"broken,host').expect(400);
  const first = await preview(csv).expect(201);
  const same = await preview(csv).expect(201);
  expect(same.body.id).toBe(first.body.id);
  expect(same.body.replayed).toBe(true);
  const commits = await Promise.all(
    [1, 2, 3].map(() =>
      http
        .post(`/api/customers/acme/imports/${first.body.id}/commit`)
        .set(auth)
        .expect(201),
    ),
  );
  expect(new Set(commits.map((r) => r.body.rows[0].assetId)).size).toBe(1);
  const river = await preview(csv, "river").expect(201);
  expect(river.body.id).not.toBe(first.body.id);
  await http
    .post(`/api/customers/river/imports/${river.body.id}/commit`)
    .set(auth)
    .expect(201);
  await http
    .get(`/api/customers/river/imports/${first.body.id}`)
    .set(auth)
    .expect(404);
  await http
    .post(`/api/customers/river/imports/${first.body.id}/commit`)
    .set(auth)
    .expect(404);
  await http
    .get(`/api/customers/river/imports/${river.body.id}`)
    .auth("limited-import-secret", { type: "bearer" })
    .expect(403);
  await http
    .post("/api/customers/river/imports/csv/preview")
    .auth("limited-import-secret", { type: "bearer" })
    .send({ fileName: "x", content: csv })
    .expect(403);
  await http.get("/api/customers/acme/imports").expect(401);
  // Two different snapshots preview the same new source object before either commit.
  const a = await preview(csv.replaceAll("host-1", "host-new")).expect(201);
  const b = await preview(
    "source,sourceRef,name,kind,collectedAt,ip\ncmdb,rolled-back,first-in-batch,host,,\ncmdb,host-new,other,host,,",
  ).expect(201);
  const results = [];
  for (const p of [a, b])
    results.push(
      await http
        .post(`/api/customers/acme/imports/${p.body.id}/commit`)
        .set(auth),
    );
  expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
  expect(
    (await http.get("/api/customers/acme/assets").set(auth)).body.total,
  ).toBe(2);
  const listed = await http
    .get("/api/customers/acme/imports")
    .set(auth)
    .expect(200);
  expect(listed.body.items.every((x: object) => !("content" in x))).toBe(true);
});

test("并发独立提交与中途失败事务不会回滚其他请求的资产", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-import-concurrent-"));
  app = await createApp({ ...config, databaseUrl: `pglite://${directory}` });
  const http = request(app.getHttpServer());
  const preview = async (content: string) =>
    (
      await http
        .post("/api/customers/acme/imports/csv/preview")
        .set(auth)
        .send({ fileName: "concurrent.csv", content })
        .expect(201)
    ).body;
  const first = await preview(csv);
  const conflict = await preview(
    "source,sourceRef,name,kind,collectedAt,ip\ncmdb,rollback,this must rollback,host,,\ncmdb,host-1,conflict,host,,",
  );
  const independent = await preview(csv.replaceAll("host-1", "independent"));
  await http
    .post(`/api/customers/acme/imports/${first.id}/commit`)
    .set(auth)
    .expect(201);
  await Promise.all([
    http
      .post(`/api/customers/acme/imports/${conflict.id}/commit`)
      .set(auth)
      .expect(409),
    http
      .post("/api/customers/acme/assets")
      .set(auth)
      .send({ name: "concurrent manual", kind: "host" })
      .expect(201),
    http
      .post(`/api/customers/acme/imports/${independent.id}/commit`)
      .set(auth)
      .expect(201),
  ]);
  const assets = (
    await http.get("/api/customers/acme/assets").set(auth).expect(200)
  ).body;
  expect(assets.total).toBe(3);
  expect(
    assets.items.map((a: { sourceRef?: string }) => a.sourceRef),
  ).not.toContain("rollback");
  const failed = (
    await http
      .get(`/api/customers/acme/imports/${conflict.id}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(failed.status).toBe("preview");
  expect(
    failed.rows.every((r: { status: string }) => r.status === "ready"),
  ).toBe(true);
});
