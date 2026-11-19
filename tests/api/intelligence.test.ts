import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
const config = {
  operators: [
    { token: "test-operator-secret", name: "分析员", customerIds: ["acme"] },
    { token: "other-operator-secret", name: "其他", customerIds: ["acme"] },
  ],
  customers: [{ id: "acme", name: "客户" }],
};
let app: Awaited<ReturnType<typeof createApp>>;
let directory: string;
afterEach(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("公开情报任务明确标记未评估客户资产，刷新及重启仍能回读且按操作员隔离", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-intelligence-"));
  app = await createApp({ ...config, databaseUrl: `pglite://${directory}` });
  const http = request(app.getHttpServer());
  const auth = { Authorization: "Bearer test-operator-secret" };
  const saved = await http
    .post("/api/intelligence/queries")
    .set(auth)
    .send({ message: "查看这个月的PHP CVE", idempotencyKey: "public-php-1" })
    .expect(202);
  expect(saved.body).toMatchObject({
    context: "public_intelligence",
    targetAssessment: "not_assessed",
    originalMessage: "查看这个月的PHP CVE",
  });
  let detail: any;
  for (let i = 0; i < 50; i++) {
    detail = (
      await http
        .get(`/api/intelligence/queries/${saved.body.id}`)
        .set(auth)
        .expect(200)
    ).body;
    if (!["queued", "running"].includes(detail.status)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(detail.status).toBe("unavailable");
  expect(detail.error).toContain("Pi");
  await http
    .get(`/api/intelligence/queries/${saved.body.id}`)
    .auth("other-operator-secret", { type: "bearer" })
    .expect(404);
  const replay = await http
    .post("/api/intelligence/queries")
    .set(auth)
    .send({ message: "查看这个月的PHP CVE", idempotencyKey: "public-php-1" })
    .expect(202);
  expect(replay.body.id).toBe(saved.body.id);
  await app.close();
  app = await createApp({ ...config, databaseUrl: `pglite://${directory}` });
  const reopened = await request(app.getHttpServer())
    .get(`/api/intelligence/queries/${saved.body.id}`)
    .set(auth)
    .expect(200);
  expect(reopened.body.status).toBe("unavailable");
  await request(app.getHttpServer())
    .get("/api/intelligence/queries")
    .expect(401);
});

test("固定 Pi 工具结果通过公开任务回读，不接受客户范围注入且幂等号不能改写问题", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-intelligence-rpc-"));
  const { AgentModule } = await import("../../apps/api/src/agent/agent.module");
  const { PiPublicQueryExecutor } =
    await import("../../apps/api/src/agent/pi-process");
  const { resolve } = await import("node:path");
  const executor = new PiPublicQueryExecutor({
    executable: process.execPath,
    prefixArgs: [resolve("tests/fixtures/pi-rpc.mjs")],
    artifactRoot: join(directory, "artifacts"),
    scriptPath: resolve("tests/fixtures/pi-rpc.mjs"),
    pythonExecutable: process.execPath,
    timeoutMs: 2000,
  });
  app = await createApp(
    { ...config, databaseUrl: `pglite://${join(directory, "db")}` },
    [AgentModule.register(executor)],
  );
  const http = request(app.getHttpServer());
  const auth = { Authorization: "Bearer test-operator-secret" };
  await http
    .post("/api/intelligence/queries")
    .set(auth)
    .send({ message: "PHP", idempotencyKey: "x", customerId: "acme" })
    .expect(400);
  const query = await http
    .post("/api/intelligence/queries")
    .set(auth)
    .send({ message: "PHP 最新 CVE", idempotencyKey: "rpc" })
    .expect(202);
  let result: any;
  for (let i = 0; i < 100; i++) {
    result = (
      await http
        .get(`/api/intelligence/queries/${query.body.id}`)
        .set(auth)
        .expect(200)
    ).body;
    if (!["queued", "running"].includes(result.status)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(result).toMatchObject({
    status: "partial",
    result: {
      results: [{ cve_id: "CVE-2024-4577" }],
      query: { original: "PHP 最新 CVE" },
      sources: [{ source_id: "php" }],
      coverage: { limitations: ["固定样例：第二来源不可用"] },
    },
  });
  expect(result.events.map((e: any) => e.type)).toContain("agent_settled");
  await http
    .post("/api/intelligence/queries")
    .set(auth)
    .send({ message: "改写后的PHP", idempotencyKey: "rpc" })
    .expect(409);
  const other = await http
    .get("/api/intelligence/queries")
    .auth("other-operator-secret", { type: "bearer" })
    .expect(200);
  expect(other.body.items).toEqual([]);
});

test("服务停止时保留中断任务，重启不会自动重做公开查询", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-agent-stop-"));
  const { AgentModule } = await import("../../apps/api/src/agent/agent.module");
  const conf = { ...config, databaseUrl: `pglite://${directory}` };
  app = await createApp(conf, [
    AgentModule.register({
      execute: async (_input, _emit, signal) =>
        new Promise((_ok, fail) => {
          signal.addEventListener("abort", () => fail(new Error("stop")), {
            once: true,
          });
        }),
    }),
  ]);
  const http = request(app.getHttpServer());
  const auth = { Authorization: "Bearer test-operator-secret" };
  const saved = await http
    .post("/api/intelligence/queries")
    .set(auth)
    .send({ message: "PHP slow", idempotencyKey: "stop" })
    .expect(202);
  await app.close();
  app = await createApp(conf);
  const reopened = await request(app.getHttpServer())
    .get(`/api/intelligence/queries/${saved.body.id}`)
    .set(auth)
    .expect(200);
  expect(reopened.body.status).toBe("interrupted");
});
