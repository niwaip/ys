import { test, expect } from "@playwright/test";
test("网页保存人工基础快照，刷新回读来源与未评估状态，连接仅可选受控配置", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (e) => failures.push(e.message));
  await page.addInitScript(() =>
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    }),
  );
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  const name = `collection-${Date.now()}`;
  await page.getByRole("button", { name: "＋ 新建资产" }).click();
  await page.getByLabel("资产名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "保存资产", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  const assetId = await row.locator("code").first().textContent();
  await page.locator("nav button").filter({ hasText: "资产采集" }).click();
  await page.getByLabel("主机资产").selectOption(assetId!);
  await expect(
    page.getByRole("tab", { name: "主机基础资料", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "容器运行资料", exact: true }).click();
  await expect(
    page.getByText("该连接未授权 Docker 访问", { exact: false }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "主机基础资料", exact: true }).click();
  await page.getByRole("tab", { name: "手动输入" }).click();
  await page.getByLabel("来源说明").fill("浏览器现场声明");
  await page.getByLabel("主机名", { exact: true }).fill(name);
  await page.getByLabel("OS发行版ID").fill("debian");
  await page.getByLabel("OS版本", { exact: true }).fill("12");
  await page.getByRole("button", { name: "保存基础快照", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `快照详情 · ${name}` }),
  ).toBeVisible();
  await expect(page.getByText("人工来源快照已保存，尚未评估")).toBeVisible();
  await expect(
    page.locator("summary").filter({ hasText: "关联软件 / 镜像SBOM版本" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "确认选中资料并更新基线" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认选中资料并更新基线" }).click();
  await expect(
    page.getByText("已确认并更新资产基线", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭资料详情" }).click();
  await page.getByRole("tab", { name: "连接采集" }).click();
  await page.getByLabel("主机连接").selectOption({ index: 0 });
  // No configured target connection is offered; the server's unavailable state is
  // covered by HTTP tests, while the browser keeps the fixed profile selector.
  await expect(page.getByLabel("主机连接").locator("option")).toHaveCount(1);
  await page.reload();
  await page.locator("nav button").filter({ hasText: "资产采集" }).click();
  await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
  expect(failures).toEqual([]);
});

test("网页新建凭证并绑定所选主机，刷新后仅显示关联连接", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  const name = `connection-${Date.now()}`;
  await page.getByRole("button", { name: "＋ 新建资产" }).click();
  await page.getByLabel("资产名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "保存资产", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
  await page.locator("nav button").filter({ hasText: "资产采集" }).click();
  await page.getByLabel("主机资产").selectOption({ label: name });
  await page.getByRole("button", { name: "＋ 新建连接" }).click();
  const dialog = page.getByRole("dialog", { name: "新建主机连接" });
  await dialog.getByLabel("主机地址").fill("192.0.2.10");
  await dialog.getByLabel("登录账号").fill("reader");
  await dialog.getByRole("button", { name: "＋ 新建凭证" }).click();
  await dialog.getByLabel("凭证名称").fill("测试只读密钥");
  await dialog
    .getByLabel("SSH私钥")
    .fill(
      "-----BEGIN OPENSSH PRIVATE KEY-----\nBROWSER-TEST-KEY\n-----END OPENSSH PRIVATE KEY-----",
    );
  await dialog.getByRole("button", { name: "保存凭证", exact: true }).click();
  await expect(dialog.getByLabel("登录凭证")).not.toHaveValue("");
  // Only host-key discovery is substituted: credential and association use real HTTP persistence.
  let releaseProbe!: () => void;
  const probeGate = new Promise<void>((resolve) => {
    releaseProbe = resolve;
  });
  await page.route("**/collections/connections/host-key", async (route) => {
    await probeGate;
    await route.fulfill({
      json: {
        hostKey:
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        fingerprint: "SHA256:test-fingerprint",
      },
    });
  });
  await dialog.getByRole("button", { name: "读取主机指纹" }).click();
  await expect(dialog.getByLabel("主机地址")).toBeDisabled();
  await expect(dialog.getByLabel("SSH端口")).toBeDisabled();
  releaseProbe();
  await dialog.getByLabel("我已核对该主机指纹").check();
  await dialog.getByRole("button", { name: "保存连接", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByLabel("主机连接").locator("option:checked"),
  ).toHaveText(`${name} · SSH`);
  await page.screenshot({
    path: "output/deployment/collection-new-desktop.png",
    fullPage: true,
  });
  await page.reload();
  await page.locator("nav button").filter({ hasText: "资产采集" }).click();
  await page.getByLabel("主机资产").selectOption({ label: name });
  await expect(
    page.getByLabel("主机连接").locator("option:checked"),
  ).toHaveText(`${name} · SSH`);
  await expect(page.getByText("测试只读密钥", { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("aside.sidebar")).toHaveCSS("position", "static");
  await page.screenshot({
    path: "output/deployment/collection-new-mobile.png",
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("采集工作台首屏可见主操作，内容选择在目标上方且历史独立展示", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    name = `collect-layout-${Date.now()}`;
  const asset = await (
    await request.post("/api/customers/acme/assets", {
      headers,
      data: { name, kind: "host" },
    })
  ).json();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#collections");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByLabel("主机资产").selectOption(asset.id);
  const setup = page.getByRole("region", { name: "采集配置", exact: true }),
    history = page.getByRole("region", { name: "采集历史", exact: true });
  await expect(setup).toBeVisible();
  await expect(history).toBeVisible();
  const content = setup.getByRole("tablist", { name: "采集任务类型" }),
    target = setup.getByLabel("主机资产");
  expect(
    (await content.boundingBox())!.y + (await content.boundingBox())!.height,
  ).toBeLessThan((await target.boundingBox())!.y);
  await expect(
    setup.getByRole("button", { name: "开始基础采集 →", exact: true }),
  ).toBeInViewport();
  const entry = page.getByRole("navigation", { name: "采集入口" });
  expect(
    Math.abs((await entry.boundingBox())!.x - (await setup.boundingBox())!.x),
  ).toBeLessThan(2);
  await page.screenshot({
    path: "output/collection-workbench-desktop.png",
    fullPage: false,
  });
  await setup.getByRole("tab", { name: "容器运行资料", exact: true }).click();
  await expect(
    setup.getByRole("tab", { name: "手动输入", exact: true }),
  ).toHaveCount(0);
  await setup.getByRole("tab", { name: "离线脚本", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "下载容器目录采集脚本", exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("tab", { name: "Windows 采集导入", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Windows 主机采集资料" }),
  ).toBeVisible();
});
