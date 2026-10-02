const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

for (const pointer of ["mouse", "touch"]) {
  test(`${pointer}: left-half gestures never change event time; right grips and move still work`, async ({ browser, browserName }) => {
    test.skip(pointer === "touch" && browserName !== "chromium", "Trusted Android-style touch input uses Chromium's input dispatcher.");
    const context = await browser.newContext({ viewport: { width: pointer === "touch" ? 390 : 1280, height: 900 }, hasTouch: pointer === "touch", isMobile: pointer === "touch" });
    const page = await context.newPage();
    const touch = pointer === "touch" ? await context.newCDPSession(page) : null;
    try {
      await page.goto(app.baseUrl);
      await page.locator("#localTestUser").selectOption("bojan");
      await page.locator("#localTestPassword").fill(TEST_PASSWORD);
      await page.locator("#localTestLoginBtn").click();
      await expect(page.locator("#app")).toBeVisible();
      const title = `Safe drag ${pointer}`;
      const id = await page.evaluate(async ({ title }) => {
        const result = await api("/api/todos", { method: "POST", body: JSON.stringify({ title, status: "open", date: "2032-04-05", start: "09:00", end: "11:00", assigneeIds: ["bojan"], client: "Drag QA" }) });
        await loadTodos();
        setWorkContext("admin");
        openDayTimeline("2032-04-05");
        return state.todos.find(todo => todo.title === title).id;
      }, { title });
      const card = page.locator(`.day-timeline-event[data-todo-id="${id}"]`);
      const reset = async () => {
        // Opening/returning from the editor schedules an initial fit frame.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        await page.evaluate(() => { state.dayTimelineDrafts.clear(); state.dayTimelineMinuteHeight = 1.5; renderDayTimeline(); });
        await card.evaluate(el => { document.querySelector("#dayTimelineScroll").scrollTop = el.offsetTop - 130; });
        return card.boundingBox();
      };
      const down = async (x, y) => {
        if (touch) await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
        else { await page.mouse.move(x, y); await page.mouse.down(); }
      };
      const move = async (x, y) => {
        if (touch) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y }] });
        else await page.mouse.move(x, y, { steps: 8 });
      };
      const up = async () => {
        if (touch) await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        else await page.mouse.up();
      };
      for (const yPart of [0.03, 0.5, 0.97]) {
        const box = await reset();
        const x = box.x + box.width * 0.25, y = box.y + box.height * yPart;
        const beforeScroll = await page.locator("#dayTimelineScroll").evaluate(el => el.scrollTop);
        await down(x, y);
        await page.waitForTimeout(500); // Exceeds the existing touch drag hold threshold.
        expect(await page.evaluate(() => state.dayTimelineInteraction)).toBeNull();
        await move(x, y - 48); await up();
        expect(await page.evaluate(() => state.dayTimelineDrafts.size)).toBe(0);
        await expect(card).toHaveAttribute("data-start", "09:00");
        await expect(card).toHaveAttribute("data-end", "11:00");
        expect(await page.locator("#dayTimelineScroll").evaluate(el => el.scrollTop)).toBeGreaterThan(beforeScroll);
        await expect(page.locator("#todoDialog")).toBeHidden();
      }
      // Moving from the safe half onto a grip cannot arm editing midway.
      let box = await reset();
      await down(box.x + box.width * 0.49, box.y + 6);
      await page.waitForTimeout(500);
      await move(box.x + box.width * 0.6, box.y + 96); await up();
      expect(await page.evaluate(() => state.dayTimelineDrafts.size)).toBe(0);
      await expect(page.locator("#saveDayTimeline")).toBeDisabled();
      // A short click/tap on the safe side still opens the existing editor.
      box = await reset(); await down(box.x + box.width * 0.25, box.y + box.height / 2); await up();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormTask")).toHaveValue(title);
      await page.locator("#closeTodoDialog").click();
      await expect(page.locator("#dayTimelineDialog")).toBeVisible();
      for (const [mode, yPart] of [["resize-start", 0.03], ["resize-end", 0.97], ["move", 0.5]]) {
        box = await reset();
        const x = box.x + box.width * 0.9, y = box.y + box.height * yPart;
        await down(x, y);
        if (touch) await page.waitForTimeout(500);
        expect(await page.evaluate(() => state.dayTimelineInteraction?.mode)).toBe(mode);
        await move(x, y + 45); await up();
        await expect(page.locator("#saveDayTimeline")).toBeEnabled();
        const draft = await page.evaluate(id => state.dayTimelineDrafts.get(id), id);
        expect(draft.start).toBe(mode === "resize-end" ? "09:00" : "09:30");
        expect(draft.end).toBe(mode === "resize-start" ? "11:00" : "11:30");
      }
      await reset();
      // Large grips must not cover the safe half of a short, narrow event.
      await card.evaluate(el => { el.style.width = "70px"; el.style.height = "24px"; });
      box = await card.boundingBox();
      for (const grip of await card.locator(".day-resize-handle").all()) {
        const bounds = await grip.boundingBox();
        expect(bounds.x).toBeGreaterThanOrEqual(box.x + box.width / 2);
        expect(bounds.height).toBeLessThanOrEqual(box.height / 2);
      }
      await down(box.x + box.width * 0.25, box.y + 3);
      await page.waitForTimeout(500); await move(box.x + box.width * 0.25, box.y + 48); await up();
      expect(await page.evaluate(() => state.dayTimelineDrafts.size)).toBe(0);
      await reset();
      const persisted = await page.evaluate(async id => (await api("/api/todos")).todos.find(todo => todo.id === id), id);
      expect(persisted).toMatchObject({ start: "09:00", end: "11:00", date: "2032-04-05" });
      await page.screenshot({ path: test.info().outputPath(`safe-drag-${pointer}.png`) });
    } finally { await context.close(); }
  });
}
