import { test, expect } from "@playwright/test";
test("客户概览选择固定版本、同scope下钻和趋势覆盖，刷新及切客户", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 600 });
  const headers = { Authorization: "Bearer browser-test-secret-token" };
  await expect
    .poll(async () =>
      (await page.request.get("/api/customers", { headers })).status(),
    )
    .toBe(200);
  const name = `Dashboard-${Date.now()}`;
  async function seed(name: string) {
    const object = await (
      await page.request.post("/api/customers/acme/software", {
        headers,
        data: { name },
      })
    ).json();
    const version = await (
      await page.request.post(
        `/api/customers/acme/software/${object.id}/sbom`,
        {
          headers,
          data: {
            fileName: "dashboard.json",
            content: JSON.stringify({
              bomFormat: "CycloneDX",
              fixtureMode: "findings",
              specVersion: "1.5",
              metadata: {
                component: { type: "application", name, version: "1" },
              },
              components: [
                {
                  type: "library",
                  name: "express",
                  version: "4.18.0",
                  purl: "pkg:npm/express@4.18.0",
                },
              ],
            }),
          },
        },
      )
    ).json();
    const job = await (
      await page.request.post("/api/customers/acme/assessments", {
        headers,
        data: {
          softwareId: object.id,
          versionId: version.id,
          idempotencyKey: name,
        },
      })
    ).json();
    await expect
      .poll(
        async () =>
          (
            await (
              await page.request.get(
                `/api/customers/acme/assessments/${job.id}`,
                { headers },
              )
            ).json()
          ).status,
      )
      .toBe("succeeded");
    expect(
      (
        await page.request.put(
          `/api/customers/acme/software/${object.id}/history/current`,
          { headers, data: { versionId: version.id, assessmentId: job.id } },
        )
      ).status(),
    ).toBe(200);

    return { object, version, job };
  }
  const { object, job } = await seed(name);
  const outsideName = `Outside-${name}`;
  await seed(outsideName);
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "资产台账" }).click();
  await page.getByRole("button", { name: "客户风险概览" }).click();
  await page.getByText("筛选范围与历史批次", { exact: true }).click();
  const catalogSelect = page.getByLabel("概览对象");
  await expect
    .poll(() => catalogSelect.locator("option").count())
    .toBeGreaterThan(1);
  for (
    let i = 0;
    i < 20 &&
    !(await catalogSelect
      .locator(`option[value="software:${object.id}"]`)
      .count());
    i++
  ) {
    const next = page.getByRole("button", { name: "下一页对象", exact: true });
    await expect(next).toBeEnabled();
    const response = page.waitForResponse((r) =>
      r.url().includes("/dashboard/catalog?"),
    );
    await next.click();
    const catalog = await (await response).json();
    await expect(
      page.locator("p").filter({ hasText: /^对象目录/ }),
    ).toContainText(`${catalog.objectOffset + 1}–`);
  }
  await page.getByLabel("概览对象").selectOption(`software:${object.id}`);
  const appliedResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/dashboard/view") &&
      response.request().postDataJSON()?.object?.id === object.id,
  );
  await page.getByRole("button", { name: "应用概览范围" }).click();
  const applied = await (await appliedResponse).json();
  expect(applied.objects).toHaveLength(1);
  expect(applied.metrics.cve.instances).toBe(1);
  expect(applied.scope.assessmentRefs).toEqual([job.id]);
  await expect(
    page.getByRole("button", { name: `下钻 ${outsideName}`, exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText("库时间有效", { exact: false })).toBeVisible();
  const detailResponse = page.waitForResponse((response) =>
    response.url().endsWith("/dashboard/findings"),
  );
  await page.getByRole("button", { name: "下钻观测实例" }).click();
  const detailsResponse = await detailResponse;
  expect(detailsResponse.request().postDataJSON().object).toEqual(
    applied.scope.object,
  );
  const detail = await detailsResponse.json();
  expect(detail.total).toBe(applied.metrics.cve.instances);
  expect(detail.assessmentRefs).toEqual(applied.scope.assessmentRefs);
  expect(
    detail.items.map(
      (finding: { assessmentId: string }) => finding.assessmentId,
    ),
  ).toEqual([job.id]);
  await expect(
    page.getByRole("heading", { name: /固定范围观测明细/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: /CVE-2099-FIXTURE/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: `下钻 ${name}` }).click();
  await expect(
    page.getByRole("heading", { name: `${name} · 固定范围明细` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "查看固定任务证据" }).click();
  await expect(
    page.getByText("固定任务原始证据", { exact: true }),
  ).toBeVisible();
  await page.screenshot({ path: "output/t12-dashboard.png", fullPage: true });
  await page.reload();
  await page.getByRole("button", { name: "客户风险概览" }).click();
  await expect(
    page.getByRole("button", { name: `下钻 ${name}` }),
  ).toBeVisible();
  await page.locator("nav button").filter({ hasText: "生命周期资料" }).click();
  await page.getByRole("button", { name: "客户风险概览" }).click();
  await expect(
    page.getByRole("heading", { name: "客户风险概览", exact: true }),
  ).toBeVisible();
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByRole("button", { name: `下钻 ${name}` })).toHaveCount(
    0,
  );
  await expect(
    page.getByText("未选择评估版本，生命周期未知。", { exact: true }),
  ).toBeVisible();
});
