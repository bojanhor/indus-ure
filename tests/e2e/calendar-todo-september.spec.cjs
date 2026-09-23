const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

async function login(page, user = "bojan") {
  await page.goto(app.baseUrl);
  await page.locator("#localTestUser").selectOption(user);
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
}

test("boss calendar filters external workers, grouped planning and recorded hours; worker view stays independent", async ({ page, browser }) => {
  await login(page);
  const external = await page.evaluate(async () => {
    const { worker } = await api("/api/workers", { method: "POST", body: JSON.stringify({ name: "Zunanji izvajalci QA" }) });
    const cases = [
      ["External planning QA", "open", [worker.id], "08:00", "09:00"],
      ["External hours QA", "execution", [worker.id], "09:00", "10:00"],
      ["Bojan planning QA", "open", ["bojan"], "10:00", "11:00"],
      ["Shared planning QA", "open", ["ibro", worker.id], "11:00", "12:00"],
      ["Ibro planning QA", "open", ["ibro"], "12:00", "13:00"]
    ];
    for (const [title, status, assigneeIds, start, end] of cases) {
      await api("/api/todos", { method: "POST", body: JSON.stringify({ title, status, assigneeIds, syncUser: assigneeIds[0], date: "2032-04-05", start, end, client: "Calendar QA" }) });
    }
    await refreshAfterWorkerManagement();
    state.current = new Date(2032, 3, 1);
    setWorkContext("admin");
    setView("calendar");
    renderMonth();
    return worker;
  });
  const cards = page.locator("#calendar .day-todo");
  await expect(page.locator("#calendarWorkerFilter")).toBeVisible();
  await expect(cards.filter({ hasText: "External planning QA" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "External hours QA" })).toHaveCount(0);
  await expect(cards.filter({ hasText: "Shared planning QA" })).toHaveCount(1);
  await expect(cards.filter({ hasText: "Shared planning QA" }).locator(".day-todo-worker")).toContainText("Ibro");
  await expect(cards.filter({ hasText: "Shared planning QA" }).locator(".day-todo-worker")).toContainText(external.name);
  await page.locator("#calendarWorkerFilter").selectOption(external.id);
  await expect(cards.filter({ hasText: "Bojan planning QA" })).toHaveCount(0);
  await expect(cards.filter({ hasText: "Ibro planning QA" })).toHaveCount(0);
  await expect(cards.filter({ hasText: "Shared planning QA" })).toHaveCount(1);
  await page.locator("#calendarCompletedFilter").check();
  await expect(cards.filter({ hasText: "External hours QA" })).toHaveCount(1);
  await page.screenshot({ path: test.info().outputPath("calendar-external-filter.png") });

  await page.evaluate(() => openDayTimeline("2032-04-05"));
  const events = page.locator("#dayTimelineEvents .day-timeline-event");
  await expect(events).toHaveCount(3);
  await expect(events.filter({ hasText: "External hours QA" }).locator(".day-timeline-event-meta")).toHaveText("09:00-10:00 | Zunanji izvajalci QA | Calendar QA");
  await expect(page.locator("#dayTimelineFit")).toHaveText("24h");
  await expect(page.locator("#dayTimelineZoomValue")).toHaveCount(0);
  const height = await page.locator("#dayTimeline").evaluate(element => element.offsetHeight);
  await page.locator("#dayTimelineZoomIn").click();
  expect(await page.locator("#dayTimeline").evaluate(element => element.offsetHeight)).toBeGreaterThan(height);
  await page.locator("#dayTimelineZoomOut").click();
  await page.locator("#dayTimelineFit").click();
  expect(await page.locator("#dayTimelineScroll").evaluate(element => element.scrollTop)).toBe(0);
  await expect(page.locator("#dayTimelineFit")).toHaveText("15h");
  await expect(page.locator("#dayTimelineZoomIn svg")).toHaveCount(1);
  await expect(page.locator("#dayTimelineZoomOut svg")).toHaveCount(1);
  await page.locator("#dayTimelineWorkerFilter").selectOption("bojan");
  await expect(events).toHaveCount(1);
  await expect(events).toContainText("Bojan planning QA");
  await expect(page.locator("#calendarWorkerFilter")).toHaveValue("bojan");
  await expect(page.locator("#dayTimelineFit")).toHaveText("15h");
  await page.locator("#dayTimelineWorkerFilter").selectOption(external.id);
  await expect(events).toHaveCount(3);
  await page.locator("#dayTimelineFit").click();
  await expect(page.locator("#dayTimelineFit")).toHaveText("24h");
  expect(await page.locator("#dayTimelineScroll").evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await page.evaluate(() => {
    const todo = state.todos.find(todo => todo.title === "External planning QA");
    saveDayTimelineDraft(todo, "08:15", "09:15", todo.date);
    renderDayTimeline();
  });
  await page.locator("#dayTimelineWorkerFilter").selectOption("bojan");
  await expect(page.getByText("Najprej shrani ali prekliči spremembe dnevne časovnice.", { exact: true })).toBeVisible();
  await expect(page.locator("#dayTimelineWorkerFilter")).toHaveValue(external.id);
  expect(await page.evaluate(() => state.dayTimelineDrafts.size)).toBe(1);
  await page.locator("#dayTimelineDialog .modal-global-notice").getByRole("button", { name: "Zapri obvestilo" }).click();
  await page.evaluate(() => {
    const todo = state.todos.find(todo => todo.title === "External planning QA");
    saveDayTimelineDraft(todo, todo.start, todo.end, todo.date);
    renderDayTimeline();
  });
  await page.screenshot({ path: test.info().outputPath("daily-calendar-controls.png") });
  await page.locator("#closeDayTimeline").click();

  await page.reload();
  await expect(page.locator("#app")).toBeVisible();
  await page.evaluate(() => { state.current = new Date(2032, 3, 1); setView("calendar"); renderMonth(); });
  await expect(page.locator("#calendarWorkerFilter")).toHaveValue(external.id);
  await expect(page.locator("#calendarCompletedFilter")).toBeChecked();
  await expect(cards.filter({ hasText: "Bojan planning QA" })).toHaveCount(0);
  await page.evaluate(() => setWorkContext("worker:ibro"));
  await expect(page.locator("#calendarWorkerFilter")).toBeHidden();
  await expect(cards.filter({ hasText: "Ibro planning QA" })).toHaveCount(1);
  await expect(page.locator("#calendar .day-todo-worker")).toHaveCount(0);
  await page.evaluate(() => setWorkContext("admin"));
  await expect(page.locator("#calendarWorkerFilter")).toHaveValue(external.id);
  await page.locator("#calendarWorkerFilter").selectOption("");
  await expect(cards.filter({ hasText: "Bojan planning QA" })).toHaveCount(1);

  const context = await browser.newContext();
  try {
    const workerPage = await context.newPage();
    await login(workerPage, "ibro");
    await workerPage.evaluate(() => { state.current = new Date(2032, 3, 1); setView("calendar"); renderMonth(); });
    await expect(workerPage.locator("#calendarWorkerFilter")).toBeHidden();
    await expect(workerPage.locator("#calendar .day-todo").filter({ hasText: "External planning QA" })).toHaveCount(0);
    await expect(workerPage.locator("#calendar .day-todo").filter({ hasText: "Shared planning QA" })).toHaveCount(1);
  } finally { await context.close(); }
});

test("mobile weekday labels follow both date fields, shortcuts, clearing and single-day hours", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.locator("#newTodoButton").click();
  await page.locator("#todoFormDateTimeSection > summary").click();
  await page.locator("#todoFormDate").fill("2026-09-28");
  await page.locator("#todoFormDate").dispatchEvent("change");
  await expect(page.locator("#todoFormDateWeekday")).toHaveText("(pon)");
  await expect(page.locator("#todoFormEndDateWeekday")).toHaveText("(pon)");
  await page.locator("#setTodoFormEndDateTomorrow").click();
  await expect(page.locator("#todoFormEndDateWeekday")).toHaveText("(tor)");
  await page.locator("#advanceTodoFormDate").click();
  await expect(page.locator("#todoFormDateWeekday")).toHaveText("(tor)");
  await page.locator("#todoFormEndDate").fill("2026-10-25");
  await page.locator("#todoFormEndDate").dispatchEvent("change");
  await expect(page.locator("#todoFormEndDateWeekday")).toHaveText("(ned)");
  await page.screenshot({ path: test.info().outputPath("mobile-weekdays.png") });
  await page.locator("#clearTodoFormDate").click();
  await expect(page.locator("#todoFormDateWeekday")).toBeEmpty();
  await expect(page.locator("#todoFormEndDateWeekday")).toBeEmpty();
  await page.getByRole("tab", { name: "Vpis ur", exact: true }).click();
  await expect(page.locator("#todoFormStatus")).toHaveValue("execution");
  await expect(page.locator("#todoFormDate")).toBeVisible();
  await page.locator("#todoFormDate").fill("2026-10-25");
  await page.locator("#todoFormDate").dispatchEvent("change");
  await expect(page.locator("#todoFormDateWeekday")).toHaveText("(ned)");
  await expect(page.locator("#todoFormEndDateWeekday")).toHaveText("(ned)");
  await expect(page.locator("#todoFormEndDate")).toBeDisabled();
  await page.locator("#advanceTodoFormDate").click();
  await expect(page.locator("#todoFormDateWeekday")).toHaveText("(pon)");
  await expect(page.locator("#todoFormEndDateWeekday")).toHaveText("(pon)");
  await page.locator("#closeTodoDialog").click();
  await expect(page.locator("#todoDialog")).toBeHidden();
  await page.evaluate(() => openDayTimeline("2026-10-26"));
  await expect(page.locator("#dayTimelineFit")).toBeVisible();
  await expect(page.locator("#dayTimelineFit")).toHaveText("24h");
  await expect(page.locator("#dayTimelineDialog .gesture-zoom-controls")).not.toContainText("%");
  await expect(page.locator("#dayTimelineWorkerFilter")).toBeVisible();
  expect((await page.locator("#dayTimelineWorkerFilter").boundingBox()).width).toBeGreaterThanOrEqual(170);
  await page.locator("#dayTimelineFit").click();
  await expect(page.locator("#dayTimelineFit")).toHaveText("15h");
  const size = await page.locator("#dayTimelineScroll").evaluate(element => ({ viewport: element.clientHeight, timeline: element.querySelector("#dayTimeline").offsetHeight }));
  expect(Math.abs(size.viewport - size.timeline)).toBeLessThanOrEqual(1);
  await page.screenshot({ path: test.info().outputPath("mobile-day-toolbar.png") });
});
