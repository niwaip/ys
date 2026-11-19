import { test, expect } from "@playwright/test";
test("公开情报对话保存失败任务并刷新回读，不把未配置显示为最新查询成功", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("button", { name: "公开 CVE 对话" })).toBeVisible(
    { timeout: 2000 },
  );
  await page.getByRole("button", { name: "公开 CVE 对话" }).click();
  const message = `查看这个月的PHP CVE ${Date.now()}`;
  await page.getByLabel("原始问题").fill(message);
  await page.getByRole("button", { name: "发送公开查询" }).click();
  await expect(page.getByRole("status")).toContainText("不可用");
  await expect(page.getByText("未评估客户资产", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "公开 CVE 对话" }).click();
  await page.getByRole("button", { name: message, exact: true }).click();
  await expect(page.getByRole("status")).toContainText("不可用");
  await page.screenshot({
    path: "output/t09-intelligence.png",
    fullPage: true,
  });
});
