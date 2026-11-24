import { test, expect } from "@playwright/test";
test("controlled revision review and formal HTML delivery, then edits return to draft", async ({
  page,
  request,
}) => {
  const root = process.env.YS_BROWSER_API ?? "http://127.0.0.1:3101",
    base = `${root}/api/customers/acme`,
    headers = { Authorization: "Bearer browser-test-secret-token" },
    unique = Date.now();
  await expect
    .poll(async () => {
      try {
        return (await request.get(`${base}/assets`, { headers })).status();
      } catch {
        return 0;
      }
    })
    .toBe(200);
  const asset = await (
    await request.post(`${base}/assets`, {
      headers,
      data: {
        name: `Review-${unique}`,
        kind: "host",
        attributes: { product: "Widget", version: "1" },
      },
    })
  ).json();
  const batch = await (
    await request.post(`${base}/lifecycle/batches`, {
      headers,
      data: {
        fileName: "review.csv",
        content: `source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nFixture,review-${unique},Widget,1,Sales,2020-01-01,Support,`,
      },
    })
  ).json();
  const assessment = await (
    await request.post(`${base}/lifecycle/assessments`, {
      headers,
      data: { batchId: batch.id, assetIds: [asset.id] },
    })
  ).json();
  const report = await (
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
  const summaryResponse = page.waitForResponse((r) =>
    r.url().endsWith(`/reports/${report.id}/revisions?view=summary`),
  );
  await page.getByRole("button", { name: report.id, exact: true }).click();
  const revisionSummaries = (await (await summaryResponse).json()).items;
  expect(revisionSummaries).toHaveLength(1);
  expect(revisionSummaries[0]).not.toHaveProperty("facts");

  await page.getByRole("tab", { name: "编辑与复核", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "下载正式 HTML" }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "复核通过" })).toBeDisabled();
  await page.getByText("文字编辑语法与本报告引用目录", { exact: true }).click();
  await expect(page.getByText(/这里只接受列出的有限句法/)).toBeVisible();
  await page.getByText("编辑受控叙述与章节顺序", { exact: true }).click();
  await page.getByLabel(/scope.*叙述文字/).fill("已修复，无风险。");
  await page.getByRole("button", { name: "保存为新草稿" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "叙述只接受目录中的引用说明句和建议句",
  );
  await page
    .getByLabel(/scope.*叙述文字/)
    .fill(
      "围绕【scope】，本段说明所选输入。因此，建议核对输入身份，以便明确后续核查范围。",
    );
  await page.getByLabel("版面密度").selectOption("compact");
  await page.getByRole("button", { name: "保存为新草稿" }).click();
  await expect(
    page.getByRole("button", { name: "修订 2 · draft" }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "报告预览", exact: true }).click();
  await expect(
    page
      .frameLocator('iframe[title="事实报告草稿"]')
      .getByText(/建议核对输入身份，以便明确后续核查范围/),
  ).toBeVisible();
  await page.getByRole("tab", { name: "编辑与复核", exact: true }).click();
  await page.getByRole("button", { name: "提交复核", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "复核通过", exact: true }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "复核通过", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "正式交付该修订" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "正式交付该修订" }).click();
  await page.getByRole("tab", { name: "报告预览", exact: true }).click();
  await expect(
    page
      .frameLocator('iframe[title="事实报告草稿"]')
      .getByText("正式交付 · 已内部复核", { exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: "编辑与复核", exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "下载正式 HTML" }).click(),
  ]);
  expect(download.suggestedFilename()).toContain("-r2.html");
  await page.getByRole("button", { name: "保存为新草稿" }).click();
  await expect(
    page.getByRole("button", { name: "修订 3 · draft" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "下载正式 HTML" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "修订 2 · delivered" }).click();
  await expect(
    page.getByRole("button", { name: "下载正式 HTML" }),
  ).toBeEnabled();
});
