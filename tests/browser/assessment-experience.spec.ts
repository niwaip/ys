import { test, expect } from "@playwright/test";

test("评估对象只选择一次，网络设备缺少支持资料时不提供扫描", async ({
  page,
  request,
}) => {
  const asset = await (
    await request.post("http://127.0.0.1:3101/api/customers/acme/assets", {
      headers: { Authorization: "Bearer browser-test-secret-token" },
      data: { name: `network-${Date.now()}`, kind: "host" },
    })
  ).json();
  await request.patch(
    `http://127.0.0.1:3101/api/customers/acme/assets/${asset.id}/classification`,
    {
      headers: { Authorization: "Bearer browser-test-secret-token" },
      data: { hardwareType: "network" },
    },
  );
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "CVE评估" }).click();
  const conditions = page.getByRole("region", {
    name: "扫描条件",
    exact: true,
  });
  await expect(conditions).toBeVisible();
  await expect(conditions.getByLabel("评估对象", { exact: true })).toHaveCount(
    1,
  );
  await expect(conditions.getByRole("tab")).toHaveCount(4);
  await expect(page.getByLabel("评估对象", { exact: true })).toHaveCount(1);
  await expect(page.getByLabel("扫描主机", { exact: true })).toHaveCount(0);
  await page.getByLabel("评估对象", { exact: true }).selectOption(asset.id);
  await expect(page.getByText(/厂商固件.*尚未接入/).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "扫描", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "本资产关联SBOM", exact: true }).click();
  await expect(conditions.getByText(/尚无关联SBOM/)).toBeVisible();
  await expect(
    conditions.getByRole("heading", { name: "本资产关联版本评估历史" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "本资产关联版本评估历史" }),
  ).toBeVisible();
  await page.route(`**/windows/imports?assetId=${asset.id}`, (route) =>
    route.fulfill({ status: 500, json: { message: "fixture lookup failed" } }),
  );
  await page.getByRole("button", { name: "刷新资料状态" }).click();
  await page
    .getByRole("tab", { name: "Windows 补丁评估", exact: true })
    .click();
  await expect(
    page.getByText("Windows资料读取失败，请刷新后重试。").first(),
  ).toBeVisible();
  await expect(page.getByText("没有绑定本资产的Windows采集资料。")).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("heading", { name: "Windows 评估历史" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "开始 Windows 评估" }),
  ).toHaveCount(0);

  await page.route(`**/api/customers/acme/assets/${asset.id}`, (route) =>
    route.fulfill({ status: 500, json: { message: "fixture asset failed" } }),
  );
  await page.getByLabel("评估对象", { exact: true }).selectOption("");
  await page.getByLabel("评估对象", { exact: true }).selectOption(asset.id);
  await page
    .getByRole("tab", { name: "Windows 补丁评估", exact: true })
    .click();
  await expect(
    page.getByText("评估对象读取失败，请刷新页面或重新选择。"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "开始 Windows 评估" }),
  ).toHaveCount(0);
});
