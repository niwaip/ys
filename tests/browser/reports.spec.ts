import { test, expect } from "@playwright/test";
test("select lifecycle facts, preview protected draft, inspect evidence and switch customer", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    base = "http://127.0.0.1:3101/api/customers/acme";
  await expect
    .poll(async () => {
      try {
        return (await request.get(`${base}/assets`, { headers })).status();
      } catch {
        return 0;
      }
    })
    .toBe(200);
  const unique = Date.now();
  const asset = await (
    await request.post(`${base}/assets`, {
      headers,
      data: {
        name: `Report-host-${unique}`,
        kind: "host",
        attributes: { product: "Widget", version: "1" },
      },
    })
  ).json();
  const batch = await (
    await request.post(`${base}/lifecycle/batches`, {
      headers,
      data: {
        fileName: "report-fixture.csv",
        content: `source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nFixture,report-${unique},Widget,1,Sales,2020-01-01,Support,`,
      },
    })
  ).json();
  const assessment = await (
    await request.post(`${base}/lifecycle/assessments`, {
      headers,
      data: { batchId: batch.id, assetIds: [asset.id] },
    })
  ).json();
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  await page.getByRole("button", { name: "报告中心" }).click();
  await page
    .getByText("旧版评估引用入口（兼容历史使用方式）", { exact: true })
    .click();
  await page.getByLabel(new RegExp(assessment.id)).check();
  await page.getByRole("button", { name: "生成事实草稿" }).click();
  await expect(
    page.getByRole("heading", { name: "事实草稿预览" }),
  ).toBeVisible();
  const preview = page.frameLocator('iframe[title="事实报告草稿"]');
  await expect(
    preview.getByText("草稿 · 尚未内部复核，不代表正式交付"),
  ).toBeVisible();
  await expect(
    preview.getByText(/未选择CVE评估，未评估/).first(),
  ).toBeVisible();
  await page.getByRole("tab", { name: "来源依据", exact: true }).click();
  await page
    .getByRole("button", { name: `lifecycle 依据 ${assessment.id}` })
    .click();
  await expect(page.getByText("原始评估依据", { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "报告中心" }).click();
  await page.getByRole("button", { name: "← 生成与历史", exact: true }).click();
  await expect(page.getByRole("heading", { name: "报告历史" })).toBeVisible();
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByLabel(new RegExp(assessment.id))).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "事实草稿预览" })).toHaveCount(
    0,
  );
});
