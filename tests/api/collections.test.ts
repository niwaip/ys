import { execFileSync } from "node:child_process";
import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm, writeFile, readFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, dir: string;
const auth = { Authorization: "Bearer collection-test-token" };
const base = {
  customers: [
    { id: "acme", name: "A" },
    { id: "other", name: "B" },
  ],
  operators: [
    {
      name: "T",
      token: "collection-test-token",
      customerIds: ["acme", "other"],
    },
  ],
};
afterEach(async () => {
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
test("三入口共用不可变基础快照；包清单分页、原文、未知与未评估状态可回读", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-collections-"));
  const config = { ...base, databaseUrl: `pglite://${dir}` };
  app = await createApp(config);
  let http = request(app.getHttpServer());
  const asset = (
    await http
      .post("/api/customers/acme/assets")
      .set(auth)
      .send({ name: "YS", kind: "host" })
      .expect(201)
  ).body;
  const data = {
    schemaVersion: "ys-host/1",
    identity: { hostname: "ys", serial: null, machineId: "m1" },
    collectedAt: null,
    sections: {
      os: {
        status: "acquired",
        data: {
          id: "debian",
          version: "12",
          kernel: "6.1",
          architecture: "x86_64",
        },
      },
      packages: {
        status: "acquired",
        data: [
          {
            name: "openssl",
            version: "1:3.0.11-1~deb12u2",
            architecture: "amd64",
            state: "installed",
            manager: "dpkg",
          },
        ],
      },
      dockerDaemon: { status: "permission_denied", data: null },
    },
    extensions: { vendor: "preserved" },
  };
  const upload = () =>
    http
      .post("/api/customers/acme/collections/upload")
      .set(auth)
      .send({
        assetId: asset.id,
        fileName: "host.json",
        content: JSON.stringify(data),
      });
  const first = (await upload().expect(201)).body;
  expect(first).toMatchObject({
    assetId: asset.id,
    entry: "upload",
    assessmentStatus: "not_assessed",
    collectedAt: null,
    sections: {
      packages: { count: 1 },
      dockerDaemon: { status: "permission_denied" },
      containers: { status: "not_collected" },
    },
  });
  expect(first.sections.packages.data).toBeUndefined();
  expect((await upload().expect(201)).body.id).toBe(first.id);
  await http
    .post("/api/customers/acme/collections/manual")
    .set(auth)
    .send({
      assetId: asset.id,
      note: "现场提供",
      data: { ...data, identity: { ...data.identity, machineId: "different" } },
    })
    .expect(409);
  const packages = await http
    .get(
      `/api/customers/acme/collections/snapshots/${first.id}/sections/packages?limit=1`,
    )
    .set(auth)
    .expect(200);
  expect(packages.body.items[0].version).toBe("1:3.0.11-1~deb12u2");
  await app.close();
  app = await createApp(config);
  http = request(app.getHttpServer());
  expect(
    (
      await http
        .get(`/api/customers/acme/collections/snapshots/${first.id}/raw`)
        .set(auth)
        .expect(200)
    ).body.content,
  ).toBe(JSON.stringify(data));
  await http
    .get(`/api/customers/other/collections/snapshots/${first.id}`)
    .set(auth)
    .expect(404);
  expect(
    (
      await http
        .get(`/api/customers/acme/collections/snapshots/${first.id}`)
        .set(auth)
    ).body.extensions,
  ).toEqual({ vendor: "preserved" });
  await http
    .post("/api/customers/acme/collections/upload")
    .set(auth)
    .send({
      assetId: asset.id,
      fileName: "future.json",
      content: JSON.stringify({ ...data, schemaVersion: "future" }),
    })
    .expect(400);
});

test("Pi未配置仍保存可回读任务，连接引用与客户目标绑定，幂等冲突明确", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-collection-jobs-"));
  app = await createApp({ ...base, databaseUrl: `pglite://${dir}` });
  const http = request(app.getHttpServer());
  const asset = (
    await http
      .post("/api/customers/acme/assets")
      .set(auth)
      .send({ name: "YS", kind: "host" })
  ).body;
  const body = {
    assetId: asset.id,
    idempotencyKey: "request-1",
    profileId: "ys-read",
    scope: "basic",
    message: "取得OS和包清单",
  };
  const job = (
    await http
      .post("/api/customers/acme/collections/jobs")
      .set(auth)
      .send(body)
      .expect(201)
  ).body;
  expect(job.status).toBe("unavailable");
  expect(job.error).toContain("Pi");
  expect(
    (
      await http
        .post("/api/customers/acme/collections/jobs")
        .set(auth)
        .send(body)
        .expect(201)
    ).body.id,
  ).toBe(job.id);
  await http
    .post("/api/customers/acme/collections/jobs")
    .set(auth)
    .send({ ...body, message: "changed" })
    .expect(409);
  await http
    .get(`/api/customers/other/collections/jobs/${job.id}`)
    .set(auth)
    .expect(404);
  expect(
    (
      await http
        .get(`/api/customers/acme/collections/jobs/${job.id}`)
        .set(auth)
        .expect(200)
    ).body.snapshotId,
  ).toBeNull();
});

