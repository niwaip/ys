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

test("虚拟机仅要求OS期限，不适用购买维保和硬件项，也不生成未知硬件风险", async () => {
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({
        name: "applicability-vm",
        kind: "host",
        attributes: {
          netbox: { objectType: "virtual-machine" },
          osProduct: "Ubuntu",
          osVersion: "26.04",
        },
      })
      .expect(201)
  ).body;
  await http()
    .post(`${base}/lifecycle/batches`)
    .set(auth)
    .send({
      fileName: "ubuntu.csv",
      content:
        "source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate,category,phase\nUbuntu,Doc,Ubuntu,26.04,Sales,,Standard,2031-04-01,os,eol",
    })
    .expect(201);
  const list = (
    await http()
      .get(`${base}/lifecycle/workspace?q=applicability-vm`)
      .set(auth)
      .expect(200)
  ).body;
  expect(list.items[0]).toMatchObject({
    state: "complete",
    applicability: {
      os: true,
      device: false,
      purchasedOn: false,
      warrantyUntil: false,
    },
  });
  expect(list.items[0].support.map((r: any) => r.kind)).toEqual(["os"]);
  const missing = (
    await http()
      .get(`${base}/lifecycle/workspace?q=applicability-vm&missing=purchasedOn`)
      .set(auth)
      .expect(200)
  ).body;
  expect(missing.total).toBe(0);
  const risk = (
    await http().get(`${base}/lifecycle-risk/current`).set(auth).expect(200)
  ).body;
  expect(
    risk.items
      .filter((r: any) => r.assetId === asset.id)
      .map((r: any) => r.type),
  ).toEqual(["os_support"]);
});

test("确认OS与登记平台分别展示；未确认观测不用于期限判断，冲突保持待核对", async () => {
  for (const platform of [null, { name: "ubuntu" }, { name: "Debian" }]) {
    const asset = (
      await http()
        .post(`${base}/assets`)
        .set(auth)
        .send({
          name: `source-vm-${platform?.name ?? "none"}`,
          kind: "host",
          attributes: {
            netbox: {
              objectType: "virtual-machine",
              syncedAt: "2026-11-24T01:00:00Z",
            },
            platform,
          },
        })
        .expect(201)
    ).body;
    const snapshot = (
      await http()
        .post(`${base}/collections/upload`)
        .set(auth)
        .send({
          assetId: asset.id,
          fileName: "os.json",
          content: JSON.stringify({
            schemaVersion: "ys-host/1",
            identity: {
              hostname: asset.name,
              serial: null,
              machineId: asset.id,
            },
            collectedAt: "2026-11-24T00:00:00Z",
            sections: {
              os: {
                status: "acquired",
                data: {
                  id: "ubuntu",
                  version: "26.04",
                  kernel: "7",
                  architecture: "x86_64",
                },
              },
            },
            extensions: {},
          }),
        })
        .expect(201)
    ).body;
    const get = async () =>
      (
        await http()
          .get(`${base}/lifecycle/workspace?q=${asset.name}`)
          .set(auth)
          .expect(200)
      ).body.items[0];
    expect((await get()).osIdentity.confirmed).toBeNull();
    await http()
      .post(`${base}/assets/${asset.id}/baseline/confirm`)
      .set(auth)
      .send({
        snapshotId: snapshot.id,
        expectedBaselineId: null,
        idempotencyKey: asset.id,
        sections: ["os"],
        writeMasterData: false,
      })
      .expect(201);
    const item = await get();
    expect(item.osIdentity.confirmed).toMatchObject({
      product: "ubuntu",
      version: "26.04",
      snapshotId: snapshot.id,
      actor: "Editor",
    });
    expect(item.osIdentity.status).toBe(
      platform?.name === "Debian"
        ? "conflict"
        : platform
          ? "consistent"
          : "platform_missing",
    );
    if (platform?.name === "Debian") {
      const risk = (
        await http().get(`${base}/lifecycle-risk/current`).set(auth).expect(200)
      ).body;
      expect(
        risk.items.find(
          (r: any) => r.assetId === asset.id && r.type === "os_support",
        ),
      ).toMatchObject({ level: "conflict", dueDate: null });
    }
  }
});

