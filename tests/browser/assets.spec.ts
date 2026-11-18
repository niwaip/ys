import { test, expect } from "@playwright/test";
test("登录、建档、刷新及客户切换保持清晰归属", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
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
