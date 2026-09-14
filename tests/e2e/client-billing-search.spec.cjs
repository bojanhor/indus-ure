const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

async function openFixture(page) {
  await page.goto(app.baseUrl);
  await page.locator("#localTestUser").selectOption("bojan");
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  const hydrated = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/bootstrap" && !new URL(response.url()).search);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
  await hydrated;
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => {
    state.clients = Array.from({ length: 250 }, (_, i) => ({ id: `qa-client-${i}`, name: `QA stranka ${i}`, search: `Vzdevek ${i}` }));
    state.todos = Array.from({ length: 600 }, (_, i) => ({
      id: `qa-event-${i}`, clientId: `qa-client-${i % 250}`, client: `QA stranka ${i % 250}`,
      title: `Menjava konektorja in kamere z dolgim podrobnim naslovom, ki mora ostati v celoti viden tudi na telefonu ${i}`,
      notes: "Večvrstični podroben opis izvedenih del in uporabljenega materiala. ".repeat(14),
      status: "execution", done: true, date: "2026-09-14", start: "08:00", end: "09:30",
      syncUser: "ibro", createdBy: "ibro", assigneeIds: ["ibro"], photos: [], driveFiles: []
    }));
    state.entries = []; state.clientBills = [];
    state.showClientPending = true; state.showClientBilled = false;
    state.reportClient = ""; state.reportClientId = "";
    $("reportClient").value = "";
    setView("report"); renderReport();
  });
}

test("billing search builds the directory once, keeps exact matches in overview and restores filtered Back", async ({ page }) => {
  await openFixture(page);
  const measurement = await page.evaluate(() => {
    const original = allClientRecords;
    let builds = 0;
    allClientRecords = function () { if (!clientLookupSnapshot) builds++; return original(); };
    const start = performance.now();
    try { renderReport(); return { ms: performance.now() - start, builds }; }
    finally { allClientRecords = original; }
  });
  expect(measurement.builds).toBe(1);
  expect(measurement.ms).toBeLessThan(1000);
  console.log("600-event billing render:", measurement);
  await page.locator("#reportClient").fill("QA stranka 249");
  await expect(page.locator(".open-client-report")).toHaveCount(1);
  await expect(page.locator("#reportClient")).toBeVisible();
  await expect(page.locator("#reportBackToClients")).toBeHidden();
  await page.locator("#reportClient").press("Enter");
  await expect(page.locator("#clientDetailTitle")).toHaveText("Poročilo: QA stranka 249");
  await page.locator("#reportBackToClients").click();
  await expect(page.locator("#reportClient")).toHaveValue("QA stranka 249");
  await expect(page.locator(".open-client-report")).toHaveCount(1);
  await page.locator("#reportClient").press("Escape");
  await expect(page.locator(".open-client-report")).toHaveCount(250);
  await page.locator("#reportClient").fill("Vzdevek 249");
  await expect(page.locator(".open-client-report")).toHaveCount(1);
});

test("search closes on blank panel space, outside clicks and Escape without swallowing results", async ({ page }) => {
  await openFixture(page);
  await page.locator("#clientSearch").fill("Menjava");
  await expect(page.locator("#searchPanel")).toHaveClass(/active/);
  await page.locator("[data-search-filter='completed']").check();
  await expect(page.locator("#searchPanel .result")).toHaveCount(600);
  await expect(page.locator("#clientSearch")).toHaveValue("Menjava");
  await page.locator("#searchPanel").click({ position: { x: 2, y: 2 } });
  await expect(page.locator("#clientSearch")).toHaveValue("");
  await page.locator("#clientSearch").fill("Menjava");
  await expect(page.locator("#searchPanel")).toHaveClass(/active/);
  await page.locator("#clientSearch").press("Escape");
  await expect(page.locator("#searchPanel")).not.toHaveClass(/active/);
  await page.locator("#clientSearch").fill("does-not-exist");
  await page.getByRole("heading", { name: "Obračun strank", exact: true }).click();
  await expect(page.locator("#clientSearch")).toHaveValue("");
  await page.waitForTimeout(180);
  await expect(page.locator("#searchPanel")).not.toHaveClass(/active/);
  await page.locator("#clientSearch").fill("does-not-exist");
  await page.getByRole("button", { name: "Zapri iskanje", exact: true }).click();
  await expect(page.locator("#clientSearch")).toHaveValue("");
});

test("billing title and notes grow and shrink at mobile and desktop widths; edits save through existing endpoint", async ({ page }, testInfo) => {
  await openFixture(page);
  await page.locator("#reportClient").fill("QA stranka 249");
  await expect(page.locator(".open-client-report")).toHaveCount(1);
  await page.locator(".open-client-report").click();
  for (const width of [390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const title = page.locator(".client-billing-inline-title").first();
    await expect.poll(() => title.evaluate((field) => field.scrollHeight <= field.clientHeight + 1)).toBe(true);
    const notes = page.locator(".client-billing-inline-description").first();
    await expect.poll(() => notes.evaluate((field) => field.scrollHeight <= field.clientHeight + 1)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`billing-autosize-${width}.png`) });
  }
  let saved;
  await page.route("**/api/todos/qa-event-249/client-billing-fields", async (route) => {
    saved = route.request().postDataJSON();
    const todos = await page.evaluate((title) => state.todos.map((todo) => todo.id === "qa-event-249" ? { ...todo, title } : todo), saved.title);
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ todos }) });
  });
  const title = page.locator(".client-billing-inline-title").first();
  const oldHeight = await title.evaluate((field) => field.clientHeight);
  await title.fill("Kratek naslov");
  await expect.poll(() => title.evaluate((field) => field.clientHeight)).toBeLessThanOrEqual(oldHeight);
  await title.press("Enter");
  await expect.poll(() => saved?.title).toBe("Kratek naslov");
  await expect(page.locator(".client-billing-inline-title").first()).toHaveValue("Kratek naslov");
});