test("显式产品别名复用共同资料且保留原值、客户隔离和歧义", async () => {
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({
        name: "alias-vm",
        kind: "host",
        attributes: {
          netbox: { objectType: "virtual-machine" },
          osProduct: "u-alias",
          osVersion: "26.04",
        },
      })
      .expect(201)
  ).body;
  const get = async () =>
    (
      await http()
        .get(`${base}/lifecycle/workspace?q=alias-vm`)
        .set(auth)
        .expect(200)
    ).body.items[0];
  expect((await get()).support[0].status).toBe("unmatched");
  await http()
    .post(`${base}/lifecycle/aliases`)
    .set(auth)
    .send({
      category: "os",
      alias: "u-alias",
      product: "Ubuntu",
      basis: "厂商产品名称确认",
    })
    .expect(201);
  expect((await get()).support[0]).toMatchObject({
    status: "matched",
    product: "Ubuntu",
    rawProduct: "u-alias",
    mappingBasis: "厂商产品名称确认",
  });
  expect(
    (
      await http()
        .get("/api/customers/b/lifecycle/aliases")
        .set(auth)
        .expect(200)
    ).body.items,
  ).toEqual([]);
  const old = (
    await http().get(`${base}/lifecycle-risk/current`).set(auth).expect(200)
  ).body;
  await http()
    .post(`${base}/lifecycle/aliases`)
    .set(auth)
    .send({
      category: "os",
      alias: "u-alias",
      product: "Other",
      basis: "待核对另一来源",
    })
    .expect(201);
  expect((await get()).support[0].status).toBe("conflict");
  expect(
    (
      await http()
        .get(`${base}/lifecycle-risk/views/${old.id}`)
        .set(auth)
        .expect(200)
    ).body,
  ).toEqual(old);
  expect(asset.id).toBeTruthy();
});

test("默认标准支持，扩展期限必须登记权益依据；页面与风险采用相同来源且旧评估固定", async () => {
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({
        name: "tier-vm",
        kind: "host",
        attributes: {
          netbox: { objectType: "virtual-machine" },
          osProduct: "TierOS",
          osVersion: "1",
        },
      })
      .expect(201)
  ).body;
  const batch = (
    await http()
      .post(`${base}/lifecycle/batches`)
      .set(auth)
      .send({
        fileName: "tiers.csv",
        content:
          "source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate,category,phase,supportTier\nVendor,Standard-doc,TierOS,1,Sales,,标准支持,2020-01-01,os,eol,standard\nVendor,Extended-doc,TierOS,1,Sales,,付费支持,2040-01-01,os,eol,extended",
      })
      .expect(201)
  ).body;
  const get = async () =>
    (
      await http()
        .get(`${base}/lifecycle/workspace?q=tier-vm`)
        .set(auth)
        .expect(200)
    ).body.items[0].support[0];
  expect(await get()).toMatchObject({
    status: "matched",
    date: "2020-01-01",
    supportTier: "standard",
  });
  const old = (
    await http().get(`${base}/lifecycle-risk/current`).set(auth).expect(200)
  ).body;
  const binding = {
    batchId: batch.id,
    product: "TierOS",
    version: "1",
    phase: "eol",
    supportTier: "extended",
  };
  await http()
    .patch(`${base}/assets/${asset.id}/lifecycle`)
    .set(auth)
    .send({ os: binding })
    .expect(400);
  await http()
    .patch(`${base}/assets/${asset.id}/lifecycle`)
    .set(auth)
    .send({ os: { ...binding, entitlement: "订阅凭证 SUB-123" } })
    .expect(200);
  expect(await get()).toMatchObject({
    status: "matched",
    date: "2040-01-01",
    supportTier: "extended",
    entitlement: "订阅凭证 SUB-123",
    standardDate: "2020-01-01",
  });
  expect(
    (await http().get(`${base}/lifecycle-risk/latest`).set(auth).expect(200))
      .body.id,
  ).toBe(old.id);
  const risk = (
    await http().get(`${base}/lifecycle-risk/current`).set(auth).expect(200)
  ).body;
  expect(
    risk.items.find(
      (i: any) => i.assetId === asset.id && i.type === "os_support",
    ),
  ).toMatchObject({
    dueDate: "2040-01-01",
    level: "normal",
    basis: expect.stringContaining("SUB-123"),
  });
  expect(
    (
      await http()
        .get(`${base}/lifecycle-risk/views/${old.id}`)
        .set(auth)
        .expect(200)
    ).body,
  ).toEqual(old);
});