test("网页Pi固定工具通过SSH替身取得OS/包，基础采集不会读取容器目录", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-ssh-fixture-"));
  const key = join(dir, "identity"),
    known = join(dir, "known_hosts"),
    ssh = join(dir, "ssh"),
    pi = join(dir, "pi"),
    record = join(dir, "invocation.json");
  await writeFile(key, "fixture", { mode: 0o600 });
  await writeFile(known, "fixture");
  const lines =
    Object.entries({
      hostname: "ys",
      machineId: "m1",
      serial: "serial",
      os: 'ID=debian\nVERSION_ID="12"',
      kernel: "6.1",
      architecture: "x86_64",
      packages: "dpkg\topenssl\t1:3.0.11-1~deb12u2\tamd64\tinstalled",
      cpu: "cpu",
      memory: "mem",
      disks: "disk",
      network: "[]",
      dockerClient: "Docker version 27.0.0, build test",
    })
      .map(
        ([name, text]) => `${name}|0|${Buffer.from(text).toString("base64")}`,
      )
      .join("\n") + "\n";
  await writeFile(
    ssh,
    `#!${process.execPath}\nconst fs=require("node:fs");let script="";process.stdin.on("data",c=>script+=c);process.stdin.on("end",()=>{fs.writeFileSync(${JSON.stringify(record)},JSON.stringify({args:process.argv.slice(2),script}));process.stdout.write(${JSON.stringify(lines)});});`,
  );
  await writeFile(
    pi,
    `#!/usr/bin/env node\nconst {pathToFileURL}=require("node:url");let text="";process.stdin.on("data",async c=>{text+=c;const at=text.indexOf("\\n");if(at<0)return;const message=JSON.parse(text.slice(0,at));text=text.slice(at+1);let tool;const extension=await import(pathToFileURL(process.argv[process.argv.indexOf("-e")+1]));extension.default({registerTool:t=>tool=t});const send=v=>process.stdout.write(JSON.stringify(v)+"\\n");send({type:"response",id:message.id,success:true});send({type:"tool_execution_start",toolCallId:"c",toolName:tool.name});try{await tool.execute("c",{});send({type:"tool_execution_end",toolCallId:"c",toolName:tool.name,isError:false});send({type:"agent_settled"});}catch(e){send({type:"tool_execution_end",toolCallId:"c",toolName:tool.name,isError:true});}});`,
  );
  await chmod(ssh, 0o700);
  await chmod(pi, 0o700);
  const config = { ...base, databaseUrl: `pglite://${join(dir, "db")}` };
  app = await createApp(config);
  const asset = (
    await request(app.getHttpServer())
      .post("/api/customers/acme/assets")
      .set(auth)
      .send({ name: "YS", kind: "host" })
  ).body;
  await app.close();
  app = await createApp({
    ...config,
    pi: {
      executable: pi,
      artifactRoot: join(dir, "artifacts"),
      timeoutMs: 10000,
    },
    collection: {
      profiles: [
        {
          id: "ys-read",
          label: "YS只读",
          customerId: "acme",
          assetId: asset.id,
          host: "host.invalid",
          username: "reader",
          identityFile: key,
          knownHostsFile: known,
          sshExecutable: ssh,
          allowDocker: false,
        },
      ],
    },
  });
  const http = request(app.getHttpServer());
  const body = {
    assetId: asset.id,
    idempotencyKey: "run",
    profileId: "ys-read",
    scope: "basic",
    message: "取得系统包",
  };
  await http
    .post("/api/customers/acme/collections/jobs")
    .set(auth)
    .send({ ...body, profileId: "other" })
    .expect(403);
  const job = (
    await http
      .post("/api/customers/acme/collections/jobs")
      .set(auth)
      .send(body)
      .expect(201)
  ).body;
  let result = job;
  for (
    let i = 0;
    i < 100 && ["queued", "running"].includes(result.status);
    i++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    result = (
      await http.get(`/api/customers/acme/collections/jobs/${job.id}`).set(auth)
    ).body;
  }
  expect(result, JSON.stringify(result)).toMatchObject({
    status: "succeeded",
    error: null,
  });
  expect(result.snapshotId).toBeTruthy();
  const invocation = JSON.parse(await readFile(record, "utf8"));
  execFileSync("/bin/sh", ["-n"], { input: invocation.script });
  expect(invocation.args).toContain("StrictHostKeyChecking=yes");
  expect(invocation.args).toContain("IdentityAgent=none");
  expect(invocation.script).toContain("dpkg-query");
  expect(invocation.script).not.toContain("inspect");
  expect(invocation.script).not.toContain("sudo");
  expect(invocation.script).not.toContain("trivy");
  const snapshot = (
    await http
      .get(`/api/customers/acme/collections/snapshots/${result.snapshotId}`)
      .set(auth)
  ).body;
  expect(snapshot.sections).toMatchObject({
    packages: { count: 1 },
    containers: { status: "not_collected" },
    dockerDaemon: { status: "not_collected" },
  });
  expect(JSON.stringify(result)).not.toContain(key);
});

