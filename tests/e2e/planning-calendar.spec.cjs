const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

for (const userId of ["bojan", "ibro"]) {
  test(`${userId}: planning calendar account panel and access boundaries`, async ({ page }) => {
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(app.baseUrl);
    await page.locator("#localTestUser").selectOption(userId);
    await page.locator("#localTestPassword").fill(TEST_PASSWORD);
    await page.locator("#localTestLoginBtn").click();
    await expect(page.locator("#app")).toBeVisible();
    await page.locator("#toolsMenu > summary").click();
    await page.locator("#accountBtn").click();
    await expect(page.locator("#planningCalendarStatus")).toContainText("še ni povezan");
    await expect(page.locator("#copyWorkerCalendar")).toContainText("ICS koledar planiranja");
    if (userId === "bojan") {
      await expect(page.locator("#connectPlanningCalendar")).toBeVisible();
      await expect(page.locator("#connectPlanningCalendar")).toBeDisabled();
    } else {
      await expect(page.locator("#connectPlanningCalendar")).toBeHidden();
    }
    await expect(page.locator("#syncPlanningCalendar")).toBeHidden();
    await expect(page.locator("#pausePlanningCalendar")).toBeHidden();
    const noCsrf = await page.request.post(`${app.baseUrl}/api/planning-calendar/sync`, { data: {} });
    expect(noCsrf.status()).toBe(403);
    await page.locator("#closeAccount").click();
    await expect(page.locator("#accountDialog")).toBeHidden();
    await page.locator("#calendarViewBtn").click();
    await expect(page.locator("#calendar")).toBeVisible();
    if (userId === "bojan") {
      await page.goto(`${app.baseUrl}/?planning_calendar=connected`);
      await expect(page.locator("#accountDialog")).toBeVisible();
      await expect(page.locator("#planningCalendarStatus")).toContainText("še ni povezan");
      expect(page.url()).not.toContain("planning_calendar=");
    }
    expect(errors).toEqual([]);
  });
}

test("mobile calendar status wraps and owner controls stay visible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.baseUrl);
  await page.locator("#localTestUser").selectOption("bojan");
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
  await page.locator("#toolsMenu > summary").click();
  await page.locator("#accountBtn").click();
  await expect(page.locator("#planningCalendarStatus")).toContainText("še ni povezan");
  const size = await page.locator("#accountDialog").evaluate(el => ({ client: el.clientWidth, scroll: el.scrollWidth }));
  expect(size.scroll).toBeLessThanOrEqual(size.client + 1);
});
