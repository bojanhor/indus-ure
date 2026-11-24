const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");

test("an employee's personal purchase can make the payroll balance negative", async ({ page, context }) => {
  const app = await startIsolatedTestApp();
  try {
    expect((await context.request.post(app.baseUrl + "/api/test-login", { data: { userId: "bojan", password: TEST_PASSWORD } })).ok()).toBeTruthy();
    await page.goto(app.baseUrl);
    await expect(page.locator("#app")).toBeVisible();
    const { date, expected } = await page.evaluate(async () => {
      const date = dateKey(new Date());
      const purchase = 250;
      await api("/api/todos", { method: "POST", body: JSON.stringify({
        status: "execution", title: "Negativni saldo QA", client: "QA stranka", date,
        start: "08:00", end: "09:00", syncUser: "ibro", assigneeIds: ["ibro"], billingHourlyRate: 15, workFromHome: true
      }) });
      await api("/api/personal-purchases", { method: "POST", body: JSON.stringify({
        date, amount: purchase, person: "ibro", reason: "Osebni nakup QA"
      }) });
      await loadAll();
      return { date, expected: money(15 - purchase) + " EUR" };
    });
    await page.locator("#toolsMenu > summary").click();
    await page.locator("#billingMenuBtn").click();
    await page.locator("#billingWorker").selectOption("ibro");
    await page.locator('[data-billing-range-preset="open-to-today"]').click();
    await expect(page.locator("#billingFrom")).toHaveValue(date);
    await expect(page.locator("#billingTo")).toHaveValue(date);
    await expect(page.locator("#billingSummary .is-payout .billing-summary-value")).toHaveText(expected);
    await expect(page.locator("#billingConfirm")).toBeDisabled();
    await page.screenshot({ path: test.info().outputPath("negative-payroll.png") });
  } finally {
    await app.stop();
  }
});
