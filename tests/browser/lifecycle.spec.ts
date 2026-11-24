import { test, expect } from "@playwright/test";
test("lifecycle CSV exposes separate stages and immutable assessment history per customer", async ({
  page,
  request,
}) => {
  const unique = Date.now();
  const name = `lifecycle-host-${unique}`;
  await expect
    .poll(async () => {
      try {
        return (
          await request.get("http://127.0.0.1:3101/api/customers", {
            headers: { Authorization: "Bearer browser-test-secret-token" },
          })
        ).status();
      } catch {
        return 0;
      }
    })
    .toBe(200);
  await request.post("http://127.0.0.1:3101/api/customers/acme/assets", {
    headers: { Authorization: "Bearer browser-test-secret-token" },
    data: {
      name,
      kind: "host",
      attributes: { product: "Widget", version: "1" },
    },
  });
  const software = await (
    await request.post("http://127.0.0.1:3101/api/customers/acme/software", {
      headers: { Authorization: "Bearer browser-test-secret-token" },
      data: { name: "Widget" },
    })
  ).json();
  const snapshot = await (
    await request.post(
      `http://127.0.0.1:3101/api/customers/acme/software/${software.id}/sbom`,
      {
        headers: { Authorization: "Bearer browser-test-secret-token" },
        data: {
          fileName: "fixture-bom.json",
          content: JSON.stringify({
            bomFormat: "CycloneDX",
            specVersion: "1.5",
            metadata: {
              component: { type: "application", name: "Widget", version: "1" },
            },
            components: [],
            serialNumber: `urn:uuid:${unique}`,
          }),
        },
      },
    )
  ).json();
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  await page.locator("nav button").filter({ hasText: "生命周期资料" }).click();
  await page
    .getByRole("tab", { name: "厂商共同资料 · CSV", exact: true })
    .click();
  await page.getByLabel("生命周期 CSV 文件").setInputFiles({
    name: `lifecycle-${unique}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(
      `source,sourceRef,product,version,eosStage,eosDate,eolStage,eolDate\nFixture bulletin,fixture-${unique},Widget,1,Sales,2020-01-01,Support,2026-02-30`,
    ),
  });
  await page.getByRole("button", { name: "导入生命周期批次" }).click();
  await expect(
    page.getByText("eolDate 无效，保留其他信息", { exact: true }),
  ).toBeVisible();
  await page.locator("nav button").filter({ hasText: "EOSL评估" }).click();
  await page
    .getByRole("button", { name: `lifecycle-${unique}.csv`, exact: true })
    .click();
  await page.getByLabel(new RegExp(name)).check();
  await page.getByLabel(new RegExp(snapshot.id)).check();
  await page.getByRole("button", { name: "保存生命周期评估" }).click();
  await expect(
    page.getByRole("heading", { name: `${name} · 精确匹配` }),
  ).toBeVisible();
  await expect(
    page.getByText("EOS · Sales · 2020-01-01 · 阶段日期已到").first(),
  ).toBeVisible();
  await expect(
    page.getByText("EOL · Support · 未知日期 · 未知").first(),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Widget · 精确匹配", exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.locator("nav button").filter({ hasText: "生命周期资料" }).click();
  await page.getByRole("tab",{name:"厂商共同资料 · CSV",exact:true}).click();
  await expect(
    page.getByRole("button", { name: `lifecycle-${unique}.csv`, exact: true }),
  ).toBeVisible();
  await page.getByLabel("当前客户").selectOption("river");
  await expect(
    page.getByRole("button", { name: `lifecycle-${unique}.csv`, exact: true }),
  ).toHaveCount(0);
});
