import { readFile } from "node:fs/promises";
import { unzipSync, strFromU8 } from "fflate";
import { test, expect, type APIRequestContext } from "@playwright/test";

async function reportHost(
  request: APIRequestContext,
  name: string,
  supported = true,
) {
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    base = "/api/customers/acme";
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
                id: supported ? "ubuntu" : "centos",
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
              os: supported
                ? 'ID=ubuntu\nVERSION_ID="24.04"\n'
                : 'ID=centos\nVERSION_ID="24.04"\n',
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
  return { asset, snapshot };
}

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
  const steps = await page
    .getByLabel("报告生成步骤")
    .locator("li")
    .evaluateAll((items) =>
      items.map((item) => item.getBoundingClientRect().y),
    );
  expect(new Set(steps).size).toBe(1);
  await page.screenshot({
    path: testInfo.outputPath("report-create-desktop.png"),
    fullPage: true,
  });
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
  await page.screenshot({
    path: testInfo.outputPath("report-preview-desktop.png"),
    fullPage: true,
  });
  await expect(
    preview.getByRole("heading", { name: "管理摘要" }),
  ).toBeVisible();
  await expect(
    preview.getByRole("heading", { name: "CVE 软件评估" }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "报告预览", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "文件与交付", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.getByRole("tab", { name: "文件与交付", exact: true }).click();
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
  await page.getByRole("tab", { name: "编辑与复核", exact: true }).click();
  await page
    .getByLabel("修订报告专题", { exact: true })
    .selectOption("vulnerability");
  await page.getByLabel("修订管理摘要", { exact: true }).uncheck();
  await page.getByRole("button", { name: "保存为新草稿", exact: true }).click();
  await page.getByRole("tab", { name: "报告预览", exact: true }).click();
  await expect(
    preview.getByRole("heading", { name: "CVE 软件评估" }),
  ).toBeVisible();
  await expect(preview.getByRole("heading", { name: "管理摘要" })).toHaveCount(
    0,
  );
  await page.reload();
  await page.getByRole("button", { name: "← 生成与历史", exact: true }).click();
  await page
    .getByRole("button", { name: `查看报告 ${name}`, exact: true })
    .click();
  await expect(
    preview.getByRole("heading", { name: "执行与覆盖说明" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "创建报告", exact: true }).click();
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
  const { asset } = await reportHost(request, name);
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
  await page
    .getByLabel("新报告 PDF 明细模式", { exact: true })
    .selectOption("full");
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
  await page.getByRole("tab", { name: "文件与交付", exact: true }).click();
  const draftFiles = page
    .getByRole("region", { name: "报告文件与交付包" })
    .locator("article")
    .filter({ hasText: "草稿 · 未复核" });
  await expect(
    draftFiles.getByRole("button", { name: "下载 PDF", exact: true }),
  ).toBeEnabled({ timeout: 20000 });
  const fullDownload = page.waitForEvent("download");
  await draftFiles
    .getByRole("button", { name: "下载 PDF", exact: true })
    .click();
  await (await fullDownload).saveAs(testInfo.outputPath("full-report.pdf"));
  await page.getByRole("tab", { name: "编辑与复核", exact: true }).click();
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
  await page.getByRole("tab", { name: "文件与交付", exact: true }).click();
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
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("mobile-report.png"),
    fullPage: true,
  });
});

