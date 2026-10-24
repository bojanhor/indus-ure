const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

for (const pointer of ["mouse", "touch"]) {
  test(`${pointer}: clicks open, only a held gesture moves, and explicit resize grips preserve duration controls`, async ({ browser, browserName }) => {
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
      await expect(card).toHaveCSS("cursor", "default");
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
        expect(await page.evaluate(() => state.dayTimelineInteraction?.touchReady)).toBe(false);
        await move(x, y - 48); await up();
        expect(await page.evaluate(() => state.dayTimelineDrafts.size)).toBe(0);
        await expect(card).toHaveAttribute("data-start", "09:00");
        await expect(card).toHaveAttribute("data-end", "11:00");
        expect(await page.locator("#dayTimelineScroll").evaluate(el => el.scrollTop)).toBeGreaterThan(beforeScroll);
        await expect(page.locator("#todoDialog")).toBeHidden();
      }
      // Moving before the hold, even onto a grip, cannot arm editing midway.
      let box = await reset();
      await down(box.x + box.width * 0.49, box.y + 6);
      await move(box.x + box.width * 0.6, box.y + 96); await up();
      expect(await page.evaluate(() => state.dayTimelineDrafts.size)).toBe(0);
      await expect(page.locator("#saveDayTimeline")).toBeEnabled();
      // A short click/tap on the safe side still opens the existing editor.
      box = await reset(); await down(box.x + box.width * 0.25, box.y + box.height / 2); await up();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormTask")).toHaveValue(title);
      await page.locator("#closeTodoDialog").click();
      await expect(page.locator("#dayTimelineDialog")).toBeVisible();
      // Slow taps and small hand wobble do not disappear into the drag handler.
      box = await reset();
      await down(box.x + box.width * .25, box.y + box.height / 2);
      await expect(card).toHaveClass(/is-drag-ready/);
      await expect(card).toHaveCSS("cursor", "move");
      await page.screenshot({ path: test.info().outputPath(`held-ready-${pointer}.png`) });
      await move(box.x + box.width * .25 + 3, box.y + box.height / 2 + 3); await up();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormId")).toHaveValue(id);
      await page.locator("#closeTodoDialog").click();
      await expect(page.locator("#dayTimelineDialog")).toBeVisible();
      for (const [mode, yPart] of [["resize-start", 0.03], ["resize-end", 0.97], ["move", 0.5], ["move", 0.03], ["move", 0.97]]) {
        box = await reset();
        const grip = mode === "move" ? null : await card.locator(`.day-resize-handle[data-mode="${mode}"]`).boundingBox();
        const x = grip ? grip.x + grip.width / 2 : box.x + box.width * .25;
        const y = grip ? grip.y + grip.height / 2 : box.y + box.height * yPart;
        await down(x, y);
        if (touch || mode === "move") await expect(card).toHaveClass(/is-drag-ready/);
        expect(await page.evaluate(() => state.dayTimelineInteraction?.mode)).toBe(mode);
        await move(x, y + 45); await up();
        await expect(page.locator("#saveDayTimeline")).toBeEnabled();
        const draft = await page.evaluate(id => state.dayTimelineDrafts.get(id), id);
        expect(draft.start).toBe(mode === "resize-end" ? "09:00" : "09:30");
        expect(draft.end).toBe(mode === "resize-start" ? "11:00" : "11:30");
        await expect(page.locator("#todoDialog")).toBeHidden();
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
      await move(box.x + box.width * 0.25, box.y + 48); await up();
      expect(await page.evaluate(() => state.dayTimelineDrafts.size)).toBe(0);
      await reset();
      if (touch) {
        // A second finger cancels the pending hold and zooms, never drags a task.
        box = await card.boundingBox();
        const a = { x: box.x + box.width * .25, y: box.y + box.height / 2, id: 1 };
        const b = { x: a.x + 30, y: a.y + 30, id: 2 };
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [a] });
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [a, b] });
        expect(await page.evaluate(() => state.dayTimelineInteraction)).toBeNull();
        expect(await page.evaluate(() => state.dayTimelineGesture?.type)).toBe("pinch");
        await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [a, { ...b, y: b.y + 30 }] });
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.waitForTimeout(450);
        expect(await page.evaluate(() => state.dayTimelineInteraction)).toBeNull();
        expect(await page.evaluate(() => state.dayTimelinePointers.size)).toBe(0);
        expect(await page.evaluate(() => state.dayTimelineDrafts.size)).toBe(0);
        await expect(page.locator("#todoDialog")).toBeHidden();
        await reset();
      }
      const persisted = await page.evaluate(async id => (await api("/api/todos")).todos.find(todo => todo.id === id), id);
      expect(persisted).toMatchObject({ start: "09:00", end: "11:00", date: "2032-04-05" });
      await page.screenshot({ path: test.info().outputPath(`safe-drag-${pointer}.png`) });
    } finally { await context.close(); }
  });
}
