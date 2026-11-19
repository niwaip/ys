import { test, expect, afterEach } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, dir: string;
afterEach(async () => {
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
test("采集不自动更新基线；采纳后比较包版本，缺失层不删除；旧基线确认冲突且客户隔离", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-baseline-"));
  app = await createApp({
    databaseUrl: `pglite://${dir}`,
    customers: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    operators: [
      { name: "测试", token: "baseline-test-token", customerIds: ["a", "b"] },
    ],
  });
  const http = request(app.getHttpServer()),
    auth = { Authorization: "Bearer baseline-test-token" },
    base = "/api/customers/a";
  const asset = (
    await http
      .post(base + "/assets")
      .set(auth)
      .send({ name: "YS", kind: "host" })
  ).body;
  const data = (version: string) => ({
    schemaVersion: "ys-host/1",
    identity: { hostname: "ys", serial: null, machineId: "one" },
    collectedAt: null,
    sections: {
      os: {
        status: "acquired",
        data: {
          id: "ubuntu",
          version: "26.04",
          kernel: "7.0",
          architecture: "x86_64",
        },
      },
      network: {
        status: "acquired",
        data: [
          {
            ifname: "eth0",
            operstate: "UP",
            addr_info: [{ family: "inet", local: "192.0.2.1", prefixlen: 24 }],
          },
        ],
      },
      packages: {
        status: "acquired",
        data: [
          {
            name: "openssl",
            version,
            architecture: "amd64",
            manager: "dpkg",
            state: "installed",
          },
        ],
      },
    },
    extensions: {},
  });
  const upload = async (value: unknown) =>
    (
      await http
        .post(base + "/collections/upload")
        .set(auth)
        .send({
          assetId: asset.id,
          fileName: "host.json",
          content: JSON.stringify(value),
        })
        .expect(201)
    ).body;
  const first = await upload(data("1.0"));
  const path = base + `/assets/${asset.id}/baseline`;
  let preview = (
    await http
      .get(path + `?snapshotId=${first.id}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(preview.current).toBeNull();
  expect(preview.sections.packages.counts.added).toBe(1);
  const accepted = (
    await http
      .post(path + "/confirm")
      .set(auth)
      .send({
        snapshotId: first.id,
        expectedBaselineId: null,
        idempotencyKey: "first",
        sections: ["identity", "os", "packages", "network"],
        excludeFields: [],
      })
      .expect(201)
  ).body;
  expect(accepted.status).toBe("confirmed");
  const second = await upload(data("2.0"));
  preview = (
    await http
      .get(path + `?snapshotId=${second.id}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(preview.current.id).toBe(accepted.id);
  expect(preview.sections.packages.counts.changed).toBe(1);
  expect(preview.sections.packages.changes[0]).toMatchObject({
    before: { version: "1.0" },
    after: { version: "2.0" },
  });
  await http
    .post(path + "/confirm")
    .set(auth)
    .send({
      snapshotId: second.id,
      expectedBaselineId: null,
      idempotencyKey: "stale",
      sections: ["packages"],
      excludeFields: [],
    })
    .expect(409);
  const partial = data("2.0");
  partial.sections.packages = { status: "failed", data: null } as any;
  const third = await upload(partial);
  preview = (
    await http
      .get(path + `?snapshotId=${third.id}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(preview.sections.packages.counts.removed).toBe(0);
  expect(preview.sections.packages.comparable).toBe(false);
  await http
    .post(path + "/confirm")
    .set(auth)
    .send({
      snapshotId: third.id,
      expectedBaselineId: accepted.id,
      idempotencyKey: "failed-layer",
      sections: ["packages"],
      excludeFields: [],
    })
    .expect(400);
  const unknown = data("3.0");
  unknown.sections.os.data.kernel = "9.0";
  unknown.sections.packages.data[0].version = null as any;
  (unknown.sections as any).network = {
    status: "acquired",
    data: [{ ifname: "eth0" }],
  };
  const fourth = await upload(unknown);
  expect(
    (await http.get(path + `?snapshotId=${fourth.id}`).set(auth)).body.sections
      .network.totalChanges,
  ).toBe(0);
  await http
    .post(path + "/confirm")
    .set(auth)
    .send({
      snapshotId: fourth.id,
      expectedBaselineId: accepted.id,
      idempotencyKey: "retained",
      sections: ["os", "packages"],
      excludeFields: ["os.kernel"],
    })
    .expect(201);
  const kept = (await http.get(path).set(auth)).body.current;
  expect(kept.sources.os.kernel).toBe(first.id);
  expect(kept.sources.os.version).toBe(fourth.id);
  const pack = (
    await http.get(path + "/sections/packages?view=baseline").set(auth)
  ).body;
  expect(pack.items[0].version).toBe("1.0");
  const os = (await http.get(path + "/sections/os?view=baseline").set(auth))
    .body;
  expect(os.data.kernel).toBe("7.0");
  await http
    .get(`/api/customers/b/assets/${asset.id}/baseline`)
    .set(auth)
    .expect(404);
});

test("NetBox写回响应丢失不更新基线、不重复写入；核对远端实际值后确认", async () => {
  const { createServer } = await import("node:http");
  let native = { id: 42, name: "old-name", serial: "S1", tenant: { id: 7 } },
    writes = 0;
  let releasePatch!: () => void;
  const patchGate = new Promise<void>((r) => {
    releasePatch = r;
  });
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.method === "PATCH") {
      let body = "";
      for await (const c of req) body += c;
      native = { ...native, ...JSON.parse(body), tenant: { id: 7 } };
      writes++;
      await patchGate;
      req.socket.destroy();
      return;
    }
    if (req.url === "/api/dcim/devices/42/") res.end(JSON.stringify(native));
    else
      res.end(
        JSON.stringify({
          count: req.url?.includes("dcim") ? 1 : 0,
          next: null,
          results: req.url?.includes("dcim") ? [native] : [],
        }),
      );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    dir = await mkdtemp(join(tmpdir(), "ys-baseline-nb-"));
    app = await createApp({
      databaseUrl: `pglite://${dir}`,
      customers: [{ id: "a", name: "A" }],
      operators: [
        { name: "测试", token: "baseline-test-token", customerIds: ["a"] },
      ],
      netbox: {
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`,
        token: "private-netbox-test-token",
        tenantIds: { a: 7 },
      },
    });
    const http = request(app.getHttpServer()),
      auth = { Authorization: "Bearer baseline-test-token" },
      base = "/api/customers/a";
    await http
      .post(base + "/netbox/sync")
      .set(auth)
      .send({})
      .expect(201);
    const asset = (await http.get(base + "/assets").set(auth)).body.items[0];
    const snapshot = (
      await http
        .post(base + "/collections/upload")
        .set(auth)
        .send({
          assetId: asset.id,
          fileName: "host.json",
          content: JSON.stringify({
            schemaVersion: "ys-host/1",
            identity: {
              hostname: "observed-name",
              serial: "S1",
              machineId: "one",
            },
            collectedAt: null,
            sections: {},
            extensions: {},
          }),
        })
        .expect(201)
    ).body;
    const path = base + `/assets/${asset.id}/baseline`,
      input = {
        snapshotId: snapshot.id,
        expectedBaselineId: null,
        idempotencyKey: "once",
        sections: ["identity"],
        excludeFields: ["identity.serial"],
      };
    native.serial = "MANUALLY-CORRECTED";
    const active = http
      .post(path + "/confirm")
      .set(auth)
      .send(input)
      .expect(201)
      .then((r) => r.body);
    let pending: string | undefined;
    for (let i = 0; i < 100 && !pending; i++) {
      const p = (await http.get(path).set(auth)).body;
      pending = p.history.find((h: any) => h.status === "pending")?.id;
      if (!pending) await new Promise((r) => setTimeout(r, 10));
    }
    expect(pending).toBeTruthy();
    await http
      .post(path + `/${pending}/reconcile`)
      .set(auth)
      .send({})
      .expect(409);
    releasePatch();
    const approval = await active;
    expect(native.serial).toBe("MANUALLY-CORRECTED");
    expect(approval.status).toBe("unknown");
    expect(writes).toBe(1);
    expect((await http.get(path).set(auth)).body.current).toBeNull();
    await http
      .post(path + "/confirm")
      .set(auth)
      .send(input)
      .expect(201);
    expect(writes).toBe(1);
    await http
      .post(path + `/${approval.id}/reconcile`)
      .set(auth)
      .send({})
      .expect(201);
    expect((await http.get(path).set(auth)).body.current.id).toBe(approval.id);
    expect(writes).toBe(1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("同一快照再次确认：NetBox已是目标值时不误报冲突或重复PATCH", async () => {
  const { createServer } = await import("node:http");
  let native = { id: 42, name: "old", tenant: { id: 7 } },
    writes = 0;
  let failRead = false,
    failReadCount = 0;
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (failRead && req.method !== "PATCH" && ++failReadCount > 1) {
      res.statusCode = 503;
      res.end("{}");
      return;
    }
    if (req.method === "PATCH") {
      let body = "";
      for await (const c of req) body += c;
      native = { ...native, ...JSON.parse(body), tenant: { id: 7 } };
      writes++;
    }
    res.end(
      JSON.stringify(
        req.url === "/api/dcim/devices/42/"
          ? native
          : {
              count: req.url?.includes("dcim") ? 1 : 0,
              next: null,
              results: req.url?.includes("dcim") ? [native] : [],
            },
      ),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    dir = await mkdtemp(join(tmpdir(), "ys-baseline-repeat-"));
    app = await createApp({
      databaseUrl: `pglite://${dir}`,
      customers: [{ id: "a", name: "A" }],
      operators: [
        { name: "测试", token: "baseline-test-token", customerIds: ["a"] },
      ],
      netbox: {
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`,
        token: "private-test-token",
        tenantIds: { a: 7 },
      },
    });
    const http = request(app.getHttpServer()),
      auth = { Authorization: "Bearer baseline-test-token" },
      base = "/api/customers/a";
    await http
      .post(base + "/netbox/sync")
      .set(auth)
      .send({});
    const asset = (await http.get(base + "/assets").set(auth)).body.items[0];
    const snap = (
      await http
        .post(base + "/collections/manual")
        .set(auth)
        .send({
          assetId: asset.id,
          note: "测试",
          data: {
            schemaVersion: "ys-host/1",
            identity: { hostname: "new", serial: null, machineId: "one" },
            collectedAt: null,
            sections: {},
            extensions: {},
          },
        })
    ).body;
    const path = base + `/assets/${asset.id}/baseline`;
    const input = {
      snapshotId: snap.id,
      expectedBaselineId: null,
      idempotencyKey: "first",
      sections: ["identity"],
      excludeFields: [],
    };
    const first = (
      await http
        .post(path + "/confirm")
        .set(auth)
        .send(input)
    ).body;
    expect(first.status).toBe("confirmed");
    const second = (
      await http
        .post(path + "/confirm")
        .set(auth)
        .send({
          ...input,
          expectedBaselineId: first.id,
          idempotencyKey: "again",
        })
    ).body;
    expect(second.status).toBe("confirmed");
    expect(writes).toBe(1);
    native.name = "external-edit";
    const conflict = (
      await http
        .post(path + "/confirm")
        .set(auth)
        .send({
          ...input,
          expectedBaselineId: second.id,
          idempotencyKey: "conflict",
        })
    ).body;
    expect(conflict.status).toBe("rejected");
    expect(conflict.message).toContain("未执行");
    expect(writes).toBe(1);
    failRead = true;
    const unavailable = (
      await http
        .post(path + "/confirm")
        .set(auth)
        .send({
          ...input,
          expectedBaselineId: second.id,
          idempotencyKey: "read-failed",
        })
    ).body;
    expect(unavailable.status).toBe("rejected");
    expect(writes).toBe(1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
