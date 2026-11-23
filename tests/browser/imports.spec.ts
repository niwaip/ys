import { test, expect } from "@playwright/test";
test("CSV上传预览、问题阻断、提交及刷新溯源", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  await page
    .getByRole("button", { name: "批量导入资产清单", exact: true })
    .click();
  const unique = Date.now();
  const csv = `source,sourceRef,name,kind,collectedAt,ip\ncmdb,ui-${unique},CSV主机-${unique},host,,10.1.0.1`;
  await page.getByLabel("CSV 文件").setInputFiles({
    name: "mixed.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv + "\n,broken,bad,host,,"),
  });
  await page.getByRole("button", { name: "预览映射" }).click();
  await expect(page.getByText("缺失 source", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "整批提交" })).toBeDisabled();
  await page.getByLabel("CSV 文件").setInputFiles({
    name: `valid-${unique}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.getByRole("button", { name: "预览映射" }).click();
  await expect(page.getByText("attributes.ip", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "整批提交" }).click();
  await expect(page.getByText("已导入", { exact: true })).toBeVisible();
  await page.reload();
  await page
    .getByRole("button", { name: "批量导入资产清单", exact: true })
    .click();
  await page.getByRole("button", { name: `valid-${unique}.csv` }).click();
  await page.getByText("原始 CSV").click();
  await expect(page.getByText(csv, { exact: true })).toBeVisible();
  await page.screenshot({ path: "output/t02-import.png", fullPage: true });
  await page.getByLabel("当前客户").selectOption("river");
  await expect(
    page.getByRole("button", { name: `valid-${unique}.csv` }),
  ).toHaveCount(0);
});
