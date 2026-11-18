import { test, expect } from "@playwright/test";
test("上传Windows采集、查看未知/完整性、刷新历史并切换客户", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.getByRole("button", { name: "Windows 采集导入" }).click();
  const name = `windows-${Date.now()}.json`;
  await page
    .getByLabel("Windows JSON 文件")
    .setInputFiles({
      name,
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          Hostname: name,
          SerialNumber: name,
          OS: "Windows Server 2022",
          OSBuild: "20348",
          InstalledSoftware: [{ Name: "Example", Version: "" }],
          CollectionStatus: { Overall: "PARTIAL" },
          KBInventoryComplete: false,
        }),
      ),
    });
  await page.getByRole("button", { name: "导入采集资料" }).click();
  await expect(page.getByText("已导入独立快照", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "未知", exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.getByText('{"Overall":"PARTIAL"}', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "Windows 采集导入" }).click();
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.getByText("已导入独立快照", { exact: true })).toBeVisible();
  await page.screenshot({ path: "output/t03-windows.png", fullPage: true });
  await page.getByLabel("当前客户").selectOption("river");
  await expect(
    page.getByRole("button", { name: new RegExp(name) }),
  ).toHaveCount(0);
});
