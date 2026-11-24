import { writeFile, rm } from "node:fs/promises";
const slowUpdate = ".data/trivy-browser-fixture/slow-update";
const failedUpdate = ".data/trivy-browser-fixture/fail-update";
test.afterEach(async () => {
  await Promise.all([
    rm(slowUpdate, { force: true }),
    rm(failedUpdate, { force: true }),
  ]);
});
import { test, expect } from "@playwright/test";
test("软件后台评估呈现发现、覆盖、过期库和证据，刷新后回读并隔离客户", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  await page.goto("/#software");
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
  const conditions = page.getByRole("region", {
    name: "扫描条件",
    exact: true,
  });
  await expect(
    conditions.getByRole("combobox", { name: "软件对象", exact: true }),
  ).toHaveValue(/.+/);
  await expect(
    conditions.getByRole("combobox", { name: "SBOM 输入版本", exact: true }),
  ).toHaveValue(/.+/);
  await writeFile(slowUpdate, "");
  await conditions
    .getByRole("button", { name: "提交评估", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "正在更新漏洞数据库", exact: true }),
  ).toBeVisible();
  await expect(
    conditions.getByRole("heading", { name: "评估历史", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("CVE-2099-FIXTURE", { exact: true })).toBeVisible(
    { timeout: 15000 },
  );
  await expect(
    page.getByText("已覆盖声明组件", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText("漏洞数据库已过期", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "4.19.2 工具报告，升级前需验证" }),
  ).toBeVisible();
  await rm(slowUpdate, { force: true });
  await page.getByText("任务详情与执行证据", { exact: true }).click();
  await expect(
    page.getByRole("region", { name: "漏洞数据库更新证据" }),
  ).toContainText("Trivy 数据库检查与更新成功");
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

test("数据库更新失败停止扫描，修复后新请求重新更新并扫描，刷新保留更新证据", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    name = `DB-refresh-${Date.now()}`;
  const software = await (
    await request.post("/api/customers/acme/software", {
      headers,
      data: { name },
    })
  ).json();
  await request.post(`/api/customers/acme/software/${software.id}/sbom`, {
    headers,
    data: {
      fileName: "refresh.json",
      content: JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        fixtureMode: "findings",
        metadata: { component: { type: "application", name, version: "1" } },
        components: [
          {
            type: "library",
            name: "express",
            version: "4.18.0",
            purl: "pkg:npm/express@4.18.0",
          },
        ],
      }),
    },
  });
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "CVE评估" }).click();
  await page.getByRole("tab", { name: "软件漏洞评估", exact: true }).click();
  await page
    .getByRole("combobox", { name: "软件对象", exact: true })
    .selectOption(software.id);
  await page
    .getByRole("combobox", { name: "SBOM 输入版本", exact: true })
    .selectOption({ index: 1 });
  await writeFile(failedUpdate, "");
  await page.getByRole("button", { name: "提交评估", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "数据库更新失败，未开始扫描",
  );
  await expect(page.getByText("CVE-2099-FIXTURE", { exact: true })).toHaveCount(
    0,
  );
  await page.getByText("任务详情与执行证据", { exact: true }).click();
  await expect(
    page.getByRole("region", { name: "漏洞数据库更新证据" }),
  ).toContainText("数据库更新未完成，未开始扫描");
  await rm(failedUpdate, { force: true });
  await page.getByRole("button", { name: "新建评估请求", exact: true }).click();
  await page.getByRole("button", { name: "提交评估", exact: true }).click();
  await expect(
    page.getByText("CVE-2099-FIXTURE", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.locator("nav button").filter({ hasText: "CVE评估" }).click();
  await page.getByRole("tab", { name: "软件漏洞评估", exact: true }).click();
  await page
    .getByRole("button", { name: /执行成功 ·/ })
    .first()
    .click();
  await page.getByText("任务详情与执行证据", { exact: true }).click();
  await expect(
    page.getByRole("region", { name: "漏洞数据库更新证据" }),
  ).toContainText("Trivy 数据库检查与更新成功");
});
