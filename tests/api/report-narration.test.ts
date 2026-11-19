import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, directory: string;
const auth = { Authorization: "Bearer narration-test-secret" };
const config = {
  customers: [
    { id: "a", name: "A" },
    { id: "b", name: "B" },
  ],
  operators: [
    {
      token: "narration-test-secret",
      name: "Narrator",
      customerIds: ["a", "b"],
    },
  ],
};
afterEach(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
async function seed() {
  const h = request(app.getHttpServer());
  const asset = (
    await h
      .post("/api/customers/a/assets")
      .set(auth)
      .send({
        name: "Scoped input",
        kind: "host",
        attributes: { product: "Widget" },
      })
  ).body;
  const batch = (
    await h
      .post("/api/customers/a/lifecycle/batches")
      .set(auth)
      .send({
        fileName: "l.csv",
        content:
          "source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nFixture,fixture,Widget,1,Sales,,Support,2026-02-30",
      })
  ).body;
  const assessment = (
    await h
      .post("/api/customers/a/lifecycle/assessments")
      .set(auth)
      .send({ batchId: batch.id, assetIds: [asset.id] })
  ).body;
  return (
    await h
      .post("/api/customers/a/reports")
      .set(auth)
      .send({ lifecycleRefs: [assessment.id] })
      .expect(201)
  ).body;
}
async function done(base: string, id: string) {
  let result: any;
  await expect
    .poll(async () => {
      result = (
        await request(app.getHttpServer())
          .get(`${base}/narrations/${id}`)
          .set(auth)
          .expect(200)
      ).body;
      return ["queued", "running"].includes(result.status);
    })
    .toBe(false);
  return result;
}
test("AI job binds scoped immutable facts and creates a controlled reviewable revision after valid proposal", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-narration-"));
  let seen: any;
  app = await createApp(
    { ...config, databaseUrl: `pglite://${directory}` },
    [],
    {
      reportNarrationExecutor: {
        execute: async (input: any, emit: any) => {
          seen = input;
          await emit("proposal", "fixture proposal");
          return {
            schemaVersion: "report-proposal-v1",
            baseRevisionId: input.baseRevisionId,
            factHash: input.factHash,
            narrative: {
              ...input.allowedNarrative,
              blocks: [
                { templateId: "summary", wording: "standard" },
                ...input.allowedNarrative.blocks.slice().reverse(),
                { templateId: "recommendations", wording: "concise" },
              ],
            },
          };
        },
      },
    },
  );
  const report = await seed(),
    http = request(app.getHttpServer()),
    base = `/api/customers/a/reports/${report.id}`;
  const job = (
    await http
      .post(`${base}/narrations`)
      .set(auth)
      .send({ baseRevisionId: report.revision.id, idempotencyKey: "normal" })
      .expect(202)
  ).body;
  const result = await done(base, job.id);
  expect(result).toMatchObject({
    status: "succeeded",
    fallback: false,
    factHash: report.revision.factHash,
  });
  expect(seen).toMatchObject({
    baseRevisionId: report.revision.id,
    factHash: report.revision.factHash,
  });
  expect(JSON.stringify(seen)).not.toContain("narration-test-secret");
  const revised = (
    await http.get(`${base}/revisions/${result.resultRevisionId}`).set(auth)
  ).body;
  expect(revised).toMatchObject({
    status: "draft",
    factHash: report.revision.factHash,
    facts: report.revision.facts,
  });
  expect(revised.number).toBe(2);
  await http
    .get(`${base}/revisions/${revised.id}/export`)
    .set(auth)
    .expect(409);
  await http
    .post(`${base}/revisions/${revised.id}/approve`)
    .set(auth)
    .send({})
    .expect(409);
  const html = (
    await http.get(`${base}/revisions/${revised.id}/preview`).set(auth)
  ).text;
  expect(html).toContain("摘要");
  expect(html).toContain("建议");
  expect(html).toContain("未知");
  const replay = (
    await http
      .post(`${base}/narrations`)
      .set(auth)
      .send({ baseRevisionId: report.revision.id, idempotencyKey: "normal" })
      .expect(202)
  ).body;
  expect(replay.id).toBe(job.id);
  await http
    .get(`/api/customers/b/reports/${report.id}/narrations/${job.id}`)
    .set(auth)
    .expect(404);
});
test("invented facts, identifiers, filled dates and timeout fall back without replacing the fact draft", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-narration-fallback-"));
  const options = { ...config, databaseUrl: `pglite://${directory}` };
  const outputs = ["identifier", "statistics", "date", "timeout"];
  app = await createApp(options, [], {
    reportNarrationTimeoutMs: 70,
    reportNarrationExecutor: {
      execute: async (input: any) => {
        const mode = outputs.shift();
        if (mode === "timeout") return new Promise(() => {});
        const narrative = structuredClone(input.allowedNarrative);
        if (mode === "identifier")
          narrative.blocks[0].factRef = "00000000-0000-4000-8000-000000000099";
        if (mode === "statistics")
          narrative.statistics = { findingInstances: 0 };
        if (mode === "date")
          narrative.blocks[0].text = "EOS已于2026-01-01结束，无风险";
        return {
          schemaVersion: "report-proposal-v1",
          baseRevisionId: input.baseRevisionId,
          factHash: input.factHash,
          narrative,
        };
      },
    },
  });
  const report = await seed(),
    http = request(app.getHttpServer()),
    base = `/api/customers/a/reports/${report.id}`;
  for (const key of ["identifier", "statistics", "date", "timeout"]) {
    const job = (
      await http
        .post(`${base}/narrations`)
        .set(auth)
        .send({ baseRevisionId: report.revision.id, idempotencyKey: key })
        .expect(202)
    ).body;
    const result = await done(base, job.id);
    expect(result.status).toBe(key === "timeout" ? "timed_out" : "failed");
    expect(result.fallback).toBe(true);
    expect(result.error).toBeTruthy();
    expect((await http.get(base).set(auth)).body).toEqual(report);
  }
  await app.close();
  app = await createApp(options);
  expect(
    (await request(app.getHttpServer()).get(`${base}/narrations`).set(auth))
      .body.items,
  ).toHaveLength(4);
});
test("a newer manual revision wins over an in-flight AI proposal, and shutdown preserves interrupted jobs", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-narration-conflict-"));
  const options = { ...config, databaseUrl: `pglite://${directory}` };
  let release: () => void = () => {};
  app = await createApp(options, [], {
    reportNarrationExecutor: {
      execute: async (input: any, emit: any) => {
        await emit("fixture_waiting", "waiting for manual edit");
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {
          schemaVersion: "report-proposal-v1",
          baseRevisionId: input.baseRevisionId,
          factHash: input.factHash,
          narrative: input.allowedNarrative,
        };
      },
    },
  });
  const report = await seed(),
    http = request(app.getHttpServer()),
    base = `/api/customers/a/reports/${report.id}`;
  const job = (
    await http
      .post(`${base}/narrations`)
      .set(auth)
      .send({
        baseRevisionId: report.revision.id,
        idempotencyKey: "concurrent",
      })
  ).body;
  await expect
    .poll(async () =>
      (
        await http.get(`${base}/narrations/${job.id}`).set(auth)
      ).body.events.some((e: any) => e.type === "fixture_waiting"),
    )
    .toBe(true);
  const edited = (
    await http
      .post(`${base}/revisions`)
      .set(auth)
      .send({
        baseRevisionId: report.revision.id,
        narrative: { ...report.revision.narrative, density: "compact" },
      })
      .expect(201)
  ).body;
  release();
  expect(await done(base, job.id)).toMatchObject({
    status: "failed",
    fallback: true,
  });
  expect((await http.get(base).set(auth)).body.revision.id).toBe(edited.id);
  const interrupted = (
    await http
      .post(`${base}/narrations`)
      .set(auth)
      .send({ baseRevisionId: edited.id, idempotencyKey: "interrupt" })
  ).body;
  await expect
    .poll(
      async () =>
        (await http.get(`${base}/narrations/${interrupted.id}`).set(auth)).body
          .status,
    )
    .toBe("running");
  await app.close();
  app = await createApp(options);
  expect(
    (
      await request(app.getHttpServer())
        .get(`${base}/narrations/${interrupted.id}`)
        .set(auth)
    ).body,
  ).toMatchObject({ status: "interrupted", fallback: true });
});
