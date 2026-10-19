const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
let app;
test.beforeEach(async () => { app = await startIsolatedTestApp(); });
test.afterEach(async () => { await app?.stop(); });

async function setup(page) {
  await page.goto(app.baseUrl);
  await page.locator("#localTestUser").selectOption("bojan");
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
  await page.waitForLoadState("networkidle");
  const id = await page.evaluate(async () => {
    // Match the reported narrow daily view: a gray plan beside three green
    // hour entries. Keep the real task list underneath the modal: in Firefox
    // a retargeted click used to open a second editor from that list.
    for (const [status, start, end] of [
      ["open", "16:15", "18:15"],
      ["execution", "16:15", "17:15"],
      ["execution", "17:15", "18:15"],
      ["execution", "18:15", "19:15"]
    ]) {
      await api("/api/todos", { method: "POST", body: JSON.stringify({
        title: "Popravilo inštalacijske omarice", status, date: "2032-10-14", start, end,
        assigneeIds: ["bojan"], client: "PETERNEL TINA tilkova"
      }) });
    }
    await loadTodos();
    setWorkContext("admin");
    openDayTimeline("2032-10-14");
    return state.todos.find(todo => todo.title === "Popravilo inštalacijske omarice" && todo.status === "open").id;
  });
  await frames(page);
  await page.evaluate(() => {
    state.dayTimelineMinuteHeight = 1.5;
    renderDayTimeline();
    $("dayTimelineScroll").scrollTop = 13 * 60 * 1.5;
  });
  return id;
}

async function frames(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function view(page) {
  return page.evaluate(() => ({ zoom: state.dayTimelineMinuteHeight, top: $("dayTimelineScroll").scrollTop, left: $("dayTimelineScroll").scrollLeft }));
}

for (const pointer of ["touch", "mouse"]) {
  test(`${pointer}: one daily tap opens only the selected plan and closing restores zoom/scroll`, async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 393, height: 780 }, hasTouch: true, serviceWorkers: "block" });
    const page = await context.newPage();
    try {
      const id = await setup(page);
      const card = page.locator(`.day-timeline-event[data-todo-id="${id}"]`);
      await card.scrollIntoViewIfNeeded();
      let lockRequests = 0;
      page.on("request", request => { if (request.method() === "POST" && request.url().endsWith("/lock")) lockRequests++; });
      // Left half (safe pan), right body, and both resize handles must all
      // support a short tap. A hold/drag is covered by safe-drag.spec.cjs.
      for (const [xPart, yPart] of [[.25, .4], [.75, .5], [.9, .03], [.9, .97]]) {
        const before = await view(page);
        const previousRequests = lockRequests;
        const box = await card.boundingBox();
        if (pointer === "touch") await page.touchscreen.tap(box.x + box.width * xPart, box.y + box.height * yPart);
        else await page.mouse.click(box.x + box.width * xPart, box.y + box.height * yPart);
        await expect(page.locator("#todoDialog")).toBeVisible();
        await expect(page.locator("#todoFormId")).toHaveValue(id);
        await expect(page.locator("#todoFormTask")).toBeEnabled();
        await page.waitForTimeout(300); // Allow the compatibility click and history traversal to settle.
        await expect(page.locator("#todoDialog")).toBeVisible();
        await expect(page.locator("#todoFormId")).toHaveValue(id);
        expect(lockRequests - previousRequests).toBe(1);
        await expect(page.locator("#dayTimelineDialog")).toBeHidden();
        if (xPart === .25) await page.screenshot({ path: testInfo.outputPath(`daily-${pointer}-editor.png`) });
        // The next intentional tap must NOT be swallowed by the guard.
        if (pointer === "touch") await page.locator("#closeTodoDialog").tap();
        else await page.locator("#closeTodoDialog").click();
        await expect(page.locator("#dayTimelineDialog")).toBeVisible();
        await frames(page);
        expect(await view(page)).toEqual(before);
        expect(await page.evaluate(() => state.dayTimelineDrafts.size)).toBe(0);
        await page.waitForFunction(() => !state.todoEditLock && !state.todoLockPending);
      }
      await page.screenshot({ path: testInfo.outputPath(`daily-${pointer}-returned.png`) });
      const persisted = await page.evaluate(async id => (await api("/api/todos")).todos.find(todo => todo.id === id), id);
      expect(persisted).toMatchObject({ date: "2032-10-14", start: "16:15", end: "18:15" });
    } finally { await context.close(); }
  });
}

test("empty daily tap creates one form; keyboard opening and browser Back keep the daily position", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 393, height: 780 }, hasTouch: true, serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    const id = await setup(page);
    const before = await view(page);
    const scrollBox = await page.locator("#dayTimelineScroll").boundingBox();
    await page.touchscreen.tap(scrollBox.x + 100, scrollBox.y + 65);
    await expect(page.locator("#todoDialog")).toBeVisible();
    await expect(page.locator("#todoFormId")).toHaveValue("");
    await page.waitForTimeout(300);
    await expect(page.locator("#todoDialog")).toBeVisible();
    await expect(page.locator("#todoFormTask")).toHaveValue("");
    await page.locator("#closeTodoDialog").tap();
    await expect(page.locator("#dayTimelineDialog")).toBeVisible();
    await frames(page);
    expect(await view(page)).toEqual(before);
    const card = page.locator(`.day-timeline-event[data-todo-id="${id}"]`);
    await card.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#todoFormTask")).toBeEnabled();
    await expect(page.locator("#todoFormId")).toHaveValue(id);
    await page.goBack();
    await expect(page.locator("#todoDialog")).toBeHidden();
    await expect(page.locator("#dayTimelineDialog")).toBeVisible();
    await frames(page);
    expect(await view(page)).toEqual(before);
  } finally { await context.close(); }
});

test("a deliberate held click without a drag still opens the event instead of being swallowed", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 980, height: 860 }, serviceWorkers: "block" });
  const page = await context.newPage();
  try {
    const id = await setup(page);
    const card = page.locator(`.day-timeline-event[data-todo-id="${id}"]`);
    await card.scrollIntoViewIfNeeded();
    const box = await card.boundingBox();
    await page.mouse.move(box.x + box.width * .7, box.y + box.height / 2);
    await page.mouse.down();
    expect(await page.evaluate(() => state.dayTimelineInteraction?.touchReady)).toBe(false);
    await expect(card).toHaveClass(/is-drag-ready/);
    await page.mouse.up();
    await expect(page.locator("#todoDialog")).toBeVisible();
    await expect(page.locator("#todoFormId")).toHaveValue(id);
    expect(await page.evaluate(() => state.dayTimelineDrafts.size)).toBe(0);
    await page.locator("#closeTodoDialog").click();
    await expect(page.locator("#dayTimelineDialog")).toBeVisible();
    await frames(page);
    await card.evaluate(el => el.click()); // Accessible click with no pointer sequence.
    await expect(page.locator("#todoDialog")).toBeVisible();
    await expect(page.locator("#todoFormId")).toHaveValue(id);
  } finally { await context.close(); }
});
