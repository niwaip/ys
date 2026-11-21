import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("选择Windows固定快照与源戳规则、执行、刷新回读补丁依据", async ({
  page,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" };
  const name = `win-evidence-${Date.now()}`;
  const host = {
    Hostname: name,
    SerialNumber: name,
    OS: "Windows Server 2022",
    OSBuild: "20348",
    Architecture: "x64",
    UBR: 2600,
    CollectedAt: "2026-11-18T00:00:00Z",
    InstalledKBs: ["KB5040000"],
    KBInventoryComplete: true,
    RebootPending: false,
    CollectionStatus: { Overall: "COMPLETE" },
  };
  await expect
    .poll(async () =>
      (await page.request.get("/api/customers", { headers })).status(),
    )
    .toBe(200);
  const response = await page.request.post(
    "/api/customers/acme/windows/imports",
    {
      headers,
      data: { fileName: `${name}.json`, content: JSON.stringify(host) },
    },
  );
  expect(response.status()).toBe(201);
  const snapshot = await response.json();
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  await page.locator("nav button").filter({ hasText: "CVE评估" }).click();
  await page
    .getByRole("tab", { name: "Windows 补丁评估", exact: true })
    .click();
  await page.getByLabel("Windows 规则 JSON").setInputFiles({
    name: "synthetic-rules.json",
    mimeType: "application/json",
    buffer: await readFile("tests/fixtures/windows/rules.json"),
  });
  await page.getByRole("button", { name: "导入源戳规则" }).click();
  await expect(page.getByLabel("Windows 规则版本")).not.toHaveValue("");
  await page.getByLabel("主机快照").selectOption(snapshot.snapshotId);
  await page.getByRole("button", { name: "开始 Windows 评估" }).click();
  await expect(
    page.getByRole("cell", { name: "已修复", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: /已核实规则中的补丁替代链/ }),
  ).toBeVisible();
  await expect(
    page.getByText("来源内容哈希已核对；未联网核实上传内容真实性", {
      exact: true,
    }),
  ).toBeVisible();
  const heading = await page
    .getByRole("heading", { name: /^任务 / })
    .innerText();
  await page.reload();
  await page.locator("nav button").filter({ hasText: "CVE评估" }).click();
  await page
    .getByRole("tab", { name: "Windows 补丁评估", exact: true })
    .click();
  const id = heading.replace("任务 ", "");
  await page.getByRole("button", { name: new RegExp(id) }).click();
  await expect(
    page.getByRole("cell", { name: "已修复", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "output/t07-windows-assessment.png",
    fullPage: true,
  });
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByRole("button", { name: new RegExp(id) })).toHaveCount(
    0,
  );
});
