import { test, expect } from "vitest";
import request from "supertest";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
test("混合批次自动提交等待外部校验时，另一请求固定的手动结果不会丢失", async () => {
  let armed = false,
    count = 0,
    release = () => {};
  let blocked!: () => void;
  const waiting = new Promise<void>((resolve) => {
    blocked = resolve;
  });
  const device = {
    id: 42,
    name: "YS",
    tenant: { id: 7 },
    serial: "SERIAL",
    role: { id: 1, name: "Server", slug: "server" },
  };
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    const detail = req.url === "/api/dcim/devices/42/";
    if (detail && armed && ++count === 2) {
      release = () => res.end(JSON.stringify(device));
      blocked();
      return;
    }
    res.end(
      JSON.stringify(
        detail
          ? device
          : {
              count: req.url?.startsWith("/api/dcim/devices/") ? 1 : 0,
              next: null,
              results: req.url?.startsWith("/api/dcim/devices/")
                ? [device]
                : [],
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = await mkdtemp(join(tmpdir(), "ys-configuration-race-"));
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let pending: Promise<request.Response> | undefined;
  try {
    app = await createApp({
      databaseUrl: `pglite://${dir}`,
      customers: [{ id: "a", name: "A" }],
      operators: [
        { name: "T", token: "race-operator-token", customerIds: ["a"] },
      ],
      collection: { profiles: [], storeDir: join(dir, "access") },
      netbox: {
        baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/api/`,
        token: "private",
        tenantIds: { a: 7 },
        timeoutMs: 15000,
      },
    });
    const http = () => request(app!.getHttpServer()),
      auth = { Authorization: "Bearer race-operator-token" },
      base = "/api/customers/a";
    await http()
      .post(base + "/netbox/sync")
      .set(auth)
      .send({})
      .expect(201);
    const asset = (
      await http()
        .get(base + "/assets")
        .set(auth)
        .expect(200)
    ).body.items[0];
    const snapshot = (
      await http()
        .post(base + "/collections/manual")
        .set(auth)
        .send({
          assetId: asset.id,
          note: "操作员软件记录",
          data: {
            schemaVersion: "ys-host/1",
            identity: { hostname: "YS", serial: "SERIAL" },
            collectedAt: null,
            sections: {
              device: {
                status: "acquired",
                data: { category: "server", software: "app 1.0" },
              },
            },
          },
        })
        .expect(201)
    ).body;
    const path = `${base}/collections/configurations/${asset.id}`;
    await http()
      .post(path)
      .set(auth)
      .send({
        category: "server",
        platform: "linux",
        items: [
          {
            content: "basic",
            method: "automatic",
            enabled: true,
            profileId: "missing",
          },
          { content: "software", method: "manual", enabled: true },
        ],
      })
      .expect(201);
    armed = true;
    pending = http()
      .post(path + "/run")
      .set(auth)
      .send({ idempotencyKey: "mixed" })
      .expect(201)
      .then((r) => r);
    let timer: ReturnType<typeof setTimeout>;
    try {
      await Promise.race([
        waiting,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("外部校验未进入等待")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer!);
    }
    const run = (
      await http()
        .get(path + "/runs")
        .set(auth)
        .expect(200)
    ).body.items[0];
    await http()
      .post(`${base}/collections/configuration-runs/${run.id}/result`)
      .set(auth)
      .send({ content: "basic", snapshotId: snapshot.id })
      .expect(409);
    await http()
      .post(`${base}/collections/configuration-runs/${run.id}/result`)
      .set(auth)
      .send({ content: "software", snapshotId: snapshot.id })
      .expect(201);
    release();
    await pending;
    const saved = (
      await http()
        .get(`${base}/collections/configuration-runs/${run.id}`)
        .set(auth)
        .expect(200)
    ).body;
    expect(saved.items[0].status).toBe("failed");
    expect(saved.items[1]).toMatchObject({
      status: "succeeded",
      snapshotId: snapshot.id,
    });
  } finally {
    release();
    await pending?.catch(() => {});
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
