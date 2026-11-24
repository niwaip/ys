import { afterAll, beforeAll, expect, test, vi } from "vitest";
import request from "supertest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../../apps/api/src/app";
let app: Awaited<ReturnType<typeof createApp>>;
let directory: string;
const auth = { Authorization: "Bearer risk-test-secret" };
const base = "/api/customers/a/lifecycle-risk";
const http = () => request(app.getHttpServer());
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "ys-risk-"));
  app = await createApp({
    databaseUrl: `pglite://${directory}`,
    customers: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    operators: [
      { token: "risk-test-secret", name: "Tester", customerIds: ["a", "b"] },
      { token: "limited-risk-secret", name: "Limited", customerIds: ["a"] },
    ],
  });
});
afterAll(async () => {
  await app?.close();
  if (directory) await rm(directory, { recursive: true, force: true });
});
test("customer can configure default thresholds and see OS risk with explicit source evidence", async () => {
  const config = (await http().get(`${base}/config`).set(auth).expect(200))
    .body;
  expect(config).toMatchObject({
    timeZone: "Asia/Shanghai",
    defaultRule: { enabled: true, reminderMonths: 12, warningMonths: 6 },
    overrides: [],
  });
  const batch = (
    await http()
      .post("/api/customers/a/lifecycle/batches")
      .set(auth)
      .send({
        fileName: "os.csv",
        content:
          "source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nVendor,Bulletin,Example OS,1,Sales,2099-01-01,Support,2020-01-01",
      })
      .expect(201)
  ).body;
  const asset = (
    await http()
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "risk-server", kind: "host", attributes: {} })
      .expect(201)
  ).body;
  await http()
    .patch(`/api/customers/a/assets/${asset.id}/lifecycle`)
    .set(auth)
    .send({
      os: {
        batchId: batch.id,
        product: "Example OS",
        version: "1",
        phase: "eol",
      },
    })
    .expect(200);
  const view = (await http().get(`${base}/current`).set(auth).expect(200)).body;
  expect(
    view.items.find(
      (i: any) => i.assetId === asset.id && i.type === "os_support",
    ),
  ).toMatchObject({
    level: "critical",
    dueDate: "2020-01-01",
    evidence: [{ source: "Vendor", sourceRef: "Bulletin", stage: "Support" }],
  });
  expect(view.summary).toMatchObject({ riskAssets: 1, riskItems: 1 });
  await http().get(`${base}/views/${view.id}`).set(auth).expect(200);
  await http()
    .get(`/api/customers/b/lifecycle-risk/views/${view.id}`)
    .set(auth)
    .expect(404);
});
test("four risks deduplicate assets; category overrides preview without mutation, disabling is unassessed", async () => {
  const asset = (
    await http()
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "four-risks", kind: "host", attributes: {} })
  ).body;
  await http()
    .patch(`/api/customers/a/assets/${asset.id}/classification`)
    .set(auth)
    .send({ hardwareType: "server" })
    .expect(200);
  const batch = (
    await http().post("/api/customers/a/lifecycle/batches").set(auth).send({
      fileName: "hardware.csv",
      content:
        "source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nVendor,ref,Model,1,Sales,2099-01-01,Support,2020-01-01",
    })
  ).body;
  await http()
    .patch(`/api/customers/a/assets/${asset.id}/lifecycle`)
    .set(auth)
    .send({
      device: {
        batchId: batch.id,
        product: "Model",
        version: "1",
        phase: "eol",
      },
      purchasedOn: "2010-02-28",
      warrantyUntil: "2020-01-01",
      sourceRef: "contract-1",
    })
    .expect(200);
  const config = (await http().get(`${base}/config`).set(auth)).body;
  config.serviceYears.server = 5;
  const preview = (
    await http().post(`${base}/preview`).set(auth).send(config).expect(201)
  ).body;
  expect(
    preview.after.items.find(
      (i: any) => i.assetId === asset.id && i.type === "service_age",
    ),
  ).toMatchObject({ dueDate: "2015-02-28", level: "critical" });
  expect(
    (await http().get(`${base}/config`).set(auth)).body.serviceYears.server,
  ).toBeNull();
  const saved = (
    await http().put(`${base}/config`).set(auth).send(config).expect(200)
  ).body;
  expect(
    saved.items.filter(
      (i: any) => i.assetId === asset.id && i.level === "critical",
    ),
  ).toHaveLength(3);
  config.overrides = [
    {
      type: "warranty",
      category: "server",
      rule: { enabled: false, reminderMonths: 12, warningMonths: 6 },
    },
  ];
  const disabled = (
    await http().put(`${base}/config`).set(auth).send(config).expect(200)
  ).body;
  expect(
    disabled.items.find(
      (i: any) => i.assetId === asset.id && i.type === "warranty",
    ).level,
  ).toBe("unassessed");
  expect(disabled.summary.unassessed).toBeGreaterThan(0);
  expect(
    (await http().get(`${base}/views/${saved.id}`).set(auth)).body,
  ).toEqual(saved);
});
test("treatment acceptance keeps severity, requires reason and expiry, expires on subsequent calculation", async () => {
  const view = (await http().get(`${base}/current`).set(auth)).body;
  const item = view.items.find((i: any) => i.level === "critical");
  await http()
    .put(`${base}/treatments/${item.assetId}/${item.type}`)
    .set(auth)
    .send({
      status: "accepted",
      owner: "Operator",
      note: "",
      acceptedUntil: "2099-01-01",
    })
    .expect(400);
  const treated = (
    await http()
      .put(`${base}/treatments/${item.assetId}/${item.type}`)
      .set(auth)
      .send({
        status: "accepted",
        owner: "Operator",
        note: "Maintenance window",
        acceptedUntil: "2099-01-01",
      })
      .expect(200)
  ).body;
  expect(treated.items.find((i: any) => i.id === item.id)).toMatchObject({
    level: "critical",
    treatment: { status: "accepted", owner: "Operator" },
    history: [{ actor: "Tester", action: "更新处理状态" }],
  });
  expect(treated.summary.acceptedItems).toBe(1);
  await http()
    .put(
      `/api/customers/b/lifecycle-risk/treatments/${item.assetId}/${item.type}`,
    )
    .set(auth)
    .send({ status: "pending", owner: "", note: "", acceptedUntil: null })
    .expect(404);
  await http()
    .put(`${base}/treatments/${item.assetId}/${item.type}`)
    .set(auth)
    .send({
      status: "accepted",
      owner: "Operator",
      note: "Expired",
      acceptedUntil: "2020-01-01",
    })
    .expect(400);
});

