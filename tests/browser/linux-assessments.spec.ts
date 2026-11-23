import { test, expect } from "@playwright/test";

test("Linux快照扫描分页、原始证据下载、历史回读及客户隔离", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" };
  const api = "http://127.0.0.1:3101/api/customers/acme";
  const name = `Linux-browser-${Date.now()}`;
  const assetResponse = await request.post(`${api}/assets`, {
    headers,
    data: { name, kind: "host" },
  });
  expect(assetResponse.ok()).toBe(true);
  const asset = await assetResponse.json();
  const hostData = {
    schemaVersion: "ys-host/1",
    identity: { hostname: name },
    collectedAt: null,
    sections: {
      os: {
        status: "acquired",
        data: {
          id: "ubuntu",
          version: "24.04",
          kernel: "6.8",
          architecture: "x86_64",
        },
      },
      packages: {
        status: "acquired",
        data: [
          {
            manager: "dpkg",
            name: "libssl3",
            version: "3.0.1",
            architecture: "amd64",
            state: "installed",
          },
        ],
      },
    },
    extensions: {
      rawSections: {
        os: 'ID=ubuntu\nVERSION_ID="24.04"\n',
        lsbRelease: "DISTRIB_ID=Ubuntu\nDISTRIB_RELEASE=24.04\n",
        dpkgStatus:
          "Package: libssl3\nStatus: install ok installed\nArchitecture: amd64\nVersion: 3.0.1\nSource: openssl\n\n",
      },
    },
  };
  const adopt = async (snapshotId: string) => {
    const preview = await (
      await request.get(`${api}/assets/${asset.id}/baseline`, { headers })
    ).json();
    const confirmed = await request.post(
      `${api}/assets/${asset.id}/baseline/confirm`,
      {
        headers,
        data: {
          snapshotId,
          expectedBaselineId: preview.current?.id ?? null,
          idempotencyKey: `adopt-${snapshotId}`,
          sections: ["os", "packages"],
          writeMasterData: false,
        },
      },
    );
    expect(confirmed.ok()).toBe(true);
  };
  const snapshotResponse = await request.post(`${api}/collections/manual`, {
    headers,
    data: {
      assetId: asset.id,
      note: "Browser fixed native metadata",
      data: hostData,
    },
  });
  expect(snapshotResponse.ok()).toBe(true);
  const snapshot = await snapshotResponse.json();
  await adopt(snapshot.id);
  let streams = 0,
    submissions = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/assessments"))
      submissions++;
  });
  await page.route("**/assessments/*/events", (route) => {
    streams++;
    return streams === 1 ? route.abort() : route.continue();
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "CVE评估" }).click();
  await page.getByLabel("评估对象", { exact: true }).selectOption(asset.id);
  const conditions = page.getByRole("region", {
    name: "扫描条件",
    exact: true,
  });
  await expect(
    conditions.getByText(snapshot.id, { exact: true }),
  ).toBeVisible();
  await expect(
    conditions.getByRole("button", { name: "扫描", exact: true }),
  ).toBeEnabled();
  await expect(conditions.getByLabel("扫描任务进度")).toHaveCount(0);
  await expect(page.getByLabel("Linux采集快照")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "扫描", exact: true }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: "建立新扫描请求" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("checkbox", { name: "致命", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "高危", exact: true }),
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "中危", exact: true }),
  ).not.toBeChecked();
  await expect(page.getByLabel("扫描任务进度")).toContainText("等待开始扫描");
  await page.screenshot({
    path: "output/verification/scan-conditions-linux.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "扫描", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "发现 120 条漏洞记录" }),
  ).toBeVisible();
  await expect(
    page.getByText("扫描完成，结果已生成。", { exact: true }),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText("SSE");
  expect(streams).toBeGreaterThanOrEqual(2);
  expect(submissions).toBe(1);
  await expect(
    page.getByRole("progressbar", { name: "扫描进度" }),
  ).toHaveAttribute("value", "100");
  await expect(
    page.getByRole("button", { name: "按组件分组", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: "output/verification/assessment-components.png",
    fullPage: false,
  });
  await page.getByRole("button", { name: "按组件分组", exact: true }).click();
  await expect(page.getByLabel("选择漏洞组件").locator("option")).toHaveCount(
    2,
  );
  await expect(
    page.getByLabel("选择漏洞组件").locator("option").nth(1),
  ).toContainText("120 个 CVE / 120 条匹配");
  await page.getByLabel("选择漏洞组件").selectOption({ index: 1 });
  await expect(page.getByText("CVE-LINUX-000", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "下一页漏洞" }).click();
  await expect(page.getByText("CVE-LINUX-050", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "逐条匹配", exact: true }).click();
  const firstEvidence = page.locator(".findings-table tbody tr").first();
  await firstEvidence.getByText("查看证据", { exact: true }).click();
  await expect(firstEvidence).toContainText("证据不足，尚未确认受影响");
  await expect(firstEvidence).toContainText("运行内核：6.8");
  await expect(
    firstEvidence.getByText("技术追溯信息", { exact: true }),
  ).toBeVisible();
  await firstEvidence.getByText("查看证据", { exact: true }).click();
  await page.getByRole("checkbox", { name: "高危", exact: true }).uncheck();
  await expect(
    page.getByText("当前关注等级显示 0 条，完整记录 120 条。", { exact: true }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: "高危", exact: true }).check();
  await expect(
    page.getByText("当前关注等级显示 120 条，完整记录 120 条。", {
      exact: true,
    }),
  ).toBeVisible();

  await page
    .getByRole("searchbox", { name: "检索漏洞记录" })
    .fill("CVE-LINUX-119");
  await expect(
    page.getByText("当前关注等级显示 1 条，完整记录 120 条。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("CVE-LINUX-119", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "AI解析", exact: true }).click();
  const analysis = page.getByRole("dialog", { name: "漏洞 AI 解析" });
  await expect(analysis.getByRole("alert")).toContainText("Pi未配置");
  await page.keyboard.press("Escape");
  await expect(analysis).toHaveCount(0);
  await page.route("**/findings/*/analyses", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    const previous = body.items[0];
    const section = {
      text: "## 核实结论\n\n- **仍需核实**\n- 当前资料有边界\n\n| 条件 | 状态 |\n| --- | --- |\n| Xen | 未知 |\n\n![remote](https://tracking.invalid/pixel)\n<script>window.markdownExecuted=true</script>\n[unsafe](javascript:alert(1))",
      sourceIds: ["finding"],
    };
    await route.fulfill({
      json: {
        items: [
          {
            ...previous,
            status: "succeeded",
            narrative: {
              explanation: section,
              impact: section,
              checks: [section],
              nextSteps: [section],
            },
          },
        ],
      },
    });
  });
  await page.getByRole("button", { name: "AI解析", exact: true }).click();
  await expect(
    analysis.getByRole("heading", { name: "核实结论", exact: true }),
  ).toHaveCount(4);
  await expect(analysis.locator("table")).toHaveCount(4);
  await expect(analysis.locator("img")).toHaveCount(0);
  await expect(analysis.locator('a[href^="javascript:"]')).toHaveCount(0);
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { markdownExecuted?: boolean }).markdownExecuted,
    ),
  ).toBeUndefined();
  await expect(
    analysis.getByRole("button", { name: "复制 Markdown" }),
  ).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await analysis.getByRole("button", { name: "复制 Markdown" }).click();
  await expect(
    analysis.getByText("Markdown 已复制", { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(
    "## 当前系统影响",
  );
  await page.screenshot({
    path: "output/verification/assessment-markdown.png",
    fullPage: false,
  });

  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "漏洞来源与依据", exact: true })
    .click();
  const source = page.getByRole("dialog", { name: "漏洞来源与依据" });
  await expect(source).toContainText("未重新抓取完整来源原文");
  await expect(source).toContainText("匹配依据");
  await expect(
    source.getByRole("link", { name: "打开来源原文 ↗" }),
  ).toHaveAttribute("target", "_blank");
  await source.getByRole("button", { name: "关闭来源详情" }).click();
  // Changing from one matching group to another must not reuse the old group's key.
  const assessmentList = await (
    await request.get(
      `${api}/assessments?targetKind=linux&targetId=${asset.id}`,
      { headers },
    )
  ).json();
  const reference = await (
    await request.get(
      `${api}/assessments/${assessmentList.items[0].id}?findingsOffset=0&severities=CRITICAL,HIGH&search=CVE-LINUX-119`,
      { headers },
    )
  ).json();
  const alternate = {
    ...reference.result.findings[0],
    id: "alternate-fixture",
    componentId: "alternate:amd64",
    packageName: "alternate",
    vulnerabilityId: "CVE-ALTERNATE",
  };
  const alternateKey = JSON.stringify([
    alternate.componentId,
    alternate.packageName,
    alternate.installedVersion,
    alternate.ecosystem,
    alternate.target,
    null,
  ]);
  await page.route("**/assessments/*?*", async (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("search") !== "alternate") return route.continue();
    const selected = url.searchParams.get("component") ?? "";
    const matches =
      !selected || JSON.stringify(JSON.parse(selected)) === alternateKey;
    await route.fulfill({
      json: {
        ...reference,
        result: { ...reference.result, findings: matches ? [alternate] : [] },
        componentGroups: [
          {
            key: alternateKey,
            componentId: alternate.componentId,
            packageName: "alternate",
            installedVersion: alternate.installedVersion,
            ecosystem: alternate.ecosystem,
            target: alternate.target,
            records: 1,
            uniqueCves: 1,
            severities: { HIGH: 1 },
          },
        ],
        findingsPage: {
          total: matches ? 1 : 0,
          unfilteredTotal: 120,
          offset: 0,
          limit: 50,
          search: "alternate",
          severities: ["CRITICAL", "HIGH"],
          ...(selected ? { component: selected } : {}),
        },
      },
    });
  });
  await page.getByRole("searchbox", { name: "检索漏洞记录" }).fill("alternate");
  await expect(page.getByText("CVE-ALTERNATE", { exact: true })).toBeVisible();

  await page.getByRole("searchbox", { name: "检索漏洞记录" }).fill("");
  await expect(
    page.getByText("当前关注等级显示 120 条，完整记录 120 条。", {
      exact: true,
    }),
  ).toBeVisible();
  const resultTop = await page
    .locator(".assessment-results")
    .evaluate((el) => el.getBoundingClientRect().top);
  const historyTop = await page
    .getByRole("heading", { name: "本主机Linux扫描历史" })
    .evaluate((el) => el.getBoundingClientRect().top);
  expect(historyTop).toBeGreaterThan(resultTop);
  await expect(page.getByText("CVE-LINUX-000", { exact: true })).toBeVisible();
  await expect(page.getByText("CVE-LINUX-050", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "下一页漏洞" }).click();
  await expect(page.getByText("CVE-LINUX-050", { exact: true })).toBeVisible();
  await expect(page.getByText("CVE-LINUX-000", { exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByText("任务详情与执行证据", { exact: true }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "下载原始Trivy报告" }).click();
  expect((await download).suggestedFilename()).toMatch(/^trivy-.*\.json$/);
  await page.reload();
  await page.getByLabel("评估对象", { exact: true }).selectOption(asset.id);
  await page
    .getByRole("button", { name: /执行成功 ·/ })
    .first()
    .click();
  await expect(
    page.getByRole("heading", { name: "发现 120 条漏洞记录" }),
  ).toBeVisible();
  const history = await (
    await request.get(
      `${api}/assessments?targetKind=linux&targetId=${asset.id}`,
      { headers },
    )
  ).json();
  const job = history.items[0];
  expect(job.target.snapshotId).toBe(snapshot.id);
  const newer = await (
    await request.post(`${api}/collections/manual`, {
      headers,
      data: {
        assetId: asset.id,
        note: "New collection after page loaded",
        data: { ...hostData, collectedAt: new Date().toISOString() },
      },
    })
  ).json();
  await adopt(newer.id);
  const rescanResponse = page.waitForResponse(
    (r) => r.url().endsWith("/assessments") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "扫描", exact: true }).click();
  const rescan = await (await rescanResponse).json();
  expect(rescan.id).not.toBe(job.id);
  expect(rescan.target.snapshotId).toBe(newer.id);
  await expect(
    page.getByRole("heading", { name: "发现 120 条漏洞记录" }),
  ).toBeVisible();

  await page.locator("nav button").filter({ hasText: "风险事实报告" }).click();
  await page.getByLabel(new RegExp(job.id)).check();
  await page.getByRole("button", { name: "生成事实草稿" }).click();
  const preview = page.frameLocator('iframe[title="事实报告草稿"]');
  await expect(
    preview.getByRole("heading", { name: "CVE Linux系统包评估" }),
  ).toBeVisible();
  await expect(
    preview.getByText("完整漏洞明细（120条，展开查看）"),
  ).toBeVisible();
  await expect(
    preview.getByText("CVE-LINUX-119", { exact: true }),
  ).not.toBeVisible();
  await preview.getByText("完整漏洞明细（120条，展开查看）").click();
  await expect(
    preview.getByText("CVE-LINUX-119", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `cve 依据 ${job.id}`, exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "发现 120 条漏洞记录", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "下一页漏洞", exact: true }).click();
  await expect(page.getByText("CVE-LINUX-050", { exact: true })).toBeVisible();
  const originalDownload = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载原始扫描报告", exact: true })
    .click();
  expect((await originalDownload).suggestedFilename()).toContain(job.id);
  await expect(
    page.getByRole("button", { name: "下载正式 HTML" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "提交复核", exact: true }).click();
  await expect(
    preview.getByText("待复核草稿 · 不代表正式交付", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByLabel("当前客户").selectOption("river");
  await expect(page.getByText("CVE-LINUX-000", { exact: true })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("没有最新Linux资料时提前说明原因并禁止提交空任务", async ({
  page,
  request,
}) => {
  const headers = { Authorization: "Bearer browser-test-secret-token" };
  const asset = await (
    await request.post("http://127.0.0.1:3101/api/customers/acme/assets", {
      headers,
      data: { name: `No-snapshot-${Date.now()}`, kind: "host" },
    })
  ).json();
  let submissions = 0;
  page.on("request", (r) => {
    if (r.method() === "POST" && r.url().endsWith("/assessments"))
      submissions++;
  });
  await page.goto("/");
  await page.getByLabel("操作员访问令牌").fill("browser-test-secret-token");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await page.locator("nav button").filter({ hasText: "CVE评估" }).click();
  await page.getByLabel("评估对象", { exact: true }).selectOption(asset.id);
  await expect(
    page.getByRole("button", { name: "扫描", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText(/没有采集资料/).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "扫描", exact: true }),
  ).toBeDisabled();
  expect(submissions).toBe(0);
  await page.route("**/assessments/linux-inputs?**", (route) =>
    route.fulfill({
      json: {
        items: [
          { id: asset.id, supported: false, reason: "最新资料缺少dpkg" },
          { id: asset.id, supported: true },
        ],
        total: 2,
        offset: 0,
      },
    }),
  );
  await page.getByRole("button", { name: "刷新资料状态" }).click();
  await expect(page.getByText(/最新资料缺少dpkg/).first()).toBeVisible();
  await expect(
    page.getByRole("button", { name: "扫描", exact: true }),
  ).toBeDisabled();
  expect(submissions).toBe(0);
});
