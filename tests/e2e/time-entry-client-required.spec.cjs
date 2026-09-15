const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");

let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

for (const userId of ["bojan", "ibro"]) {
  for (const width of [390, 1280]) {
    test(`${userId}: brez stranke ostane urejevalnik odprt (${width}px)`, async ({ browser }) => {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const page = await context.newPage();
      try {
        await page.goto(app.baseUrl);
        await page.locator("#localTestUser").selectOption(userId);
        await page.locator("#localTestPassword").fill(TEST_PASSWORD);
        await page.locator("#localTestLoginBtn").click();
        await expect(page.locator("#app")).toBeVisible();
        if (userId === "bojan") {
          await page.locator("#activeWorkContext").click();
          await page.locator('[data-work-context="worker:bojan"]').click();
        }
        await page.locator("#writeHoursButton").click();
        await expect(page.locator("#todoDialog")).toBeVisible();
        await page.locator("#todoFormTask").fill("Vpis brez stranke");
        const mutations = [];
        page.on("request", (request) => {
          if (request.method() === "POST" && new URL(request.url()).pathname === "/api/todos") mutations.push(request.url());
        });
        // Covers both ordinary submission and the automatic slot path when
        // the user has not entered a time. Neither may save or close first.
        for (const [start, end] of [["08:00", "09:00"], ["", ""]]) {
          await page.locator("#todoFormStart").fill(start);
          await page.locator("#todoFormEnd").fill(end);
          await page.locator("#saveTodoDialog").click();
          await expect(page.locator("#todoDialog")).toBeVisible();
          await expect(page.locator("#todoForm")).toContainText("Za vpis ur izberi stranko.");
          await expect(page.locator("#todoFormClient")).toBeFocused();
          await expect(page.locator("#appConfirmDialog")).toBeHidden();
          expect(mutations).toEqual([]);
        }
        await page.screenshot({ path: test.info().outputPath("missing-client.png") });
      } finally {
        await context.close();
      }
    });
  }
}
