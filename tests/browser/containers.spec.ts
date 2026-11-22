import { test, expect } from "@playwright/test";
test("镜像详情保留digest版本、组件和评估证据，刷新及客户切换不串联", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  await page.getByRole("button", { name: "容器镜像" }).click();
  const name = `Image-${Date.now()}`;
  await page.getByLabel("镜像名称").fill(name);
  await page.getByLabel("镜像资料来源").fill("release-pipeline");
  await page.getByRole("button", { name: "建立镜像对象" }).click();
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
  const digest = "sha256:" + "a".repeat(64);
  const content = (d: string) =>
    JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      fixtureMode: "findings",
      metadata: {
        component: {
          type: "container",
          name,
          version: "latest",
          purl: `pkg:oci/debian@${encodeURIComponent(d)}?repository_url=registry.test%2Flibrary%2Fdebian&tag=latest&arch=amd64`,
        },
      },
      components: [
        { type: "operating-system", name: "Debian", version: "12" },
        {
          type: "library",
          name: "libssl3",
          version: "3.0.1",
          purl: "pkg:deb/debian/libssl3@3.0.1?distro=debian-12",
        },
      ],
    });
  await page.getByLabel("容器 SBOM 文件").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from("{"),
  });
  await page.getByRole("button", { name: "上传镜像 SBOM" }).click();
  await expect(page.getByRole("alert")).toContainText("无效 JSON");
  await page.getByLabel("容器 SBOM 文件").setInputFiles({
    name: "image.json",
    mimeType: "application/json",
    buffer: Buffer.from(content(digest)),
  });
  await page.getByRole("button", { name: "上传镜像 SBOM" }).click();
  await expect(page.getByText("镜像 SBOM 已保存为独立输入版本")).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "libssl3", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Digest：" + digest, { exact: false }),
  ).toBeVisible();
  const originalVersion = await page
    .getByRole("button", { name: /镜像版本 latest/ })
    .first()
    .textContent();
  await page.getByRole("button", { name: "上传镜像 SBOM" }).click();
  await expect(page.getByText("重复资料：回读原镜像输入版本")).toBeVisible();
  await page.getByRole("button", { name: "评估当前镜像版本" }).click();
  await expect(
    page.getByText("CVE-2099-CONTAINER", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("漏洞数据库已过期", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("发现不自动归属于运行实例。", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("容器 SBOM 文件").setInputFiles({
    name: "image2.json",
    mimeType: "application/json",
    buffer: Buffer.from(content("sha256:" + "b".repeat(64))),
  });
  await page.getByRole("button", { name: "上传镜像 SBOM" }).click();
  await expect(page.getByText("本输入版本有 0 个评估任务")).toBeVisible();
  await expect(
    page.getByText("CVE-2099-CONTAINER", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: originalVersion!, exact: true })
    .click();
  await page.getByRole("button", { name: /镜像评估 执行成功/ }).click();
  await expect(
    page.getByText("CVE-2099-CONTAINER", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await page.getByRole("button", { name: "容器镜像" }).click();
  await page.getByRole("button", { name, exact: true }).click();
  await page
    .getByRole("button", { name: originalVersion!, exact: true })
    .click();
  await page.getByRole("button", { name: /镜像评估 执行成功/ }).click();
  await page.getByText("任务详情与执行证据", { exact: true }).click();
  await page.getByText("原始 Trivy 报告", { exact: true }).click();
  await expect(page.getByText(/"SchemaVersion":2/)).toBeVisible();
  await page.screenshot({ path: "output/t06-container.png", fullPage: true });
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await expect(
    page.getByText("CVE-2099-CONTAINER", { exact: true }),
  ).toHaveCount(0);
});
