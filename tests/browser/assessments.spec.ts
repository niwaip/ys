import { test, expect } from "@playwright/test";
test("软件后台评估呈现发现、覆盖、过期库和证据，刷新后回读并隔离客户", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  await page.getByRole("button", { name: "软件 SBOM" }).click();
  const name = `Assessment-${Date.now()}`;
  await page.getByLabel("软件名称").fill(name);
  await page.getByRole("button", { name: "建立软件对象" }).click();
  const content = JSON.stringify({
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    fixtureMode: "findings",
    metadata: { component: { type: "application", name, version: "1.0" } },
    components: [
      {
        type: "library",
        name: "express",
        version: "4.18.0",
        purl: "pkg:npm/express@4.18.0",
      },
    ],
  });
  await page.getByLabel("SBOM 文件").setInputFiles({
    name: "fixture.json",
    mimeType: "application/json",
    buffer: Buffer.from(content),
  });
  await page.getByRole("button", { name: "上传 SBOM" }).click();
  await expect(page.getByText("SBOM 已导入为新输入版本")).toBeVisible();
  await page.locator("nav button").filter({ hasText: "CVE评估" }).click();
  await page.getByRole("tab", { name: "软件漏洞评估", exact: true }).click();
  await page
    .getByRole("combobox", { name: "软件对象", exact: true })
    .selectOption({ label: name });
  await page
    .getByRole("combobox", { name: "SBOM 输入版本", exact: true })
    .selectOption({ index: 1 });
  await page.getByRole("button", { name: "提交评估", exact: true }).click();
  await expect(
    page.getByText("CVE-2099-FIXTURE", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("已覆盖声明组件", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("漏洞数据库已过期", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "4.19.2 工具报告，升级前需验证" }),
  ).toBeVisible();
  await page.getByText("任务详情与执行证据", { exact: true }).click();
  await page.getByText("原始 Trivy 报告", { exact: true }).click();
  await expect(page.getByText(/"SchemaVersion":2/)).toBeVisible();
  await page.getByRole("button", { name: "提交评估", exact: true }).click();
  await expect(page.getByText("重复请求：回读原任务")).toBeVisible();
  await page.reload();
  await page.locator("nav button").filter({ hasText: "CVE评估" }).click();
  await page.getByRole("tab", { name: "软件漏洞评估", exact: true }).click();
  const history = page.getByRole("button", { name: /执行成功 ·/ }).first();
  await history.click();
  await expect(
    page.getByText("CVE-2099-FIXTURE", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "output/t05-assessment.png", fullPage: true });
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByText("CVE-2099-FIXTURE", { exact: true })).toHaveCount(
    0,
  );
});