test("calendar month-end, timezone and acceptance expiry are evaluated through customer API", async () => {
  const asset = (
    await http()
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "calendar-boundary", kind: "host", attributes: {} })
  ).body;
  await http()
    .patch(`/api/customers/a/assets/${asset.id}/lifecycle`)
    .set(auth)
    .send({ warrantyUntil: "2030-08-31" })
    .expect(200);
  const config = (await http().get(`${base}/config`).set(auth)).body;
  config.overrides = [];
  config.timeZone = "Asia/Shanghai";
  await http().put(`${base}/config`).set(auth).send(config).expect(200);
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2030-02-27T16:00:00Z"));
    let view = (await http().get(`${base}/current`).set(auth)).body;
    expect(view.localDate).toBe("2030-02-28");
    expect(
      view.items.find(
        (i: any) => i.assetId === asset.id && i.type === "warranty",
      ).level,
    ).toBe("warning");
    vi.setSystemTime(new Date("2030-08-30T16:00:00Z"));
    view = (await http().get(`${base}/current`).set(auth)).body;
    expect(
      view.items.find(
        (i: any) => i.assetId === asset.id && i.type === "warranty",
      ),
    ).toMatchObject({ level: "critical", daysRemaining: 0 });
    await http()
      .put(`${base}/treatments/${asset.id}/warranty`)
      .set(auth)
      .send({
        status: "accepted",
        owner: "Owner",
        note: "One day",
        acceptedUntil: "2030-08-31",
      })
      .expect(200);
    vi.setSystemTime(new Date("2030-08-31T16:00:00Z"));
    view = (await http().get(`${base}/current`).set(auth)).body;
    const item = view.items.find(
      (i: any) => i.assetId === asset.id && i.type === "warranty",
    );
    expect(item).toMatchObject({
      level: "critical",
      treatment: { status: "pending", owner: "Owner" },
    });
    expect(item.history.at(-1)).toMatchObject({
      actor: "系统",
      action: "风险接受到期",
    });
    const again = (await http().get(`${base}/current`).set(auth)).body;
    expect(again.items.find((i: any) => i.id === item.id).history).toHaveLength(
      2,
    );
  } finally {
    vi.useRealTimers();
  }
});
test("invalid input, missing and conflicting dates and cross-customer sources never become normal", async () => {
  const asset = (
    await http()
      .post("/api/customers/a/assets")
      .set(auth)
      .send({ name: "conflicting", kind: "host", attributes: {} })
  ).body;
  await http()
    .patch(`/api/customers/a/assets/${asset.id}/lifecycle`)
    .set(auth)
    .send({ warrantyUntil: "2026-02-30" })
    .expect(400);
  const content =
    "source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nOne,ref1,Conflict,1,Sales,,Support,2020-01-01\nTwo,ref2,Conflict,1,Sales,,Support,2099-01-01";
  const batch = (
    await http()
      .post("/api/customers/a/lifecycle/batches")
      .set(auth)
      .send({ fileName: "conflict.csv", content })
  ).body;
  await http()
    .patch(`/api/customers/b/assets/${asset.id}/lifecycle`)
    .set(auth)
    .send({})
    .expect(404);
  const foreign = (
    await http()
      .post("/api/customers/b/assets")
      .set(auth)
      .send({ name: "other", kind: "host", attributes: {} })
  ).body;
  await http()
    .patch(`/api/customers/b/assets/${foreign.id}/lifecycle`)
    .set(auth)
    .send({
      os: {
        batchId: batch.id,
        product: "Conflict",
        version: "1",
        phase: "eol",
      },
    })
    .expect(404);
  await http()
    .patch(`/api/customers/a/assets/${asset.id}/lifecycle`)
    .set(auth)
    .send({
      os: {
        batchId: batch.id,
        product: "Conflict",
        version: "1",
        phase: "eol",
      },
    })
    .expect(200);
  const view = (await http().get(`${base}/current`).set(auth)).body;
  expect(
    view.items.find(
      (i: any) => i.assetId === asset.id && i.type === "os_support",
    ),
  ).toMatchObject({ level: "conflict", dueDate: null });
  expect(
    view.items.find((i: any) => i.assetId === asset.id && i.type === "warranty")
      .level,
  ).toBe("missing");
  const config = (await http().get(`${base}/config`).set(auth)).body;
  await http()
    .put(`${base}/config`)
    .set(auth)
    .send({ ...config, timeZone: "bad-zone" })
    .expect(400);
  await http()
    .post(`${base}/preview`)
    .set(auth)
    .send({
      ...config,
      defaultRule: { enabled: true, reminderMonths: 3, warningMonths: 6 },
    })
    .expect(400);
  await http().get(`${base}/current`).expect(401);
  await http()
    .get("/api/customers/b/lifecycle-risk/current")
    .auth("limited-risk-secret", { type: "bearer" })
    .expect(403);
  await http()
    .delete(`/api/customers/a/assets/${asset.id}`)
    .set(auth)
    .expect(200);
  const after = (await http().get(`${base}/current`).set(auth)).body;
  expect(after.items.some((i: any) => i.assetId === asset.id)).toBe(false);
  expect((await http().get(`${base}/views/${view.id}`).set(auth)).body).toEqual(
    view,
  );
});
test("daily scheduler persists a new customer snapshot without a current-risk request", async () => {
  const folder = await mkdtemp(join(tmpdir(), "ys-risk-daily-"));
  let scheduled: Awaited<ReturnType<typeof createApp>> | undefined;
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  try {
    vi.setSystemTime(new Date("2030-01-01T00:00:00Z"));
    scheduled = await createApp({
      databaseUrl: `pglite://${folder}`,
      customers: [{ id: "a", name: "A" }],
      operators: [
        { token: "risk-test-secret", name: "Tester", customerIds: ["a"] },
      ],
    });
    const api = request(scheduled.getHttpServer());
    const asset = (
      await api
        .post("/api/customers/a/assets")
        .set(auth)
        .send({
          name: "daily",
          kind: "host",
          attributes: { lifecycle: { warrantyUntil: "2030-01-02" } },
        })
    ).body;
    const initial = (await api.get(`${base}/current`).set(auth)).body;
    expect(
      initial.items.find(
        (i: any) => i.assetId === asset.id && i.type === "warranty",
      ).level,
    ).toBe("warning");
    vi.setSystemTime(new Date("2030-01-02T00:00:00Z"));
    await vi.advanceTimersByTimeAsync(60_000);
    await expect
      .poll(async () => {
        const r = await api.get(`${base}/latest`).set(auth);
        return r.body.localDate;
      })
      .toBe("2030-01-02");
    const latest = (await api.get(`${base}/latest`).set(auth).expect(200)).body;
    expect(latest.id).not.toBe(initial.id);
    expect(latest.items.find((i: any) => i.type === "warranty").level).toBe(
      "critical",
    );
    expect(
      (await api.get(`${base}/views/${initial.id}`).set(auth)).body,
    ).toEqual(initial);
  } finally {
    await scheduled?.close();
    vi.useRealTimers();
    await rm(folder, { recursive: true, force: true });
  }
});
