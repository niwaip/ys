import { createServer } from "node:http";
import { rm } from "node:fs/promises";
import { createApp } from "../../apps/api/src/app";
import request from "supertest";
const devices: Record<string, unknown>[] = [
  {
    id: 1,
    name: "核心交换机",
    tenant: { id: 7 },
    serial: "SW1",
    role: { id: 10, name: "Core Switch", slug: "core-switch" },
    device_type: {
      id: 20,
      model: "C9300",
      manufacturer: { id: 30, name: "Cisco" },
    },
    platform: { id: 40, name: "IOS XE" },
  },
];
const vms: Record<string, unknown>[] = [];
let deny = false,
  posts = 0,
  patches = 0;
const catalogs: Record<string, unknown[]> = {
  "/api/dcim/device-roles/": [{ id: 10, name: "Core Switch" }],
  "/api/dcim/device-types/": [{ id: 20, model: "C9300" }],
  "/api/dcim/sites/": [{ id: 50, name: "上海机房" }],
  "/api/virtualization/clusters/": [{ id: 60, name: "计算集群" }],
};
const external = createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  const url = new URL(req.url!, "http://127.0.0.1:3228");
  if (url.pathname === "/fixture/state") {
    deny = url.searchParams.get("deny") === "1";
    res.end(JSON.stringify({ posts, patches }));
    return;
  }
  if (req.headers.authorization !== "Token fixture-netbox-token") {
    res.statusCode = 403;
    res.end("{}");
    return;
  }
  if (catalogs[url.pathname]) {
    if (deny) {
      res.statusCode = 403;
      res.end("{}");
    } else
      res.end(
        JSON.stringify({
          count: catalogs[url.pathname].length,
          next: null,
          results: catalogs[url.pathname],
        }),
      );
    return;
  }
  const vm = url.pathname.startsWith("/api/virtualization/virtual-machines/");
  const rows = vm ? vms : devices;
  if (req.method === "POST") {
    let content = "";
    for await (const chunk of req) content += chunk;
    const body = JSON.parse(content);
    posts++;
    if (body.name.includes("fail")) {
      res.statusCode = 403;
      res.end("{}");
      return;
    }
    const row = {
      id: rows.length + 1,
      name: body.name,
      tenant: { id: body.tenant },
      serial: body.serial ?? "",
      role: vm ? null : { id: body.role, name: "Core Switch" },
      device_type: vm ? null : { id: body.device_type, model: "C9300" },
      platform: null,
    };
    rows.push(row);
    res.statusCode = 201;
    res.end(JSON.stringify(row));
    return;
  }
  if (req.method === "PATCH") {
    patches++;
    res.statusCode = 500;
    res.end("{}");
    return;
  }
  const id = url.pathname.match(/\/(\d+)\/$/)?.[1];
  if (id) {
    const row = rows.find((r) => r.id === Number(id));
    res.statusCode = row ? 200 : 404;
    res.end(JSON.stringify(row ?? {}));
    return;
  }
  const filtered = rows.filter(
    (r) =>
      (r.tenant as { id: number }).id ===
      Number(url.searchParams.get("tenant_id")),
  );
  res.end(
    JSON.stringify({ count: filtered.length, next: null, results: filtered }),
  );
});
await new Promise<void>((r) => external.listen(3228, "127.0.0.1", r));
await rm(".data/browser-multi-device", { force: true, recursive: true });
const app = await createApp({
  databaseUrl: "pglite://.data/browser-multi-device",
  customers: [
    { id: "acme", name: "多设备客户" },
    { id: "river", name: "隔离客户" },
  ],
  operators: [
    {
      token: "browser-test-secret-token",
      name: "测试操作员",
      customerIds: ["acme", "river"],
    },
  ],
  netbox: {
    baseUrl: "http://127.0.0.1:3228/api/",
    token: "fixture-netbox-token",
    tenantIds: { acme: 7, river: 8 },
  },
});
await request(app.getHttpServer())
  .post("/api/customers/acme/netbox/sync")
  .auth("browser-test-secret-token", { type: "bearer" })
  .send({})
  .expect(201);
await app.listen(3229, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.once(signal, async () => {
    await app.close();
    external.close();
    process.exit(0);
  });
