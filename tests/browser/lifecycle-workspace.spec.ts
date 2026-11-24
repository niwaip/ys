import { test, expect } from "@playwright/test";
test("生命周期工作台按设备筛选，专属日期确认保存与共同CSV引用分别处理", async ({
  page,
  request,
}) => {
  const auth = { Authorization: "Bearer browser-test-secret-token" },
    name = `lifecycle-workspace-${Date.now()}`;
  const asset = await (
    await request.post("/api/customers/acme/assets", {
      headers: auth,
      data: {
        name,
        kind: "host",
        attributes: {
          product: name,
          version: "1",
          osProduct: name + "OS",
          osVersion: "1",
        },
      },
    })
  ).json();
  await request.patch(`/api/customers/acme/assets/${asset.id}/classification`, {
    headers: auth,
    data: { hardwareType: "network" },
  });
  await page.goto("/#lifecycle-materials");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "生命周期资料" }).click();
  await page.getByLabel("设备类型", { exact: true }).selectOption("network");
  await page.getByLabel("填写状态", { exact: true }).selectOption("empty");
  await page.getByLabel("搜索设备", { exact: true }).fill(name);
  let row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "填写设备期限", exact: true }).click();
  await page.getByLabel("购买日期", { exact: true }).fill("2020-01-02");
  await page.getByLabel("日期依据", { exact: true }).fill("合同 workspace");
  await page
    .getByRole("button", { name: "保存资产生命周期资料", exact: true })
    .click();
  await expect(
    page.getByText("生命周期资料已保存", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭资料", exact: true }).click();
  await expect(row).toHaveCount(0);
  await page.getByLabel("填写状态", { exact: true }).selectOption("partial");
  await expect(row).toContainText("2020-01-02");
  await row.getByRole("button", { name: "填写设备期限" }).click();
  await page.getByLabel("维保到期日期", { exact: true }).fill("2020-01-02");
  await page
    .getByRole("button", { name: "保存资产生命周期资料", exact: true })
    .click();
  await expect(
    page.getByText("生命周期资料已保存", { exact: true }),
  ).toBeVisible();
  await page.getByText("资料变更历史", { exact: true }).click();
  await expect(page.getByText("查看修改前后", { exact: true })).toHaveCount(2);
  await page.getByRole("button", { name: "关闭资料" }).click();
  await page
    .getByRole("tab", { name: "厂商共同资料 · CSV", exact: true })
    .click();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载 CSV 模板" }).click();
  expect((await downloading).suggestedFilename()).toBe(
    "ys-lifecycle-template.csv",
  );
  await page.getByLabel("生命周期 CSV 文件").setInputFiles({
    name: "vendor.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(
      `source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate,category,phase\nVendor,Doc,${name},1,Sales,2020-01-01,Support,2030-01-01,device,eol\nVendor,OSDoc,${name}OS,1,Sales,2020-01-01,Support,2030-01-01,os,eol`,
    ),
  });
  await page.getByRole("button", { name: "导入生命周期批次" }).click();
  await expect(
    page.getByRole("heading", { name: "批次证据：vendor.csv", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "设备专属期限", exact: true }).click();
  await page.getByRole("button", { name: "刷新资料", exact: true }).click();
  await page.getByLabel("填写状态", { exact: true }).selectOption("complete");
  await expect(row).toContainText("2030-01-01");
  await expect(row).toContainText("维保风险：致命");
  await page.reload();
  await page.getByLabel("搜索设备", { exact: true }).fill(name);
  await expect(row).toContainText("2020-01-02");
  await page.screenshot({
    path: "output/deployment/lifecycle-workspace-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: "output/deployment/lifecycle-workspace-mobile.png",
    fullPage: true,
  });
});

