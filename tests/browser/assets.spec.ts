import { test, expect } from "@playwright/test";
test("登录、建档、刷新及客户切换保持清晰归属", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  await expect(page.getByRole("heading", { name: "资产台账" })).toBeVisible();
  const name = `生产主机-${Date.now()}`;
  await page.getByRole("button", { name: "新建资产" }).click();
  await page.getByLabel("资产名称").fill(name);
  await page.getByLabel("来源标识").fill("CMDB-01");
  await page.getByRole("button", { name: "保存资产" }).click();
  await expect(
    page
      .getByRole("cell")
      .filter({ has: page.getByText(name, { exact: true }) }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page
      .getByRole("cell")
      .filter({ has: page.getByText(name, { exact: true }) }),
  ).toBeVisible();
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByText(name, { exact: true })).toHaveCount(0);
  await expect(page.getByText("还没有资产")).toBeVisible();
  await page.getByLabel("当前客户").selectOption("acme");
  await expect(
    page
      .getByRole("cell")
      .filter({ has: page.getByText(name, { exact: true }) }),
  ).toBeVisible();
  await page.screenshot({ path: "output/t01-workspace.png", fullPage: true });
});

test("台账上方概览与下方明细分层，来源管理折叠且手机无横向溢出", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" };
  const name = `inventory-layout-${Date.now()}`;
  const asset = await (
    await request.post("/api/customers/acme/assets", {
      headers,
      data: { name, kind: "host", sourceRef: "layout-fixture" },
    })
  ).json();
  await request.patch(`/api/customers/acme/assets/${asset.id}/classification`, {
    headers,
    data: { hardwareType: "network" },
  });
  const summary = await (
    await request.get("/api/customers/acme/assets/summary", { headers })
  ).json();
  await page.route("**/netbox/status", (r) =>
    r.fulfill({ json: { mode: "netbox", configured: true, tenantId: 2 } }),
  );
  await page.route("**/netbox/mappings", (r) =>
    r.fulfill({ json: { items: [] } }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#assets");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  const overview = page.getByRole("region", { name: "资产概览" }),
    details = page.getByRole("region", { name: "资产明细" });
  await expect(overview).toBeVisible();
  await expect(
    overview.getByRole("article", { name: `网络设备 ${summary.network}` }),
  ).toBeVisible();
  expect(
    (await overview.boundingBox())!.y + (await overview.boundingBox())!.height,
  ).toBeLessThan((await details.boundingBox())!.y);
  await expect(page.getByText("尚未评估", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "同步客户资产", exact: true }),
  ).not.toBeVisible();
  await page.getByText("资产来源与同步", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "同步客户资产", exact: true }),
  ).toBeVisible();
  await page.getByText("资产来源与同步", { exact: true }).click();
  await page.screenshot({
    path: "output/asset-inventory-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByText("资产来源与同步", { exact: true }).click();
  await page.getByText("在NetBox新增资产", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "写入NetBox", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByText("资产来源与同步", { exact: true }).click();
  await page.screenshot({
    path: "output/asset-inventory-mobile.png",
    fullPage: true,
  });
});
