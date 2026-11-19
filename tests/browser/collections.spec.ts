import { test, expect } from "@playwright/test";
test("网页保存人工基础快照，刷新回读来源与未评估状态，连接仅可选受控配置", async ({
  page,
}) => {
  const failures: string[] = [];
  page.on("pageerror", (e) => failures.push(e.message));
  await page.addInitScript(() =>
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      configurable: true,
      value: undefined,
    }),
  );
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  const name = `collection-${Date.now()}`;
  await page.getByRole("button", { name: "＋ 新建资产" }).click();
  await page.getByLabel("资产名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "保存资产", exact: true }).click();
  const row = page.getByRole("row").filter({ hasText: name });
  await expect(row).toBeVisible();
  const assetId = await row.locator("code").first().textContent();
  await page.locator("nav button").filter({ hasText: "资产采集" }).click();
  await page.getByLabel("目标资产编号").fill(assetId!);
  await page.getByLabel("来源说明").fill("浏览器现场声明");
  await page.getByLabel("主机名", { exact: true }).fill(name);
  await page.getByLabel("OS发行版ID").fill("debian");
  await page.getByLabel("OS版本", { exact: true }).fill("12");
  await page.getByRole("button", { name: "保存基础快照", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `快照详情 · ${name}` }),
  ).toBeVisible();
  await expect(page.getByText("人工来源快照已保存，尚未评估")).toBeVisible();
  await expect(
    page.getByText("关联软件 / 镜像SBOM版本", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "调用Pi Agent", exact: true }).click();
  await page.getByLabel("受控连接").selectOption({ index: 0 });
  // No configured target connection is offered; the server's unavailable state is
  // covered by HTTP tests, while the browser keeps the fixed profile selector.
  await expect(page.getByLabel("受控连接").locator("option")).toHaveCount(1);
  await page.reload();
  await page.locator("nav button").filter({ hasText: "资产采集" }).click();
  await expect(page.getByRole("row").filter({ hasText: name })).toBeVisible();
  expect(failures).toEqual([]);
});
