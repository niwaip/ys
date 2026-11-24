import { test, expect } from "@playwright/test";
test("先选类型与设备再配置内容，软件和容器不再是顶级菜单", async ({
  page,
  request,
}) => {
  const auth = { Authorization: "Bearer browser-test-secret-token" };
  const name = `hierarchy-${Date.now()}`;
  const asset = (
    await request.post("/api/customers/acme/assets", {
      headers: auth,
      data: { name, kind: "host", attributes: { hardwareType: "server" } },
    })
  ).json();
  await request.patch(
    `/api/customers/acme/assets/${(await asset).id}/classification`,
    { headers: auth, data: { hardwareType: "server" } },
  );
  await page.goto("/#collections");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.locator("nav button").filter({ hasText: /^(容器镜像|软件 SBOM)$/ }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "物理服务器", exact: true }).click();
  await page
    .getByLabel("目标资产", { exact: true })
    .selectOption((await asset).id);
  const category = await page
    .getByRole("region", { name: "资产类型", exact: true })
    .boundingBox();
  const target = await page
    .getByLabel("目标资产", { exact: true })
    .boundingBox();
  const contents = await page
    .getByRole("region", { name: "操作系统与配置", exact: true })
    .boundingBox();
  expect(category!.y).toBeLessThan(target!.y);
  expect(target!.y).toBeLessThan(contents!.y);
  await page.getByLabel("选择软件清单与组件", { exact: true }).check();
  await page
    .getByRole("button", { name: "配置软件清单与组件", exact: true })
    .click();
  await expect(
    page.getByText("软件清单与组件资料分别保存", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("分项配置刷新保留，手动软件结果归入批次并经选中采纳", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    name = `config-${Date.now()}`;
  const asset = await (
    await request.post("/api/customers/acme/assets", {
      headers,
      data: { name, kind: "host" },
    })
  ).json();
  await request.patch(`/api/customers/acme/assets/${asset.id}/classification`, {
    headers,
    data: { hardwareType: "server" },
  });
  await page.goto(`/#collections?asset=${asset.id}`);
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  const config = page.getByRole("region", {
    name: "操作系统与配置",
    exact: true,
  });
  await config.getByLabel("选择软件清单与组件", { exact: true }).check();
  await config.getByLabel("软件清单与组件采集方式").selectOption("manual");
  await config
    .getByRole("button", { name: "保存采集配置", exact: true })
    .click();
  await expect(
    config.getByText("采集配置已保存，可刷新重复使用", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    config.getByLabel("选择软件清单与组件", { exact: true }),
  ).toBeChecked();
  await config
    .getByRole("button", { name: "执行选中采集项", exact: true })
    .click();
  await config
    .getByRole("button", { name: "录入软件清单与组件", exact: true })
    .click();
  await page.getByLabel("来源说明", { exact: true }).fill("应用版本命令");
  await page.getByLabel("软件及版本", { exact: true }).fill("Example 1.2.3");
  await page.getByRole("button", { name: "保存基础快照", exact: true }).click();
  await expect(
    config.getByText("软件清单与组件 · 采集完成", { exact: true }),
  ).toBeVisible();
  await expect(
    config.getByRole("region", { name: "最近一次采集结果", exact: true }),
  ).toBeVisible();
  await expect(config.getByText("待确认采纳", { exact: true })).toBeVisible();
  await expect(
    config.locator("details.configuration-history"),
  ).not.toHaveAttribute("open", "");
  await config.getByLabel("选中此结果", { exact: true }).check();
  await config
    .getByRole("button", { name: "采纳选中结果", exact: true })
    .click();
  await expect(
    config.getByText("已采纳1项；未触发风险评估", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    config.getByText("软件清单与组件 · 采集完成", { exact: true }),
  ).toBeVisible();
  await expect(config.getByText("已采纳", { exact: true })).toBeVisible();
});

test("软件按明确目录下载组件脚本，已有SBOM通过明确快照关联到当前主机", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    base = "/api/customers/acme";
  const asset = await (
    await request.post(base + "/assets", {
      headers,
      data: { name: `software-scope-${Date.now()}`, kind: "host" },
    })
  ).json();
  await request.patch(`${base}/assets/${asset.id}/classification`, {
    headers,
    data: { hardwareType: "server" },
  });
  const observation = await (
    await request.post(base + "/collections/manual", {
      headers,
      data: {
        assetId: asset.id,
        note: "deployment record",
        data: {
          schemaVersion: "ys-host/1",
          identity: { hostname: asset.name },
          collectedAt: null,
          sections: {
            device: {
              status: "acquired",
              data: { category: "server", software: "billing 1.0" },
            },
          },
        },
      },
    })
  ).json();
  const software = await (
    await request.post(base + "/software", {
      headers,
      data: { name: `Billing-${Date.now()}` },
    })
  ).json();
  const version = await (
    await request.post(`${base}/software/${software.id}/sbom`, {
      headers,
      data: {
        fileName: "app.json",
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          metadata: {
            component: {
              name: software.name,
              type: "application",
              version: "1.0",
            },
          },
          components: [{ name: "example", type: "library", version: "1.0" }],
        }),
      },
    })
  ).json();
  await page.goto(`/#collections?asset=${asset.id}`);
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  const config = page.getByRole("region", {
    name: "操作系统与配置",
    exact: true,
  });
  await config.getByLabel("软件清单与组件采集方式").selectOption("script");
  await config.getByLabel("应用组件目录").fill("/opt/app's folder");
  const pending = page.waitForEvent("download");
  await config
    .getByRole("button", { name: "下载软件组件脚本", exact: true })
    .click();
  const download = await pending;
  expect(download.suggestedFilename()).toBe("ys-software-sbom.mjs");
  const stream = await download.createReadStream();
  let script = "";
  for await (const part of stream!) script += part;
  expect(script).toContain("/opt/app's folder");
  expect(script).toContain("cyclonedx");
  expect(script).not.toContain("execSync");
  await config
    .getByRole("button", { name: "配置软件清单与组件", exact: true })
    .click();
  const materials = page.getByRole("region", {
    name: "主机软件组件资料",
    exact: true,
  });
  await materials.getByText("关联已有资料到当前主机", { exact: true }).click();
  await materials
    .getByLabel("主机资料版本", { exact: true })
    .selectOption(observation.id);
  await materials
    .getByLabel("资料对象", { exact: true })
    .selectOption(software.id);
  await materials
    .getByLabel("组件资料版本", { exact: true })
    .selectOption(version.id);
  await materials
    .getByLabel("关联依据", { exact: true })
    .fill("deployment manifest");
  await materials
    .getByRole("button", { name: "确认关联当前主机", exact: true })
    .click();
  await expect(
    materials.getByRole("article").filter({ hasText: software.name }),
  ).toContainText("deployment manifest");
});

test("批次录入期间查看旧历史不绑定旧快照，只有本次成功提交才固定结果", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    base = "/api/customers/acme";
  const asset = await (
    await request.post(base + "/assets", {
      headers,
      data: { name: `history-guard-${Date.now()}`, kind: "host" },
    })
  ).json();
  await request.patch(`${base}/assets/${asset.id}/classification`, {
    headers,
    data: { hardwareType: "server" },
  });
  const old = await (
    await request.post(base + "/collections/manual", {
      headers,
      data: {
        assetId: asset.id,
        note: "历史记录",
        data: {
          schemaVersion: "ys-host/1",
          identity: { hostname: `old-${asset.name}` },
          collectedAt: null,
          sections: {
            device: {
              status: "acquired",
              data: { category: "server", software: "Old 0.1" },
            },
          },
        },
      },
    })
  ).json();
  await request.post(`${base}/collections/configurations/${asset.id}`, {
    headers,
    data: {
      category: "server",
      platform: "linux",
      items: [
        { content: "basic", method: "manual", enabled: false },
        { content: "docker", method: "script", enabled: false },
        { content: "software", method: "manual", enabled: true },
      ],
    },
  });
  await page.goto(`/#collections?asset=${asset.id}`);
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  const config = page.getByRole("region", {
    name: "操作系统与配置",
    exact: true,
  });
  const creation = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/configurations/${asset.id}/run`) &&
      r.request().method() === "POST",
  );
  await config
    .getByRole("button", { name: "执行选中采集项", exact: true })
    .click();
  const run = await (await creation).json();
  await config
    .getByRole("button", { name: "录入软件清单与组件", exact: true })
    .click();
  await page.locator(".collect-history > summary").click();
  await page
    .getByRole("row")
    .filter({ hasText: `old-${asset.name}` })
    .getByRole("button", { name: "查看资料 →", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "采集结果", exact: true }),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.getByLabel("来源说明", { exact: true }).fill("本次新资料");
  await page.getByLabel("软件及版本", { exact: true }).fill("New 2.0");
  await page.getByRole("button", { name: "保存基础快照", exact: true }).click();
  await expect(
    config.getByText("软件清单与组件 · 采集完成", { exact: true }),
  ).toBeVisible();
  const saved = await (
    await request.get(`${base}/collections/configuration-runs/${run.id}`, {
      headers,
    })
  ).json();
  expect(saved.items[0].snapshotId).not.toBe(old.id);
  const section = await (
    await request.get(
      `${base}/collections/snapshots/${saved.items[0].snapshotId}/sections/device`,
      { headers },
    )
  ).json();
  expect(section.data.software).toBe("New 2.0");
});

test("恢复只含软件项的配置不会额外启用基础采集", async ({ page, request }) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    base = "/api/customers/acme";
  const asset = await (
    await request.post(base + "/assets", {
      headers,
      data: { name: `only-software-${Date.now()}`, kind: "host" },
    })
  ).json();
  await request.patch(`${base}/assets/${asset.id}/classification`, {
    headers,
    data: { hardwareType: "server" },
  });
  await request.post(`${base}/collections/configurations/${asset.id}`, {
    headers,
    data: {
      category: "server",
      platform: "linux",
      items: [{ content: "software", enabled: true, method: "manual" }],
    },
  });
  await page.goto(`/#collections?asset=${asset.id}`);
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  const config = page.getByRole("region", {
    name: "操作系统与配置",
    exact: true,
  });
  await expect(
    config.getByRole("button", { name: "执行选中采集项", exact: true }),
  ).toBeEnabled();
  await expect(
    config.getByLabel("选择基础资料", { exact: true }),
  ).not.toBeChecked();
  await expect(
    config.getByLabel("选择软件清单与组件", { exact: true }),
  ).toBeChecked();
  const response = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/configurations/${asset.id}/run`) &&
      r.request().method() === "POST",
  );
  await config
    .getByRole("button", { name: "执行选中采集项", exact: true })
    .click();
  expect(
    (await (await response).json()).items.map(
      (i: { content: string }) => i.content,
    ),
  ).toEqual(["software"]);
});
