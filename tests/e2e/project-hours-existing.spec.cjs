const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");

let app;
test.use({ viewport: { width: 393, height: 780 }, hasTouch: true });
test.beforeEach(async ({ page }) => {
  app = await startIsolatedTestApp();
  await page.goto(app.baseUrl);
  await page.locator("#localTestUser").selectOption("ibro");
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
  await page.waitForLoadState("networkidle");
});
test.afterEach(async () => { await app?.stop(); });

async function seed(page, { existing = true } = {}) {
  return page.evaluate(async ({ existing }) => {
    const payload = { title: "Popravilo inštalacijske omarice QA", client: "Project hours QA", status: "open", date: "2032-10-14", syncUser: "ibro", assigneeIds: ["ibro"] };
    const result = await api("/api/todos", { method: "POST", body: JSON.stringify(payload) });
    const source = result.todos.find(todo => todo.title === payload.title);
    const ids = [];
    if (existing) {
      for (const [start, end] of [["16:15", "17:15"], ["17:15", "18:15"]]) {
        const result = await api("/api/todos", { method: "POST", body: JSON.stringify({ ...payload, title: `Ure ${start}`, status: "execution", clientId: source.clientId, sourceProjectTodoId: source.id, start, end, clientKm: 1, billingKm: 1 }) });
        ids.push(result.todos.find(todo => todo.sourceProjectTodoId === source.id && todo.start === start).id);
      }
    }
    await loadAll();
    await openTodoDialog(state.todos.find(todo => todo.id === source.id));
    return { source, ids };
  }, { existing });
}

async function countHours(page, sourceId) {
  return page.evaluate(async sourceId => (await api("/api/todos")).todos.filter(todo => todo.sourceProjectTodoId === sourceId).length, sourceId);
}

test("existing hours: cancel, select a particular entry for editing, or explicitly create a new entry", async ({ page }) => {
  const { source, ids } = await seed(page);
  await page.locator("#writeHoursFromTodo").tap();
  await expect(page.locator("#projectHoursExistsDialog")).toBeVisible();
  await expect(page.locator("#projectHoursExistsList")).toContainText("16:15–17:15");
  await expect(page.locator("#projectHoursExistsList")).toContainText("17:15–18:15");
  await page.screenshot({ path: test.info().outputPath("existing-hours-choice.png") });
  await page.locator("#projectHoursExistsClose").tap();
  await expect(page.locator("#todoFormId")).toHaveValue(source.id);
  expect(await countHours(page, source.id)).toBe(2);
  await page.locator("#writeHoursFromTodo").tap();
  await page.locator(`#projectHoursExistsList input[value='${ids[1]}']`).check();
  await page.locator("#projectHoursExistsEdit").tap();
  await expect(page.locator("#todoFormId")).toHaveValue(ids[1]);
  await expect(page.locator("#todoFormStart")).toHaveValue("17:15");
  await expect(page.locator("#saveTodoDialog")).toBeEnabled();
  expect(await countHours(page, source.id)).toBe(2);
  await page.locator("#closeTodoDialog").tap();
  await expect(page.locator("#todoDialog")).toBeHidden();
  await page.evaluate(async sourceId => openTodoDialog(state.todos.find(todo => todo.id === sourceId)), source.id);
  await page.locator("#todoFooterWriteHours").tap();
  await page.locator("#projectHoursExistsCreate").tap();
  await expect(page.locator("#todoFormId")).toHaveValue("");
  await expect(page.locator("#todoFormStart")).toHaveValue("18:15");
  await page.locator("#todoFormClientKm").fill("1");
  await page.locator("#todoFormBillingKm").fill("1");
  await page.locator("#saveTodoDialog").tap();
  await expect(page.locator("#projectCompletionDialog")).toBeVisible();
  await expect(page.locator("#projectHoursExistsDialog")).toBeHidden();
  expect(await countHours(page, source.id)).toBe(3);
});

