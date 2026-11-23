import { test, expect } from "@playwright/test";
test("软件SBOM上传、组件未知提示、刷新与客户隔离", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  await page.goto("/#software");
  const name = `Billing-${Date.now()}`;
  await page.getByLabel("软件名称").fill(name);
  await page.getByRole("button", { name: "建立软件对象" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await page.getByLabel("SBOM 文件").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  await page.getByRole("button", { name: "上传 SBOM" }).click();
  await expect(page.getByRole("alert")).toContainText("无效 JSON");
  const content = JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    metadata: {
      component: { name, type: "application", version: "1.0" },
    },
    components: [
      { type: "library", name: "ui-library", purl: "pkg:npm/ui-library" },
    ],
  });
  await page.getByLabel("SBOM 文件").setInputFiles({
    name: "billing.json",
    mimeType: "application/json",
    buffer: Buffer.from(content),
  });
  await page.getByRole("button", { name: "上传 SBOM" }).click();
  await expect(
    page.getByRole("cell", { name: "ui-library", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("组件版本未知，漏洞匹配可能不完整"),
  ).toBeVisible();
  await page.getByText("原始 SBOM 与扩展资料").click();
  await expect(page.getByText(content, { exact: true })).toBeVisible();
  await page.reload();
  await page.goto("/#software");
  await page.getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: /版本 1.0/ }).click();
  await expect(
    page.getByRole("cell", { name: "ui-library", exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "output/t04-software.png", fullPage: true });
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
});
