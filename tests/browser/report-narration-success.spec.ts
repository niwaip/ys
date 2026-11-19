import { test, expect } from "@playwright/test";
test("fixed local Pi fixture creates an AI draft that still requires internal review", async ({
  page,
  request,
}) => {
  test.skip(
    process.env.YS_REPORT_BROWSER_FIXTURE !== "1",
    "runs only with isolated local Pi fixture",
  );
  const base = `${process.env.YS_BROWSER_API}/api/customers/acme`,
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
        data: { name: `AI-success-${unique}`, kind: "host" },
      })
    ).json(),
    batch = await (
      await request.post(`${base}/lifecycle/batches`, {
        headers,
        data: {
          fileName: "ai-success.csv",
          content: `source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nFixture,success-${unique},Widget,1,Sales,,Support,`,
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
  await page.getByRole("button", { name: "风险事实报告" }).click();
  await page.getByRole("button", { name: report.id, exact: true }).click();
  await page.getByRole("button", { name: "生成 AI 受控叙述" }).click();
  await expect(
    page.getByRole("button", { name: "打开 AI 草稿" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "打开 AI 草稿" }).click();
  await expect(
    page.getByRole("button", { name: "修订 2 · draft" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "下载正式 HTML" }),
  ).toBeDisabled();
  const current = await (
    await request.get(`${base}/reports/${report.id}`, { headers })
  ).json();
  expect(current.revision.factHash).toBe(report.revision.factHash);
  expect(current.revision.facts).toEqual(report.revision.facts);
});
