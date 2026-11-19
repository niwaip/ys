import { test, expect } from "@playwright/test";
test("台账打开全部资料区块，用户确认基线，再采集突出版本变化并保留旧基线", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    base = "http://127.0.0.1:3101/api/customers/acme";
  const name = `baseline-${Date.now()}`;
  const asset = await (
    await request.post(base + "/assets", {
      headers,
      data: { name, kind: "host" },
    })
  ).json();
  const upload = async (version: string) =>
    request.post(base + "/collections/upload", {
      headers,
      data: {
        assetId: asset.id,
        fileName: "host.json",
        content: JSON.stringify({
          schemaVersion: "ys-host/1",
          identity: { hostname: name, serial: null, machineId: asset.id },
          collectedAt: null,
          sections: {
            os: {
              status: "acquired",
              data: {
                id: "debian",
                version,
                kernel: "6.1",
                architecture: "x86_64",
              },
            },
            packages: {
              status: "acquired",
              data: [
                {
                  manager: "dpkg",
                  name: "openssl",
                  version,
                  architecture: "amd64",
                  state: "installed",
                },
              ],
            },
          },
          extensions: {},
        }),
      },
    });
  expect((await upload("12")).ok()).toBe(true);
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByRole("button", { name, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "资产详情", exact: true });
  await expect(
    dialog.getByRole("heading", { name: "操作系统", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "系统包", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("尚无已确认基线", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "确认选中资料并更新基线" }).click();
  await expect(dialog.getByRole("status")).toHaveText("已确认并更新资产基线");
  await page.getByRole("button", { name: "关闭资产详情" }).click();
  expect((await upload("13")).ok()).toBe(true);
  await page.getByRole("button", { name, exact: true }).click();
  await expect(
    dialog
      .locator("#baseline-os .baseline-field-changed")
      .filter({ hasText: "版本" }),
  ).toContainText("13");
  await expect(dialog.locator("#baseline-os")).toContainText("基线：12");
  await dialog.locator("#baseline-packages").getByLabel("仅显示变化").check();
  await expect(dialog.locator("#baseline-packages tbody")).toContainText(
    "变更",
  );
  await dialog
    .getByRole("button", { name: "已确认基础数据", exact: true })
    .click();
  await expect(dialog.locator("#baseline-os")).toContainText("12");
  await dialog.getByRole("button", { name: "本次采集与变更" }).click();
  await page.screenshot({ path: "output/deployment/baseline-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("aside.sidebar")).toHaveCSS("position", "static");
  await page.screenshot({ path: "output/deployment/baseline-mobile.png" });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
