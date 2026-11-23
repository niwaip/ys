import { beforeAll, afterAll, expect, test } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>, dir: string;
const auth = { Authorization: "Bearer multi-device-token" };
const base = "/api/customers/a";
const http = () => request(app.getHttpServer());
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ys-multi-device-"));
  app = await createApp({
    databaseUrl: `pglite://${dir}`,
    customers: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    operators: [
      { name: "tester", token: "multi-device-token", customerIds: ["a", "b"] },
    ],
  });
});
afterAll(async () => {
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true });
});
test("网络设备手动观测可预览并保留版本，不覆盖主数据或基线", async () => {
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({
        name: "core-switch",
        kind: "host",
        attributes: { serial: "SW1" },
      })
      .expect(201)
  ).body;
  const data = {
    schemaVersion: "ys-host/1",
    identity: { hostname: "core-switch", serial: "SW1" },
    collectedAt: null,
    sections: {
      device: {
        status: "acquired",
        data: {
          category: "network",
          manufacturer: "Cisco",
          model: "C9300",
          firmware: "17.12.4",
          modules: "Supervisor 1",
        },
      },
    },
  };
  const saved = (
    await http()
      .post(`${base}/collections/manual`)
      .set(auth)
      .send({ assetId: asset.id, note: "现场铭牌及版本命令", data })
      .expect(201)
  ).body;
  expect(saved.sections.device.status).toBe("acquired");
  const section = (
    await http()
      .get(`${base}/collections/snapshots/${saved.id}/sections/device`)
      .set(auth)
      .expect(200)
  ).body;
  expect(section.data).toMatchObject({ model: "C9300", firmware: "17.12.4" });
  const preview = (
    await http()
      .get(`${base}/assets/${asset.id}/baseline?snapshotId=${saved.id}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(preview.current).toBeNull();
  expect(preview.sections.device.comparable).toBe(true);
  await http()
    .post("/api/customers/b/collections/manual")
    .set(auth)
    .send({ assetId: asset.id, note: "wrong tenant", data })
    .expect(404);
  await http()
    .post(`${base}/collections/manual`)
    .set(auth)
    .send({
      assetId: asset.id,
      note: "invalid",
      data: {
        ...data,
        sections: {
          device: {
            status: "acquired",
            data: { category: "network", supportUntil: "not-a-date" },
          },
        },
      },
    })
    .expect(400);
});
test("设备观测确认及拒绝持久化，重复确认幂等，拒绝不替换基线", async () => {
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({ name: "storage", kind: "host" })
  ).body;
  const save = async (firmware: string) =>
    (
      await http()
        .post(`${base}/collections/manual`)
        .set(auth)
        .send({
          assetId: asset.id,
          note: "vendor",
          data: {
            schemaVersion: "ys-host/1",
            identity: { hostname: "observed-storage" },
            collectedAt: null,
            sections: {
              device: {
                status: "acquired",
                data: { category: "storage", model: "StorageX", firmware },
              },
            },
          },
        })
        .expect(201)
    ).body;
  const first = await save("1");
  const path = `${base}/assets/${asset.id}/baseline`;
  const input = {
    snapshotId: first.id,
    expectedBaselineId: null,
    idempotencyKey: "first-device",
    sections: ["identity", "device"],
    writeMasterData: false,
  };
  const confirmed = (
    await http()
      .post(path + "/confirm")
      .set(auth)
      .send(input)
      .expect(201)
  ).body;
  expect(confirmed.status).toBe("confirmed");
  expect(
    (
      await http()
        .post(path + "/confirm")
        .set(auth)
        .send(input)
        .expect(201)
    ).body.id,
  ).toBe(confirmed.id);
  expect(
    (await http().get(`${base}/assets/${asset.id}`).set(auth)).body.name,
  ).toBe("storage");
  const second = await save("2");
  await http()
    .post(path + "/reject")
    .set(auth)
    .send({ snapshotId: second.id, reason: "需要核实版本" })
    .expect(201);
  const preview = (
    await http()
      .get(path + "?snapshotId=" + second.id)
      .set(auth)
      .expect(200)
  ).body;
  expect(preview.review).toMatchObject({
    status: "rejected",
    reason: "需要核实版本",
  });
  expect(preview.current.id).toBe(confirmed.id);
  await http()
    .post(path + "/confirm")
    .set(auth)
    .send({
      ...input,
      snapshotId: second.id,
      expectedBaselineId: confirmed.id,
      idempotencyKey: "rejected",
    })
    .expect(409);
  await http()
    .get(`/api/customers/b/assets/${asset.id}/baseline?snapshotId=${second.id}`)
    .set(auth)
    .expect(404);
});

test("角色表单映射按客户持久保存，VM不能被配置为物理角色模板", async () => {
  await http()
    .post(`${base}/collections/role-templates`)
    .set(auth)
    .send({ roleId: 7, category: "network" })
    .expect(201);
  expect(
    (
      await http()
        .get(`${base}/collections/role-templates`)
        .set(auth)
        .expect(200)
    ).body.mappings,
  ).toEqual({ "7": "network" });
  expect(
    (
      await http()
        .get("/api/customers/b/collections/role-templates")
        .set(auth)
        .expect(200)
    ).body.mappings,
  ).toEqual({});
  await http()
    .post(`${base}/collections/role-templates`)
    .set(auth)
    .send({ roleId: 7, category: "vm" })
    .expect(400);
});
test("统一上传Windows脚本结果，身份不明拒绝，采纳后才发布补丁评估资料", async () => {
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({
        name: "win-target",
        kind: "host",
        attributes: { serial: "WIN1" },
      })
  ).body;
  const data = {
    Hostname: "win-target",
    SerialNumber: "WIN1",
    CollectorVersion: "1",
    OS: "Windows Server 2022",
    OSVersion: "10.0",
    OSBuild: "20348",
    InstalledKBs: ["KB5030216"],
  };
  const saved = (
    await http()
      .post(`${base}/collections/upload`)
      .set(auth)
      .send({
        assetId: asset.id,
        fileName: "win.json",
        scope: "basic",
        content: JSON.stringify(data),
      })
      .expect(201)
  ).body;
  expect(saved.extensions.inputFormat).toBe("windows-bat/1");
  const preview = (
    await http()
      .get(`${base}/collections/snapshots/${saved.id}/windows?offset=0`)
      .set(auth)
      .expect(200)
  ).body;
  expect(preview.kbs.items).toEqual(["KB5030216"]);
  expect(saved.extensions.windows).not.toHaveProperty("extensions");
  expect(
    (await http().get(`${base}/windows/imports?assetId=${asset.id}`).set(auth))
      .body.items,
  ).toHaveLength(0);
  await http()
    .post(`${base}/assets/${asset.id}/baseline/confirm`)
    .set(auth)
    .send({
      snapshotId: saved.id,
      expectedBaselineId: null,
      idempotencyKey: "win-confirm",
      sections: ["os"],
      writeMasterData: false,
    })
    .expect(201);
  expect(
    (await http().get(`${base}/windows/imports?assetId=${asset.id}`).set(auth))
      .body.items[0],
  ).toMatchObject({ assetId: asset.id, status: "imported" });
  await http()
    .post(`${base}/collections/upload`)
    .set(auth)
    .send({
      assetId: asset.id,
      fileName: "bound-no-serial.json",
      content: JSON.stringify({
        ...data,
        TargetAssetId: asset.id,
        SerialNumber: null,
      }),
    })
    .expect(409);
  await http()
    .post(`${base}/collections/upload`)
    .set(auth)
    .send({
      assetId: asset.id,
      fileName: "missing.json",
      content: JSON.stringify({ ...data, SerialNumber: null }),
    })
    .expect(409);
  const script = (
    await http()
      .get(`${base}/collections/script?scope=basic&platform=windows`)
      .set(auth)
      .expect(200)
  ).body;
  expect(script.fileName).toBe("ys-windows.ps1");
});

test("未采纳Linux资料不能作为扫描输入，采纳后才可使用", async () => {
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({ name: "linux-review", kind: "host" })
  ).body;
  const snapshot = (
    await http()
      .post(`${base}/collections/manual`)
      .set(auth)
      .send({
        assetId: asset.id,
        note: "offline",
        data: {
          schemaVersion: "ys-host/1",
          identity: { hostname: "linux-review" },
          collectedAt: null,
          extensions: {
            rawSections: {
              debianVersion: "12.0",
              os: "ID=debian\nVERSION_ID=12\n",
              dpkgStatus:
                "Package: openssl\nStatus: install ok installed\nArchitecture: amd64\nVersion: 3.0.1\n\n",
            },
          },
          sections: {
            os: {
              status: "acquired",
              data: {
                id: "debian",
                version: "12",
                kernel: null,
                architecture: "x86_64",
              },
            },
            packages: {
              status: "acquired",
              data: [
                {
                  name: "openssl",
                  version: "3.0.1",
                  architecture: "amd64",
                  state: "installed",
                  manager: "dpkg",
                },
              ],
            },
          },
        },
      })
      .expect(201)
  ).body;
  const inputs = async () =>
    (
      await http()
        .get(`${base}/assessments/linux-inputs?assetId=${asset.id}&offset=0`)
        .set(auth)
        .expect(200)
    ).body;
  expect((await inputs()).items[0]).toMatchObject({
    supported: false,
    reason: expect.stringContaining("尚未采纳"),
  });
  await http()
    .post(`${base}/assessments`)
    .set(auth)
    .send({
      assetId: asset.id,
      snapshotId: snapshot.id,
      idempotencyKey: "before-adoption",
    })
    .expect(409);
  const identityOnly = (
    await http()
      .post(`${base}/assets/${asset.id}/baseline/confirm`)
      .set(auth)
      .send({
        snapshotId: snapshot.id,
        expectedBaselineId: null,
        idempotencyKey: "identity-only",
        sections: ["identity"],
        writeMasterData: false,
      })
      .expect(201)
  ).body;
  expect((await inputs()).items[0].supported).toBe(false);
  await http()
    .post(`${base}/assets/${asset.id}/baseline/confirm`)
    .set(auth)
    .send({
      snapshotId: snapshot.id,
      expectedBaselineId: identityOnly.id,
      idempotencyKey: "adopt-linux",
      sections: ["os", "packages"],
      writeMasterData: false,
    })
    .expect(201);
  expect((await inputs()).items[0].supported).toBe(true);
});

test("各类设备资料都能回读，类型不适用字段不会混入观测", async () => {
  for (const [category, facts] of Object.entries({
    server: {
      model: "R750",
      cpu: "Xeon",
      memory: "64 GB",
      software: "nginx 1.26",
    },
    vm: { cpu: "4 vCPU", memory: "8 GB", software: "PostgreSQL 16" },
    network: { model: "C9300", firmware: "17.12.4", modules: "Supervisor" },
    storage: { model: "StorageX", controller: "Controller 1", firmware: "2.0" },
    power: { model: "PDU", firmware: "1.0" },
    other: { model: "Custom", supportUntil: "2027-01-01" },
  })) {
    const asset = (
      await http()
        .post(`${base}/assets`)
        .set(auth)
        .send({ name: category, kind: "host" })
    ).body;
    const data = {
      schemaVersion: "ys-host/1",
      identity: { hostname: category },
      collectedAt: null,
      sections: {
        device: { status: "acquired", data: { category, ...facts } },
      },
    };
    const saved = (
      await http()
        .post(`${base}/collections/manual`)
        .set(auth)
        .send({ assetId: asset.id, note: "铭牌 / 人工资料", data })
        .expect(201)
    ).body;
    expect(
      (
        await http()
          .get(`${base}/collections/snapshots/${saved.id}/sections/device`)
          .set(auth)
          .expect(200)
      ).body.data,
    ).toMatchObject({ category, ...facts });
  }
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({ name: "invalid-network", kind: "host" })
  ).body;
  await http()
    .post(`${base}/collections/manual`)
    .set(auth)
    .send({
      assetId: asset.id,
      note: "invalid",
      data: {
        schemaVersion: "ys-host/1",
        identity: { hostname: "invalid" },
        collectedAt: null,
        sections: {
          device: {
            status: "acquired",
            data: { category: "network", cpu: "invalid server field" },
          },
        },
      },
    })
    .expect(400);
});

test("旧Windows同名待关联资料可由统一流程明确采纳到序列号匹配的资产", async () => {
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({
        name: "win-legacy-pending",
        kind: "host",
        attributes: { serial: "WIN-PENDING" },
      })
  ).body;
  const content = JSON.stringify({
    Hostname: "win-legacy-pending",
    SerialNumber: "WIN-PENDING",
    CollectorVersion: "1",
    OS: "Windows Server 2022",
    OSBuild: "20348",
  });
  const pending = (
    await http()
      .post(`${base}/windows/imports`)
      .set(auth)
      .send({ fileName: "legacy.json", content })
      .expect(201)
  ).body;
  expect(pending.status).toBe("pending_confirmation");
  const snapshot = (
    await http()
      .post(`${base}/collections/upload`)
      .set(auth)
      .send({ assetId: asset.id, fileName: "legacy.json", content })
      .expect(201)
  ).body;
  const confirmation = (
    await http()
      .post(`${base}/assets/${asset.id}/baseline/confirm`)
      .set(auth)
      .send({
        snapshotId: snapshot.id,
        expectedBaselineId: null,
        idempotencyKey: "resolve-legacy-windows",
        sections: ["os"],
        writeMasterData: false,
      })
      .expect(201)
  ).body;
  expect(confirmation.status).toBe("confirmed");
  const adopted = (
    await http()
      .get(`${base}/windows/imports/${pending.id}`)
      .set(auth)
      .expect(200)
  ).body;
  expect(adopted).toMatchObject({
    id: pending.id,
    status: "imported",
    assetId: asset.id,
    snapshotId: expect.any(String),
  });
});

test("无原生序列号的VM可使用下载脚本声明的目标编号，不能借用其他目标声明", async () => {
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({
        name: "windows-vm",
        kind: "host",
        attributes: { netbox: { objectType: "virtual-machine" } },
      })
  ).body;
  const script = (
    await http()
      .get(
        `${base}/collections/script?scope=basic&platform=windows&assetId=${asset.id}`,
      )
      .set(auth)
      .expect(200)
  ).body;
  expect(script.content).toContain(asset.id);
  const data = {
    Hostname: "windows-vm",
    SerialNumber: null,
    TargetAssetId: asset.id,
    CollectorVersion: "1",
    OS: "Windows Server 2022",
    OSBuild: "20348",
  };
  const post = (content: unknown) =>
    http()
      .post(`${base}/collections/upload`)
      .set(auth)
      .send({
        assetId: asset.id,
        fileName: "vm.json",
        content: JSON.stringify(content),
      });
  const snapshot = (await post(data).expect(201)).body;
  expect(snapshot.extensions.targetAssetId).toBe(asset.id);
  await post({
    ...data,
    TargetAssetId: "00000000-0000-4000-8000-000000000001",
  }).expect(409);
  await http()
    .get(
      `/api/customers/b/collections/script?scope=basic&platform=windows&assetId=${asset.id}`,
    )
    .set(auth)
    .expect(404);
});

test("没有取得资料的观测不能显示为采纳成功", async () => {
  const asset = (
    await http()
      .post(`${base}/assets`)
      .set(auth)
      .send({ name: "empty-observation", kind: "host" })
  ).body;
  const snapshot = (
    await http()
      .post(`${base}/collections/manual`)
      .set(auth)
      .send({
        assetId: asset.id,
        note: "无法取得设备版本",
        data: {
          schemaVersion: "ys-host/1",
          identity: { hostname: "empty-observation" },
          collectedAt: null,
          sections: {},
        },
      })
      .expect(201)
  ).body;
  await http()
    .post(`${base}/assets/${asset.id}/baseline/confirm`)
    .set(auth)
    .send({
      snapshotId: snapshot.id,
      expectedBaselineId: null,
      idempotencyKey: "empty",
      sections: ["identity"],
      writeMasterData: false,
    })
    .expect(400);
  expect(
    (
      await http()
        .get(`${base}/assets/${asset.id}/baseline?snapshotId=${snapshot.id}`)
        .set(auth)
        .expect(200)
    ).body.review.status,
  ).toBe("pending");
});