test("多主机覆盖检查可明确选择主机及共享镜像历史结果并比较报告", async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    base = "/api/customers/acme",
    name = `batch-history-${Date.now()}`;
  const a = await reportHost(request, `${name}-a`),
    b = await reportHost(request, `${name}-b`);
  const root = await (
    await request.post(`${base}/assessments`, {
      headers,
      data: {
        assetId: a.asset.id,
        snapshotId: a.snapshot.id,
        idempotencyKey: `root-${name}`,
      },
    })
  ).json();
  const image = await (
    await request.post(`${base}/containers`, {
      headers,
      data: { name: `${name}-image`, source: "fixture" },
    })
  ).json();
  const version = await (
    await request.post(`${base}/containers/${image.id}/sbom`, {
      headers,
      data: {
        fileName: "image.json",
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          fixtureMode: "findings",
          metadata: {
            component: {
              type: "container",
              name: `${name}-image`,
              version: "1",
            },
          },
          components: [
            {
              type: "library",
              name: "libssl3",
              version: "3.0.1",
              purl: "pkg:deb/debian/libssl3@3.0.1?distro=debian-12",
            },
          ],
        }),
      },
    })
  ).json();
  for (const host of [a, b])
    expect(
      (
        await request.post(`${base}/collections/links`, {
          headers,
          data: {
            assetId: host.asset.id,
            snapshotId: host.snapshot.id,
            kind: "container",
            objectId: image.id,
            versionId: version.id,
            basis: "explicit fixture deployment",
            imageId: `sha256:${"a".repeat(64)}`,
          },
        })
      ).ok(),
    ).toBe(true);
  const imageJob = await (
    await request.post(`${base}/assessments`, {
      headers,
      data: {
        containerId: image.id,
        versionId: version.id,
        idempotencyKey: `image-${name}`,
      },
    })
  ).json();
  for (const job of [root, imageJob])
    await expect
      .poll(
        async () =>
          (
            await (
              await request.get(`${base}/assessments/${job.id}`, { headers })
            ).json()
          ).status,
      )
      .toBe("succeeded");
  const baseline = await (
    await request.post(`${base}/report-center/tasks`, {
      headers,
      data: {
        name: `${name}-baseline`,
        scope: { kind: "selected", assetIds: [a.asset.id, b.asset.id] },
        mode: "existing",
        idempotencyKey: `baseline-${name}`,
      },
    })
  ).json();
  await page.goto("/#reports");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page
    .getByRole("button", { name: `${name}-baseline`, exact: true })
    .click();
  await page.getByRole("button", { name: "创建报告", exact: true }).click();
  await page.getByLabel("报告范围", { exact: true }).selectOption("multiple");
  await page
    .getByLabel("报告服务器（多选）", { exact: true })
    .selectOption([a.asset.id, b.asset.id]);
  await page.getByLabel("报告名称", { exact: true }).fill(name);
  for (let i = 0; i < 2; i++)
    await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page
    .getByLabel(`历史结果 ${a.asset.name}`, { exact: true })
    .selectOption(root.id);
  await page
    .getByLabel(`历史结果 ${image.name} ${version.id.slice(0, 8)}`, {
      exact: true,
    })
    .selectOption(imageJob.id);
  await expect(
    page.getByRole("button", { name: "下一步", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: "应用历史选择并重新检查", exact: true })
    .click();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page
    .getByLabel("历史比较基准", { exact: true })
    .selectOption(baseline.reportId);
  await page.getByLabel("关联当前查看的报告作为来源", { exact: true }).check();
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page
    .getByRole("button", { name: "使用已有结果生成报告", exact: true })
    .click();
  const preview = page.frameLocator('iframe[title="事实报告草稿"]');
  await expect(
    preview.getByRole("heading", { name: "历史对比", exact: true }),
  ).toBeVisible();
  await expect(preview.getByText(/发现实例 121/).first()).toBeVisible();
  await expect(preview.getByText(/涉及服务器 2/).first()).toBeVisible();
  await expect(preview.getByText(/确认受影响服务器 0/).first()).toBeVisible();
});

test("逐项重试只重放选中的失败服务器，保留成功与其他失败项", async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const name = `item-retry-${Date.now()}`,
    headers = { Authorization: "Bearer browser-test-secret-token" },
    base = "/api/customers/acme";
  const a = await reportHost(request, `${name}-a`),
    b = await reportHost(request, `${name}-b`, false),
    c = await reportHost(request, `${name}-c`, false);
  await page.goto("/#reports");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByLabel("报告范围", { exact: true }).selectOption("multiple");
  await page
    .getByLabel("报告服务器（多选）", { exact: true })
    .selectOption([a.asset.id, b.asset.id, c.asset.id]);
  await page.getByLabel("报告名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page.getByLabel("报告结果来源").selectOption("assess");
  for (let i = 0; i < 3; i++)
    await page.getByRole("button", { name: "下一步", exact: true }).click();
  await page
    .getByRole("button", { name: "提交扫描报告任务", exact: true })
    .click();
  let task: any;
  await expect
    .poll(async () => {
      const list = await (
        await request.get(`${base}/report-center/tasks`, { headers })
      ).json();
      task = list.items.find((item: { name: string }) => item.name === name);
      return task?.status;
    })
    .toBe("needs_attention");
  const firstId = task.items.find(
    (item: { objectId: string }) => item.objectId === a.asset.id,
  ).assessmentId;
  const article = page
    .getByRole("region", { name: "服务器报告任务" })
    .locator("article")
    .filter({ hasText: name });
  await article.getByText(/查看逐项进度/).click();
  const response = page.waitForResponse((response) =>
    response.url().endsWith(`/tasks/${task.id}/retry`),
  );
  await page
    .getByRole("button", { name: `重试此项 · ${b.asset.name}`, exact: true })
    .click();
  expect((await response).request().postDataJSON().itemIds).toEqual([
    task.items.find(
      (item: { objectId: string }) => item.objectId === b.asset.id,
    ).id,
  ]);
  await expect
    .poll(async () => {
      task = await (
        await request.get(`${base}/report-center/tasks/${task.id}`, { headers })
      ).json();
      return task.status;
    })
    .toBe("needs_attention");
  expect(
    task.items.find(
      (item: { objectId: string }) => item.objectId === a.asset.id,
    ).assessmentId,
  ).toBe(firstId);
  expect(
    task.items.find(
      (item: { objectId: string }) => item.objectId === b.asset.id,
    ).attempt,
  ).toBe(1);
  expect(
    task.items.find(
      (item: { objectId: string }) => item.objectId === c.asset.id,
    ).attempt,
  ).toBe(0);
  await article
    .getByRole("button", { name: "保留缺口生成报告", exact: true })
    .click();
});
