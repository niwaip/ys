import { test, expect } from "@playwright/test";
test("台账只读展示分组Tab与SBOM组件，再采集突出变化并保留已确认基线", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
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
            hardware: {
              status: "acquired",
              data: {
                cpu: {
                  status: "acquired",
                  data: `processor : 0\ncpu MHz : ${version}\nprocessor : 1`,
                },
                memory: {
                  status: "acquired",
                  data: `MemTotal: 16777216 kB\nMemAvailable: ${version} kB`,
                },
                disks: {
                  status: "acquired",
                  data: `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda1 104857600 ${version} 1000 1% /`,
                },
              },
            },
            network: {
              status: "acquired",
              data: Array.from(
                { length: version === "12" ? 51 : 50 },
                (_, i) => ({
                  ifname: `eth${i}`,
                  operstate: "UP",
                  addr_info: [
                    {
                      family: "inet",
                      local: `192.0.2.${i + 10}`,
                      prefixlen: 24,
                    },
                  ],
                  stats64: { rx: { bytes: version } },
                  promiscuity: 0,
                }),
              ),
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
  await dialog.getByRole("tab", { name: /^硬件/ }).click();
  await expect(dialog.locator("#baseline-hardware")).toContainText("2 核");
  await expect(dialog.locator("#baseline-hardware")).toContainText("16.0 GiB");
  await expect(dialog.locator("#baseline-hardware")).toContainText("100.0 GiB");
  await expect(dialog.locator("#baseline-hardware pre")).toHaveCount(0);
  await dialog.getByRole("tab", { name: /^网络/ }).click();
  await expect(dialog.locator("#baseline-network")).toContainText(
    "192.0.2.10/24",
  );
  await dialog
    .locator("#baseline-network")
    .getByRole("button", { name: "下一批" })
    .click();
  await expect(dialog.locator("#baseline-network")).toContainText("eth50");
  await expect(dialog.locator("#baseline-network")).not.toContainText(
    "promiscuity",
  );
  await dialog.getByRole("tab", { name: /^操作系统/ }).click();
  await expect(
    dialog.getByRole("heading", { name: "操作系统", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: /^系统包/ }).click();
  await expect(
    dialog.getByRole("heading", { name: "系统包", exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByText("尚无已确认基线", { exact: true }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "确认选中资料并更新基线" }),
  ).toHaveCount(0);
  await expect(dialog.getByText("采纳此字段", { exact: true })).toHaveCount(0);
  await dialog.getByRole("tab", { name: "Docker 环境", exact: true }).click();
  await expect(
    dialog.getByRole("heading", { name: "Docker客户端", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "容器", exact: true }).click();
  await expect(
    dialog.getByText("容器组件扫描尚未接入", { exact: true }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "软件 / 项目", exact: true }).click();
  await expect(
    dialog.getByText("尚未关联软件 / 项目 SBOM", { exact: true }),
  ).toBeVisible();
  const sw = await (
    await request.post(base + "/software", {
      headers,
      data: { name: "关联应用" },
    })
  ).json();
  const sbom = await (
    await request.post(base + `/software/${sw.id}/sbom`, {
      headers,
      data: {
        fileName: "app.json",
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          metadata: { component: { type: "application", name } },
          specVersion: "1.5",
          version: 1,
          components: [
            { type: "library", name: "fixture-library", version: "2.3" },
          ],
        }),
      },
    })
  ).json();
  const hostPreview = await (
    await request.get(base + `/assets/${asset.id}/baseline`, { headers })
  ).json();
  expect(
    (
      await request.post(base + "/collections/links", {
        headers,
        data: {
          assetId: asset.id,
          snapshotId: hostPreview.snapshot.id,
          kind: "software",
          objectId: sw.id,
          versionId: sbom.id,
          basis: "部署关联验收",
        },
      })
    ).ok(),
  ).toBe(true);
  await dialog.getByRole("tab", { name: /^硬件/ }).click();
  await dialog.getByRole("tab", { name: "软件 / 项目", exact: true }).click();
  await dialog.getByRole("button", { name: /部署关联验收/ }).click();
  await expect(dialog.getByRole("heading", { name: /关联应用/ })).toBeVisible();
  await expect(dialog.locator("tbody")).toContainText("fixture-library");
  await expect(dialog.locator("tbody")).toContainText("2.3");
  const preview = await (
    await request.get(base + `/assets/${asset.id}/baseline`, { headers })
  ).json();
  expect(
    (
      await request.post(base + `/assets/${asset.id}/baseline/confirm`, {
        headers,
        data: {
          snapshotId: preview.snapshot.id,
          expectedBaselineId: null,
          idempotencyKey: name,
          sections: ["identity", "os", "hardware", "network", "packages"],
          excludeFields: [],
        },
      })
    ).ok(),
  ).toBe(true);
  await page.getByRole("button", { name: "关闭资产详情" }).click();
  expect((await upload("13")).ok()).toBe(true);
  await page.getByRole("button", { name, exact: true }).click();
  await expect(
    dialog.getByRole("tab", { name: "硬件", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "本次采集与变更" }).click();
  await dialog.getByRole("tab", { name: /^网络/ }).click();
  await dialog.locator("#baseline-network").getByLabel("仅显示变化").check();
  await expect(dialog.locator("#baseline-network")).toContainText("eth50");
  await expect(dialog.locator("#baseline-network")).toContainText("删除");
  await expect(dialog.locator("#baseline-network")).toContainText(
    "192.0.2.60/24",
  );
  await dialog.getByRole("tab", { name: /^操作系统/ }).click();
  await expect(
    dialog
      .locator("#baseline-os .baseline-field-changed")
      .filter({ hasText: "版本" }),
  ).toContainText("13");
  await expect(dialog.locator("#baseline-os")).toContainText("基线：12");
  await dialog.getByRole("tab", { name: /^系统包/ }).click();
  await dialog.locator("#baseline-packages").getByLabel("仅显示变化").check();
  await expect(dialog.locator("#baseline-packages tbody")).toContainText(
    "变更",
  );
  await dialog
    .getByRole("button", { name: "已确认基础数据", exact: true })
    .click();
  await dialog.getByRole("tab", { name: /^操作系统/ }).click();
  await expect(dialog.locator("#baseline-os")).toContainText("12");
  await dialog.getByRole("button", { name: "本次采集与变更" }).click();
  await page.screenshot({ path: "output/deployment/baseline-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("aside.sidebar")).toHaveCSS("position", "static");
  await page.screenshot({ path: "output/deployment/baseline-mobile.png" });
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
