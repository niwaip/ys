import { test, expect } from "@playwright/test";
test("AI task progress and unavailable fallback preserve report draft and reload history", async ({
  page,
  request,
}) => {
  const root = process.env.YS_BROWSER_API ?? "http://127.0.0.1:3101",
    base = `${root}/api/customers/acme`,
    headers = { Authorization: "Bearer browser-test-secret-token" },
    unique = Date.now();
  await expect
    .poll(
      async () => {
        try {
          return (await request.get(`${base}/assets`, { headers })).status();
        } catch {
          return 0;
        }
      },
      { timeout: 20000 },
    )
    .toBe(200);
  const asset = await (
      await request.post(`${base}/assets`, {
        headers,
        data: {
          name: `AI-input-${unique}`,
          kind: "host",
          attributes: { product: "Widget" },
        },
      })
    ).json(),
    batch = await (
      await request.post(`${base}/lifecycle/batches`, {
        headers,
        data: {
          fileName: "ai.csv",
          content: `source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nFixture,ai-${unique},Widget,1,Sales,,Support,`,
        },
      })
    ).json(),
    assessment = await (
      await request.post(`${base}/lifecycle/assessments`, {
        headers,
        data: { batchId: batch.id, assetIds: [asset.id] },
      })
    ).json(),
    report = await (
      await request.post(`${base}/reports`, {
        headers,
        data: { lifecycleRefs: [assessment.id] },
      })
    ).json();
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  await page.getByRole("button", { name: "报告中心" }).click();
  await page.getByRole("button", { name: report.id, exact: true }).click();
  await page.getByRole("tab", { name: "编辑与复核", exact: true }).click();
  await page.getByRole("button", { name: "生成 AI 受控叙述" }).click();
  await page.getByRole("tab", { name: "编辑与复核", exact: true }).click();
  await expect(page.getByText(/AI叙述失败，固定事实草稿保留/)).toBeVisible();
  await expect(
    page.getByRole("button", { name: "修订 1 · draft" }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "报告中心" }).click();
  await page.getByRole("tab", { name: "编辑与复核", exact: true }).click();
  await expect(page.getByText(/AI叙述失败，固定事实草稿保留/)).toBeVisible();
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByRole("heading", { name: "AI 受控叙述" })).toHaveCount(
    0,
  );
});
