import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";

let app: Awaited<ReturnType<typeof createApp>>, directory: string;
const auth = { Authorization: "Bearer report-center-test" };
const config = {
  customers: [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ],
  operators: [
    {
      token: "report-center-test",
      name: "Report author",
      customerIds: ["a", "b"],
    },
  ],
};
afterEach(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("单台服务器无扫描结果仍形成可回读的固定覆盖草稿，不冒充零风险", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-report-center-"));
  const options = { ...config, databaseUrl: `pglite://${directory}` };
  app = await createApp(options);
  const http = request(app.getHttpServer());
  const asset = (
    await http
      .post("/api/customers/a/assets")
      .set(auth)
      .send({
        name: "unassessed-server",
        kind: "host",
        attributes: { hardwareType: "server" },
      })
      .expect(201)
  ).body;
  await http
    .patch(`/api/customers/a/assets/${asset.id}/classification`)
    .set(auth)
    .send({ hardwareType: "server" })
    .expect(200);
  const input = {
    name: "服务器巡检",
    scope: { kind: "selected", assetIds: [asset.id] },
    mode: "existing",
    idempotencyKey: "single-no-results",
  };
  const task = (
    await http
      .post("/api/customers/a/report-center/tasks")
      .set(auth)
      .send(input)
      .expect(202)
  ).body;
  expect(task.status).toBe("completed");
  const report = (
    await http
      .get(`/api/customers/a/reports/${task.reportId}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(report.name).toBe("服务器巡检");
  expect(report.revision.facts.center.hosts).toEqual([
    expect.objectContaining({
      assetId: asset.id,
      name: "unassessed-server",
      status: "unassessed",
    }),
  ]);
  expect(report.revision.facts.statistics.findingInstances).toBeNull();
  const html = (
    await http
      .get(`/api/customers/a/reports/${report.id}/preview`)
      .set(auth)
      .expect(200)
  ).text;
  expect(html).toContain("执行与覆盖说明");
  expect(html).toContain("unassessed-server");
  expect(html).toContain("未复核");
  await http
    .get(`/api/customers/b/report-center/tasks/${task.id}`)
    .set(auth)
    .expect(404);
  expect(
    (
      await http
        .post("/api/customers/a/report-center/tasks")
        .set(auth)
        .send(input)
        .expect(202)
    ).body.id,
  ).toBe(task.id);
  await app.close();
  app = await createApp(options);
  const reopened = request(app.getHttpServer());
  expect(
    (
      await reopened
        .get(`/api/customers/a/report-center/tasks/${task.id}`)
        .set(auth)
        .expect(200)
    ).body.reportId,
  ).toBe(report.id);
  expect(
    (
      await reopened
        .get(`/api/customers/a/reports/${report.id}`)
        .set(auth)
        .expect(200)
    ).body,
  ).toEqual(report);
});