test("显式软件版本关联绑定固定主机快照，独立评估及报告冻结来源链", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-link-"));
  app = await createApp({ ...base, databaseUrl: `pglite://${dir}` });
  const http = request(app.getHttpServer());
  const asset = (
    await http
      .post("/api/customers/acme/assets")
      .set(auth)
      .send({ name: "YS", kind: "host" })
  ).body;
  const snapshot = (
    await http
      .post("/api/customers/acme/collections/manual")
      .set(auth)
      .send({
        assetId: asset.id,
        note: "现场",
        data: {
          schemaVersion: "ys-host/1",
          identity: { hostname: "ys" },
          collectedAt: null,
          sections: {},
        },
      })
  ).body;
  const software = (
    await http
      .post("/api/customers/acme/software")
      .set(auth)
      .send({ name: "Billing" })
  ).body;
  const version = (
    await http
      .post(`/api/customers/acme/software/${software.id}/sbom`)
      .set(auth)
      .send({
        fileName: "a.json",
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          version: 1,
          components: [{ type: "library", name: "example", version: "1" }],
        }),
      })
      .expect(201)
  ).body;
  const link = (
    await http
      .post("/api/customers/acme/collections/links")
      .set(auth)
      .send({
        assetId: asset.id,
        snapshotId: snapshot.id,
        kind: "software",
        objectId: software.id,
        versionId: version.id,
        basis: "客户声明部署于此主机",
      })
      .expect(201)
  ).body;
  const job = (
    await http
      .post("/api/customers/acme/assessments")
      .set(auth)
      .send({
        softwareId: software.id,
        versionId: version.id,
        linkId: link.id,
        idempotencyKey: "linked-assessment",
      })
      .expect(202)
  ).body;
  expect(job.input.provenance).toMatchObject({
    id: link.id,
    assetId: asset.id,
    snapshot: { id: snapshot.id, contentHash: snapshot.contentHash },
    basis: "客户声明部署于此主机",
    basisType: "operator_declaration",
  });
  await http
    .post("/api/customers/other/assessments")
    .set(auth)
    .send({
      softwareId: software.id,
      versionId: version.id,
      linkId: link.id,
      idempotencyKey: "forbidden",
    })
    .expect(404);
  let done = job;
  for (let i = 0; i < 100 && ["queued", "running"].includes(done.status); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    done = (
      await http.get(`/api/customers/acme/assessments/${job.id}`).set(auth)
    ).body;
  }
  const report = (
    await http
      .post("/api/customers/acme/reports")
      .set(auth)
      .send({ assessmentRefs: [job.id] })
      .expect(201)
  ).body;
  expect(report.revision.facts.assessmentSnapshots[0].input.provenance).toEqual(
    job.input.provenance,
  );
  const html = await http
    .get(`/api/customers/acme/reports/${report.id}/preview`)
    .set(auth)
    .expect(200);
  expect(html.text).toContain(snapshot.contentHash);
});

test("3000个系统包完整保存并分页，超项数及矛盾状态明确拒绝而非截断", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-many-packages-"));
  app = await createApp({ ...base, databaseUrl: `pglite://${dir}` });
  const http = request(app.getHttpServer());
  const asset = (
    await http
      .post("/api/customers/acme/assets")
      .set(auth)
      .send({ name: "large", kind: "host" })
  ).body;
  const record = {
    name: "x",
    version: null,
    architecture: null,
    state: "unknown",
    manager: "dpkg",
  };
  const data = {
    schemaVersion: "ys-host/1",
    identity: { hostname: "large" },
    collectedAt: null,
    sections: {
      packages: {
        status: "acquired",
        data: Array.from({ length: 3000 }, (_, i) => ({
          ...record,
          name: `p${i}`,
        })),
      },
    },
  };
  const post = (payload: unknown) =>
    http
      .post("/api/customers/acme/collections/upload")
      .set(auth)
      .send({
        assetId: asset.id,
        fileName: "large.json",
        content: JSON.stringify(payload),
      });
  const snapshot = (await post(data).expect(201)).body;
  expect(snapshot.sections.packages.count).toBe(3000);
  const last = (
    await http
      .get(
        `/api/customers/acme/collections/snapshots/${snapshot.id}/sections/packages?offset=2999&limit=1`,
      )
      .set(auth)
      .expect(200)
  ).body;
  expect(last.items).toHaveLength(1);
  expect(last.items[0].name).toBe("p2999");
  expect(last.total).toBe(3000);
  await post({
    ...data,
    sections: { packages: { status: "acquired", data: null } },
  }).expect(400);
  await post({
    ...data,
    sections: {
      packages: {
        status: "acquired",
        data: Array.from({ length: 50001 }, () => record),
      },
    },
  }).expect(400);
  expect(
    (await http.get("/api/customers/acme/collections/snapshots").set(auth)).body
      .total,
  ).toBe(1);
});
