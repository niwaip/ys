import { test, expect } from "@playwright/test";
async function login(page: import("@playwright/test").Page) {
  await page.goto("/#collections");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
}
test("NetBox网络设备自动选表单、采纳不回写主数据，角色映射可保存", async ({
  page,
  request,
}) => {
  await login(page);
  await expect(page.getByLabel("设备资料类型")).toHaveValue("network");
  await page.getByRole("tab", { name: "手动输入", exact: true }).click();
  await page.getByLabel("来源说明", { exact: true }).fill("设备控制台");
  await page.getByLabel("系统 / 固件版本", { exact: true }).fill("17.12.4");
  await page.getByRole("button", { name: "保存基础快照", exact: true }).click();
  const result = page.getByRole("region", { name: "采集结果", exact: true });
  await result
    .getByRole("button", { name: "确认选中资料并更新基线", exact: true })
    .click();
  await expect(result.getByText("已采纳", { exact: true })).toBeVisible();
  expect(
    (await (await request.get("http://127.0.0.1:3228/fixture/state")).json())
      .patches,
  ).toBe(0);
  await page.getByLabel("设备资料类型").selectOption("storage");
  await page.getByRole("button", { name: "将此表单用于同角色设备" }).click();
  await expect(page.getByText("已保存该NetBox角色的表单映射")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("设备资料类型")).toHaveValue("storage");
});
test("新增Device与VM后自动选中，NetBox目录403与创建失败明确可见", async ({
  page,
  request,
}) => {
  await login(page);
  for (const type of ["device", "virtual-machine"]) {
    await page
      .getByRole("button", { name: "＋ 新增资产", exact: true })
      .click();
    const d = page.getByRole("dialog", { name: "新增采集资产" });
    const name = `new-${type}-${Date.now()}`;
    await d.getByLabel("资产名称", { exact: true }).fill(name);
    await d.getByLabel("对象类型").selectOption(type);
    if (type === "device") {
      await d.getByLabel("设备型号", { exact: true }).selectOption("20");
      await d.getByLabel("设备角色", { exact: true }).selectOption("10");
    }
    await d.getByLabel("站点", { exact: true }).selectOption("50");
    await d.getByRole("button", { name: "保存并选择资产" }).click();
    await expect(d).not.toBeVisible();
    await expect(
      page.getByLabel("目标资产", { exact: true }).locator("option:checked"),
    ).toHaveText(name);
    if (type === "virtual-machine") {
      await expect(page.getByLabel("设备资料类型")).toHaveValue("vm");
      await expect(page.getByLabel("设备资料类型")).toBeDisabled();
      const targetId = await page
        .getByLabel("目标资产", { exact: true })
        .inputValue();
      await page
        .getByRole("tab", { name: "自动／脚本采集", exact: true })
        .click();
      await page.getByLabel("目标平台").selectOption("windows");
      await page.getByLabel("我已确认资料属于所选主机").check();
      await page.getByLabel("采集JSON文件").setInputFiles({
        name: "vm-windows.json",
        mimeType: "application/json",
        buffer: Buffer.from(
          JSON.stringify({
            Hostname: name,
            TargetAssetId: targetId,
            SerialNumber: null,
            CollectorVersion: "1",
            OS: "Windows Server 2022",
            OSBuild: "20348",
          }),
        ),
      });
      await page
        .getByRole("button", { name: "保存基础快照", exact: true })
        .click();
      const result = page.getByRole("region", {
        name: "采集结果",
        exact: true,
      });
      await result
        .getByRole("button", { name: "确认选中资料并更新基线", exact: true })
        .click();
      await expect(result.getByText("已采纳", { exact: true })).toBeVisible();
    }
  }
  await request.get("http://127.0.0.1:3228/fixture/state?deny=1");
  await page.getByRole("button", { name: "＋ 新增资产", exact: true }).click();
  const d = page.getByRole("dialog", { name: "新增采集资产" });
  await expect(d.getByRole("alert")).toContainText("403");
  await expect(
    d.getByRole("button", { name: "保存并选择资产" }),
  ).toBeDisabled();
  await d.getByRole("button", { name: "关闭", exact: true }).click();
  await request.get("http://127.0.0.1:3228/fixture/state");
  await page.getByRole("button", { name: "＋ 新增资产", exact: true }).click();
  const f = page.getByRole("dialog", { name: "新增采集资产" });
  await f.getByLabel("资产名称", { exact: true }).fill("fail-create");
  await f.getByLabel("设备型号", { exact: true }).selectOption("20");
  await f.getByLabel("设备角色", { exact: true }).selectOption("10");
  await f.getByLabel("站点", { exact: true }).selectOption("50");
  await f.getByRole("button", { name: "保存并选择资产" }).click();
  await expect(f.getByRole("alert")).toContainText("未获确认");
  const before = (
    await (await request.get("http://127.0.0.1:3228/fixture/state")).json()
  ).posts;
  await f.getByRole("button", { name: "保存并选择资产" }).click();
  await expect(f.getByRole("alert")).toContainText("不自动重试");
  expect(
    (await (await request.get("http://127.0.0.1:3228/fixture/state")).json())
      .posts,
  ).toBe(before);
});

test("资产分页保留所选VM身份、目标选项及资料类型锁定", async ({
  page,
  request,
}) => {
  test.setTimeout(60000);
  const headers = { Authorization: "Bearer browser-test-secret-token" };
  for (let i = 0; i < 101; i++) {
    const created = await request.post("/api/customers/acme/netbox/assets", {
      headers,
      data: {
        idempotencyKey: `page-${i}`,
        objectType: "device",
        name: `page-${i}`,
        deviceType: 20,
        role: 10,
        site: 50,
      },
    });
    expect(created.ok()).toBe(true);
  }
  const vm = await (
    await request.post("/api/customers/acme/netbox/assets", {
      headers,
      data: {
        idempotencyKey: "paged-vm",
        objectType: "virtual-machine",
        name: "保留目标的VM",
        site: 50,
      },
    })
  ).json();
  await login(page);
  await page.getByLabel("目标资产", { exact: true }).selectOption(vm.assetId);
  await expect(page.getByLabel("设备资料类型")).toHaveValue("vm");
  await page.getByText(/更多主机 · 当前第/).click();
  await page.getByRole("button", { name: "下一批主机", exact: true }).click();
  await expect(page.getByText(/更多主机 · 当前第 2 批/)).toBeVisible();
  await expect(
    page
      .getByLabel("目标资产", { exact: true })
      .locator("option")
      .filter({ hasText: /^page-0$/ }),
  ).toHaveCount(1);
  await expect(page.getByLabel("设备资料类型")).toBeDisabled();
  await expect(
    page.getByLabel("目标资产", { exact: true }).locator("option:checked"),
  ).toHaveText("保留目标的VM");
  await page.reload();
  await expect(page.getByLabel("设备资料类型")).toHaveValue("vm");
});
