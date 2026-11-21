import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, dir: string;
const auth = { Authorization: "Bearer access-test-operator" };
const base = {
  customers: [
    { id: "acme", name: "A" },
    { id: "other", name: "B" },
  ],
  operators: [
    {
      name: "T",
      token: "access-test-operator",
      customerIds: ["acme", "other"],
    },
  ],
};
afterEach(async () => {
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
test("网页新建凭证并关联主机，重启保留；直接采集不依赖Pi，私钥不回显且临时文件清理", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-access-"));
  const config = {
    ...base,
    databaseUrl: `pglite://${join(dir, "db")}`,
    collection: { profiles: [], storeDir: join(dir, "access") },
  };
  const privateKey =
    "-----BEGIN OPENSSH PRIVATE KEY-----\nSECRET-KEY-MATERIAL\n-----END OPENSSH PRIVATE KEY-----";
  let usedKeyPath = "";
  const runtime = {
    collectionExecutor: {
      async execute(_input: any, profile: any) {
        usedKeyPath = profile.identityFile;
        expect(await readFile(profile.identityFile, "utf8")).toBe(
          `${privateKey}\n`,
        );
        return {
          schemaVersion: "ys-host/1" as const,
          identity: { hostname: "test-host", serial: null, machineId: null },
          collectedAt: null,
          sections: {},
          extensions: {},
        };
      },
    },
  };
  app = await createApp(config, [], runtime);
  let http = request(app.getHttpServer());
  const asset = (
    await http
      .post("/api/customers/acme/assets")
      .set(auth)
      .send({ name: "YS", kind: "host" })
  ).body;
  const credential = (
    await http
      .post("/api/customers/acme/collections/credentials")
      .set(auth)
      .send({ name: "运维只读密钥", privateKey })
      .expect(201)
  ).body;
  expect(JSON.stringify(credential)).not.toContain("SECRET");
  const input = {
    assetId: asset.id,
    name: "YS SSH",
    credentialId: credential.id,
    host: "127.0.0.1",
    port: 22,
    username: "reader",
    hostKey:
      "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    allowDocker: false,
    trustConfirmed: true,
  };
  const connection = (
    await http
      .post("/api/customers/acme/collections/connections")
      .set(auth)
      .send(input)
      .expect(201)
  ).body;
  await http
    .post("/api/customers/other/collections/connections")
    .set(auth)
    .send(input)
    .expect(404);
  await app.close();
  app = await createApp(config, [], runtime);
  http = request(app.getHttpServer());
  const profiles = (
    await http
      .get("/api/customers/acme/collections/profiles")
      .set(auth)
      .expect(200)
  ).body;
  expect(profiles.items).toMatchObject([
    {
      id: connection.id,
      assetId: asset.id,
      label: "YS SSH",
      credentialName: "运维只读密钥",
    },
  ]);
  expect(JSON.stringify(profiles)).not.toContain("SECRET");
  const job = (
    await http
      .post("/api/customers/acme/collections/jobs")
      .set(auth)
      .send({
        assetId: asset.id,
        profileId: connection.id,
        scope: "basic",
        method: "ssh",
        message: "基础采集",
        idempotencyKey: "direct",
      })
      .expect(201)
  ).body;
  let result = job;
  for (
    let i = 0;
    i < 100 && ["queued", "running"].includes(result.status);
    i++
  ) {
    await new Promise((r) => setTimeout(r, 30));
    result = (
      await http.get(`/api/customers/acme/collections/jobs/${job.id}`).set(auth)
    ).body;
  }
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "succeeded",
    method: "ssh",
  });
  expect(result.snapshotId).toBeTruthy();
  await expect(readFile(usedKeyPath)).rejects.toThrow();
  await http
    .delete(`/api/customers/acme/collections/connections/${connection.id}`)
    .set(auth)
    .expect(200);
  await http
    .post("/api/customers/acme/collections/jobs")
    .set(auth)
    .send({
      assetId: asset.id,
      profileId: connection.id,
      scope: "basic",
      method: "ssh",
      message: "基础采集",
      idempotencyKey: "disabled",
    })
    .expect(403);
});
