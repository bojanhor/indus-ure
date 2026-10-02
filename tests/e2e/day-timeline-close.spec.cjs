const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
// These tests deliberately hold/reject network writes; do not let a service
// worker bypass Playwright's request interception (notably in WebKit).
test.use({ serviceWorkers: "block" });
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

async function setup(page, title) {
  await page.goto(app.baseUrl);
  await page.locator("#localTestUser").selectOption("bojan");
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
  await page.waitForLoadState("networkidle");
  return page.evaluate(async title => {
    await api("/api/todos", { method: "POST", body: JSON.stringify({
      title, date: "2032-03-19", endDate: "2032-03-19", start: "09:00", end: "10:00",
      status: "open", assigneeIds: ["bojan"], syncUser: "bojan"
    }) });
    await loadAll();
    const todo = state.todos.find(todo => todo.title === title);
    openDayTimeline(todo.date);
    saveDayTimelineDraft(todo, "11:00", "12:00", todo.date);
    renderDayTimeline();
    return todo.id;
  }, title);
}

async function holdBatch(page, { fail = false } = {}) {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let count = 0;
  await page.route("**/api/todos/time-batch", async route => {
    count += 1;
    await gate;
    if (fail) await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Test zavrnitve shranjevanja" }) });
    else await route.continue();
  });
  return { release, count: () => count };
}

for (const width of [390, 1024]) {
  test(`X closes during a delayed save and the response does not close a reopened day (${width}px)`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const id = await setup(page, `Close pending ${width}`);
    const batch = await holdBatch(page);
    try {
      await page.locator("#saveDayTimeline").click();
      await expect.poll(batch.count).toBe(1);
      await expect(page.locator("#saveDayTimeline")).toBeDisabled();
      await expect(page.locator("#closeDayTimeline")).toBeEnabled();
      await page.locator("#dayTimelineDialog .modal-head").screenshot({ path: testInfo.outputPath(`saving-header-${width}.png`) });
      await page.locator("#closeDayTimeline").click();
      await expect(page.locator("#dayTimelineDialog")).toBeHidden();
      // Reopening the same day is a different view, even though its date matches.
      await page.evaluate(() => openDayTimeline("2032-03-19"));
      await expect(page.locator("#closeDayTimeline")).toBeEnabled();
      batch.release();
      await expect.poll(() => page.evaluate(() => state.dayTimelineSaving)).toBe(false);
      await expect(page.locator("#dayTimelineDialog")).toBeVisible();
      expect(batch.count()).toBe(1);
      expect(await page.evaluate(id => state.todos.find(todo => todo.id === id).start, id)).toBe("11:00");
      await expect(page.locator("#saveDayTimeline")).toBeDisabled();
      await page.locator("#closeDayTimeline").click();
      await expect(page.locator("#dayTimelineDialog")).toBeHidden();
    } finally { batch.release(); }
  });
}

test("a rejected save after X preserves drafts for an explicit retry", async ({ page }) => {
  const id = await setup(page, "Close failed save");
  const batch = await holdBatch(page, { fail: true });
  try {
    await page.locator("#saveDayTimeline").click();
    await expect.poll(batch.count).toBe(1);
    await page.locator("#closeDayTimeline").click();
    await expect(page.locator("#dayTimelineDialog")).toBeHidden();
    batch.release();
    await expect.poll(() => page.evaluate(() => state.dayTimelineSaving)).toBe(false);
    await expect(page.locator("#appNoticeMessage")).toContainText("Spremembe so ohranjene");
    expect(await page.evaluate(id => state.todos.find(todo => todo.id === id).start, id)).toBe("09:00");
    expect(await page.evaluate(id => state.dayTimelineDrafts.get(id).start, id)).toBe("11:00");
    await page.unroute("**/api/todos/time-batch");
    await page.evaluate(() => openDayTimeline("2032-03-19"));
    await expect(page.locator("#closeDayTimeline")).toBeEnabled();
    await expect(page.locator("#saveDayTimeline")).toBeEnabled();
    await page.locator("#saveDayTimeline").click();
    await expect(page.locator("#dayTimelineDialog")).toBeHidden();
    expect(await page.evaluate(id => state.todos.find(todo => todo.id === id).start, id)).toBe("11:00");
    expect(await page.evaluate(() => state.dayTimelineDrafts.size)).toBe(0);
  } finally { batch.release(); }
});

test("closing during the automatic pre-editor save does not open the editor afterwards", async ({ page }) => {
  const id = await setup(page, "Close before edit");
  const batch = await holdBatch(page);
  try {
    await page.evaluate(id => {
      void openTodoFromDayTimeline(state.todos.find(todo => todo.id === id));
    }, id);
    await expect.poll(batch.count).toBe(1);
    await page.locator("#closeDayTimeline").click();
    await expect(page.locator("#dayTimelineDialog")).toBeHidden();
    batch.release();
    await expect.poll(() => page.evaluate(() => state.dayTimelineSaving)).toBe(false);
    await expect(page.locator("#todoDialog")).toBeHidden();
    await expect(page.locator("#dayTimelineDialog")).toBeHidden();
    expect(await page.evaluate(id => state.todos.find(todo => todo.id === id).start, id)).toBe("11:00");
  } finally { batch.release(); }
});

test("X discards unsent drafts, while Escape also works during a submitted save", async ({ page }) => {
  const id = await setup(page, "Close versus discard");
  await page.locator("#closeDayTimeline").click();
  await expect(page.locator("#dayTimelineDialog")).toBeHidden();
  expect(await page.evaluate(() => state.dayTimelineDrafts.size)).toBe(0);
  expect(await page.evaluate(id => state.todos.find(todo => todo.id === id).start, id)).toBe("09:00");
  await page.evaluate(id => {
    openDayTimeline("2032-03-19");
    saveDayTimelineDraft(state.todos.find(todo => todo.id === id), "11:00", "12:00", "2032-03-19");
    renderDayTimeline();
  }, id);
  const batch = await holdBatch(page);
  try {
    await page.locator("#saveDayTimeline").click();
    await expect.poll(batch.count).toBe(1);
    await page.keyboard.press("Escape");
    await expect(page.locator("#dayTimelineDialog")).toBeHidden();
    batch.release();
    await expect.poll(() => page.evaluate(() => state.dayTimelineSaving)).toBe(false);
    expect(await page.evaluate(id => state.todos.find(todo => todo.id === id).start, id)).toBe("11:00");
  } finally { batch.release(); }
});
