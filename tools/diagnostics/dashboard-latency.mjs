// Run against a seeded customer to guard the real HTTP path against regressions.
const base = process.env.YS_DIAGNOSTIC_BASE_URL;
const customer = process.env.YS_DIAGNOSTIC_CUSTOMER;
const token = process.env.YS_DIAGNOSTIC_TOKEN;
const budget = Number(process.env.YS_DIAGNOSTIC_BUDGET_MS ?? 3000);
if (!base || !customer || !token || !Number.isFinite(budget) || budget <= 0) {
  throw new Error(
    "Set YS_DIAGNOSTIC_BASE_URL, YS_DIAGNOSTIC_CUSTOMER, YS_DIAGNOSTIC_TOKEN and an optional positive YS_DIAGNOSTIC_BUDGET_MS",
  );
}
for (let attempt = 1; attempt <= 3; attempt++) {
  const start = performance.now();
  const response = await fetch(
    `${base.replace(/\/$/, "")}/api/customers/${encodeURIComponent(customer)}/dashboard/overview`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error(`Dashboard returned HTTP ${response.status}`);
  const overview = await response.json();
  if (!overview.id || !overview.metrics)
    throw new Error("Dashboard response is incomplete");
  const elapsedMs = Math.round(performance.now() - start);
  console.log(
    JSON.stringify({
      attempt,
      elapsedMs,
      budgetMs: budget,
      instances: overview.metrics.cve.instances,
      withinBudget: elapsedMs <= budget,
    }),
  );
  if (elapsedMs > budget) process.exitCode = 1;
}
