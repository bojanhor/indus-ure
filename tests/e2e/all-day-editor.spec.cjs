const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

async function login(page) {
  await page.goto(app.baseUrl);
  await page.locator("#localTestUser").selectOption("bojan");
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
  await page.waitForLoadState("networkidle");
}

async function showDateTime(page) {
  if (!await page.locator("#todoFormQuickTimeStart").isVisible()) {
    await page.locator("#todoFormDateTimeSection > summary").click();
  }
}

for (const target of ["start", "end"]) {
  test(`Cel dan from ${target} clears both times and persists the untimed task`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: target === "start" ? 390 : 1024, height: 900 });
    await login(page);
    const title = `All-day editor ${target}`;
    await page.evaluate(async (title) => {
      await api("/api/todos", { method: "POST", body: JSON.stringify({
        title, date: "2032-03-19", endDate: "2032-03-19", start: "10:15", end: "12:45",
        status: "open", assigneeIds: ["bojan"], syncUser: "bojan"
      }) });
      await loadAll();
      await openTodoDialog(state.todos.find(todo => todo.title === title));
    }, title);
    await expect(page.locator("#saveTodoDialog")).toBeEnabled();
    await showDateTime(page);
    await expect(page.locator("#todoFormQuickTimeStart")).toHaveText("Od 10:15");
    await expect(page.locator("#todoFormQuickTimeEnd")).toHaveText("Do 12:45");
    await expect(page.getByRole("button", { name: "Cel dan", exact: true })).toBeHidden();
    await page.locator(`[data-time-picker-target="${target}"]`).click();
    const allDay = page.getByRole("button", { name: "Cel dan", exact: true });
    await expect(allDay).toBeVisible();
    await page.locator("#todoFormQuickTimePicker").screenshot({ path: testInfo.outputPath(`picker-${target}.png`) });
    await allDay.click();
    await expect(page.locator("#todoFormQuickTimeStart")).toHaveText("Od ---");
    await expect(page.locator("#todoFormQuickTimeEnd")).toHaveText("Do ---");
    await expect(page.locator("#todoFormStart")).toHaveValue("");
    await expect(page.locator("#todoFormEnd")).toHaveValue("");
    await expect(page.locator("#todoFormDate")).toHaveValue("2032-03-19");
    await expect(page.locator("#todoFormEndDate")).toHaveValue("2032-03-19");
    await expect(page.locator("#todoFormQuickTimeDial")).toBeHidden();
    await page.locator("#saveTodoDialog").click();
    await expect(page.locator("#todoDialog")).toBeHidden();
    await page.reload();
    await expect(page.locator("#app")).toBeVisible();
    const saved = await page.evaluate(async title => {
      await loadAll();
      const todo = state.todos.find(todo => todo.title === title);
      await openTodoDialog(todo);
      return { start: todo.start, end: todo.end, date: todo.date, endDate: todo.endDate };
    }, title);
    expect(saved).toEqual({ start: "", end: "", date: "2032-03-19", endDate: "2032-03-19" });
    await showDateTime(page);
    await expect(page.locator("#todoFormQuickTimeStart")).toHaveText("Od ---");
    await expect(page.locator("#todoFormQuickTimeEnd")).toHaveText("Do ---");
    await page.locator("#todoFormQuickTimePicker").screenshot({ path: testInfo.outputPath(`all-day-${target}.png`) });
    // The untimed task can still be assigned a time using the existing picker.
    await page.locator("#todoFormQuickTimeStart").click();
    await page.locator('[data-time-picker-hour="8"]').click();
    await page.locator('[data-time-picker-minute="0"]').click();
    await page.locator('[data-time-picker-hour="9"]').click();
    await page.locator('[data-time-picker-minute="0"]').click();
    await expect(page.locator("#todoFormQuickTimeStart")).toHaveText("Od 08:00");
    await expect(page.locator("#todoFormQuickTimeEnd")).toHaveText("Do 09:00");
    await expect(page.locator("#todoFormQuickTimeDuration")).toHaveText("Skupaj 1 h");
  });
}

test("new untimed task shows empty labels, and required hours have no all-day action", async ({ page }) => {
  await login(page);
  await page.locator("#newTodoButton").click();
  await showDateTime(page);
  await expect(page.locator("#todoFormQuickTimeStart")).toHaveText("Od ---");
  await expect(page.locator("#todoFormQuickTimeEnd")).toHaveText("Do ---");
  await page.locator("#closeTodoDialog").click();
  for (const status of ["execution", "meal", "drive", "purchase"]) {
    await page.evaluate(status => openTodoDialog({ _standaloneHours: true, status, date: "2032-03-20" }), status);
    await showDateTime(page);
    await page.locator("#todoFormQuickTimeStart").click();
    await expect(page.getByRole("button", { name: "Cel dan", exact: true })).toBeHidden();
    expect(await page.evaluate(() => setTodoFormAllDay())).toBe(false);
    await expect(page.locator("#todoFormStart")).not.toHaveValue("");
    await expect(page.locator("#todoFormEnd")).not.toHaveValue("");
    await page.locator("#closeTodoDialog").click();
  }
});
