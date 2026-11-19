import { test, expect } from "@playwright/test";
test("软件重扫历史明确current选择并比较两批差异、覆盖及重复计数", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" },
    name = `History-${Date.now()}`;
  const software = (
    await request.post("/api/customers/acme/software", {
      headers,
      data: { name },
    })
  ).json();
  const s = await software;
  for (const version of ["1", "2"])
    await request.post(`/api/customers/acme/software/${s.id}/sbom`, {
      headers,
      data: {
        fileName: `v${version}.json`,
        content: JSON.stringify({
          bomFormat: "CycloneDX",
          specVersion: "1.5",
          fixtureMode: "history",
          metadata: { component: { type: "application", name, version } },
          components: [
            {
              type: "library",
              name: "express",
              version,
              purl: `pkg:npm/express@${version}`,
            },
          ],
        }),
      },
    });
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByRole("button", { name: "历史与比较" }).click();
  await page
    .getByRole("combobox", { name: "历史软件对象", exact: true })
    .selectOption({ label: name });
  await expect(
    page.getByText("尚未选择当前纳管版本；不自动使用最新输入或最近成功批次。"),
  ).toBeVisible();
  const rescan = async (version: string) => {
    await page.getByLabel(new RegExp(`^选择输入 ${version} `)).check();
    await page.getByRole("button", { name: "重扫所选输入" }).click();
    const text = await page.getByRole("status").textContent();
    const id = text!.match(/[0-9a-f]{8}-[0-9a-f-]{27,}/)![0];
    const button = page.getByRole("button", {
      name: `查看批次 ${id.slice(0, 8)}`,
    });
    await expect(button).toBeVisible();
    const row = page.getByRole("row").filter({ has: button });
    await expect(row).toContainText("执行成功");
    return id;
  };
  const first = await rescan("1"),
    second = await rescan("2");
  await page.getByLabel(`基准批次 ${first.slice(0, 8)}`).check();
  await page.getByLabel(`对比批次 ${second.slice(0, 8)}`).check();
  await page.getByRole("button", { name: "比较所选两批" }).click();
  await expect(
    page.getByText("新增观察：1 · 持续观察：1 · 本次未再观察到：1"),
  ).toBeVisible();
  await expect(
    page.getByText("基准：2 个实例 / 3 行；对比：2 个实例 / 2 行。", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByText("本次未再观察到不代表已修复；", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("覆盖变化：有", { exact: false })).toBeVisible();
  await page
    .getByRole("button", { name: `设为当前批次 ${first.slice(0, 8)}` })
    .click();
  await expect(
    page.getByText(`当前批次：${first}`, { exact: true }),
  ).toBeVisible();
  await rescan("2");
  await expect(
    page.getByText(`当前批次：${first}`, { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `查看批次 ${second.slice(0, 8)}` })
    .click();
  await page.getByText("原始 Trivy 报告", { exact: true }).click();
  await expect(page.getByText(/"SchemaVersion":2/)).toBeVisible();
  await page.getByRole("button", { name: "组件与来源 1", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "所选输入组件与来源" }),
  ).toBeVisible();
  await page.screenshot({ path: "output/t11-history.png", fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "历史与比较" }).click();
  await page
    .getByRole("combobox", { name: "历史软件对象", exact: true })
    .selectOption({ label: name });
  await expect(
    page.getByText(`当前批次：${first}`, { exact: true }),
  ).toBeVisible();
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByRole("option", { name, exact: true })).toHaveCount(0);
  await expect(
    page.getByText(`当前批次：${first}`, { exact: true }),
  ).toHaveCount(0);
});
