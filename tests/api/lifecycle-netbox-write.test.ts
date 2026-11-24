import { afterAll, beforeAll, expect, test } from "vitest";
import request from "supertest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>,
  server: Server,
  directory: string,
  refuse = false;
const native = {
  id: 42,
  name: "NetBox router",
  tenant: { id: 7 },
  serial: "R-42",
  custom_fields: {
    other: "preserved",
    ys_lifecycle: { purchasedOn: "2020-01-02", sourceRef: "Old contract" },
  },
};
const auth = { Authorization: "Bearer netbox-workspace-secret" };
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-lifecycle-netbox-"));
  server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/dcim/devices/42/") {
      if (req.method === "PATCH") {
        if (refuse) {
          res.statusCode = 403;
          res.end("{}");
          return;
        }
        let body = "";
        for await (const chunk of req) body += chunk;
        const patch = JSON.parse(body);
        expect(Object.keys(patch)).toEqual(["custom_fields"]);
        native.custom_fields = {
          ...native.custom_fields,
          ...patch.custom_fields,
        };
      }
      res.end(JSON.stringify(native));
    } else
      res.end(
        JSON.stringify({
          count: req.url?.includes("devices") ? 1 : 0,
          next: null,
          results: req.url?.includes("devices") ? [native] : [],
        }),
      );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as any).port;
  app = await createApp({
    databaseUrl: `pglite://${directory}`,
    customers: [{ id: "a", name: "A" }],
    operators: [
      { token: "netbox-workspace-secret", name: "Editor", customerIds: ["a"] },
    ],
    netbox: {
      baseUrl: `http://127.0.0.1:${port}/api/`,
      token: "external-secret",
      tenantIds: { a: 7 },
    },
  });
});
afterAll(async () => {
  await app?.close();
  await new Promise<void>((r) => server.close(() => r()));
  await rm(directory, { recursive: true, force: true });
});
test("YS设备期限写回NetBox并回读，保留其他字段，拒绝时不修改缓存", async () => {
  const http = () => request(app.getHttpServer());
  const synced = (
    await http()
      .post("/api/customers/a/netbox/sync")
      .set(auth)
      .send({})
      .expect(201)
  ).body;
  const id = synced.items[0].assetId;
  const saved = (
    await http()
      .patch(`/api/customers/a/assets/${id}/lifecycle`)
      .set(auth)
      .send({ warrantyUntil: "2028-01-02", sourceRef: "New contract" })
      .expect(200)
  ).body;
  expect(native.custom_fields.other).toBe("preserved");
  expect(saved.attributes.lifecycle).toMatchObject({
    purchasedOn: "2020-01-02",
    warrantyUntil: "2028-01-02",
  });
  const history = (
    await http()
      .get(`/api/customers/a/lifecycle/assets/${id}/history`)
      .set(auth)
      .expect(200)
  ).body;
  expect(history.items[0]).toMatchObject({ actor: "Editor", source: "netbox" });
  refuse = true;
  await http()
    .patch(`/api/customers/a/assets/${id}/lifecycle`)
    .set(auth)
    .send({ warrantyUntil: "2029-01-02" })
    .expect(502);
  const after = (
    await http().get(`/api/customers/a/assets/${id}`).set(auth).expect(200)
  ).body;
  expect(after.attributes.lifecycle.warrantyUntil).toBe("2028-01-02");
});
