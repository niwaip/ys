import { test, expect } from "@playwright/test";
test("Dashboard首屏、四组导航、资产删除恢复与明确评估入口", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(
    page.getByRole("heading", { name: "客户风险概览", exact: true }),
  ).toBeVisible();
  for (const group of ["总览", "资产管理", "CVE与EOSL评估", "风险与报告"])
    await expect(
      page.locator("nav").getByText(group, { exact: true }),
    ).toBeVisible();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  await page.getByRole("button", { name: "＋ 新建资产" }).click();
  const name = `delete-browser-${Date.now()}`;
  await page.getByLabel("资产名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "保存资产", exact: true }).click();
  let row = page.getByRole("row").filter({ hasText: name });
  await row.getByLabel("硬件类型").selectOption("network");
  await expect(row.getByLabel("硬件类型")).toHaveValue("network");
  await page.locator("nav button").filter({ hasText: "客户风险概览" }).click();
  await page.getByRole("button", { name: /^网络设备 / }).click();
  await expect(
    page.getByText("硬件分类：网络设备", { exact: true }),
  ).toBeVisible();
  const findingsResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/dashboard/findings") &&
      r.request().postDataJSON().hardwareType === "network",
  );
  await page.getByRole("button", { name: "下钻观测实例", exact: true }).click();
  expect((await findingsResponse).ok()).toBe(true);
  await expect(
    page.getByRole("heading", {
      name: "固定范围观测明细 · 总计 0",
      exact: true,
    }),
  ).toBeVisible();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  row = page.getByRole("row").filter({ hasText: name });
  await row.getByRole("button", { name: "CVE评估", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Linux系统包CVE扫描", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: `当前资产：${name}`, exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("评估资产范围")).toHaveCount(0);
  await page.getByRole("tab", { name: "本资产关联镜像", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `资产评估 · ${name}`, exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "切换到全部对象", exact: true })
    .click();
  await expect(page.getByLabel("评估资产范围")).toBeVisible();
  const assetValue = await page
    .getByLabel("评估资产范围")
    .locator("option")
    .filter({ hasText: name })
    .getAttribute("value");
  await page.getByLabel("评估资产范围").selectOption(assetValue!);
  await expect(
    page.getByRole("heading", { name: `当前资产：${name}`, exact: true }),
  ).toBeVisible();
  await page.getByLabel("评估资产范围").selectOption("");
  await page.getByRole("tab", { name: "软件漏洞评估", exact: true }).click();
  await expect(page.getByLabel("软件对象")).toBeVisible();
  await page.getByRole("tab", { name: "镜像漏洞评估", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "容器镜像", exact: true }),
  ).toBeVisible();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  row = page.getByRole("row").filter({ hasText: name });
  await row.getByRole("button", { name: "EOSL评估", exact: true }).click();
  await expect(
    page.getByText(`本次仅评估台账选中的资产：${name}`, { exact: true }),
  ).toBeVisible();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  row = page.getByRole("row").filter({ hasText: name });
  await row.getByRole("button", { name: "删除", exact: true }).click();
  const d = page.getByRole("dialog", { name: "删除资产" });
  await expect(d).toContainText("保留");
  await d.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: name })).toHaveCount(0);
  await page.getByRole("button", { name: "已删除资产", exact: true }).click();
  row = page.getByRole("row").filter({ hasText: name });
  await row.getByRole("button", { name: "恢复", exact: true }).click();
  await page.getByRole("button", { name: "在管资产", exact: true }).click();
  await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
});
