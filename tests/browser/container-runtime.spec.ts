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

test("redesigned collection tasks, capability gaps, immutable directory handoff, downloads and scoped offline upload", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产采集" }).click();
  await page.getByLabel("主机资产").selectOption({ label: "Docker测试主机" });
  await expect(
    page.getByRole("tab", { name: "主机基础资料", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .getByRole("button", { name: "开始基础采集 →", exact: true })
    .click();
  const basic = page
    .locator(".collect-task-list details")
    .filter({ hasText: "基础采集" })
    .first();
  await basic.locator("summary").click();
  await basic.getByRole("button", { name: "查看采集资料" }).click();
  await expect(
    page.getByRole("dialog", { name: "采集资料详情" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭资料详情" }).click();
  await page.getByRole("tab", { name: "容器运行资料", exact: true }).click();
  await page.getByRole("button", { name: "检查采集能力" }).click();
  const checks = page.getByRole("region", { name: "采集能力检查" });
  await expect(checks).toContainText("reader");
  await expect(checks).toContainText("工具缺失");
  const submitted = page.waitForResponse(
    (r) =>
      r.url().endsWith("/collections/jobs") && r.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "采集容器目录 →", exact: true })
    .click();
  const task = await (await submitted).json();
  const directory = page.locator(
    `.collect-task-list details[data-job-id="${task.id}"]`,
  );
  await directory.locator("summary").click();
  await directory.getByRole("button", { name: "查看采集资料" }).click();
  await page.getByRole("button", { name: "选择镜像生成与扫描" }).click();
  await expect(
    page.getByRole("heading", { name: "主机镜像目录" }),
  ).toBeVisible();
  await expect(page.getByLabel("Docker 已授权连接")).toHaveValue(
    "docker-fixture",
  );
  await expect(page).toHaveURL(/snapshot=/);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "主机镜像目录" }),
  ).toBeVisible();
  await expect(page.getByLabel("Docker 已授权连接")).toHaveValue(
    "docker-fixture",
  );
  await page.locator("nav button").filter({ hasText: "资产采集" }).click();
  await page.getByLabel("主机资产").selectOption({ label: "Docker测试主机" });
  await page.getByRole("tab", { name: "容器运行资料", exact: true }).click();
  await page.getByRole("tab", { name: "离线脚本", exact: true }).click();
  let waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载容器目录采集脚本" }).click();
  expect((await waiting).suggestedFilename()).toBe("ys-docker-inventory.mjs");
  await page.getByRole("tab", { name: "主机基础资料", exact: true }).click();
  await page.getByRole("tab", { name: "离线脚本", exact: true }).click();
  waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载基础采集脚本" }).click();
  expect((await waiting).suggestedFilename()).toBe("ys-host-basic.mjs");
  await page.getByRole("tab", { name: "容器运行资料", exact: true }).click();
  await page.getByRole("tab", { name: "上传脚本结果" }).click();
  const content = JSON.stringify({
    schemaVersion: "ys-host/1",
    identity: {
      hostname: "fixture-host",
      machineId: "fixture-machine",
      serial: null,
    },
    collectedAt: "2026-11-23T00:00:00Z",
    sections: {
      images: { status: "acquired", data: [] },
      containers: { status: "acquired", data: [] },
    },
    extensions: {
      execution: {
        scope: "container-inventory",
        method: "offline",
        transport: "local",
      },
    },
  });
  await page
    .getByLabel("采集JSON文件")
    .setInputFiles({
      name: "offline-directory.json",
      mimeType: "application/json",
      buffer: Buffer.from(content),
    });
  await page.getByLabel("我已确认资料属于所选主机").check();
  await page.getByRole("button", { name: "保存容器目录", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "采集资料详情" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭资料详情" }).click();
  await page.getByRole("button", { name: /采集记录/ }).click();
  await page.getByLabel("历史采集类型").selectOption("container-inventory");
  await expect(page.getByRole("table")).not.toContainText("主机基础资料");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  await page.screenshot({
    path: ".data/collection-redesign-mobile.png",
    fullPage: true,
  });
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByText("还没有采集记录", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
