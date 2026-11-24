import { test, expect } from "@playwright/test";
test("configure lifecycle dates, preview rules, process risk and drill down from dashboard", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const headers = { Authorization: "Bearer browser-test-secret-token" };
  const base = "http://127.0.0.1:3101/api/customers/acme";
  const reset = await request.put(`${base}/lifecycle-risk/config`, {
    headers,
    data: {
      timeZone: "Asia/Shanghai",
      defaultRule: { enabled: true, reminderMonths: 12, warningMonths: 6 },
      overrides: [],
      serviceYears: { server: null, network: null, unknown: null },
    },
  });
  expect(reset.ok()).toBe(true);
  const name = `risk-e2e-${Date.now()}`;
  const asset = await (
    await request.post(`${base}/assets`, {
      headers,
      data: { name, kind: "host", attributes: {} },
    })
  ).json();
  await request.patch(`${base}/assets/${asset.id}/classification`, {
    headers,
    data: { hardwareType: "server" },
  });
  const batch = await (
    await request.post(`${base}/lifecycle/batches`, {
      headers,
      data: {
        fileName: `${name}.csv`,
        content: `source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nFixture,${name},Example OS,1,Sales,2099-01-01,Support,2020-01-01\nFixture,${name},Example Model,1,Sales,2099-01-01,Hardware support,2020-01-01`,
      },
    })
  ).json();
  await page.goto("/#assets");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  const row = page.getByRole("row").filter({ hasText: name });
  await row.getByRole("button", { name: "生命周期资料", exact: true }).click();
  await page.getByLabel("购买日期", { exact: true }).fill("2010-01-01");
  await page.getByLabel("维保到期日期", { exact: true }).fill("2020-01-01");
  await page.getByLabel("日期依据", { exact: true }).fill("合同-test");
  await page.getByLabel("OS 来源批次").selectOption(batch.id);
  await page.getByLabel("OS 产品").fill("Example OS");
  await page.getByLabel("OS 版本").fill("1");
  await page.getByLabel("OS 阶段").selectOption("eol");
  await page.getByLabel("设备 来源批次").selectOption(batch.id);
  await page.getByLabel("设备 产品").fill("Example Model");
  await page.getByLabel("设备 版本").fill("1");
  await page.getByLabel("设备 阶段").selectOption("eol");
  await page.getByRole("button", { name: "保存资产生命周期资料" }).click();
  await expect(page.getByRole("status")).toContainText("生命周期资料已保存");
  await page.locator("nav button").filter({ hasText: "生命周期风险" }).click();
  await page.getByRole("tab", { name: "规则配置" }).click();
  await page.getByLabel("服务器使用年限").fill("5");
  await page.getByRole("button", { name: "预览影响" }).click();
  await expect(
    page.getByRole("heading", { name: "变更影响预览" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认保存规则" }).click();
  await expect(page.getByRole("status")).toContainText("规则已保存");
  await page.getByRole("tab", { name: "风险明细" }).click();
  await page.getByLabel("搜索资产").fill(name);
  const osRow = page
    .getByRole("row")
    .filter({ hasText: name })
    .filter({ hasText: "OS 停止支持" });
  await expect(osRow).toContainText("致命");
  await osRow.getByRole("button", { name: "查看详情" }).click();
  await expect(page.getByRole("dialog")).toContainText("Support");
  await page.getByLabel("负责人", { exact: true }).fill("张三");
  await page.getByLabel("处理状态", { exact: true }).selectOption("accepted");
  await page.getByLabel("处理备注").fill("等待维护窗口");
  await page.getByLabel("接受有效期").fill("2099-01-01");
  await page.getByRole("button", { name: "保存处理" }).click();
  await expect(page.getByRole("status")).toContainText("处理记录已保存");
  await expect(page.getByRole("dialog")).toContainText("已接受风险");
  await page.getByRole("button", { name: "关闭详情" }).click();
  await page.locator("nav button").filter({ hasText: "客户风险概览" }).click();
  await expect(
    page.getByRole("region", { name: "生命周期风险概要" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /致命生命周期风险/ }).click();
  await expect(
    page.getByRole("heading", { name: "生命周期风险", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("风险等级")).toHaveValue("critical");
  await page.getByLabel("搜索资产").fill(name);
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(4);
  await page.screenshot({
    path: ".data/lifecycle-risk-e2e.png",
    fullPage: true,
  });
  await page.reload();
  await page.getByLabel("搜索资产").fill(name);
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(4);
  await page.getByRole("button", { name: "更新当前风险" }).click();
  await page.getByRole("tab", { name: "规则配置" }).click();
  await page.getByRole("button", { name: "添加覆盖规则" }).click();
  await page.getByLabel("覆盖风险类型").selectOption("warranty");
  await page.getByLabel("覆盖设备类别").selectOption("server");
  await page.getByLabel("规则1启用").uncheck();
  await page.getByRole("button", { name: "预览影响" }).click();
  await expect(
    page.getByRole("heading", { name: "变更影响预览" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "确认保存规则" }).click();
  await expect(page.getByRole("status")).toContainText("规则已保存");
  await page.getByRole("tab", { name: "风险明细" }).click();
  await page.getByLabel("风险等级").selectOption("unassessed");
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(1);
  await expect(page.getByRole("row").filter({ hasText: name })).toContainText(
    "维保到期",
  );
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
  expect(errors).toEqual([]);
});
