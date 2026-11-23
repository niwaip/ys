import { beforeAll, afterAll, test, expect } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, dir: string;
const auth = { Authorization: "Bearer configuration-test" };
const http = () => request(app.getHttpServer());
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-config-"));
  app = await createApp(
    {
      databaseUrl: `pglite://${dir}`,
      customers: [
        { id: "a", name: "A" },
        { id: "b", name: "B" },
      ],
      collection: { profiles: [], storeDir: join(dir, "access") },
      operators: [
        {
          name: "tester",
          token: "configuration-test",
          customerIds: ["a", "b"],
        },
      ],
    },
    [],
    {
      collectionExecutor: {
        async execute() {
          return {
            schemaVersion: "ys-host/1",
            identity: { hostname: "controlled", serial: null, machineId: null },
            collectedAt: null,
            sections: {
              os: {
                status: "acquired",
                data: {
                  id: "debian",
                  version: "12",
                  kernel: null,
                  architecture: "amd64",
                },
                issues: [],
              },
              packages: {
                status: "acquired",
                data: [
                  {
                    name: "example",
                    version: "1.0",
                    architecture: "amd64",
                    state: "installed",
                    manager: "dpkg",
                  },
                ],
                issues: [],
              },
            },
            extensions: {},
          };
        },
      },
    },
  );
});
afterAll(async () => {
  await app?.close();
  await rm(dir, { recursive: true, force: true });
});
test("主机分项配置保存回读且不串客户，不适用的设备或执行方式不能保存", async () => {
  const asset = (
    await http()
      .post("/api/customers/a/assets")
      .set(auth)
      .send({
        name: "host",
        kind: "host",
        attributes: { hardwareType: "server" },
      })
      .expect(201)
  ).body;
  const path = `/api/customers/a/collections/configurations/${asset.id}`;
  const config = {
    category: "server",
    platform: "linux",
    items: [
      {
        content: "basic",
        method: "automatic",
        enabled: true,
        profileId: "controlled",
      },
      { content: "docker", method: "script", enabled: true },
      {
        content: "software",
        method: "manual",
        enabled: true,
        softwarePath: "/opt/application",
      },
    ],
  };
  await http().post(path).set(auth).send(config).expect(201);
  expect((await http().get(path).set(auth).expect(200)).body).toMatchObject(
    config,
  );
  await http()
    .get(`/api/customers/b/collections/configurations/${asset.id}`)
    .set(auth)
    .expect(404);
  await http()
    .post(path)
    .set(auth)
    .send({ ...config, category: "network" })
    .expect(400);
  await http()
    .post(path)
    .set(auth)
    .send({ ...config, platform: "windows" })
    .expect(400);
  await http()
    .post(path)
    .set(auth)
    .send({
      ...config,
      items: [{ content: "docker", method: "manual", enabled: true }],
    })
    .expect(400);
});

