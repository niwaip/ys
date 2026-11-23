import { beforeAll, afterAll, test, expect } from "vitest";
import request from "supertest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>,
  dir: string,
  assetId: string,
  otherAsset: string;
const auth = { Authorization: "Bearer collection-experience-token" };
const base = "/api/customers/a/collections";
const http = () => request(app.getHttpServer());
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-experience-"));
  const config = {
    databaseUrl: `pglite://${dir}/db`,
    customers: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    operators: [
      {
        name: "T",
        token: "collection-experience-token",
        customerIds: ["a", "b"],
      },
    ],
  };
  app = await createApp(config);
  assetId = (
    await http()
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "managed-host", kind: "host" })
  ).body.id;
  otherAsset = (
    await http()
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "other-host", kind: "host" })
  ).body.id;
  await app.close();
  const ssh = join(dir, "ssh.cjs");
  await writeFile(
    ssh,
    `#!${process.execPath}\nlet text='';process.stdin.on('data',v=>text+=v);process.stdin.on('end',()=>{if(text.includes('YS_CAPABILITY_PROBE')){const values={hostname:[0,'fixture-linux'],identity:[0,'reader'],basic:[0,'linux'],dockerClient:[0,'Docker version 27'],dockerDaemon:[0,'{"Version":"27"}'],trivy:[127,'missing']};for(const [k,[code,text]] of Object.entries(values))console.log(k+'|'+code+'|'+Buffer.from(text).toString('base64'));}else process.exit(9);});`,
    { mode: 0o700 },
  );
  app = await createApp({
    ...config,
    collection: {
      profiles: [
        {
          id: "remote",
          label: "Remote",
          customerId: "a",
          assetId,
          host: "fixture",
          username: "reader",
          knownHostsFile: "/fixture/hosts",
          identityFile: "/fixture/key",
          sshExecutable: ssh,
          allowDocker: true,
        },
        {
          id: "basic-only",
          label: "Basic",
          customerId: "a",
          assetId,
          host: "fixture",
          username: "reader",
          knownHostsFile: "/fixture/hosts",
          identityFile: "/fixture/key",
          sshExecutable: ssh,
          allowDocker: false,
        },
      ],
    },
  });
});
afterAll(async () => {
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
test("public capability check distinguishes Docker access from missing Trivy and protects target binding", async () => {
  const result = (
    await http()
      .post(`${base}/capabilities`)
      .set(auth)
      .send({ assetId, profileId: "remote", scope: "container-inventory" })
      .expect(201)
  ).body;
  expect(result).toMatchObject({
    hostname: "fixture-linux",
    identity: "reader",
    transport: "ssh",
    docker: { status: "available" },
    trivy: { status: "tool_missing" },
  });
  expect(result.checkedAt).toBeTruthy();
  const denied = (
    await http()
      .post(`${base}/capabilities`)
      .set(auth)
      .send({ assetId, profileId: "basic-only", scope: "container-inventory" })
      .expect(201)
  ).body;
  expect(denied.docker.status).toBe("unauthorized");
  await http()
    .post(`${base}/capabilities`)
    .set(auth)
    .send({ assetId: otherAsset, profileId: "remote", scope: "basic" })
    .expect(403);
  await http()
    .post("/api/customers/b/collections/capabilities")
    .set(auth)
    .send({ assetId, profileId: "remote", scope: "basic" })
    .expect(404);
});

test("registered local execution needs no SSH material and stays bound to customer and asset", async () => {
  const { configSchema } = await import("../../apps/api/src/config");
  const parsed = configSchema.safeParse({
    databaseUrl: "pglite://unused",
    customers: [{ id: "a", name: "A" }],
    operators: [
      { name: "T", token: "collection-experience-token", customerIds: ["a"] },
    ],
    collection: {
      profiles: [
        {
          id: "local",
          label: "YS deployment",
          customerId: "a",
          assetId,
          transport: "local",
          allowDocker: false,
        },
      ],
    },
  });
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error("local registration rejected");
  await app.close();
  app = await createApp({
    ...parsed.data,
    databaseUrl: `pglite://${dir}/db`,
    customers: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    operators: [
      {
        name: "T",
        token: "collection-experience-token",
        customerIds: ["a", "b"],
      },
    ],
  });
  const profiles = (await http().get(`${base}/profiles`).set(auth).expect(200))
    .body.items;
  expect(profiles).toContainEqual(
    expect.objectContaining({
      id: "local",
      assetId,
      transport: "local",
      username: expect.any(String),
    }),
  );
  const checks = (
    await http()
      .post(`${base}/capabilities`)
      .set(auth)
      .send({ assetId, profileId: "local", scope: "container-inventory" })
      .expect(201)
  ).body;
  expect(checks).toMatchObject({
    transport: "local",
    hostname: expect.any(String),
    identity: expect.any(String),
    docker: { status: "unauthorized" },
  });
  await http()
    .post(`${base}/capabilities`)
    .set(auth)
    .send({ assetId: otherAsset, profileId: "local", scope: "basic" })
    .expect(403);
  await http()
    .post("/api/customers/b/collections/capabilities")
    .set(auth)
    .send({ assetId, profileId: "local", scope: "basic" })
    .expect(404);
});

test("downloaded Linux basic script executes, uploads with scope, replays exact input and filters immutable history", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const download = (
    await http().get(`${base}/script?scope=basic`).set(auth).expect(200)
  ).body;
  expect(download.fileName).toBe("ys-host-basic.mjs");
  const script = join(dir, download.fileName),
    preload = join(dir, "fixture-os.mjs");
  await writeFile(script, download.content);
  await writeFile(
    preload,
    `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';Object.defineProperty(process,'platform',{value:'linux'});cp.spawn=()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.kill=()=>{};let script='';c.stdin.on('data',x=>script+=x);c.stdin.on('finish',()=>{if(script.includes('emit dockerDaemon')){c.emit('close',9);return;}const values={hostname:'offline-linux',machineId:'offline-machine',os:'ID=debian\\nVERSION_ID=12',kernel:'6.1',architecture:'x86_64',packages:'dpkg\\tlibssl3\\t3.0.1\\tamd64\\tinstalled'};for(const [k,text]of Object.entries(values))c.stdout.write(k+'|0|'+Buffer.from(text).toString('base64')+'\\n');c.stdout.end();c.emit('close',0);});return c;};syncBuiltinESMExports();`,
  );
  const content = (
    await promisify(execFile)(process.execPath, ["--import", preload, script])
  ).stdout;
  expect(JSON.parse(content)).toMatchObject({
    schemaVersion: "ys-host/1",
    extensions: { execution: { scope: "basic", method: "offline" } },
  });
  const input = { assetId, fileName: "offline.json", scope: "basic", content };
  const saved = (
    await http().post(`${base}/upload`).set(auth).send(input).expect(201)
  ).body;
  expect(saved).toMatchObject({
    entry: "upload",
    scope: "basic",
    identity: { hostname: "offline-linux" },
    sections: { packages: { status: "acquired", count: 1 } },
  });
  const replay = (
    await http().post(`${base}/upload`).set(auth).send(input).expect(201)
  ).body;
  expect(replay).toMatchObject({ id: saved.id, replayed: true });
  await http()
    .post(`${base}/upload`)
    .set(auth)
    .send({ ...input, scope: "container-inventory" })
    .expect(400);
  expect(
    (
      await http().get(`${base}/snapshots?scope=basic`).set(auth).expect(200)
    ).body.items.map((x: any) => x.id),
  ).toContain(saved.id);
  expect(
    (
      await http()
        .get(`${base}/snapshots?scope=container-inventory`)
        .set(auth)
        .expect(200)
    ).body.items,
  ).toHaveLength(0);
  expect(
    (
      await http()
        .get(`${base}/snapshots/${saved.id}/raw`)
        .set(auth)
        .expect(200)
    ).body.content,
  ).toBe(content);
  await http()
    .get(`/api/customers/b/collections/snapshots/${saved.id}`)
    .set(auth)
    .expect(404);
});

test("offline Docker directory preserves immutable runtime evidence without authorizing online generation", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const imageId = "sha256:" + "c".repeat(64);
  const download = (
    await http()
      .get(`${base}/script?scope=container-inventory`)
      .set(auth)
      .expect(200)
  ).body;
  expect(download.fileName).toBe("ys-docker-inventory.mjs");
  const path = join(dir, download.fileName),
    preload = join(dir, "fixture-docker.mjs");
  const values = {
    hostname: "offline-linux",
    machineId: "offline-machine",
    dockerDaemon: '{"Version":"27"}',
    containers: JSON.stringify({
      containerId: "d".repeat(64),
      imageId,
      name: "offline-app",
      state: "running",
    }),
    images: JSON.stringify({
      ID: imageId,
      Repository: "example/app",
      Tag: "one",
      Digest: "<none>",
    }),
  };
  const protocol =
    Object.entries(values)
      .map(
        ([key, value]) => key + "|0|" + Buffer.from(value).toString("base64"),
      )
      .join("\n") + "\n";
  await writeFile(path, download.content);
  await writeFile(
    preload,
    `import cp from 'node:child_process';import {syncBuiltinESMExports} from 'node:module';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';Object.defineProperty(process,'platform',{value:'linux'});cp.spawn=()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.kill=()=>{};let script='';c.stdin.on('data',x=>script+=x);c.stdin.on('finish',()=>{if(!script.includes('emit containers') || script.includes('emit packages') || script.includes('trivy image')){c.emit('close',9);return;}c.stdout.end(${JSON.stringify(protocol)});c.emit('close',0);});return c;};syncBuiltinESMExports();`,
  );
  const content = (
    await promisify(execFile)(process.execPath, ["--import", preload, path])
  ).stdout;
  const saved = (
    await http()
      .post(`${base}/upload`)
      .set(auth)
      .send({
        assetId,
        fileName: "directory.json",
        scope: "container-inventory",
        content,
      })
      .expect(201)
  ).body;
  expect(saved).toMatchObject({
    scope: "container-inventory",
    entry: "upload",
    sections: { images: { status: "acquired", count: 1 } },
  });
  const inventory = (
    await http()
      .get(`/api/customers/a/container-runtime/inventory/${saved.id}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(inventory.items[0]).toMatchObject({
    imageId,
    containers: [{ name: "offline-app" }],
  });
  expect(
    (await http().get(`${base}/snapshots?scope=container-inventory`).set(auth))
      .body.items,
  ).toHaveLength(1);
  await http()
    .post("/api/customers/a/container-runtime/jobs")
    .set(auth)
    .send({
      assetId,
      profileId: "local",
      snapshotId: saved.id,
      imageIds: [imageId],
      idempotencyKey: "offline-no-grant",
    })
    .expect(403);
  await http()
    .post(`${base}/manual`)
    .set(auth)
    .send({ assetId, note: "operator", data: JSON.parse(content) })
    .expect(400);
  await http()
    .post(`${base}/upload`)
    .set(auth)
    .send({
      assetId,
      fileName: "bad.json",
      scope: "container-inventory",
      content: "{",
    })
    .expect(400);
  await http().get(`${base}/script?scope=all`).set(auth).expect(400);
});
