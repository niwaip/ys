import { test, expect } from "@playwright/test";

test("Linux快照扫描分页、原始证据下载、历史回读及客户隔离", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" };
  const api = "http://127.0.0.1:3101/api/customers/acme";
  const name = `Linux-browser-${Date.now()}`;
  const assetResponse = await request.post(`${api}/assets`, {
    headers,
    data: { name, kind: "host" },
  });
  expect(assetResponse.ok()).toBe(true);
  const asset = await assetResponse.json();
  const snapshotResponse = await request.post(`${api}/collections/manual`, {
    headers,
    data: {
      assetId: asset.id,
      note: "Browser fixed native metadata",
      data: {
        schemaVersion: "ys-host/1",
        identity: { hostname: name },
        collectedAt: null,
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
  });
  expect(snapshotResponse.ok()).toBe(true);
  const snapshot = await snapshotResponse.json();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "CVE评估" }).click();
  await page.getByLabel("扫描主机").selectOption(asset.id);
  await page.getByLabel("Linux采集快照").selectOption(snapshot.id);
  await page.getByRole("button", { name: "扫描所选Linux快照" }).click();
  await expect(
    page.getByRole("heading", { name: "发现 60 条漏洞记录" }),
  ).toBeVisible();
  await expect(page.getByText("CVE-LINUX-000", { exact: true })).toBeVisible();
  await expect(page.getByText("CVE-LINUX-050", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "下一页漏洞" }).click();
  await expect(page.getByText("CVE-LINUX-050", { exact: true })).toBeVisible();
  await expect(page.getByText("CVE-LINUX-000", { exact: true })).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载原始Trivy报告" }).click();
  expect((await download).suggestedFilename()).toMatch(/^trivy-.*\.json$/);
  await page.reload();
  await page.getByLabel("扫描主机").selectOption(asset.id);
  await page
    .getByRole("button", { name: /执行成功 ·/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "发现 60 条漏洞记录" }),
  ).toBeVisible();
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByText("CVE-LINUX-000", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});
