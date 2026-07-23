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
});