test("分项批次保持幂等和配置版本，手动结果明确绑定同一资产后可回读", async () => {
  const asset = (
    await http()
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "batch", kind: "host" })
      .expect(201)
  ).body;
  const path = `/api/customers/a/collections/configurations/${asset.id}`;
  await http()
    .post(path)
    .set(auth)
    .send({
      category: "server",
      platform: "linux",
      items: [
        { content: "basic", method: "manual", enabled: true },
        { content: "software", method: "manual", enabled: true },
      ],
    })
    .expect(201);
  const run = (
    await http()
      .post(path + "/run")
      .set(auth)
      .send({ idempotencyKey: "one" })
      .expect(201)
  ).body;
  expect(run.items.map((i: any) => i.status)).toEqual([
    "awaiting_input",
    "awaiting_input",
  ]);
  expect(
    (
      await http()
        .post(path + "/run")
        .set(auth)
        .send({ idempotencyKey: "one" })
        .expect(201)
    ).body.id,
  ).toBe(run.id);
  const snapshot = (
    await http()
      .post("/api/customers/a/collections/manual")
      .set(auth)
      .send({
        assetId: asset.id,
        note: "现场版本",
        data: {
          schemaVersion: "ys-host/1",
          identity: { hostname: "batch" },
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
  await http()
    .post(`/api/customers/a/collections/configuration-runs/${run.id}/result`)
    .set(auth)
    .send({ content: "software", snapshotId: snapshot.id })
    .expect(201);
  const saved = (
    await http()
      .get(`/api/customers/a/collections/configuration-runs/${run.id}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(saved.items[1]).toMatchObject({
    status: "succeeded",
    snapshotId: snapshot.id,
  });
  await http()
    .get(`/api/customers/b/collections/configuration-runs/${run.id}`)
    .set(auth)
    .expect(404);
  const other = (
    await http()
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "other", kind: "host" })
  ).body;
  const foreign = (
    await http()
      .post("/api/customers/a/collections/manual")
      .set(auth)
      .send({
        assetId: other.id,
        note: "other",
        data: {
          schemaVersion: "ys-host/1",
          identity: { hostname: "other" },
          collectedAt: null,
          sections: {
            device: {
              status: "acquired",
              data: { category: "server", model: "other" },
            },
          },
        },
      })
  ).body;
  await http()
    .post(`/api/customers/a/collections/configuration-runs/${run.id}/result`)
    .set(auth)
    .send({ content: "basic", snapshotId: foreign.id })
    .expect(409);
});

test("自动批次逐项执行，未授权Docker失败不会抹去基础和软件结果，历史可回读", async () => {
  const root = "/api/customers/a";
  const asset = (
    await http()
      .post(root + "/assets")
      .set(auth)
      .send({ name: "automatic", kind: "host" })
      .expect(201)
  ).body;
  const cred = (
    await http()
      .post(root + "/collections/credentials")
      .set(auth)
      .send({
        name: "controlled",
        privateKey:
          "-----BEGIN OPENSSH PRIVATE KEY-----\nFIXTURE-EXTERNAL-KEY\n-----END OPENSSH PRIVATE KEY-----",
      })
      .expect(201)
  ).body;
  const profile = (
    await http()
      .post(root + "/collections/connections")
      .set(auth)
      .send({
        assetId: asset.id,
        name: "controlled",
        credentialId: cred.id,
        host: "127.0.0.1",
        port: 22,
        username: "reader",
        hostKey:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        allowDocker: false,
        trustConfirmed: true,
      })
      .expect(201)
  ).body;
  const path = `${root}/collections/configurations/${asset.id}`;
  await http()
    .post(path)
    .set(auth)
    .send({
      category: "server",
      platform: "linux",
      items: ["basic", "docker", "software"].map((content) => ({
        content,
        method: "automatic",
        enabled: true,
        profileId: profile.id,
      })),
    })
    .expect(201);
  const run = (
    await http()
      .post(path + "/run")
      .set(auth)
      .send({ idempotencyKey: "automatic" })
      .expect(201)
  ).body;
  let done = run;
  for (let i = 0; i < 100; i++) {
    done = (
      await http()
        .get(`${root}/collections/configuration-runs/${run.id}`)
        .set(auth)
        .expect(200)
    ).body;
    if (
      done.items.every((v: any) => ["succeeded", "failed"].includes(v.status))
    )
      break;
    await new Promise((r) => setTimeout(r, 25));
  }
  expect(
    done.items.map((v: any) => v.status),
    JSON.stringify(done.items),
  ).toEqual(["succeeded", "failed", "succeeded"]);
  expect(done.items[0].snapshotId).toBeTruthy();
  expect(done.items[2].snapshotId).toBeTruthy();
  const baseline = (
    await http()
      .get(
        `${root}/assets/${asset.id}/baseline?snapshotId=${done.items[0].snapshotId}`,
      )
      .set(auth)
      .expect(200)
  ).body;
  expect(baseline.current).toBeNull();
  expect(
    (
      await http()
        .get(path + "/runs")
        .set(auth)
        .expect(200)
    ).body.items[0].id,
  ).toBe(run.id);
});

test("资产类型筛选在分页前执行，网络角色与VM原生身份分别归类", async () => {
  const root = "/api/customers/a/assets";
  const server = (
    await http()
      .post(root)
      .set(auth)
      .send({ name: "typed-server", kind: "host" })
      .expect(201)
  ).body;
  await http()
    .patch(`${root}/${server.id}/classification`)
    .set(auth)
    .send({ hardwareType: "server" })
    .expect(200);
  const network = (
    await http()
      .post(root)
      .set(auth)
      .send({
        name: "typed-switch",
        kind: "host",
        attributes: { role: { id: 31, slug: "core-switch" } },
      })
      .expect(201)
  ).body;
  const vm = (
    await http()
      .post(root)
      .set(auth)
      .send({
        name: "typed-vm",
        kind: "host",
        attributes: { netbox: { objectType: "virtual-machine" } },
      })
      .expect(201)
  ).body;
  const found = (
    await http()
      .get(root + "?category=server&limit=1")
      .set(auth)
      .expect(200)
  ).body;
  expect(found.total).toBe(1);
  expect(found.items[0].id).toBe(server.id);
  expect(
    (
      await http()
        .get(root + "?category=network&limit=1")
        .set(auth)
        .expect(200)
    ).body.items[0].id,
  ).toBe(network.id);
  expect(
    (
      await http()
        .get(root + "?category=vm&limit=1")
        .set(auth)
        .expect(200)
    ).body.items[0].id,
  ).toBe(vm.id);
  await http()
    .post("/api/customers/a/collections/role-templates")
    .set(auth)
    .send({ roleId: 31, category: "storage" })
    .expect(201);
  const mapped = (
    await http()
      .get(root + "?category=storage")
      .set(auth)
      .expect(200)
  ).body;
  expect(mapped.total).toBe(1);
  expect(mapped.items[0].id).toBe(network.id);
});
