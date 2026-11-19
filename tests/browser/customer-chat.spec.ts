import { test, expect } from "@playwright/test";
test("客户只读对话显示未评估并保持客户隔离，刷新回读固定依据", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("button", { name: "客户风险对话" })).toBeVisible({
    timeout: 2000,
  });
  await page.getByRole("button", { name: "客户风险对话" }).click();
  const question = `CVE-2024-4577 查询 ${Date.now()}`;
  await page.getByLabel("客户问题").fill(question);
  await page.getByRole("button", { name: "查询已保存评估" }).click();
  await expect(
    page.getByText("未选择已保存的评估，当前范围未评估。", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "客户风险对话" }).click();
  await page.getByRole("button", { name: question, exact: true }).click();
  await expect(
    page.getByText("未选择已保存的评估，当前范围未评估。", { exact: true }),
  ).toBeVisible();
  await page.getByLabel("当前客户").selectOption("river");
  await expect(
    page.getByRole("button", { name: question, exact: true }),
  ).toHaveCount(0);
});
