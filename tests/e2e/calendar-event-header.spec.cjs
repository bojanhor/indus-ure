const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

test("calendar headers show profile then name on the left and time on the right, without an urgent prefix", async ({ page }) => {
  await page.goto(app.baseUrl);
  await page.locator("#localTestUser").selectOption("bojan");
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
  await page.evaluate(async () => {
    const avatar = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF9sAAAAASUVORK5CYII=";
    await api("/api/profile", { method: "PUT", body: JSON.stringify({ name: "Bojan", avatar }) });
    const { client } = await api("/api/clients", { method: "POST", body: JSON.stringify({ name: "Stranka QA" }) });
    const { worker } = await api("/api/workers", { method: "POST", body: JSON.stringify({ name: 'Dolgo ime <delavca> "QA"' }) });
    for (const item of [
      { title: "Nujni obisk QA", assigneeIds: ["bojan"], start: "08:00", end: "09:00", urgent: true },
      { title: "Skupno opravilo QA", assigneeIds: ["ibro", "bojan"], start: "09:30", end: "10:30" },
      { title: "Brez časa QA", assigneeIds: ["ibro"] },
      { title: "Dolgo ime QA", assigneeIds: [worker.id], start: "11:00", end: "12:00" },
      { title: "Večdnevni obisk QA", assigneeIds: ["ibro"], endDate: "2032-04-08", urgent: true },
      { title: "Dostava QA", status: "material", assigneeIds: [] }
    ]) {
      await api("/api/todos", { method: "POST", body: JSON.stringify({ status: "open", date: "2032-04-05", client: client.name, clientId: client.clientId, ...item }) });
    }
    await refreshAfterWorkerManagement();
    state.current = new Date(2032, 3, 1);
    setWorkContext("admin");
    setView("calendar");
    renderMonth();
  });
  const cards = page.locator('#calendar .day[data-date="2032-04-05"] .day-todo');
  const urgent = cards.filter({ hasText: "Nujni obisk QA" });
  await expect(urgent.locator(".day-todo-worker-name")).toHaveText("Bojan");
  await expect(urgent.locator(".avatar img")).toHaveCount(1);
  await expect(urgent.locator(".day-todo-time")).toHaveText("08:00–09:00");
  await expect(urgent.locator(".day-todo-title")).toHaveText("Nujni obisk QA");
  await expect(urgent).toHaveClass(/urgent/);
  await expect(urgent).toHaveCSS("border-left-color", "rgb(217, 48, 37)");
  await expect(urgent).toHaveAttribute("aria-label", /Nujno opravilo/);
  expect(await urgent.locator(".avatar img").evaluate(img => img.complete && img.naturalWidth > 0)).toBe(true);
  await expect(cards.filter({ hasText: "Skupno opravilo QA" }).locator(".day-todo-worker-name")).toHaveText(["Ibro", "Bojan"]);
  await expect(cards.filter({ hasText: "Brez časa QA" }).locator(".avatar")).toHaveText("I");
  await expect(cards.filter({ hasText: "Brez časa QA" }).locator(".day-todo-time")).toHaveText("Brez ure");
  await expect(cards.filter({ hasText: "Dolgo ime QA" }).locator(".day-todo-worker-name")).toHaveText('Dolgo ime <delavca> "QA"');
  await expect(cards.filter({ hasText: "Dolgo ime QA" }).locator(".day-todo-worker")).toHaveAttribute("title", 'Dolgo ime <delavca> "QA"');
  const span = page.locator('.day-multiday-event.is-span-start').filter({ hasText: "Večdnevni obisk QA" });
  await expect(span.locator(".day-todo-worker-name")).toHaveText("Ibro");
  await expect(span.locator(".day-multiday-event-title")).toHaveText("Večdnevni obisk QA");
  await expect(span).toHaveCSS("border-left-color", "rgb(217, 48, 37)");
  await page.locator("#calendarCompletedFilter").check();
  await expect(cards.filter({ hasText: "Dostava QA" }).locator(".day-todo-worker")).toHaveCount(0);
  for (const width of [390, 760, 761, 800, 900, 1024, 1100, 1101, 1200, 1250, 1280, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await urgent.evaluate(card => {
      const worker = card.querySelector(".day-todo-workers").getBoundingClientRect();
      const time = card.querySelector(".day-todo-time").getBoundingClientRect();
      const avatar = card.querySelector(".avatar").getBoundingClientRect();
      const name = card.querySelector(".day-todo-worker-name").getBoundingClientRect();
      return { beforeTime: worker.right <= time.left, iconBeforeName: avatar.right <= name.left,
        sameRow: Math.abs(worker.top - time.top) < 2,
        fits: card.scrollWidth <= card.clientWidth,
        pageFits: document.documentElement.scrollWidth <= window.innerWidth };
    });
    expect(layout).toEqual({ beforeTime: true, iconBeforeName: true, sameRow: true, fits: true, pageFits: true });
    const textLayout = await cards.evaluateAll(items => items.map(item => {
      const names = [...item.querySelectorAll(".day-todo-worker-name")].map(name => {
        const style = getComputedStyle(name);
        const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.5;
        return { text: name.textContent, oneLine: name.getBoundingClientRect().height <= lineHeight + 1, fits: name.scrollWidth <= name.clientWidth + 1 };
      });
      const times = [...item.querySelectorAll(".day-todo-time-part")].map(part => part.getBoundingClientRect());
      return { names, allowsEllipsis: item.textContent.includes("Dolgo ime QA"), wrappedTimeAligned: times.length !== 2 || times[1].top <= times[0].top + 1 || Math.abs(times[0].left - times[1].left) < 1 };
    }));
    for (const cardText of textLayout) {
      expect(cardText.wrappedTimeAligned, `time alignment at ${width}px`).toBe(true);
      for (const name of cardText.names) {
        expect(name.oneLine, `${name.text} at ${width}px stays on one line`).toBe(true);
        if (!cardText.allowsEllipsis) expect(name.fits, `${name.text} at ${width}px is fully visible`).toBe(true);
      }
    }
    await page.screenshot({ path: test.info().outputPath(`calendar-profile-${width}.png`) });
  }
  // The avatar remains inside the event button and opens the usual editor.
  await page.setViewportSize({ width: 1280, height: 900 });
  await urgent.locator(".avatar").click();
  await expect(page.locator("#todoDialog")).toBeVisible();
  await expect(page.locator("#todoFormTask")).toHaveValue("Nujni obisk QA");
  await page.locator("#closeTodoDialog").click();
  await expect(page.locator("#todoDialog")).toBeHidden();
  await page.evaluate(() => setWorkContext("worker:ibro"));
  await expect(cards.filter({ hasText: "Brez časa QA" }).locator(".day-todo-worker-name")).toHaveText("Ibro");
  // Worker calendars retain their existing per-worker assignment projection.
  await expect(cards.filter({ hasText: "Skupno opravilo QA" }).locator(".day-todo-worker-name")).toHaveText("Ibro");
});