test("save rechecks the actual date and can edit an existing entry without creating a duplicate", async ({ page }) => {
  const { source, ids } = await seed(page);
  // Start a new project-hour form on another day to exercise the independent
  // pre-save safeguard after changing the date.
  await page.evaluate(async source => {
    await closeModalBeforeTransition(document.getElementById("todoDialog"));
    await openTodoDialog({ _hoursSourceId: source.id, client: source.client, clientId: source.clientId, title: source.title, date: "2032-10-15", status: "execution", syncUser: "ibro", _hoursAssigneeIds: ["ibro"], start: "18:15", end: "19:15" });
  }, source);
  await page.locator("#todoFormDate").fill(source.date);
  await page.locator("#saveTodoDialog").tap();
  await expect(page.locator("#projectHoursExistsDialog")).toBeVisible();
  await page.locator("#projectHoursExistsEdit").tap();
  await expect(page.locator("#todoFormId")).toHaveValue(ids[0]);
  await expect(page.locator("#todoFormStart")).toHaveValue("16:15");
  await expect(page.locator("#saveTodoDialog")).toBeEnabled();
  expect(await countHours(page, source.id)).toBe(2);
  // Editing itself must not be mistaken for another new entry.
  await page.locator("#todoFormNotes").fill("Popravljen opis");
  await page.locator("#saveTodoDialog").tap();
  await expect(page.locator("#todoDialog")).toBeHidden();
  await expect(page.locator("#projectHoursExistsDialog")).toBeHidden();
  expect(await countHours(page, source.id)).toBe(2);
});

test("closing during lookup never opens a late warning or another editor", async ({ page }) => {
  const { source } = await seed(page);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/project-hours?**", async route => { await gate; await route.continue(); });
  const request = page.waitForRequest("**/project-hours?**");
  await page.locator("#writeHoursFromTodo").tap();
  await request;
  await page.locator("#closeTodoDialog").tap();
  await expect(page.locator("#todoDialog")).toBeHidden();
  const response = page.waitForResponse("**/project-hours?**");
  release();
  await response;
  expect(await countHours(page, source.id)).toBe(2);
  await expect(page.locator("#todoDialog")).toBeHidden();
  await expect(page.locator("#projectHoursExistsDialog")).toBeHidden();
});

test("offline warning identifies cached entries and allows editing without creating new hours", async ({ page, context }) => {
  const { source, ids } = await seed(page);
  await context.setOffline(true);
  await page.locator("#writeHoursFromTodo").tap();
  await expect(page.locator("#projectHoursExistsMessage")).toContainText("Brez povezave");
  await expect(page.locator("#projectHoursExistsList")).toContainText("16:15–17:15");
  await page.locator("#projectHoursExistsEdit").tap();
  await expect(page.locator("#todoFormId")).toHaveValue(ids[0]);
  await expect(page.locator("#saveTodoDialog")).toBeEnabled();
  await context.setOffline(false);
  expect(await countHours(page, source.id)).toBe(2);
});

test("first entry has no warning; another device creating hours while the form is open triggers it at save", async ({ page }) => {
  const { source } = await seed(page, { existing: false });
  await page.locator("#writeHoursFromTodo").tap();
  await expect(page.locator("#todoFormId")).toHaveValue("");
  await expect(page.locator("#projectHoursExistsDialog")).toBeHidden();
  await page.evaluate(async source => {
    await api("/api/todos", { method: "POST", body: JSON.stringify({ title: "Other device", client: source.client, clientId: source.clientId, status: "execution", sourceProjectTodoId: source.id, date: source.date, start: "20:00", end: "21:00", syncUser: "ibro", assigneeIds: ["ibro"] }) });
  }, source);
  await page.locator("#saveTodoDialog").tap();
  await expect(page.locator("#projectHoursExistsDialog")).toBeVisible();
  await expect(page.locator("#projectHoursExistsList")).toContainText("20:00–21:00");
  await page.locator("#projectHoursExistsClose").tap();
  await expect(page.locator("#todoFormId")).toHaveValue("");
  await expect(page.locator("#saveTodoDialog")).toBeEnabled();
  expect(await countHours(page, source.id)).toBe(1);
});
