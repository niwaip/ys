import { test, expect } from "@playwright/test";

test("按服务器生成报告并在刷新后打开固定覆盖草稿", async ({
  page,
  request,
}) => {
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
  await page.getByLabel("报告专题", { exact: true }).selectOption("lifecycle");
  await page
    .getByRole("button", { name: "使用已有结果生成报告", exact: true })
    .click();
  const preview = page.frameLocator('iframe[title="事实报告草稿"]');
  await expect(
    preview.getByRole("heading", { name: "执行与覆盖说明" }),
  ).toBeVisible();
  await expect(preview.getByText(name, { exact: false }).first()).toBeVisible();
  await expect(
    preview.getByRole("heading", { name: "管理摘要" }),
  ).toBeVisible();
  await expect(
    preview.getByRole("heading", { name: "CVE 软件评估" }),
  ).toHaveCount(0);
  await page
    .getByLabel("修订报告专题", { exact: true })
    .selectOption("vulnerability");
  await page.getByLabel("修订管理摘要", { exact: true }).uncheck();
  await page.getByRole("button", { name: "保存为新草稿", exact: true }).click();
  await expect(
    preview.getByRole("heading", { name: "CVE 软件评估" }),
  ).toBeVisible();
  await expect(preview.getByRole("heading", { name: "管理摘要" })).toHaveCount(
    0,
  );
  await page.reload();
  await page
    .getByRole("button", { name: `查看报告 ${name}`, exact: true })
    .click();
  await expect(
    preview.getByRole("heading", { name: "执行与覆盖说明" }),
  ).toBeVisible();
  await page.getByLabel("报告范围", { exact: true }).selectOption("tenant");
  await page.getByLabel("报告名称", { exact: true }).fill(`${name}-tenant`);
  await page
    .getByRole("button", { name: "使用已有结果生成报告", exact: true })
    .click();
  await expect(
    preview.getByText(`${name}-tenant`, { exact: false }).first(),
  ).toBeVisible();
  await expect(preview.getByText(name, { exact: false }).first()).toBeVisible();
});
