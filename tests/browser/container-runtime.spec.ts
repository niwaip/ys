import { test, expect } from "@playwright/test";
test("host image discovery, batch generation and scan, source evidence, manual/offline and dashboard", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.goto("/#containers");
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
  await page.getByRole("button", { name: /^镜像对象 / }).click();
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
  await page.goto("/#containers");
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
  await page.getByLabel("目标资产").selectOption({ label: "Docker测试主机" });
  await expect(
    page.getByRole("button", { name: "配置基础资料", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page
    .getByRole("button", { name: "开始基础采集 →", exact: true })
    .click();
  await page.locator(".collect-history > summary").click();
  const basic = page
    .locator(".collect-task-list details")
    .filter({ hasText: "基础采集" })
    .first();
  await basic.locator("summary").click();
  await basic.getByRole("button", { name: "查看采集资料" }).click();
  await expect(
    page.getByRole("region", { name: "采集结果", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Docker容器采集方式").selectOption("automatic");
  await page
    .getByRole("button", { name: "配置Docker容器", exact: true })
    .click();
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
  const inline = page.getByRole("region", { name: "容器采集结果" });
  await expect(inline).toBeVisible();
  await expect(page.getByRole("dialog", { name: "采集资料详情" })).toHaveCount(
    0,
  );
  await expect(inline.getByRole("tab", { name: /^容器/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    inline.getByRole("button", { name: "确认采纳容器资料" }),
  ).toBeVisible();
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
  await page.getByLabel("目标资产").selectOption({ label: "Docker测试主机" });
  await page.getByLabel("Docker容器采集方式").selectOption("automatic");
  await page
    .getByRole("button", { name: "配置Docker容器", exact: true })
    .click();
  await page.getByRole("tab", { name: "离线脚本", exact: true }).click();
  let waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载容器目录采集脚本" }).click();
  expect((await waiting).suggestedFilename()).toBe("ys-docker-inventory.mjs");
  await page.getByRole("button", { name: "配置基础资料", exact: true }).click();
  await page.getByRole("tab", { name: "离线脚本", exact: true }).click();
  waiting = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载基础采集脚本" }).click();
  expect((await waiting).suggestedFilename()).toBe("ys-host-basic.mjs");
  await page.getByLabel("Docker容器采集方式").selectOption("automatic");
  await page
    .getByRole("button", { name: "配置Docker容器", exact: true })
    .click();
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
  await page.getByLabel("采集JSON文件").setInputFiles({
    name: "offline-directory.json",
    mimeType: "application/json",
    buffer: Buffer.from(content),
  });
  await page.getByLabel("我已确认资料属于所选主机").check();
  await page.getByRole("button", { name: "保存容器目录", exact: true }).click();
  await expect(
    page.getByRole("region", { name: "容器采集结果" }),
  ).toBeVisible();
  await expect(page.getByRole("dialog", { name: "采集资料详情" })).toHaveCount(
    0,
  );
  await page.locator(".collect-history > summary").click();
  await page.getByRole("button", { name: /采集记录/ }).click();
  await page.getByLabel("历史采集类型").selectOption("container-inventory");
  await expect(
    page.locator(".collect-history").getByRole("table"),
  ).not.toContainText("主机基础资料");
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
  await page.locator(".collect-history > summary").click();
  await expect(page.getByText("还没有采集记录", { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test("collection action keeps submission, completion and errors visible beside the button", async ({
  page,
}) => {
  const confirmationBodies: { sections: string[] }[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/baseline/confirm"))
      confirmationBodies.push(r.postDataJSON());
  });
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产采集" }).click();
  await page.getByLabel("目标资产").selectOption({ label: "Docker测试主机" });
  await page.getByLabel("Docker容器采集方式").selectOption("automatic");
  await page
    .getByRole("button", { name: "配置Docker容器", exact: true })
    .click();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holdPolling = true;
  let submittedJob: Record<string, unknown> | undefined;
  await page.route("**/collections/jobs", async (route) => {
    if (route.request().method() === "POST") {
      await gate;
      const response = await route.fetch();
      submittedJob = {
        ...(await response.json()),
        status: "queued",
        snapshotId: null,
      };
      await route.fulfill({ response, json: submittedJob });
    } else if (holdPolling && submittedJob) {
      await route.fulfill({ json: { items: [submittedJob] } });
    } else await route.continue();
  });
  try {
    await page
      .getByRole("button", { name: "采集容器目录 →", exact: true })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "正在提交采集任务" }),
    ).toBeInViewport();
    await expect(
      page.getByRole("button", { name: "处理中…", exact: true }),
    ).toBeDisabled();
  } finally {
    release();
  }
  const progress = page.getByRole("region", { name: "本次采集任务" });
  await expect(progress).toContainText("排队");
  await expect(
    page.getByRole("button", { name: "采集中…", exact: true }),
  ).toBeDisabled();
  const bar = progress.getByRole("progressbar", { name: "采集进度" });
  const barBox = await bar.boundingBox(),
    progressBox = await progress.boundingBox();
  expect(barBox!.width).toBeGreaterThan(progressBox!.width * 0.8);
  expect(barBox!.height).toBeGreaterThanOrEqual(12);
  holdPolling = false;
  await expect(progress).toContainText("完成");
  await expect(progress).toBeInViewport();
  await page.setViewportSize({ width: 390, height: 844 });
  await progress.scrollIntoViewIfNeeded();
  await expect(progress).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const inline = page.getByRole("region", { name: "容器采集结果" });
  await expect(inline).toBeVisible();
  await expect(inline.getByText("app-1", { exact: true })).toBeVisible();
  await expect(
    inline.getByRole("checkbox", { name: "采纳容器目录" }),
  ).toBeChecked();
  await expect(
    inline.getByText("确认后才会更新资产基线，原始采集记录会保留。", {
      exact: true,
    }),
  ).toBeVisible();
  expect(confirmationBodies).toHaveLength(0);
  await inline.getByRole("button", { name: "暂不采纳", exact: true }).click();
  await expect(inline).toHaveCount(0);
  expect(confirmationBodies).toHaveLength(0);
  await progress.getByRole("button", { name: "查看本次采集资料" }).click();
  await expect(inline).toBeVisible();
  await inline.getByRole("button", { name: "确认采纳容器资料" }).click();
  await expect(
    inline.getByText("已确认并更新资产基线", { exact: true }),
  ).toBeVisible();
  expect(confirmationBodies).toHaveLength(1);
  expect(confirmationBodies[0].sections).toEqual(
    expect.arrayContaining(["containers", "images"]),
  );
  expect(confirmationBodies[0].sections).not.toContain("identity");
  await page.unroute("**/collections/jobs");
  await page.route("**/collections/jobs", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 503,
          json: { message: "fixture connection unavailable" },
        })
      : route.continue(),
  );
  await page
    .getByRole("button", { name: "采集容器目录 →", exact: true })
    .click();
  await expect(page.getByRole("alert")).toBeInViewport();
  await expect(page.getByRole("alert")).toContainText(
    "fixture connection unavailable",
  );
});

test("Docker批次结果直接显示容器镜像及确认入口，历史默认折叠", async ({
  page,
}) => {
  await page.goto("/#collections");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page
    .getByLabel("目标资产", { exact: true })
    .selectOption({ label: "Docker测试主机" });
  const config = page.getByRole("region", {
    name: "操作系统与配置",
    exact: true,
  });
  await config.getByLabel("选择基础资料", { exact: true }).uncheck();
  await config.getByLabel("选择Docker容器", { exact: true }).check();
  await config.getByLabel("Docker容器采集方式").selectOption("automatic");
  await config.getByLabel("Docker容器授权连接").selectOption("docker-fixture");
  await config
    .getByRole("button", { name: "执行选中采集项", exact: true })
    .click();
  const result = config.getByRole("region", {
    name: "最近一次采集结果",
    exact: true,
  });
  await expect(
    result.getByText("Docker容器 · 采集完成", { exact: true }),
  ).toBeVisible();
  await expect(result.getByText("待确认采纳", { exact: true })).toBeVisible();
  await expect(result.getByText(/本次容器目录：/)).toBeVisible();
  await expect(result.getByText(/本次镜像目录：/)).toBeVisible();
  await expect(
    result.getByRole("button", { name: "确认采纳容器资料", exact: true }),
  ).toBeVisible();
  await expect(config.locator(".configuration-history")).not.toHaveAttribute(
    "open",
    "",
  );
  await expect(page.locator(".collect-history")).not.toHaveAttribute(
    "open",
    "",
  );
});
