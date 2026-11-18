import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
const operators = [
  {
    token: "test-operator-secret",
    name: "测试操作员",
    customerIds: ["acme", "river"],
  },
];
const customers = [
  { id: "acme", name: "星河科技" },
  { id: "river", name: "远山集团" },
];
let app: Awaited<ReturnType<typeof createApp>>;
let directory: string;
afterEach(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("操作人员保存资产，重启后通过客户业务接口回读核心信息与扩展属性", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-assets-"));
  const config = { databaseUrl: `pglite://${directory}`, operators, customers };
  app = await createApp(config);
  const saved = await request(app.getHttpServer())
    .post("/api/customers/acme/assets")
    .auth(operators[0].token, { type: "bearer" })
    .send({
      name: "生产服务器",
      kind: "host",
      sourceRef: "CMDB-42",
      attributes: { environment: "production", ip: "10.0.0.12" },
    })
    .expect(201);
  expect(saved.body).toMatchObject({
    customerId: "acme",
    name: "生产服务器",
    kind: "host",
    source: "manual",
    sourceRef: "CMDB-42",
    attributes: { environment: "production", ip: "10.0.0.12" },
  });
  expect(saved.body.id).toMatch(/^[0-9a-f-]{36}$/);
  await app.close();
  app = await createApp(config);
  const listed = await request(app.getHttpServer())
    .get("/api/customers/acme/assets")
    .auth(operators[0].token, { type: "bearer" })
    .expect(200);
  expect(listed.body.items).toEqual([saved.body]);
  const detail = await request(app.getHttpServer())
    .get(`/api/customers/acme/assets/${saved.body.id}`)
    .auth(operators[0].token, { type: "bearer" })
    .expect(200);
  expect(detail.body).toEqual(saved.body);
});

test("客户隔离：同名资产独立，无凭据、伪造权限、跨客户引用与缺失范围均不能越权", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-isolation-"));
  app = await createApp({
    databaseUrl: `pglite://${directory}`,
    operators: [
      ...operators,
      {
        token: "restricted-secret-token",
        name: "受限操作员",
        customerIds: ["acme"],
      },
    ],
    customers,
  });
  const http = request(app.getHttpServer());
  const auth = { Authorization: `Bearer ${operators[0].token}` };
  const acme = await http
    .post("/api/customers/acme/assets")
    .set(auth)
    .send({ name: "主机01", kind: "host" })
    .expect(201);
  const river = await http
    .post("/api/customers/river/assets")
    .set(auth)
    .send({ name: "主机01", kind: "host" })
    .expect(201);
  expect(acme.body.id).not.toBe(river.body.id);
  const restricted = { Authorization: "Bearer restricted-secret-token" };
  const allowed = await http.get("/api/customers").set(restricted).expect(200);
  expect(allowed.body.items).toEqual([{ id: "acme", name: "星河科技" }]);
  expect(JSON.stringify(allowed.body)).not.toContain("secret");
  await http.get("/api/customers/acme/assets").expect(401);
  await http
    .get("/api/customers/acme/assets")
    .auth("invalid", { type: "bearer" })
    .expect(401);
  await http
    .get("/api/customers/river/assets")
    .set(restricted)
    .set("X-Customer-Id", "acme")
    .expect(403);
  await http
    .post("/api/customers/river/assets")
    .set(restricted)
    .send({ name: "拒绝写入", kind: "host" })
    .expect(403);
  await http
    .get(`/api/customers/acme/assets/${river.body.id}`)
    .set(restricted)
    .expect(404);
  await http
    .get(`/api/customers/river/assets/${acme.body.id}`)
    .set(auth)
    .expect(404);
  await http.get("/api/customers/unknown/assets").set(auth).expect(403);
  await http.get("/api/assets").set(auth).expect(404);
  await http
    .post("/api/customers/acme/assets")
    .set(auth)
    .send({ name: "伪造", kind: "host", customerId: "river" })
    .expect(400);
  const acmeAssets = await http
    .get("/api/customers/acme/assets")
    .set(auth)
    .expect(200);
  const riverAssets = await http
    .get("/api/customers/river/assets")
    .set(auth)
    .expect(200);
  expect(acmeAssets.body.items.map((a: { id: string }) => a.id)).toEqual([
    acme.body.id,
  ]);
  expect(riverAssets.body.items.map((a: { id: string }) => a.id)).toEqual([
    river.body.id,
  ]);
});

test("无效输入不创建记录，列表分页有明确边界，名称不充当系统身份", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-validation-"));
  app = await createApp({
    databaseUrl: `pglite://${directory}`,
    operators,
    customers,
  });
  const http = request(app.getHttpServer());
  const auth = { Authorization: `Bearer ${operators[0].token}` };
  for (const body of [
    { name: " ", kind: "host" },
    { name: "x", kind: "container" },
    { name: "x", kind: "host", attributes: [] },
  ])
    await http
      .post("/api/customers/acme/assets")
      .set(auth)
      .send(body)
      .expect(400);
  await http.get("/api/customers/acme/assets?limit=0").set(auth).expect(400);
  await http.get("/api/customers/acme/assets/not-a-uuid").set(auth).expect(400);
  const empty = await http
    .get("/api/customers/acme/assets")
    .set(auth)
    .expect(200);
  expect(empty.body).toEqual({ items: [], total: 0, limit: 50, offset: 0 });
  await http
    .post("/api/customers/acme/assets")
    .set(auth)
    .send({ name: "同名", kind: "host" })
    .expect(201);
  await http
    .post("/api/customers/acme/assets")
    .set(auth)
    .send({ name: "同名", kind: "host" })
    .expect(201);
  const page = await http
    .get("/api/customers/acme/assets?limit=1&offset=1")
    .set(auth)
    .expect(200);
  expect(page.body.total).toBe(2);
  expect(page.body.items).toHaveLength(1);
});
