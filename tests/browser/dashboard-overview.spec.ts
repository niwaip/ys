import { test, expect } from "@playwright/test";
test("风险结果页独立回读固定概览范围，刷新后不带入后来新增对象", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    name = `Frozen-${Date.now()}`;
  await request.post("/api/customers/acme/assets", {
    headers,
    data: { name, kind: "host" },
  });
  const overview = await (
    await request.post("/api/customers/acme/dashboard/overview", {
      headers,
      data: {},
    })
  ).json();
  await request.post("/api/customers/acme/assets", {
    headers,
    data: { name: name + "-later", kind: "host" },
  });
  await page.goto(`/#risk?scope=${overview.id}`);
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "风险结果", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `下钻 ${name}`, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: `下钻 ${name}-later`, exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^服务器 / })).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: `下钻 ${name}`, exact: true }),
  ).toBeVisible();
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page).toHaveURL(/#risk$/);
  await page.goto(`/#risk?scope=${overview.id}`);
  await expect(page.getByLabel("当前客户")).toHaveValue("river");
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(
    page.getByRole("button", { name: `下钻 ${name}`, exact: true }),
  ).toHaveCount(0);
});

test("客户概览首屏仅数字图标，资产与未评估卡片跳转到独立页面", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#dashboard");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("region", { name: "资产规模" })).toBeVisible();
  await expect(page.locator("main table")).toHaveCount(0);
  await expect(page.locator("main select")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "评估覆盖与待处理" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight + 1,
    ),
  ).toBe(true);
  await expect(page.getByRole("button", { name: /^覆盖未知 / })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /^库时间未知 / }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^主机资产 / }).click();
  await expect(page).toHaveURL(/#assets$/);
  await page.locator("nav button").filter({ hasText: "客户风险概览" }).click();
  await page.getByRole("button", { name: /^未评估对象 / }).click();
  await expect(page).toHaveURL(/#risk\?scope=.+state=unselected/);
  await expect(
    page.getByRole("heading", { name: "风险结果", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText(/状态：unselected/)).toBeVisible();
});

test("CVE等级数字跳转固定严重度明细，刷新和手机布局保持正确", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    name = `Card-CVE-${Date.now()}`;
  const obj = await (
    await request.post("/api/customers/acme/software", {
      headers,
      data: { name },
    })
  ).json();
  const version = await (
    await request.post(`/api/customers/acme/software/${obj.id}/sbom`, {
      headers,
      data: {
        fileName: "card.json",
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          fixtureMode: "findings",
          metadata: { component: { type: "application", name, version: "1" } },
          components: [
            {
              type: "library",
              name: "express",
              version: "4.18.0",
              purl: "pkg:npm/express@4.18.0",
            },
          ],
        }),
      },
    })
  ).json();
  const job = await (
    await request.post("/api/customers/acme/assessments", {
      headers,
      data: { softwareId: obj.id, versionId: version.id, idempotencyKey: name },
    })
  ).json();
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(`/api/customers/acme/assessments/${job.id}`, {
              headers,
            })
          ).json()
        ).status,
    )
    .toBe("succeeded");
  await request.put(`/api/customers/acme/software/${obj.id}/history/current`, {
    headers,
    data: { versionId: version.id, assessmentId: job.id },
  });
  await page.goto("/#dashboard");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  const high = page.getByRole("button", { name: /^高危匹配记录 / });
  await expect(high).toBeVisible();
  const count = Number(
    (await high.getAttribute("aria-label"))!.split(" ").at(-1),
  );
  expect(count).toBeGreaterThan(0);
  await high.click();
  await expect(page).toHaveURL(/scope=.+severity=high/);
  await expect(
    page.getByRole("heading", {
      name: `固定范围观测明细 · 总计 ${count}`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: / · high/i }).first(),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", {
      name: `固定范围观测明细 · 总计 ${count}`,
      exact: true,
    }),
  ).toBeVisible();
  await page.locator("nav button").filter({ hasText: "客户风险概览" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("region", { name: "CVE 概要" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("生命周期概要数字链接固定视图和处理筛选，全部概要保持首屏", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    name = `Life-card-${Date.now()}`;
  const asset = await (
    await request.post("/api/customers/acme/assets", {
      headers,
      data: { name, kind: "host" },
    })
  ).json();
  await request.patch(`/api/customers/acme/assets/${asset.id}/lifecycle`, {
    headers,
    data: { warrantyUntil: "2020-01-01", sourceRef: "fixture" },
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#dashboard");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  const life = page.getByRole("region", { name: "生命周期风险概要" });
  await expect(life).toBeVisible();
  await expect(
    life.getByRole("button", { name: /^致命生命周期风险 / }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "CVE 概要" })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollHeight <= innerHeight + 1,
    ),
  ).toBe(true);
  await life.getByRole("button", { name: /^待处理风险项 / }).click();
  await expect(page).toHaveURL(/view=.+level=active.+handling=pending/);
  await expect(page.getByRole("combobox", { name: "处理状态" })).toHaveValue(
    "pending",
  );
  await expect(page.getByRole("combobox", { name: "风险等级" })).toHaveValue(
    "active",
  );
  await page.reload();
  await expect(page.getByRole("combobox", { name: "处理状态" })).toHaveValue(
    "pending",
  );
  await page.locator("nav button").filter({ hasText: "客户风险概览" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("region", { name: "生命周期风险概要" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("生命周期等级卡只下钻最高等级符合的资产", async ({ page, request }) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" };
  const base = "/api/customers/acme";
  const config = await (
    await request.get(`${base}/lifecycle-risk/config`, { headers })
  ).json();
  await request.put(`${base}/lifecycle-risk/config`, {
    headers,
    data: {
      ...config,
      serviceYears: { server: 5, network: null, unknown: null },
    },
  });
  const name = `mixed-grade-${Date.now()}`;
  const asset = await (
    await request.post(`${base}/assets`, {
      headers,
      data: { name, kind: "host" },
    })
  ).json();
  await request.patch(`${base}/assets/${asset.id}/classification`, {
    headers,
    data: { hardwareType: "server" },
  });
  const due = new Date();
  due.setMonth(due.getMonth() + 3);
  const purchase = new Date(due);
  purchase.setFullYear(purchase.getFullYear() - 5);
  await request.patch(`${base}/assets/${asset.id}/lifecycle`, {
    headers,
    data: {
      purchasedOn: purchase.toISOString().slice(0, 10),
      warrantyUntil: "2020-01-01",
      sourceRef: "fixture",
    },
  });
  const summary = await (
    await request.get(`${base}/lifecycle-risk/summary`, { headers })
  ).json();
  const view = await (
    await request.get(`${base}/lifecycle-risk/views/${summary.id}`, { headers })
  ).json();
  expect(
    view.items
      .filter((i: any) => i.assetId === asset.id)
      .map((i: any) => i.level),
  ).toContain("warning");
  await page.goto(
    `/#lifecycle-risk?view=${summary.id}&level=warning&assetLevel=warning`,
  );
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByText("仅显示最高风险等级为警告的资产")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("仅显示最高风险等级为警告的资产")).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
});
