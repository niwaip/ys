import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>;
let server: Server;
let directory: string;
const auth = { Authorization: "Bearer test-netbox-operator" };
afterEach(async () => {
  await app?.close();
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("客户同步NetBox原生资产，保留稳定身份、分页与来源，拒绝错误Tenant", async () => {
  server = createServer((req, res) => {
    expect(req.headers.authorization).toBe("Token netbox-private-token");
    res.setHeader("Content-Type", "application/json");
    if (req.url?.startsWith("/api/dcim/devices/")) {
      res.end(
        JSON.stringify({
          count: 1,
          next: null,
          results: [
            {
              id: 42,
              name: "YS",
              tenant: { id: 7 },
              serial: "SERIAL",
              platform: { id: 2, name: "Debian" },
              primary_ip4: { address: "10.0.0.1/24" },
            },
          ],
        }),
      );
    } else res.end(JSON.stringify({ count: 0, next: null, results: [] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  directory = await mkdtemp(join(tmpdir(), "ys-netbox-"));
  app = await createApp({
    databaseUrl: `pglite://${directory}`,
    customers: [
      { id: "acme", name: "A" },
      { id: "other", name: "B" },
    ],
    operators: [
      {
        token: "test-netbox-operator",
        name: "test",
        customerIds: ["acme", "other"],
      },
    ],
    netbox: {
      baseUrl: `http://127.0.0.1:${port}/api/`,
      token: "netbox-private-token",
      tenantIds: { acme: 7, other: 8 },
    },
  } as Parameters<typeof createApp>[0]);
  const http = request(app.getHttpServer());
  await http
    .post("/api/customers/acme/netbox/sync")
    .set(auth)
    .send({})
    .expect(201);
  const first = await http
    .get("/api/customers/acme/assets")
    .set(auth)
    .expect(200);
  expect(first.body.items).toHaveLength(1);
  expect(first.body.items[0]).toMatchObject({
    name: "YS",
    source: "netbox",
    attributes: {
      netbox: { objectType: "device", id: 42, tenantId: 7 },
      serial: "SERIAL",
    },
  });
  await http
    .post("/api/customers/acme/netbox/sync")
    .set(auth)
    .send({})
    .expect(201);
  expect(
    (await http.get("/api/customers/acme/assets").set(auth)).body.items[0].id,
  ).toBe(first.body.items[0].id);
  await http
    .post("/api/customers/other/netbox/sync")
    .set(auth)
    .send({})
    .expect(502);
  expect(
    (await http.get("/api/customers/other/assets").set(auth)).body.total,
  ).toBe(0);
  expect(JSON.stringify(first.body)).not.toContain("private-token");
});

test("显式映射保留旧资产ID；NetBox模式关闭本地手工建档", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-netbox-map-"));
  const config = {
    databaseUrl: `pglite://${directory}`,
    customers: [{ id: "acme", name: "A" }],
    operators: [
      { token: "test-netbox-operator", name: "test", customerIds: ["acme"] },
    ],
  };
  app = await createApp(config);
  const old = await request(app.getHttpServer())
    .post("/api/customers/acme/assets")
    .set(auth)
    .send({ name: "旧YS", kind: "host" })
    .expect(201);
  await app.close();
  server = createServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: 42,
        name: "YS",
        tenant: { id: 7 },
        serial: "SERIAL",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  app = await createApp({
    ...config,
    netbox: {
      baseUrl: `http://127.0.0.1:${port}/api/`,
      token: "private",
      timeoutMs: 1000,
      tenantIds: { acme: 7 },
    },
  });
  const http = request(app.getHttpServer());
  await http
    .post("/api/customers/acme/netbox/mappings")
    .set(auth)
    .send({ assetId: old.body.id, objectType: "device", externalId: 42 })
    .expect(201);
  const mapped = await http
    .get(`/api/customers/acme/assets/${old.body.id}`)
    .set(auth)
    .expect(200);
  expect(mapped.body).toMatchObject({
    id: old.body.id,
    name: "YS",
    source: "netbox",
  });
  await http
    .post("/api/customers/acme/assets")
    .set(auth)
    .send({ name: "错误本地建档", kind: "host" })
    .expect(409);
  expect(
    (await http.get("/api/customers/acme/assets").set(auth)).body.total,
  ).toBe(1);
});

test("NetBox模式CSV关联原生身份、Windows按唯一序列号归档，均不复制主数据", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-netbox-inputs-"));
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const row = { id: 42, name: "YS", tenant: { id: 7 }, serial: "SERIAL" };
    res.end(
      JSON.stringify(
        req.url?.includes("virtual-machines")
          ? { count: 0, next: null, results: [] }
          : req.url?.includes("/42/")
            ? row
            : { count: 1, next: null, results: [row] },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  app = await createApp({
    databaseUrl: `pglite://${directory}`,
    customers: [{ id: "acme", name: "A" }],
    operators: [
      { token: "test-netbox-operator", name: "test", customerIds: ["acme"] },
    ],
    netbox: {
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`,
      token: "private",
      tenantIds: { acme: 7 },
    },
  });
  const http = request(app.getHttpServer());
  await http
    .post("/api/customers/acme/netbox/sync")
    .set(auth)
    .send({})
    .expect(201);
  const asset = (await http.get("/api/customers/acme/assets").set(auth)).body
    .items[0];
  const preview = await http
    .post("/api/customers/acme/imports/csv/preview")
    .set(auth)
    .send({
      fileName: "hosts.csv",
      content:
        "source,sourceRef,name,kind,collectedAt,ip\nnetbox,device:42,观测名称,host,,10.0.0.2",
    })
    .expect(201);
  const committed = await http
    .post(`/api/customers/acme/imports/${preview.body.id}/commit`)
    .set(auth)
    .expect(201);
  expect(committed.body.rows[0]).toMatchObject({
    assetId: asset.id,
    status: "imported",
  });
  const upload = (serial: string) =>
    http
      .post("/api/customers/acme/windows/imports")
      .set(auth)
      .send({
        fileName: "win.json",
        content: JSON.stringify({
          Hostname: "观测名称",
          SerialNumber: serial,
          CollectorVersion: "1",
        }),
      });
  expect((await upload("SERIAL").expect(201)).body).toMatchObject({
    status: "imported",
    assetId: asset.id,
  });
  expect((await upload("UNKNOWN").expect(201)).body).toMatchObject({
    status: "pending_confirmation",
    assetId: null,
    snapshotId: null,
  });
  const after = await http
    .get("/api/customers/acme/assets")
    .set(auth)
    .expect(200);
  expect(after.body.total).toBe(1);
  expect(after.body.items[0].name).toBe("YS");
});

test("网页原生建档写入NetBox，幂等重放不重复创建；失去确认时禁止自动重试", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-netbox-write-"));
  let created = 0;
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      if (req.method === "POST") {
        created++;
        const input = JSON.parse(body);
        expect(input).toMatchObject({
          tenant: 7,
          device_type: 2,
          role: 3,
          site: 4,
        });
        if (input.name === "uncertain") {
          res.destroy();
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            id: created,
            name: input.name,
            tenant: { id: 7 },
            serial: input.serial,
          }),
        );
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  app = await createApp({
    databaseUrl: `pglite://${directory}`,
    customers: [{ id: "acme", name: "A" }],
    operators: [
      { token: "test-netbox-operator", name: "test", customerIds: ["acme"] },
    ],
    netbox: {
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`,
      token: "private",
      tenantIds: { acme: 7 },
    },
  });
  const http = request(app.getHttpServer());
  const input = {
    idempotencyKey: "create-one",
    objectType: "device",
    name: "YS",
    deviceType: 2,
    role: 3,
    site: 4,
    serial: "SERIAL",
  };
  const first = await http
    .post("/api/customers/acme/netbox/assets")
    .set(auth)
    .send(input)
    .expect(201);
  const replay = await http
    .post("/api/customers/acme/netbox/assets")
    .set(auth)
    .send(input)
    .expect(201);
  expect(replay.body.assetId).toBe(first.body.assetId);
  expect(created).toBe(1);
  await http
    .post("/api/customers/acme/netbox/assets")
    .set(auth)
    .send({ ...input, name: "different" })
    .expect(409);
  const unknown = { ...input, idempotencyKey: "unknown", name: "uncertain" };
  await http
    .post("/api/customers/acme/netbox/assets")
    .set(auth)
    .send(unknown)
    .expect(502);
  await http
    .post("/api/customers/acme/netbox/assets")
    .set(auth)
    .send(unknown)
    .expect(409);
  expect(created).toBe(2);
});

test("修改NetBox资产保留历史编号且不把离线资产强制启用", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-netbox-edit-"));
  let name = "YS";
  const writes: unknown[] = [];
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method === "PATCH") {
        const body = JSON.parse(raw);
        writes.push(body);
        name = body.name;
      }
      const asset = { id: 42, name, tenant: { id: 7 }, serial: "S" };
      res.end(
        JSON.stringify(
          req.url?.includes("virtual-machines")
            ? { count: 0, next: null, results: [] }
            : req.url?.includes("/42/")
              ? asset
              : { count: 1, next: null, results: [asset] },
        ),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  app = await createApp({
    databaseUrl: `pglite://${directory}`,
    customers: [{ id: "acme", name: "A" }],
    operators: [
      { token: "test-netbox-operator", name: "test", customerIds: ["acme"] },
    ],
    netbox: {
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`,
      token: "private",
      tenantIds: { acme: 7 },
    },
  });
  const http = request(app.getHttpServer());
  await http
    .post("/api/customers/acme/netbox/sync")
    .set(auth)
    .send({})
    .expect(201);
  const asset = (await http.get("/api/customers/acme/assets").set(auth)).body
    .items[0];
  const updated = (
    await http
      .patch(`/api/customers/acme/netbox/assets/${asset.id}`)
      .set(auth)
      .send({ idempotencyKey: "edit", name: "YS-new" })
      .expect(200)
  ).body;
  expect(updated.assetId).toBe(asset.id);
  expect(writes).toEqual([{ name: "YS-new", tenant: 7 }]);
  expect(
    (await http.get(`/api/customers/acme/assets/${asset.id}`).set(auth)).body
      .name,
  ).toBe("YS-new");
});

test("资产迁出Tenant后，即使缓存未同步也拒绝新快照和Pi任务", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-live-tenant-"));
  let tenantId = 7;
  server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const asset = { id: 42, name: "YS", tenant: { id: tenantId } };
    res.end(
      JSON.stringify(
        req.url?.includes("virtual-machines")
          ? { count: 0, next: null, results: [] }
          : req.url?.includes("/42/")
            ? asset
            : { count: 1, next: null, results: [asset] },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  app = await createApp({
    databaseUrl: `pglite://${directory}`,
    customers: [{ id: "acme", name: "A" }],
    operators: [
      { token: "test-netbox-operator", name: "test", customerIds: ["acme"] },
    ],
    netbox: {
      baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`,
      token: "private",
      tenantIds: { acme: 7 },
    },
  });
  const http = request(app.getHttpServer());
  await http
    .post("/api/customers/acme/netbox/sync")
    .set(auth)
    .send({})
    .expect(201);
  const asset = (await http.get("/api/customers/acme/assets").set(auth)).body
    .items[0];
  tenantId = 8;
  await http
    .post("/api/customers/acme/collections/manual")
    .set(auth)
    .send({
      assetId: asset.id,
      note: "旧客户",
      data: {
        schemaVersion: "ys-host/1",
        identity: { hostname: "ys" },
        collectedAt: null,
        sections: {},
      },
    })
    .expect(502);
  await http
    .post("/api/customers/acme/collections/jobs")
    .set(auth)
    .send({
      assetId: asset.id,
      idempotencyKey: "no-run",
      profileId: "read",
      scope: "basic",
      message: "采集",
    })
    .expect(502);
  expect(
    (await http.get("/api/customers/acme/collections/snapshots").set(auth)).body
      .total,
  ).toBe(0);
  expect(
    (await http.get("/api/customers/acme/collections/jobs").set(auth)).body
      .items,
  ).toEqual([]);
});
