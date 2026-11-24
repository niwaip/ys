import { test, expect } from "@playwright/test";
test("生命周期工作台按设备筛选，专属日期确认保存与共同CSV引用分别处理", async ({
  page,
  request,
}) => {
  const auth = { Authorization: "Bearer browser-test-secret-token" },
    name = `lifecycle-workspace-${Date.now()}`;
  const asset = await (
    await request.post("/api/customers/acme/assets", {
      headers: auth,
      data: { name, kind: "host", attributes: { product: name, version: "1" } },
    })
  ).json();
  await request.patch(`/api/customers/acme/assets/${asset.id}/classification`, {
    headers: auth,
    data: { hardwareType: "network" },
  });
  await page.goto("/#lifecycle-materials");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "生命周期资料" }).click();
  await page.getByLabel("设备类型", { exact: true }).selectOption("network");
  await page.getByLabel("填写状态", { exact: true }).selectOption("empty");
  await page.getByLabel("搜索设备", { exact: true }).fill(name);
  let row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "填写设备期限", exact: true }).click();
  await page.getByLabel("购买日期", { exact: true }).fill("2020-01-02");
  await page.getByLabel("日期依据", { exact: true }).fill("合同 workspace");
  await page
    .getByRole("button", { name: "保存资产生命周期资料", exact: true })
    .click();
  await expect(
    page.getByText("生命周期资料已保存", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭资料", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByLabel("填写状态", { exact: true }).selectOption("partial");
  await expect(row).toContainText("2020-01-02");
  await row.getByRole("button", { name: "填写设备期限" }).click();
  await page.getByLabel("维保到期日期", { exact: true }).fill("2028-01-02");
  await page
    .getByRole("button", { name: "保存资产生命周期资料", exact: true })
    .click();
  await expect(
    page.getByText("生命周期资料已保存", { exact: true }),
  ).toBeVisible();
  await page.getByText("资料变更历史", { exact: true }).click();
  await expect(page.getByText("查看修改前后", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "关闭资料" }).click();
  await page
    .getByRole("tab", { name: "厂商共同资料 · CSV", exact: true })
    .click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 CSV 模板" }).click();
  expect((await downloading).suggestedFilename()).toBe(
    "ys-lifecycle-template.csv",
  );
  await page.getByLabel("生命周期 CSV 文件").setInputFiles({
    name: "vendor.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      `source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate,category,phase\nVendor,Doc,${name},1,Sales,2020-01-01,Support,2030-01-01,device,eol`,
    ),
  });
  await page.getByRole("button", { name: "导入生命周期批次" }).click();
  await expect(
    page.getByRole("heading", { name: "批次证据：vendor.csv", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "设备专属期限", exact: true }).click();
  await page.getByRole("button", { name: "刷新资料", exact: true }).click();
  await page.getByLabel("填写状态", { exact: true }).selectOption("complete");
  await expect(row).toContainText("2030-01-01");
  await page.reload();
  await page.getByLabel("搜索设备", { exact: true }).fill(name);
  await expect(row).toContainText("2028-01-02");
  await page.screenshot({
    path: "output/deployment/lifecycle-workspace-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "output/deployment/lifecycle-workspace-mobile.png",
    fullPage: true,
  });
});
