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

test("billing compares read-only recorded hours with billable hours, including groups, zero and locked entries", async ({ page }, testInfo) => {
  await openFixture(page);
  await page.evaluate(() => {
    const make = (id, extra = {}) => ({ id, assignmentGroupId: id, title: id, clientId: "qa-client-0", client: "QA stranka 0", status: "execution", done: true, date: "2026-09-14", start: "08:00", end: "11:00", syncUser: "ibro", createdBy: "ibro", assigneeIds: ["ibro"], clientBillableMinutes: 240, ...extra });
    state.todos = [make("More"), make("Equal", { clientBillableMinutes: null }), make("Zero", { clientBillableMinutes: 0 }),
      make("Shared", { assignmentGroupId: "group", eventClientBillableMinutes: 240 }),
      make("Shared other", { assignmentGroupId: "group", syncUser: "bojan", end: "10:00", eventClientBillableMinutes: 240 }),
      make("Shared trashed", { assignmentGroupId: "group", trashedAt: "2026-09-20" }),
      make("Locked", { clientBillId: "confirmed" }), make("Material", { status: "material" }), make("Note", { status: "note" }), make("Warranty", { warranty: true })];
    state.clientBills = [{ id: "confirmed", status: "confirmed", eventIds: ["Locked"], confirmedAt: new Date().toISOString() }];
    state.showClientBilled = true;
    openClientReport("QA stranka 0", "qa-client-0");
  });
  await expect(page.locator("#reportHoursMode, #reportHoursModeOption")).toHaveCount(0);
  const row = title => page.locator(".client-billing-row").filter({ has: page.locator(`textarea[data-todo-id="${title}"]`) });
  const more = row("More"), equal = row("Equal"), zero = row("Zero"), shared = row("Shared");
  for (const [item, recorded, billed, message] of [[more, "3", "4", "Za obračun je 1 h več."], [equal, "3", "3", ""], [zero, "3", "0", "Za obračun je 3 h manj."], [shared, "5", "4", "Za obračun je 1 h manj."]]) {
    await expect(item.getByRole("textbox", { name: "Vpisane ure", exact: true })).toHaveValue(recorded);
    await expect(item.getByRole("textbox", { name: "Vpisane ure", exact: true })).toHaveAttribute("readonly", "");
    await expect(item.getByRole("spinbutton", { name: "Za obračun ur", exact: true })).toHaveValue(billed);
    const notice = item.locator(".client-billing-hours-difference");
    if (message) { await expect(notice).toHaveText(message); await expect(item.locator(".client-billing-inline-fields")).toHaveClass(/has-hours-difference/); }
    else { await expect(notice).toBeHidden(); await expect(item.locator(".client-billing-inline-fields")).not.toHaveClass(/has-hours-difference/); }
  }
  const locked = page.locator(".client-billing-row").filter({ has: page.locator('[data-cancel-client-bill-id="confirmed"]') });
  await expect(locked.locator(".client-billing-inline-fields")).toHaveCount(0);
  await expect(locked).toContainText("Vpisane ure: 3 h");
  await expect(locked).toContainText("Za obračun: 4 h");
  for (const name of ["Material", "Note", "Warranty"]) await expect(row(name).locator(".client-billing-worker-hours")).toHaveCount(0);
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const recorded = await more.locator(".client-billing-worker-hours").boundingBox();
    const billed = await more.getByRole("spinbutton", { name: "Za obračun ur", exact: true }).boundingBox();
    expect(recorded.x).toBeLessThan(billed.x);
    expect(Math.abs(recorded.y - billed.y)).toBeLessThan(2);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`billing-hours-${width}.png`), fullPage: true });
  }
  // Live feedback does not save or alter the recorded time until the existing
  // change handler is triggered; returning to the stored value sends no write.
  const input = more.getByRole("spinbutton", { name: "Za obračun ur", exact: true });
  await input.fill("3");
  await expect(more.locator(".client-billing-hours-difference")).toBeHidden();
  await input.fill("4");
  await expect(more.locator(".client-billing-hours-difference")).toHaveText("Za obračun je 1 h več.");
  await expect(more.locator(".client-billing-worker-hours")).toHaveValue("3");
});

test("saving billable hours preserves worker time and survives refresh", async ({ page }) => {
  await openFixture(page);
  const id = await page.evaluate(async () => {
    const result = await api("/api/todos", { method: "POST", body: JSON.stringify({ title: "Recorded hours integration", client: "Hours integration", status: "execution", date: "2032-05-10", start: "08:00", end: "11:00", syncUser: "ibro", assigneeIds: ["ibro"] }) });
    const todo = result.todos.find(item => item.title === "Recorded hours integration");
    await loadAll();
    state.showClientPending = true;
    openClientReport(todo.client, todo.clientId);
    return todo.id;
  });
  const row = page.locator(".client-billing-row").filter({ has: page.locator(`[data-todo-id="${id}"]`) });
  await expect(row.locator(".client-billing-worker-hours")).toHaveValue("3");
  const field = row.getByRole("spinbutton", { name: "Za obračun ur", exact: true });
  const saved = page.waitForResponse(response => response.url().includes(`/api/todos/${id}/client-billing-fields`) && response.request().method() === "POST");
  await field.fill("4");
  await field.press("Enter");
  expect((await saved).status()).toBe(200);
  await expect(row.locator(".client-billing-hours-difference")).toHaveText("Za obračun je 1 h več.");
  const stored = await page.evaluate(async id => (await api(`/api/todos/${id}`)).todo, id);
  expect(stored.start).toBe("08:00"); expect(stored.end).toBe("11:00"); expect(stored.clientBillableMinutes).toBe(240);
  await page.reload();
  await expect(page.locator("#app")).toBeVisible();
  await page.waitForLoadState("networkidle");
  await page.evaluate(async id => { await loadAll(); const todo = state.todos.find(t => t.id === id); setView("report"); openClientReport(todo.client, todo.clientId); }, id);
  await expect(row.locator(".client-billing-worker-hours")).toHaveValue("3");
  await expect(row.getByRole("spinbutton", { name: "Za obračun ur", exact: true })).toHaveValue("4");
  await expect(row.locator(".client-billing-hours-difference")).toHaveText("Za obračun je 1 h več.");
});
