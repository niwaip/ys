import { afterEach, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, directory: string;
const auth = { Authorization: "Bearer review-test-secret" };
afterEach(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("reviewed delivery binds immutable facts and HTML, edited revisions require review and audit stays customer scoped", async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-review-"));
  const options = {
    databaseUrl: `pglite://${directory}`,
    customers: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    operators: [
      {
        token: "review-test-secret",
        name: "Reviewer",
        customerIds: ["a", "b"],
      },
    ],
  };
  app = await createApp(options);
  const http = request(app.getHttpServer());
  const asset = (
    await http
      .post("/api/customers/a/assets")
      .set(auth)
      .send({
        name: "Review host",
        kind: "host",
        attributes: { product: "Widget", version: "1" },
      })
  ).body;
  const batch = (
    await http.post("/api/customers/a/lifecycle/batches").set(auth).send({
      fileName: "eol.csv",
      content:
        "source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nFixture,fixture,Widget,1,Sales,2020-01-01,Support,",
    })
  ).body;
  const assessment = (
    await http
      .post("/api/customers/a/lifecycle/assessments")
      .set(auth)
      .send({ batchId: batch.id, assetIds: [asset.id] })
  ).body;
  const report = (
    await http
      .post("/api/customers/a/reports")
      .set(auth)
      .send({ lifecycleRefs: [assessment.id] })
  ).body;
  const base = `/api/customers/a/reports/${report.id}`,
    revision = `${base}/revisions/${report.revision.id}`;
  await http.get(`${revision}/export`).set(auth).expect(409);
  await http.post(`${revision}/deliver`).set(auth).send({}).expect(409);
  await http.post(`${revision}/approve`).set(auth).send({}).expect(409);
  await http.post(`${revision}/submit-review`).set(auth).send({}).expect(201);
  await http.post(`${revision}/approve`).set(auth).send({}).expect(201);
  const delivery = (
    await http.post(`${revision}/deliver`).set(auth).send({}).expect(201)
  ).body;
  expect(delivery).toMatchObject({ revisionId: report.revision.id });
  expect(delivery.contentHash).toMatch(/^[a-f0-9]{64}$/);
  const html = (await http.get(`${revision}/export`).set(auth).expect(200))
    .text;
  expect(html).toContain("正式交付");
  expect(html).toContain("2020-01-01");
  expect(html).toContain("未知");
  const narrative = {
    ...report.revision.narrative,
    density: "compact",
    blocks: [...report.revision.narrative.blocks]
      .reverse()
      .map((x: { wording: string }) => ({
        ...x,
        wording: "concise",
        text: "围绕【scope】，本段说明所选输入。因此，建议核对输入身份，以便明确后续核查范围。",
      })),
  };
  const edited = (
    await http
      .post(`${base}/revisions`)
      .set(auth)
      .send({ baseRevisionId: report.revision.id, narrative })
      .expect(201)
  ).body;
  expect(edited).toMatchObject({
    number: 2,
    status: "draft",
    factHash: report.revision.factHash,
    facts: report.revision.facts,
  });
  const editedPreview = (
    await http
      .get(`${base}/revisions/${edited.id}/preview`)
      .set(auth)
      .expect(200)
  ).text;
  expect(editedPreview).toContain("本段说明所选输入");
  expect(editedPreview).toContain("建议核对输入身份，以便明确后续核查范围");
  expect(editedPreview).toContain(asset.id);
  expect(editedPreview).not.toContain("【scope】");
  for (const text of [
    "围绕【scope】，这些缺口限制结果解释，需补充证据后复评。",
    "围绕【scope】，本段说明所选输入。因此，建议补充覆盖资料，以便完善后续评估输入。",
    "建议安排人工复评，以便保留复核依据。",
    "已确认安全，无风险。",
    "围绕【missing】，本段说明所选输入。",
    "围绕【scope】，本段说明所选输入。2027-01-01已修复。",
    "围绕【findings】，本段说明所选输入。",
    "围绕【scope】，本段说明所选输入。<script>alert(1)</script>",
  ]) {
    const invalid = structuredClone(narrative);
    invalid.blocks[0].text = text;
    await http
      .post(`${base}/revisions`)
      .set(auth)
      .send({ baseRevisionId: edited.id, narrative: invalid })
      .expect(400);
  }
  await http
    .post(`${base}/revisions/${edited.id}/deliver`)
    .set(auth)
    .send({})
    .expect(409);
  await http
    .post(`${base}/revisions`)
    .set(auth)
    .send({
      baseRevisionId: edited.id,
      narrative,
      facts: { statistics: { findingInstances: 0 } },
    })
    .expect(400);
  await http
    .post(`${base}/revisions`)
    .set(auth)
    .send({
      baseRevisionId: edited.id,
      narrative: {
        ...narrative,
        blocks: narrative.blocks.filter(
          (x: { templateId: string }) => x.templateId !== "coverage",
        ),
      },
    })
    .expect(400);
  expect((await http.get(`${revision}/export`).set(auth)).text).toBe(html);
  const audit = (await http.get(`${base}/audit`).set(auth).expect(200)).body;
  expect(audit.items.map((x: { action: string }) => x.action)).toEqual([
    "submit_review",
    "approve",
    "deliver",
    "revise",
  ]);
  expect(audit.items[0].actor).toMatchObject({ name: "Reviewer" });
  expect(JSON.stringify(audit)).not.toContain("review-test-secret");
  await http
    .get(`/api/customers/b/reports/${report.id}/audit`)
    .set(auth)
    .expect(404);
  await http
    .post(
      `/api/customers/b/reports/${report.id}/revisions/${edited.id}/approve`,
    )
    .set(auth)
    .send({})
    .expect(404);
  await app.close();
  app = await createApp(options);
  expect(
    (await request(app.getHttpServer()).get(`${revision}/export`).set(auth))
      .text,
  ).toBe(html);
});
