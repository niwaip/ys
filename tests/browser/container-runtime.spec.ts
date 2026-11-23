import { test, expect } from "@playwright/test";
test("host image discovery, batch generation and scan, source evidence, manual/offline and dashboard", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "容器镜像" }).click();
  await page
    .getByLabel("容器所属主机")
    .selectOption({ label: "Docker测试主机" });
  await page.getByLabel("Docker 已授权连接").selectOption("docker-fixture");
  await page.getByRole("button", { name: "发现主机镜像" }).click();
  await expect(
    page.getByRole("heading", { name: "主机镜像目录" }),
  ).toBeVisible();
  await expect(
    page.getByRole("row").filter({ hasText: "fixture/app" }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("row").filter({ hasText: "fixture/app" }),
  ).toContainText("app-1");
  await page.getByLabel("仅显示运行中容器使用的镜像").uncheck();
  await page.getByLabel("选择镜像 fixture/app", { exact: true }).check();
  await page.getByLabel("选择镜像 fixture/worker", { exact: true }).check();
  await page
    .getByLabel("选择镜像 fixture/unavailable", { exact: true })
    .check();
  await page
    .getByRole("button", { name: "生成并扫描所选镜像（3）", exact: true })
    .click();
  await expect(
    page.getByRole("cell", { name: "扫描完成", exact: true }),
  ).toHaveCount(2, { timeout: 30000 });
  await expect(
    page.getByRole("cell", { name: /工具或连接不可用/ }),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "重试未成功任务" }).click();
  await expect(
    page.getByRole("cell", { name: /工具或连接不可用/ }),
  ).toHaveCount(2);
  await page.getByRole("button", { name: "查看镜像结果" }).first().click();
  await expect(
    page.getByText("CVE-2099-CONTAINER", { exact: true }),
  ).toBeVisible();
  await page.getByText("扫描来源证据", { exact: true }).click();
  await expect(
    page.getByText(/生成工具：fixture-trivy-generator/),
  ).toBeVisible();
  await page.getByRole("tab", { name: "离线脚本" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载镜像生成脚本" }).click();
  expect((await download).suggestedFilename()).toBe("ys-image-sbom.mjs");
  await page.getByLabel("上传镜像名称").fill("手工镜像");
  await page.getByLabel("镜像资料文件").setInputFiles({
    name: "manual.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        bomFormat: "CycloneDX",
        specVersion: "1.5",
        metadata: { component: { type: "container", name: "manual-e2e" } },
        components: [],
      }),
    ),
  });
  await page.getByRole("button", { name: "接入镜像资料" }).click();
  await expect(
    page.getByRole("heading", { name: "手工镜像", exact: true }),
  ).toBeVisible();
  await page.locator("nav button").filter({ hasText: "客户风险概览" }).click();
  const summary = page.getByRole("region", { name: "容器镜像扫描概要" });
  await expect(summary).toContainText("生成并扫描完成");
  await summary
    .getByRole("button", { name: "选择主机生成 / 查看镜像" })
    .click();
  await expect(
    page.getByRole("heading", { name: "容器镜像", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("cell", { name: "扫描完成", exact: true }),
  ).toHaveCount(2);
  await page.getByLabel("当前客户").selectOption("river");
  await expect(
    page.getByRole("cell", { name: "扫描完成", exact: true }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
  await page.screenshot({
    path: ".data/container-runtime-e2e.png",
    fullPage: true,
  });
});
test("mobile container controls and persisted jobs remain readable", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "容器镜像" }).click();
  await expect(
    page.getByRole("heading", { name: "容器镜像", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "生成与扫描任务" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    )
    .toBe(true);
  await page.screenshot({
    path: ".data/container-runtime-mobile.png",
    fullPage: true,
  });
});
