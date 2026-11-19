import { afterEach, expect, test } from "vitest";
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
test("客户对话明确未评估范围并持久回读，授权范围由后端限制", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-chat-"));
  const config = {
    databaseUrl: `pglite://${dir}`,
    customers: [
      { id: "acme", name: "客户A" },
      { id: "river", name: "客户B" },
    ],
    operators: [
      { token: "chat-operator-secret", name: "操作员", customerIds: ["acme"] },
    ],
  };
  app = await createApp(config);
  const http = request(app.getHttpServer());
  const auth = { Authorization: "Bearer chat-operator-secret" };
  const saved = await http
    .post("/api/customers/acme/conversations")
    .set(auth)
    .send({
      message: "哪些组件涉及CVE-2024-4577",
      assessmentIds: [],
      idempotencyKey: "first",
    })
    .expect(202);
  expect(saved.body).toMatchObject({
    customerId: "acme",
    facts: { coverage: "not_assessed", matches: [] },
  });
  await http
    .get(`/api/customers/river/conversations/${saved.body.id}`)
    .set(auth)
    .expect(403);
  await http
    .post("/api/customers/acme/conversations")
    .set(auth)
    .send({
      message: "PHP",
      assessmentIds: [],
      idempotencyKey: "inject",
      customerId: "river",
    })
    .expect(400);
  await app.close();
  app = await createApp(config);
  const result = await request(app.getHttpServer())
    .get(`/api/customers/acme/conversations/${saved.body.id}`)
    .set(auth)
    .expect(200);
  expect(result.body.facts.coverage).toBe("not_assessed");
});

test("对话只读选定客户软件发现，伪造评估引用不能跨客户，Pi工具只收到授权快照", async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-chat-evidence-"));
  const cfg = {
    databaseUrl: `pglite://${dir}`,
    customers: [
      { id: "acme", name: "A" },
      { id: "river", name: "B" },
    ],
    operators: [
      {
        token: "chat-evidence-secret",
        name: "分析",
        customerIds: ["acme", "river"],
      },
    ],
  };
  const observed: string[] = [];
  app = await createApp(cfg, [], {
    customerReadExecutor: {
      async execute(input, emit) {
        observed.push(input.customerId);
        expect(input.facts.matches[0]?.vulnerabilityId).toBe("CVE-2024-4577");
        await emit("tool_completed", "已读取授权快照");
      },
    },
    trivyExecutor: {
      async execute() {
        return {
          status: "succeeded",
          toolVersion: "fixture",
          argv: [],
          startedAt: "2026-11-18T00:00:00Z",
          finishedAt: "2026-11-18T00:00:01Z",
          exitCode: 0,
          signal: null,
          stderr: "",
          databaseBefore: null,
          databaseAfter: null,
          rawReport: JSON.stringify({
            SchemaVersion: 2,
            Results: [
              {
                Target: "app",
                Class: "lang-pkgs",
                Type: "npm",
                Packages: [
                  {
                    Name: "lib",
                    Version: "1",
                    Identifier: { PURL: "pkg:npm/lib@1" },
                  },
                ],
                Vulnerabilities: [
                  {
                    VulnerabilityID: "CVE-2024-4577",
                    PkgName: "lib",
                    InstalledVersion: "1",
                    Severity: "HIGH",
                    FixedVersion: "2",
                  },
                ],
              },
            ],
          }),
        };
      },
    },
  });
  const http = request(app.getHttpServer());
  const auth = { Authorization: "Bearer chat-evidence-secret" };
  const software = (
    await http
      .post("/api/customers/acme/software")
      .set(auth)
      .send({ name: "App" })
      .expect(201)
  ).body;
  const version = (
    await http
      .post(`/api/customers/acme/software/${software.id}/sbom`)
      .set(auth)
      .send({
        fileName: "app.json",
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          metadata: {
            component: { type: "application", name: "App", version: "1" },
          },
          components: [
            {
              type: "library",
              name: "lib",
              version: "1",
              purl: "pkg:npm/lib@1",
            },
          ],
        }),
      })
      .expect(201)
  ).body;
  const task = (
    await http
      .post("/api/customers/acme/assessments")
      .set(auth)
      .send({
        softwareId: software.id,
        versionId: version.id,
        idempotencyKey: "assess",
      })
      .expect(202)
  ).body;
  for (let i = 0; i < 50; i++) {
    const d = (
      await http
        .get(`/api/customers/acme/assessments/${task.id}`)
        .set(auth)
        .expect(200)
    ).body;
    if (d.status === "succeeded") break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await http
    .post("/api/customers/river/conversations")
    .set(auth)
    .send({
      message: "CVE-2024-4577",
      assessmentIds: [task.id],
      idempotencyKey: "forged",
    })
    .expect(404);
  const chat = (
    await http
      .post("/api/customers/acme/conversations")
      .set(auth)
      .send({
        message: "哪些组件涉及CVE-2024-4577",
        assessmentIds: [task.id],
        idempotencyKey: "actual",
      })
      .expect(202)
  ).body;
  let detail: any;
  for (let i = 0; i < 50; i++) {
    detail = (
      await http
        .get(`/api/customers/acme/conversations/${chat.id}`)
        .set(auth)
        .expect(200)
    ).body;
    if (!["queued", "running"].includes(detail.status)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(detail).toMatchObject({
    status: "succeeded",
    facts: {
      matches: [
        {
          assessmentId: task.id,
          packageName: "lib",
          installedVersion: "1",
          vulnerabilityId: "CVE-2024-4577",
          applicability: "tool_reported",
        },
      ],
    },
  });
  expect(observed).toEqual(["acme"]);
  await http
    .get(`/api/customers/river/conversations/${chat.id}`)
    .set(auth)
    .expect(404);
  await http
    .post("/api/customers/acme/conversations")
    .set(auth)
    .send({
      message: "其他问题",
      assessmentIds: [task.id],
      idempotencyKey: "actual",
    })
    .expect(409);
});
