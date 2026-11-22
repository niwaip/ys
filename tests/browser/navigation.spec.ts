import { test, expect } from "@playwright/test";

test("HTTP兼容模式下所有菜单往返切换仍显示内容且无浏览器异常", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  await expect(page.getByRole("heading", { name: "资产台账" })).toBeVisible();
  const labels = await page.locator("nav button").allTextContents();
  expect(labels).toHaveLength(14);
  for (const label of [...labels, ...[...labels].reverse()]) {
    await page.locator("nav button").filter({ hasText: label }).click();
    await expect(page.locator("main h1, main h2").first(), label).toBeVisible();
    expect(errors, label).toEqual([]);
  }
  await page.locator("nav button").filter({ hasText: "CVE评估" }).click();
  await page
    .getByRole("tab", { name: "Windows 补丁评估", exact: true })
    .click();
  await page.getByRole("button", { name: "新建评估请求" }).click();
  await expect(
    page.getByRole("heading", { name: "Windows 补丁证据评估" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
