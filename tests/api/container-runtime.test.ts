import { afterAll, beforeAll, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let fixtureAsset: string;
let releaseAssessment: (() => void) | undefined;
let holdAssessment = false;
const imageId = "sha256:" + "a".repeat(64);
let app: Awaited<ReturnType<typeof createApp>>, directory: string;
const auth = { Authorization: "Bearer container-runtime-secret" };
const base = "/api/customers/a/container-runtime";
const http = () => request(app.getHttpServer());
const sbom = (name = "manual-image", count = 1) =>
  JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    metadata: { component: { type: "container", name } },
    components: Array.from({ length: count }, (_, n) => ({
      type: "library",
      name: `lib-${n}`,
      version: "1",
      purl: `pkg:npm/lib-${n}@1`,
    })),
  });
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-image-runtime-"));
  const config = {
    databaseUrl: `pglite://${directory}`,
    customers: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    operators: [
      {
        token: "container-runtime-secret",
        name: "Tester",
        customerIds: ["a", "b"],
      },
    ],
  };
  app = await createApp(config);
  fixtureAsset = (
    await http()
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "fixture-host", kind: "host" })
  ).body.id;
  await app.close();
  app = await createApp(
    {
      ...config,
      collection: {
        profiles: [
          {
            id: "docker-fixture",
            label: "Docker fixture",
            customerId: "a",
            assetId: fixtureAsset,
            host: "fixture",
            username: "reader",
            identityFile: "/fixture/key",
            knownHostsFile: "/fixture/hosts",
            allowDocker: true,
          },
        ],
      },
    },
    [],
    {
      collectionExecutor: {
        execute: async () => ({
          schemaVersion: "ys-host/1",
          identity: {
            hostname: "fixture-host",
            machineId: "fixture-machine",
            serial: null,
          },
          collectedAt: "2026-11-23T00:00:00Z",
          sections: {
            images: {
              status: "acquired",
              data: [
                {
                  imageId,
                  repository: "fixture/image",
                  tag: "v1",
                  digest: null,
                },
              ],
              issues: [],
            },
            containers: {
              status: "acquired",
              data: [
                {
                  containerId: "c".repeat(64),
                  imageId,
                  name: "fixture-container",
                  state: "running",
                },
              ],
              issues: [],
            },
          },
          extensions: {},
        }),
      },
      imageGenerator: {
        generate: async (_profile, id) => ({
          schemaVersion: "ys-image/1",
          host: {
            hostname: "fixture-host",
            machineId: "fixture-machine",
            serial: null,
          },
          image: {
            imageId: id,
            architecture: "amd64",
            os: "linux",
            repoTags: ["fixture/image:v1"],
            repoDigests: [],
          },
          toolVersion: "fixture-trivy",
          generatedAt: "2026-11-23T00:00:00Z",
          sbom: JSON.parse(sbom("generated-image")),
        }),
      },
      trivyExecutor: {
        execute: async () => {
          if (holdAssessment)
            await new Promise<void>((resolve) => {
              releaseAssessment = resolve;
            });
          return {
            status: "succeeded",
            toolVersion: "fixture-trivy",
            argv: ["sbom"],
            startedAt: "2026-11-23T00:00:00Z",
            finishedAt: "2026-11-23T00:00:01Z",
            exitCode: 0,
            signal: null,
            stderr: "",
            databaseBefore: null,
            databaseAfter: null,
            rawReport: JSON.stringify({
              SchemaVersion: 2,
              Results: [
                {
                  Target: "fixture/image",
                  Class: "os-pkgs",
                  Type: "alpine",
                  Packages: [{ Name: "lib-0", Version: "1" }],
                  Vulnerabilities: [],
                },
              ],
            }),
          };
        },
      },
    },
  );
});
afterAll(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("manual container SBOM import supports real image capacity, optional host provenance and replay", async () => {
  const asset = (
    await http()
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "host", kind: "host" })
      .expect(201)
  ).body;
  const body = {
    name: "manual-image",
    fileName: "manual.json",
    content: sbom("manual-image", 1200),
    assetId: asset.id,
  };
  const saved = (
    await http().post(`${base}/imports`).set(auth).send(body).expect(201)
  ).body;
  expect(saved.version.components).toHaveLength(1200);
  expect(saved.source).toMatchObject({
    assetId: asset.id,
    basis: "operator_declaration",
  });
  const replay = (
    await http().post(`${base}/imports`).set(auth).send(body).expect(201)
  ).body;
  expect(replay.version.id).toBe(saved.version.id);
  expect(replay.source.id).toBe(saved.source.id);
  const sources = (
    await http()
      .get(`${base}/sources?assetId=${asset.id}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(sources.items[0]).toMatchObject({
    containerId: saved.version.containerId,
    versionId: saved.version.id,
  });
  await http()
    .post("/api/customers/b/container-runtime/imports")
    .set(auth)
    .send(body)
    .expect(404);
  await http().get(`${base}/summary`).expect(401);
});
test("host discovery groups full ImageIDs, preserves runtime instances and rejects unauthorized connections", async () => {
  const asset = (
    await http()
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "inventory-host", kind: "host" })
  ).body;
  const imageId = "sha256:" + "a".repeat(64);
  const snapshot = (
    await http()
      .post("/api/customers/a/collections/upload")
      .set(auth)
      .send({
        assetId: asset.id,
        fileName: "inventory.json",
        content: JSON.stringify({
          schemaVersion: "ys-host/1",
          identity: {
            hostname: "inventory-host",
            serial: null,
            machineId: null,
          },
          collectedAt: null,
          sections: {
            images: {
              status: "acquired",
              data: [
                {
                  imageId,
                  repository: "example/app",
                  tag: "one",
                  digest: null,
                },
                {
                  imageId,
                  repository: "example/app",
                  tag: "two",
                  digest: null,
                },
              ],
            },
            containers: {
              status: "acquired",
              data: [
                {
                  containerId: "c".repeat(64),
                  imageId,
                  name: "app",
                  state: "running",
                },
              ],
            },
          },
          extensions: {},
        }),
      })
      .expect(201)
  ).body;
  const inventory = (
    await http().get(`${base}/inventory/${snapshot.id}`).set(auth).expect(200)
  ).body;
  expect(inventory.items).toHaveLength(1);
  expect(inventory.items[0]).toMatchObject({
    imageId,
    tags: ["one", "two"],
    containers: [{ name: "app", state: "running" }],
  });
  await http()
    .post(`${base}/discover`)
    .set(auth)
    .send({
      assetId: asset.id,
      profileId: "not-authorized",
      idempotencyKey: "bad-connection",
    })
    .expect(403);
  await http()
    .get(`/api/customers/b/container-runtime/inventory/${snapshot.id}`)
    .set(auth)
    .expect(404);
});

test("discover then generate selected image and assess with immutable host provenance; duplicate submit replays", async () => {
  const discover = (
    await http()
      .post(`${base}/discover`)
      .set(auth)
      .send({
        assetId: fixtureAsset,
        profileId: "docker-fixture",
        idempotencyKey: "discover",
      })
      .expect(201)
  ).body;
  let snapshotId: string;
  await expect
    .poll(async () => {
      const job = (
        await http()
          .get(`/api/customers/a/collections/jobs/${discover.id}`)
          .set(auth)
      ).body;
      snapshotId = job.snapshotId;
      return !!snapshotId;
    })
    .toBe(true);
  const input = {
    assetId: fixtureAsset,
    profileId: "docker-fixture",
    snapshotId: snapshotId!,
    imageIds: [imageId, imageId],
    idempotencyKey: "generate",
  };
  holdAssessment = true;
  const batch = (
    await http().post(`${base}/jobs`).set(auth).send(input).expect(202)
  ).body;
  expect(batch.items).toHaveLength(1);
  const replay = (
    await http().post(`${base}/jobs`).set(auth).send(input).expect(202)
  ).body;
  expect(replay.items[0].id).toBe(batch.items[0].id);
  await expect.poll(() => !!releaseAssessment).toBe(true);
  const active = (
    await http().get(`${base}/jobs/${batch.items[0].id}`).set(auth)
  ).body;
  holdAssessment = false;
  releaseAssessment!();
  releaseAssessment = undefined;
  expect(active.status).toBe("assessing");
  let job: any;
  await expect
    .poll(async () => {
      job = (await http().get(`${base}/jobs/${batch.items[0].id}`).set(auth))
        .body;
      return job.status;
    })
    .toBe("succeeded");
  const assessment = (
    await http()
      .get(`/api/customers/a/assessments/${job.assessmentId}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(assessment.input.containerSource).toMatchObject({
    assetId: fixtureAsset,
    basis: "docker_image_observation",
    imageId,
    generator: "fixture-trivy",
    containers: [{ name: "fixture-container" }],
  });
  await http()
    .get(`/api/customers/b/container-runtime/jobs/${job.id}`)
    .set(auth)
    .expect(404);
  await http()
    .post(`${base}/jobs`)
    .set(auth)
    .send({ ...input, imageIds: ["sha256:" + "b".repeat(64)] })
    .expect(400);
  const summary = (await http().get(`${base}/summary`).set(auth).expect(200))
    .body;
  expect(summary.generatedVersions).toBeGreaterThan(0);
});
test("invalid and concurrent manual imports stay atomic and preserve exact raw evidence", async () => {
  const before = (await http().get("/api/customers/a/containers").set(auth))
    .body.items.length;
  await http()
    .post(`${base}/imports`)
    .set(auth)
    .send({
      name: "bad",
      fileName: "bad.json",
      content: '{"bomFormat":"invalid"}',
    })
    .expect(400);
  expect(
    (await http().get("/api/customers/a/containers").set(auth)).body.items
      .length,
  ).toBe(before);
  const body = {
    name: "concurrent",
    fileName: "same.json",
    content: sbom("concurrent"),
  };
  const pair = await Promise.all([
    http().post(`${base}/imports`).set(auth).send(body),
    http().post(`${base}/imports`).set(auth).send(body),
  ]);
  expect(pair.map((r) => r.status)).toEqual([201, 201]);
  expect(pair[0].body.source.id).toBe(pair[1].body.source.id);
  expect(
    (
      await http()
        .get(`${base}/sources/${pair[0].body.source.id}/artifact`)
        .set(auth)
        .expect(200)
    ).body.content,
  ).toBe(body.content);
  await http()
    .get(
      `/api/customers/b/container-runtime/sources/${pair[0].body.source.id}/artifact`,
    )
    .set(auth)
    .expect(404);
});
test("current Trivy CycloneDX 1.7 output is accepted for containers without widening software input", async () => {
  const latest = JSON.parse(sbom("current-trivy"));
  latest.specVersion = "1.7";
  const result = (
    await http()
      .post(`${base}/imports`)
      .set(auth)
      .send({
        name: "current-trivy",
        fileName: "current.json",
        content: JSON.stringify(latest),
      })
      .expect(201)
  ).body;
  expect(result.version.components).toHaveLength(1);
  const software = (
    await http()
      .post("/api/customers/a/software")
      .set(auth)
      .send({ name: "old-software-contract" })
  ).body;
  latest.metadata.component.type = "application";
  await http()
    .post(`/api/customers/a/software/${software.id}/sbom`)
    .set(auth)
    .send({ fileName: "software.json", content: JSON.stringify(latest) })
    .expect(400);
});
test("fixed container sources and completed jobs survive application restart", async () => {
  const jobs = (await http().get(`${base}/jobs`).set(auth)).body.items;
  const source = (await http().get(`${base}/sources`).set(auth)).body.items[0];
  const artifact = (
    await http().get(`${base}/sources/${source.id}/artifact`).set(auth)
  ).body;
  await app.close();
  app = await createApp({
    databaseUrl: `pglite://${directory}`,
    customers: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    operators: [
      {
        token: "container-runtime-secret",
        name: "Tester",
        customerIds: ["a", "b"],
      },
    ],
  });
  expect(
    (
      await http()
        .get(`${base}/sources/${source.id}/artifact`)
        .set(auth)
        .expect(200)
    ).body,
  ).toEqual(artifact);
  expect(
    (await http().get(`${base}/jobs/${jobs[0].id}`).set(auth).expect(200)).body,
  ).toMatchObject({
    id: jobs[0].id,
    status: "succeeded",
    assessmentId: jobs[0].assessmentId,
  });
});

test("offline download normalizes untagged local image fields into an importable envelope", async () => {
  const { runInNewContext } = await import("node:vm");
  const script = (await http().get(`${base}/script`).set(auth).expect(200)).body
    .content;
  const fields = {
    YS_HOST: "offline-host",
    YS_MACHINE: "",
    YS_SERIAL: "",
    YS_IMAGE: JSON.stringify({
      imageId,
      architecture: "amd64",
      os: "linux",
      repoTags: null,
      repoDigests: null,
    }),
    YS_TOOL: "fixture-trivy",
    YS_TIME: "2026-11-23T00:00:00Z",
    YS_SBOM: sbom("offline-local"),
  };
  const protocol = Object.entries(fields)
    .map(([k, v]) => `${k}|${Buffer.from(v).toString("base64")}`)
    .join("\n");
  let content = "";
  runInNewContext(
    script.replace("import {execFileSync} from 'node:child_process';", ""),
    {
      Buffer,
      process: { argv: ["node", "script", imageId] },
      execFileSync: () => protocol,
      console: {
        log: (value: string) => {
          content = value;
        },
      },
    },
  );
  await http()
    .post(`${base}/imports`)
    .set(auth)
    .send({ name: "offline-local", fileName: "image.json", content })
    .expect(201);
});
