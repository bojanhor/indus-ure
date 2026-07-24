const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");

const CLIENT_ALIAS = "PW stranka";
const ENTRY_TITLE = "PW vpis ur";
const ENTRY_DATE = "2025-06-15";

let app;

async function localLogin(page, userId) {
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await expect(page.locator("#localTestLoginPanel")).toBeVisible();
  await page.locator("#localTestUser").selectOption(userId);
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
}

test.describe.serial("isolated worker time entry and boss payroll", () => {
  test.beforeAll(async () => {
    app = await startIsolatedTestApp();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test("worker enters hours through the real form", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");
      await page.locator("#writeHoursButton").click();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormTitle")).toHaveText("Vpis ur");
      await expect(page.locator("#todoFormStatus")).toHaveValue("execution");
      await expect(page.locator("#todoFormHourlyRateField")).toBeHidden();

      await page.locator("#todoFormNotes").fill("Podroben opis opravljenega dela. ".repeat(28));
      const notesMetrics = await page.locator("#todoFormNotes").evaluate((field) => ({
        offsetHeight: field.offsetHeight,
        scrollHeight: field.scrollHeight
      }));
      expect(notesMetrics.offsetHeight).toBeGreaterThan(82);
      expect(notesMetrics.offsetHeight).toBeGreaterThanOrEqual(notesMetrics.scrollHeight);

      await page.locator("#todoFormClient").fill(CLIENT_ALIAS);
      await page.locator("#quickAddClientBtn").click();
      await expect(page.locator("#quickClientDialog")).toBeVisible();
      await page.locator("#quickClientName").fill(CLIENT_ALIAS);
      await page.locator("#quickClientForm button[type=submit]").click();
      await expect(page.locator("#quickClientDialog")).toBeHidden();

      await page.locator("#todoFormTask").fill(ENTRY_TITLE);
      await page.locator("#todoFormDate").fill(ENTRY_DATE);
      await page.locator("#todoFormStart").fill("08:00");
      await page.locator("#todoFormEnd").fill("10:00");
      await page.locator("#todoFormBillingKm").fill("10");
      await page.locator("#todoFormClientKm").fill("5");
      await page.locator("#saveTodoDialog").click();

      await expect(page.locator("#todoDialog")).toBeHidden();
      await expect(page.locator("#todoItems")).toContainText(ENTRY_TITLE);
      await expect(page.locator("#todoItems")).toContainText(CLIENT_ALIAS);
    } finally {
      await context.close();
    }
  });

  test("boss sees and confirms the worker payroll through the UI", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "bojan");
      await page.locator("#toolsMenu > summary").click();
      await page.locator("#billingMenuBtn").click();
      await expect(page.locator(".billing-screen")).toBeVisible();

      await page.locator("#billingWorker").selectOption("ibro");
      await page.locator("#billingFrom").fill("2025-06-01");
      await page.locator("#billingFrom").blur();
      await page.locator("#billingTo").fill("2025-06-30");
      await page.locator("#billingTo").blur();

      await expect(page.locator("#billingDayList")).toContainText("2 h po 15,00 EUR/h");
      await expect(page.locator("#billingSummary")).toContainText("2 h");
      await expect(page.locator("#billingSummary")).toContainText("30,00 EUR");
      await expect(page.locator("#billingSummary")).toContainText("10 km");

      await expect(page.locator("#billingConfirm")).toBeVisible();
      await expect(page.locator("#billingConfirm")).toBeEnabled();
      await page.locator("#billingConfirm").click();
      await expect(page.locator("#appConfirmDialog")).toBeVisible();
      await page.locator("#appConfirmAccept").click();
      await expect(page.locator("#billingState")).toContainText("Potrjeno");
      await expect(page.locator("#billingConfirm")).toBeHidden();
    } finally {
      await context.close();
    }
  });
  test("multi-day task is a continuous monthly span without an untimed label", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");
      const span = await page.evaluate(() => {
        const start = new Date();
        start.setHours(12, 0, 0, 0);
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
        const end = new Date(start);
        end.setDate(end.getDate() + 7);
        const key = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        return { start: key(start), end: key(end) };
      });
      const title = "PW večdnevno opravilo";
      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormTask").fill(title);
      await page.locator("#todoFormDate").fill(span.start);
      await page.locator("#todoFormEndDate").fill(span.end);
      await page.locator("#todoFormEndDate").blur();
      await expect(page.locator("#todoFormStart")).toBeDisabled();
      await expect(page.locator("#todoFormStart").locator("xpath=..")).toBeHidden();
      await page.locator("#saveTodoDialog").click();
      await expect(page.locator("#todoDialog")).toBeHidden();

      await page.locator("#calendarViewBtn").click();
      const startSpan = page.locator(`.day[data-date="${span.start}"] .day-multiday-event.is-span-start`);
      const continuation = page.locator(`.day[data-date="${span.end}"] .day-multiday-event.is-span-continuation`);
      await expect(startSpan).toHaveText(title);
      await expect(continuation).toHaveText("");
      expect(await page.locator(".day-multiday-event").evaluateAll((items) => items.every((item) => !item.textContent.includes("Brez ure")))).toBeTruthy();
    } finally {
      await context.close();
    }
  });

  test("queued task retries automatically after a transient server outage", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const title = "PW samodejni sync";
    let dropResponseAfterServerSave = true;
    try {
      await localLogin(page, "ibro");
      await page.route("**/api/todos", async (route, request) => {
        if (request.method() === "POST" && dropResponseAfterServerSave) {
          dropResponseAfterServerSave = false;
          const response = await route.fetch();
          expect(response.ok()).toBeTruthy();
          // The server has committed the create, but the browser loses its response.
          await route.abort("failed");
          return;
        }
        await route.continue();
      });

      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormTask").fill(title);
      await page.locator("#todoFormClient").fill(CLIENT_ALIAS);
      await page.locator("#saveTodoDialog").click();

      await expect(page.locator("#todoDialog")).toBeHidden();
      await expect(page.locator("#offlineSyncNotice")).toContainText("Povezava je na voljo");
      await page.unroute("**/api/todos");

      // No browser online event is dispatched here. The retry timer itself
      // must resend the queued mutation while navigator.onLine stays true.
      await expect(page.locator("#offlineSyncNotice")).toBeHidden({ timeout: 10_000 });
      await expect(page.locator("#todoItems")).toContainText(title);
      await expect.poll(() => page.locator("#todoItems .todo-item").filter({ hasText: title }).count(), { timeout: 10_000 }).toBe(1);
    } finally {
      await context.close();
    }
  });
});