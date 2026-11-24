import { afterAll, beforeAll, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, directory: string;
const auth = { Authorization: "Bearer workspace-test-secret" };
const base = "/api/customers/a";
const http = () => request(app.getHttpServer());
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-lifecycle-workspace-"));
  app = await createApp({
    databaseUrl: `pglite://${directory}`,
    customers: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    operators: [
      {
        token: "workspace-test-secret",
        name: "Editor",
        customerIds: ["a", "b"],
      },
    ],
  });
});
afterAll(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("资产生命周期筛选在分页前执行，保存专属期限保留旧字段与客户范围历史", async () => {
  const first = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({ name: "switch-one", kind: "host" })
      .expect(201)
  ).body;
  const other = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({ name: "server-two", kind: "host" })
      .expect(201)
  ).body;
  await http()
    .patch(`${base}/assets/${first.id}/classification`)
    .set(auth)
    .send({ hardwareType: "network" })
    .expect(200);
  await http()
    .patch(`${base}/assets/${other.id}/classification`)
    .set(auth)
    .send({ hardwareType: "server" })
    .expect(200);
  const initial = (
    await http()
      .get(`${base}/lifecycle/workspace?category=network&state=empty&limit=1`)
      .set(auth)
      .expect(200)
  ).body;
  expect(initial.total).toBe(1);
  expect(initial.items[0].id).toBe(first.id);
  expect(initial.summary.total).toBe(2);
  await http()
    .patch(`${base}/assets/${first.id}/lifecycle`)
    .set(auth)
    .send({ purchasedOn: "2021-01-02", sourceRef: "Contract 1" })
    .expect(200);
  const saved = (
    await http()
      .patch(`${base}/assets/${first.id}/lifecycle`)
      .set(auth)
      .send({ warrantyUntil: "2028-01-02" })
      .expect(200)
  ).body;
  expect(saved.attributes.lifecycle).toMatchObject({
    purchasedOn: "2021-01-02",
    warrantyUntil: "2028-01-02",
    sourceRef: "Contract 1",
  });
  const list = (
    await http()
      .get(`${base}/lifecycle/workspace?category=network&missing=purchasedOn`)
      .set(auth)
      .expect(200)
  ).body;
  expect(list.total).toBe(0);
  const history = (
    await http()
      .get(`${base}/lifecycle/assets/${first.id}/history`)
      .set(auth)
      .expect(200)
  ).body;
  expect(history.items).toHaveLength(2);
  expect(history.items[0].actor).toBe("Editor");
  await http()
    .get(`/api/customers/b/lifecycle/assets/${first.id}/history`)
    .set(auth)
    .expect(404);
  await http()
    .get(`${base}/lifecycle/workspace?state=invalid`)
    .set(auth)
    .expect(400);
});
test("分类厂商资料只自动引用唯一精确产品版本，歧义不猜测且旧风险视图保留", async () => {
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({
        name: "shared-router",
        kind: "host",
        attributes: { product: "Exact Router", version: "1" },
      })
      .expect(201)
  ).body;
  const content =
    "source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate,category,phase\nVendor,Doc-1,Exact Router,1,Sales,2020-01-01,Support,2021-01-01,device,eol";
  const batch = (
    await http()
      .post(`${base}/lifecycle/batches`)
      .set(auth)
      .send({ fileName: "router.csv", content })
      .expect(201)
  ).body;
  const list = (
    await http()
      .get(`${base}/lifecycle/workspace?q=shared-router`)
      .set(auth)
      .expect(200)
  ).body;
  expect(list.items[0].support).toContainEqual(
    expect.objectContaining({
      kind: "device",
      status: "matched",
      batchId: batch.id,
      date: "2021-01-01",
    }),
  );
  const risk = (
    await http().get(`${base}/lifecycle-risk/current`).set(auth).expect(200)
  ).body;
  expect(
    risk.items.find(
      (x: any) => x.assetId === asset.id && x.type === "device_support",
    ),
  ).toMatchObject({ dueDate: "2021-01-01", level: "critical" });
  await http()
    .post(`${base}/lifecycle/batches`)
    .set(auth)
    .send({
      fileName: "router2.csv",
      content: content
        .replace("Doc-1", "Doc-2")
        .replace("2021-01-01", "2030-01-01"),
    })
    .expect(201);
  const conflict = (
    await http()
      .get(`${base}/lifecycle/workspace?q=shared-router&missing=conflict`)
      .set(auth)
      .expect(200)
  ).body;
  expect(conflict.total).toBe(1);
  expect(conflict.items[0].support).toContainEqual(
    expect.objectContaining({ status: "conflict" }),
  );
  const old = (
    await http()
      .get(`${base}/lifecycle-risk/views/${risk.id}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(
    old.items.find(
      (x: any) => x.assetId === asset.id && x.type === "device_support",
    ).dueDate,
  ).toBe("2021-01-01");
  await http()
    .post(`${base}/lifecycle/batches`)
    .set(auth)
    .send({
      fileName: "bad.csv",
      content: content.replace("device,eol", "nonsense,eol"),
    })
    .expect(400);
});
test("编辑旧版本时返回冲突，不覆盖其他操作员已经确认的日期", async () => {
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({ name: "concurrent-lifecycle", kind: "host" })
      .expect(201)
  ).body;
  await http()
    .patch(`${base}/assets/${asset.id}/lifecycle`)
    .set(auth)
    .send({ purchasedOn: "2020-01-01" })
    .expect(200);
  await http()
    .patch(`${base}/assets/${asset.id}/lifecycle`)
    .set(auth)
    .send({ expected: {}, warrantyUntil: "2030-01-01" })
    .expect(409);
  const saved = (
    await http().get(`${base}/assets/${asset.id}`).set(auth).expect(200)
  ).body;
  expect(saved.attributes.lifecycle.purchasedOn).toBe("2020-01-01");
  expect(saved.attributes.lifecycle.warrantyUntil).toBeUndefined();
});
test("混合分类同名产品不干扰自动风险引用，明确阶段可消除同批次歧义", async () => {
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({
        name: "phase-router",
        kind: "host",
        attributes: { product: "Phase Router", version: "1" },
      })
      .expect(201)
  ).body;
  const header =
    "source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate,category,phase";
  const batch = (
    await http()
      .post(`${base}/lifecycle/batches`)
      .set(auth)
      .send({
        fileName: "mixed.csv",
        content:
          header +
          "\nVendor,Device,Phase Router,1,Sales,2020-01-01,Support,2021-01-01,device,eol\nVendor,Software,Phase Router,1,Sales,2020-01-01,Support,2030-01-01,software,eol",
      })
      .expect(201)
  ).body;
  let risk = (
    await http().get(`${base}/lifecycle-risk/current`).set(auth).expect(200)
  ).body;
  expect(
    risk.items.find(
      (x: any) => x.assetId === asset.id && x.type === "device_support",
    ),
  ).toMatchObject({ dueDate: "2021-01-01", level: "critical" });
  const phases = (
    await http()
      .post(`${base}/lifecycle/batches`)
      .set(auth)
      .send({
        fileName: "phases.csv",
        content:
          header +
          "\nVendor,EOS,Phase Router,1,Sales,2020-01-01,Support,2022-01-01,device,eos\nVendor,EOL,Phase Router,1,Sales,2020-01-01,Support,2023-01-01,device,eol",
      })
      .expect(201)
  ).body;
  await http()
    .patch(`${base}/assets/${asset.id}/lifecycle`)
    .set(auth)
    .send({
      device: {
        batchId: phases.id,
        product: "Phase Router",
        version: "1",
        phase: "eol",
      },
    })
    .expect(200);
  const workspace = (
    await http()
      .get(`${base}/lifecycle/workspace?q=phase-router`)
      .set(auth)
      .expect(200)
  ).body;
  expect(workspace.items[0].support).toContainEqual(
    expect.objectContaining({
      status: "matched",
      batchId: phases.id,
      phase: "eol",
      date: "2023-01-01",
    }),
  );
  risk = (
    await http().get(`${base}/lifecycle-risk/current`).set(auth).expect(200)
  ).body;
  expect(
    risk.items.find(
      (x: any) => x.assetId === asset.id && x.type === "device_support",
    ),
  ).toMatchObject({ dueDate: "2023-01-01", level: "critical" });
});
