import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { test, expect } from "@playwright/test";

test("按服务器生成报告并在刷新后打开固定覆盖草稿", async ({
  page,
  request,
}, testInfo) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" };
  const name = `report-center-${Date.now()}`;
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
  await page.goto("/#reports");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByLabel("报告服务器", { exact: true }).selectOption(asset.id);
  await page.getByLabel("报告名称", { exact: true }).fill(name);
  for (let i = 0; i < 3; i++)
    await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByLabel("报告专题", { exact: true }).selectOption("lifecycle");
  await page.getByLabel("附逐台服务器 PDF", { exact: true }).check();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page
    .getByRole("button", { name: "使用已有结果生成报告", exact: true })
    .click();
  const preview = page.frameLocator('iframe[title="事实报告草稿"]');
  await expect(
    preview.getByRole("heading", { name: "执行与覆盖说明" }),
  ).toBeVisible();
  await expect(preview.getByText(name, { exact: false }).first()).toBeVisible();
  await expect(
    preview.getByRole("heading", { name: "管理摘要" }),
  ).toBeVisible();
  await expect(
    preview.getByRole("heading", { name: "CVE 软件评估" }),
  ).toHaveCount(0);
  const filesPanel = page.getByRole("region", { name: "报告文件与交付包" });
  await expect(
    filesPanel.getByRole("button", {
      name: "下载完整 ZIP 报告包",
      exact: true,
    }),
  ).toBeEnabled({ timeout: 20000 });
  const pending = page.waitForEvent("download");
  await filesPanel
    .getByRole("button", { name: "下载完整 ZIP 报告包", exact: true })
    .click();
  const download = await pending;
  const path = testInfo.outputPath("report.zip");
  await download.saveAs(path);
  const files = unzipSync(await readFile(path));
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  expect(manifest.complete).toBe(true);
  expect(manifest.files).toHaveLength(4);
  expect(manifest.input.perHostIds).toEqual([asset.id]);
  await page
    .getByLabel("修订报告专题", { exact: true })
    .selectOption("vulnerability");
  await page.getByLabel("修订管理摘要", { exact: true }).uncheck();
  await page.getByRole("button", { name: "保存为新草稿", exact: true }).click();
  await expect(
    preview.getByRole("heading", { name: "CVE 软件评估" }),
  ).toBeVisible();
  await expect(preview.getByRole("heading", { name: "管理摘要" })).toHaveCount(
    0,
  );
  await page.reload();
  await page
    .getByRole("button", { name: `查看报告 ${name}`, exact: true })
    .click();
  await expect(
    preview.getByRole("heading", { name: "执行与覆盖说明" }),
  ).toBeVisible();
  await page.getByLabel("报告范围", { exact: true }).selectOption("tenant");
  await page.getByLabel("报告名称", { exact: true }).fill(`${name}-tenant`);
  for (let i = 0; i < 4; i++)
    await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page
    .getByRole("button", { name: "使用已有结果生成报告", exact: true })
    .click();
  await expect(
    preview.getByText(`${name}-tenant`, { exact: false }).first(),
  ).toBeVisible();
  await expect(preview.getByText(name, { exact: false }).first()).toBeVisible();
});

test("移动端新评估、证据附件、可选 AI 失败与正式交付闭环", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(60000);
  await page.setViewportSize({ width: 390, height: 844 });
  const headers = { Authorization: "Bearer browser-test-secret-token" };
  const base = "/api/customers/acme",
    name = `new-report-${Date.now()}`;
  const asset = await (
    await request.post(`${base}/assets`, {
      headers,
      data: { name, kind: "host" },
    })
  ).json();
  await request.patch(`${base}/assets/${asset.id}/classification`, {
    headers,
    data: { hardwareType: "server" },
  });
  const snapshot = await (
    await request.post(`${base}/collections/manual`, {
      headers,
      data: {
        assetId: asset.id,
        note: "report browser fixture",
        data: {
          schemaVersion: "ys-host/1",
          identity: { hostname: name },
          collectedAt: "2026-10-01T00:00:00Z",
          sections: {
            os: {
              status: "acquired",
              data: {
                id: "ubuntu",
                version: "24.04",
                kernel: "6.8",
                architecture: "x86_64",
              },
            },
            packages: {
              status: "acquired",
              data: [
                {
                  manager: "dpkg",
                  name: "libssl3",
                  version: "3.0.1",
                  architecture: "amd64",
                  state: "installed",
                },
              ],
            },
          },
          extensions: {
            rawSections: {
              os: 'ID=ubuntu\nVERSION_ID="24.04"\n',
              lsbRelease: "DISTRIB_ID=Ubuntu\nDISTRIB_RELEASE=24.04\n",
              dpkgStatus:
                "Package: libssl3\nStatus: install ok installed\nArchitecture: amd64\nVersion: 3.0.1\nSource: openssl\n\n",
            },
          },
        },
      },
    })
  ).json();
  const baseline = await (
    await request.get(`${base}/assets/${asset.id}/baseline`, { headers })
  ).json();
  expect(
    (
      await request.post(`${base}/assets/${asset.id}/baseline/confirm`, {
        headers,
        data: {
          snapshotId: snapshot.id,
          expectedBaselineId: baseline.current?.id ?? null,
          idempotencyKey: `adopt-${snapshot.id}`,
          sections: ["os", "packages"],
          writeMasterData: false,
        },
      })
    ).ok(),
  ).toBe(true);
  await page.goto("/#reports");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByLabel("报告服务器", { exact: true }).selectOption(asset.id);
  await page.getByLabel("报告名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByLabel("报告结果来源").selectOption("assess");
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await expect(page.getByText("范围与覆盖预检", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByLabel("附原始扫描证据", { exact: true }).check();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page
    .getByRole("button", { name: "提交扫描报告任务", exact: true })
    .click();
  await page
    .getByRole("button", { name: `查看报告 ${name}`, exact: true })
    .click({ timeout: 20000 });
  const preview = page.frameLocator('iframe[title="事实报告草稿"]');
  await expect(preview.getByText(/发现实例 120/).first()).toBeVisible();
  await expect(preview.getByText(/采集资料超过 7 天/).first()).toBeVisible();
  await page
    .getByRole("button", { name: "生成 AI 受控叙述", exact: true })
    .click();
  await expect(page.getByText(/AI叙述失败，固定事实草稿保留/)).toBeVisible({
    timeout: 15000,
  });
  await page.getByRole("button", { name: "提交复核", exact: true }).click();
  await page.getByRole("button", { name: "复核通过", exact: true }).click();
  await page
    .getByRole("button", { name: "正式交付该修订", exact: true })
    .click();
  await page
    .getByRole("button", { name: "生成正式报告包", exact: true })
    .click();
  const official = page
    .getByRole("region", { name: "报告文件与交付包" })
    .locator("article")
    .filter({ hasText: "正式交付 · 已复核" });
  await expect(
    official.getByRole("button", { name: "下载完整 ZIP 报告包", exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  const pending = page.waitForEvent("download");
  await official
    .getByRole("button", { name: "下载完整 ZIP 报告包", exact: true })
    .click();
  const download = await pending;
  const path = testInfo.outputPath("official.zip");
  await download.saveAs(path);
  const files = unzipSync(await readFile(path));
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  expect(manifest.input.audience).toBe("official");
  expect(manifest.complete).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("mobile-report.png"),
    fullPage: true,
  });
});
