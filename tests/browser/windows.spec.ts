import { test, expect } from "@playwright/test";
test("Windows脚本上传在统一配置中预览，确认后用于评估并保留历史与客户隔离", async ({
  page,
  request,
}) => {
  const name = `windows-${Date.now()}`;
  const headers = { Authorization: "Bearer browser-test-secret-token" };
  const asset = await (
    await request.post("/api/customers/acme/assets", {
      headers,
      data: { name, kind: "host", attributes: { serial: name } },
    })
  ).json();
  await page.goto("/#collections");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByLabel("目标资产", { exact: true }).selectOption(asset.id);
  await page.getByLabel("设备资料类型").selectOption("server");
  await page.getByLabel("目标平台").selectOption("windows");
  await page.getByRole("button", { name: "配置基础资料", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "开始基础采集 →", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: "离线脚本", exact: true }).click();
  const downloadPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载基础采集脚本", exact: true })
    .click();
  expect((await downloadPromise).suggestedFilename()).toBe("ys-windows.ps1");
  await page.getByRole("tab", { name: "上传脚本结果", exact: true }).click();
  await page.getByLabel("我已确认资料属于所选主机").check();
  await page.getByLabel("采集JSON文件").setInputFiles({
    name: name + ".json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        Hostname: name,
        SerialNumber: name,
        OS: "Windows Server 2022",
        OSBuild: "20348",
        InstalledSoftware: [{ Name: "Example", Version: "" }],
        CollectionStatus: { Overall: "PARTIAL" },
        KBInventoryComplete: false,
      }),
    ),
  });
  await page.getByRole("button", { name: "保存基础快照", exact: true }).click();
  const result = page.getByRole("region", { name: "采集结果", exact: true });
  await expect(result.getByText("待确认采纳", { exact: true })).toBeVisible();
  await result.getByText("Windows软件与补丁资料", { exact: true }).click();
  await expect(
    result.getByRole("row").filter({ hasText: "Example" }),
  ).toContainText("未知");
  await expect(result.getByText(/补丁清单：部分/)).toBeVisible();
  await result.getByRole("tab", { name: "操作系统", exact: true }).click();
  await expect(
    result.getByText("Windows Server 2022", { exact: true }),
  ).toBeVisible();
  await result
    .getByRole("button", { name: "确认选中资料并更新基线", exact: true })
    .click();
  await expect(result.getByText("已采纳", { exact: true })).toBeVisible();
  const materials = await (
    await request.get(
      `/api/customers/acme/windows/imports?assetId=${asset.id}`,
      { headers },
    )
  ).json();
  expect(materials.items[0]).toMatchObject({
    assetId: asset.id,
    snapshot: { kbInventoryComplete: false, software: [{ version: null }] },
  });
  await page.reload();
  await page
    .getByRole("row")
    .filter({ hasText: name })
    .getByRole("button", { name: "查看资料 →" })
    .click();
  await expect(result.getByText("已采纳", { exact: true })).toBeVisible();
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
});
