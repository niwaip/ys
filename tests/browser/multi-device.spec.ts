import { test, expect } from "@playwright/test";
test("网络设备在统一工作台手动录入、预览及拒绝，刷新保留决定", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" };
  const name = `switch-${Date.now()}`;
  const asset = await (
    await request.post("/api/customers/acme/assets", {
      headers,
      data: { name, kind: "host", attributes: { serial: "SW-E2E" } },
    })
  ).json();
  await page.goto("/#collections");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("tab", { name: "Windows 采集导入", exact: true }),
  ).toHaveCount(0);
  await page.getByLabel("目标资产", { exact: true }).selectOption(asset.id);
  await page.getByLabel("设备资料类型").selectOption("network");
  await page.getByRole("button", { name: "配置基础资料", exact: true }).click();
  await page.getByRole("tab", { name: "手动输入", exact: true }).click();
  await expect(page.getByLabel("OS发行版ID")).toHaveCount(0);
  await page.getByLabel("来源说明", { exact: true }).fill("现场版本命令");
  await page.getByLabel("型号", { exact: true }).fill("C9300");
  await page.getByLabel("系统 / 固件版本", { exact: true }).fill("17.12.4");
  await page.getByRole("button", { name: "保存基础快照", exact: true }).click();
  const result = page.getByRole("region", { name: "采集结果", exact: true });
  await expect(result).toBeVisible();
  await expect(page.getByRole("dialog", { name: "采集资料详情" })).toHaveCount(
    0,
  );
  await result.getByRole("tab", { name: "设备资料", exact: true }).click();
  await expect(result.getByText("17.12.4", { exact: true })).toBeVisible();
  await result.getByLabel("拒绝原因").fill("需要核实版本");
  await result.getByRole("button", { name: "拒绝采纳", exact: true }).click();
  await expect(result.getByText("已拒绝采纳", { exact: true })).toBeVisible();
  await page.reload();
  await page.locator(".collect-history > summary").click();
  const row = page.getByRole("row").filter({ hasText: name }).first();
  await row.getByRole("button", { name: "查看资料 →" }).click();
  await expect(
    page
      .getByRole("region", { name: "采集结果", exact: true })
      .getByText("已拒绝采纳", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("配置旁新增资产后自动选中，切换目标清除当前结果及上传文件", async ({
  page,
  request,
}) => {
  const name = `new-target-${Date.now()}`;
  await page.goto("/#collections");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByRole("button", { name: "＋ 新增资产", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "新增采集资产" });
  await dialog.getByLabel("资产名称", { exact: true }).fill(name);
  await dialog.getByRole("button", { name: "保存并选择资产" }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByLabel("目标资产", { exact: true }).locator("option:checked"),
  ).toHaveText(name);
  const other = await (
    await request.post("/api/customers/acme/assets", {
      headers: { Authorization: "Bearer browser-test-secret-token" },
      data: { name: name + "-other", kind: "host" },
    })
  ).json();
  await page.reload();
  await page
    .getByLabel("目标资产", { exact: true })
    .selectOption({ label: name });
  await page.getByRole("button", { name: "配置基础资料", exact: true }).click();
  await page.getByRole("tab", { name: "上传脚本结果", exact: true }).click();
  await page.getByLabel("采集JSON文件").setInputFiles({
    name: "invalid.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  await page.getByLabel("目标资产", { exact: true }).selectOption(other.id);
  await page.getByRole("button", { name: "配置基础资料", exact: true }).click();
  await page.getByRole("tab", { name: "上传脚本结果", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "保存基础快照", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("region", { name: "采集结果", exact: true }),
  ).toHaveCount(0);
});