test("Ubuntu虚拟机关联共同资料、显式别名及扩展权益；来源冲突与物理服务器入口可核对", async ({
  page,
  request,
}) => {
  const auth = { Authorization: "Bearer browser-test-secret-token" },
    stamp = Date.now(),
    product = `Ubuntu-${stamp}`,
    raw = `ubuntu-${stamp}`,
    vmName = `POC-ECS-${stamp}`;
  async function asset(name: string, attributes: Record<string, unknown>) {
    const response = await request.post("/api/customers/acme/assets", {
      headers: auth,
      data: { name, kind: "host", attributes },
    });
    expect(response.ok()).toBeTruthy();
    return response.json();
  }
  const vm = await asset(vmName, {
    netbox: { objectType: "virtual-machine" },
    platform: null,
  });
  const conflict = await asset(`conflict-${stamp}`, {
    netbox: { objectType: "virtual-machine" },
    platform: { name: "Debian" },
  });
  for (const target of [vm, conflict]) {
    const response = await request.post(
      "/api/customers/acme/collections/upload",
      {
        headers: auth,
        data: {
          assetId: target.id,
          fileName: "ubuntu.json",
          content: JSON.stringify({
            schemaVersion: "ys-host/1",
            identity: {
              hostname: target.name,
              serial: null,
              machineId: target.id,
            },
            collectedAt: "2026-11-24T00:00:00Z",
            sections: {
              os: {
                status: "acquired",
                data: {
                  id: raw,
                  version: "26.04",
                  kernel: "7",
                  architecture: "x86_64",
                },
              },
            },
            extensions: {},
          }),
        },
      },
    );
    expect(response.ok()).toBeTruthy();
    const snapshot = await response.json();
    expect(
      (
        await request.post(
          `/api/customers/acme/assets/${target.id}/baseline/confirm`,
          {
            headers: auth,
            data: {
              snapshotId: snapshot.id,
              expectedBaselineId: null,
              idempotencyKey: target.id,
              sections: ["os"],
              writeMasterData: false,
            },
          },
        )
      ).ok(),
    ).toBeTruthy();
  }
  const physical = await asset(`physical-${stamp}`, {
    product: "Physical model",
    version: "1",
  });
  await request.patch(
    `/api/customers/acme/assets/${physical.id}/classification`,
    { headers: auth, data: { hardwareType: "server" } },
  );
  const response = await request.post("/api/customers/acme/lifecycle/batches", {
    headers: auth,
    data: {
      fileName: `ubuntu-${stamp}.csv`,
      content: `source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate,category,phase,supportTier\nUbuntu,standard-doc,${product},26.04,Sales,,标准支持,2020-01-01,os,eol,standard\nUbuntu,extended-doc,${product},26.04,Sales,,扩展支持,2040-01-01,os,eol,extended`,
    },
  });
  expect(response.ok()).toBeTruthy();
  const batch = await response.json();
  await page.goto("/#lifecycle-materials");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "生命周期资料" }).click();
  await page.getByLabel("搜索设备", { exact: true }).fill(vmName);
  const row = page.getByRole("row").filter({ hasText: vmName });
  await expect(row).toContainText(`${raw} 26.04`);
  await expect(row).toContainText("不适用");
  await expect(row).toContainText("期限未知");
  await row.getByRole("button", { name: "关联OS厂商资料" }).click();
  await expect(page.getByLabel("购买日期", { exact: true })).toHaveCount(0);
  await page.getByText(`配置产品别名 · ${raw}`, { exact: true }).click();
  await page.getByLabel("厂商标准产品名", { exact: true }).fill(product);
  await page.getByLabel("映射依据", { exact: true }).fill("厂商名称核实");
  await page.getByRole("button", { name: "保存产品别名", exact: true }).click();
  await expect(
    page.getByText("产品别名已保存，请刷新核对引用结果", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭资料", exact: true }).click();
  await expect(row).toContainText("2020-01-01");
  await expect(row).toContainText("致命");
  await row.getByRole("button", { name: "关联OS厂商资料" }).click();
  await page.getByLabel("OS 来源批次", { exact: true }).selectOption(batch.id);
  await page
    .getByLabel("OS 支持类型", { exact: true })
    .selectOption("extended");
  await page
    .getByLabel("OS 扩展支持适用依据", { exact: true })
    .fill("订阅凭证 SUB-BROWSER");
  await page
    .getByRole("button", { name: "保存资产生命周期资料", exact: true })
    .click();
  await expect(
    page.getByText("生命周期资料已保存", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭资料", exact: true }).click();
  await expect(row).toContainText("2040-01-01");
  await expect(row).toContainText("标准支持截止：2020-01-01");
  await expect(row).toContainText("正常");
  await page.reload();
  await page.getByLabel("搜索设备", { exact: true }).fill(vmName);
  await expect(row).toContainText("2040-01-01");
  await page.screenshot({
    path: "output/deployment/lifecycle-applicability-desktop.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .locator(".lifecycle-workspace")
    .screenshot({
      path: "output/deployment/lifecycle-applicability-mobile.png",
    });
  await page.getByLabel("搜索设备", { exact: true }).fill(`conflict-${stamp}`);
  const conflictRow = page
    .getByRole("row")
    .filter({ hasText: `conflict-${stamp}` });
  await expect(conflictRow).toContainText("资料冲突");
  await expect(conflictRow).toContainText("Debian");
  await page.getByLabel("搜索设备", { exact: true }).fill(`physical-${stamp}`);
  await page
    .getByRole("row")
    .filter({ hasText: `physical-${stamp}` })
    .getByRole("button", { name: "填写设备期限" })
    .click();
  await expect(page.getByLabel("购买日期", { exact: true })).toBeVisible();
  await expect(page.getByLabel("维保到期日期", { exact: true })).toBeVisible();
});
