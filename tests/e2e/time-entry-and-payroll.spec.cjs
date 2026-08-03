const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");

const CLIENT_ALIAS = "PW stranka";
const ENTRY_TITLE = "PW vpis ur";
const ENTRY_DATE = "2025-06-15";

let app;

async function localLogin(page, userId) {
  await page.goto(app.baseUrl, { waitUntil: "networkidle" });
  await expect(page.locator("#localTestLoginPanel")).toBeVisible();
  await page.locator("#localTestUser").selectOption(userId);
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
}

test.describe.serial("isolated worker time entry and boss payroll", () => {
  test.beforeAll(async () => {
    app = await startIsolatedTestApp();
  });

  test.afterAll(async () => {
    await app?.stop();
  });

  test("task editor keeps one attachment chooser and sticky actions on phone and desktop", async ({ browser }) => {
    for (const viewport of [
      { name: "phone", width: 390, height: 844 },
      { name: "desktop", width: 1280, height: 900 }
    ]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        await localLogin(page, "ibro");
        await page.locator("#newTodoButton").click();
        await expect(page.locator("#todoDialog")).toBeVisible();
        await expect(page.locator("#todoFormStatusField")).not.toHaveAttribute("open", "");
        await expect(page.locator("#todoFormDateTimeSection")).not.toHaveAttribute("open", "");
        await page.locator("#todoFormStatusField > summary").click();
        await expect(page.locator("#todoFormStatusField")).toHaveAttribute("open", "");
        await page.locator("#todoFormDateTimeSection > summary").click();
        await expect(page.locator("#todoFormStatusField")).not.toHaveAttribute("open", "");
        await expect(page.locator("#todoFormDateTimeSection")).toHaveAttribute("open", "");
        await expect(page.locator("#todoFormAttachmentInput")).toBeAttached();
        await expect(page.locator("#todoFormAttachmentMenu > summary")).toContainText("Dodaj prilogo");
        await page.locator("#todoFormAttachmentMenu > summary").click();
        await expect(page.locator("#todoFormCameraInput")).toBeAttached();
        await expect(page.locator("#todoFormVideoInput")).toBeAttached();
        await page.locator("#todoFormAttachmentMenu > summary").click();

        // A long description makes the form scroll on both widths.  The
        // header must stay reachable so Save and Cancel are never stranded
        // below the fold.
        await page.locator("#todoFormNotes").fill("Podroben opis. ".repeat(650));
        const scrollState = await page.locator("#todoDialog").evaluate((dialog) => {
          const before = { scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight };
          dialog.scrollTop = Math.max(0, dialog.scrollHeight - dialog.clientHeight);
          return before;
        });
        expect(scrollState.scrollHeight).toBeGreaterThan(scrollState.clientHeight);
        await page.waitForTimeout(50);
        const geometry = await page.locator("#todoDialog").evaluate((dialog) => {
          const header = dialog.querySelector(".modal-head");
          const save = dialog.querySelector("#saveTodoDialog");
          const box = dialog.getBoundingClientRect();
          const headerBox = header.getBoundingClientRect();
          const saveBox = save.getBoundingClientRect();
          return { dialogTop: box.top, headerTop: headerBox.top, saveTop: saveBox.top };
        });
        expect(geometry.headerTop).toBeLessThanOrEqual(geometry.dialogTop + 6);
        expect(geometry.saveTop).toBeLessThanOrEqual(geometry.dialogTop + 72);
      } finally {
        await context.close();
      }
    }
  });

  test("saving an event gives immediate feedback and blocks duplicate interaction", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    let releasePost = null;
    const allowPost = new Promise((resolve) => { releasePost = resolve; });
    let postCount = 0;
    try {
      await localLogin(page, "ibro");
      await page.route("**/api/todos", async (route, request) => {
        if (request.method() === "POST") {
          postCount += 1;
          await allowPost;
        }
        await route.continue();
      });
      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormTask").fill("PW vidno shranjevanje");
      await page.locator("#todoFormClient").fill(CLIENT_ALIAS);
      const dialog = page.locator("#todoDialog");
      const save = page.locator("#saveTodoDialog");
      await save.click();
      await expect(save).toBeDisabled();
      await expect(save).toHaveAttribute("aria-busy", "true");
      await expect(page.locator("#closeTodoDialog")).toBeDisabled();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeVisible();
      await dialog.evaluate((node) => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await expect.poll(() => postCount).toBe(1);
      releasePost();
      await expect(dialog).toBeHidden();
      expect(postCount).toBe(1);
      await page.unroute("**/api/todos");
    } finally {
      releasePost?.();
      await context.close();
    }
  });
  test("worker enters hours through the real form", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");
      await page.locator("#writeHoursButton").click();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormTitle")).toHaveText("Vpis ur");
      await expect(page.locator("#todoFormStatus")).toHaveValue("execution");
      await expect(page.locator("#todoFormHourlyRateField")).toBeHidden();
      await expect(page.locator("#todoFormDateTimeSection")).not.toHaveAttribute("open", "");

      await page.locator("#todoFormNotes").fill("Podroben opis opravljenega dela. ".repeat(28));
      const notesMetrics = await page.locator("#todoFormNotes").evaluate((field) => ({
        offsetHeight: field.offsetHeight,
        scrollHeight: field.scrollHeight
      }));
      expect(notesMetrics.offsetHeight).toBeGreaterThan(82);
      expect(notesMetrics.offsetHeight).toBeGreaterThanOrEqual(notesMetrics.scrollHeight);

      await page.locator("#todoFormClient").fill(CLIENT_ALIAS);
      await page.locator("#quickAddClientBtn").click();
      await expect(page.locator("#quickClientDialog")).toBeVisible();
      await page.locator("#quickClientName").fill(CLIENT_ALIAS);
      await page.locator("#quickClientForm button[type=submit]").click();
      await expect(page.locator("#quickClientDialog")).toBeHidden();

      await page.locator("#todoFormTask").fill(ENTRY_TITLE);
      await page.locator("#todoFormDateTimeSection > summary").click();
      await page.locator("#todoFormDate").fill(ENTRY_DATE);
      await page.locator("#todoFormStart").fill("08:00");
      await page.locator("#todoFormEnd").fill("10:00");
      await page.locator("#todoFormBillingKm").fill("10");
      await page.locator("#todoFormClientKm").fill("5");
      await page.locator("#saveTodoDialog").click();

      await expect(page.locator("#todoDialog")).toBeHidden();
      await expect(page.locator("#todoItems")).not.toContainText(ENTRY_TITLE);
      await page.locator("#todoSortMode").selectOption("completed");
      await expect(page.locator("#todoItems")).toContainText(ENTRY_TITLE);
      await expect(page.locator("#todoItems")).toContainText(CLIENT_ALIAS);
    } finally {
      await context.close();
    }
  });

  test("e-mail task link opens its editor before the full task snapshot", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const title = "PW hitra e-poštna povezava";
    try {
      await localLogin(page, "ibro");
      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormTask").fill(title);
      await page.locator("#todoFormClient").fill(CLIENT_ALIAS);
      await page.locator("#saveTodoDialog").click();
      await expect(page.locator("#todoDialog")).toBeHidden();

      const todoId = await page.evaluate(async (taskTitle) => {
        const response = await fetch("/api/todos");
        const data = await response.json();
        return data.todos.find((todo) => todo.title === taskTitle)?.id || "";
      }, title);
      expect(todoId).toBeTruthy();

      let releaseFullSnapshot = () => {};
      let markFullSnapshotStarted = () => {};
      const fullSnapshotStarted = new Promise((resolve) => { markFullSnapshotStarted = resolve; });
      const allowFullSnapshot = new Promise((resolve) => { releaseFullSnapshot = resolve; });
      await page.route("**/api/todos", async (route, request) => {
        const requestUrl = new URL(request.url());
        if (request.method() === "GET" && requestUrl.pathname === "/api/todos") {
          markFullSnapshotStarted();
          await allowFullSnapshot;
        }
        await route.continue();
      });
      await page.goto(`${app.baseUrl}?todo=${encodeURIComponent(todoId)}`, { waitUntil: "domcontentloaded" });
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormTask")).toHaveValue(title);
      await fullSnapshotStarted;
      const resumedSnapshot = page.waitForResponse((response) => {
        const requestUrl = new URL(response.url());
        return response.request().method() === "GET" && requestUrl.pathname === "/api/todos" && response.ok();
      });
      releaseFullSnapshot();
      await resumedSnapshot;
      await page.unroute("**/api/todos");
    } finally {
      await context.close();
    }
  });

  test("boss sees and confirms the worker payroll through the UI", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "bojan");
      await page.locator("#toolsMenu > summary").click();
      await page.locator("#billingMenuBtn").click();
      await expect(page.locator(".billing-screen")).toBeVisible();

      await page.locator("#billingWorker").selectOption("ibro");
      await page.locator("#billingFrom").fill("2025-06-01");
      await page.locator("#billingFrom").blur();
      await page.locator("#billingTo").fill("2025-06-30");
      await page.locator("#billingTo").blur();

      await expect(page.locator("#billingDayList")).toContainText("2 h po 15,00 EUR/h");
      await expect(page.locator("#billingSummary")).toContainText("2 h");
      await expect(page.locator("#billingSummary")).toContainText("30,00 EUR");
      await expect(page.locator("#billingSummary")).toContainText("10 km");

      await expect(page.locator("#billingConfirm")).toBeVisible();
      await expect(page.locator("#billingConfirm")).toBeEnabled();
      await page.locator("#billingConfirm").click();
      await expect(page.locator("#appConfirmDialog")).toBeVisible();
      await page.locator("#appConfirmAccept").click();
      await expect(page.locator("#billingState")).toContainText("Potrjeno");
      await expect(page.locator("#billingConfirm")).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test("payroll quick ranges keep today selectable and fall back to entered hours", async ({ browser }) => {
    const workerContext = await browser.newContext();
    const workerPage = await workerContext.newPage();
    let today = "";
    try {
      await localLogin(workerPage, "ibro");
      today = await workerPage.evaluate(() => {
        const value = new Date();
        return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
      });
      await workerPage.locator("#writeHoursButton").click();
      await workerPage.locator("#todoFormTask").fill("PW hitri obračunski datum");
      await workerPage.locator("#todoFormClient").fill(CLIENT_ALIAS);
      await workerPage.locator("#todoFormDateTimeSection > summary").click();
      await workerPage.locator("#todoFormDate").fill(today);
      await workerPage.locator("#todoFormStart").fill("09:00");
      await workerPage.locator("#todoFormEnd").fill("10:00");
      await workerPage.locator("#saveTodoDialog").click();
      await expect(workerPage.locator("#appConfirmDialog")).toBeVisible();
      await workerPage.locator("#appConfirmAccept").click();
      await expect(workerPage.locator("#todoDialog")).toBeHidden();
    } finally {
      await workerContext.close();
    }

    const bossContext = await browser.newContext();
    const page = await bossContext.newPage();
    try {
      await localLogin(page, "bojan");
      await page.locator("#toolsMenu > summary").click();
      await page.locator("#billingMenuBtn").click();
      await page.locator("#billingWorker").selectOption("ibro");

      await page.locator('[data-billing-range-preset="today"]').click();
      await expect(page.locator("#billingFrom")).toHaveValue(today);
      await expect(page.locator("#billingTo")).toHaveValue(today);
      await expect(page.locator("#billingTo")).toHaveAttribute("max", today);

      await page.locator('[data-billing-range-preset="yesterday"]').click();
      await expect(page.locator("#billingFrom")).toHaveValue(today);
      await expect(page.locator("#billingTo")).toHaveValue(today);
      await expect(page.locator("#appNotice")).toContainText("Za včeraj ni vpisanih ur.");

      await page.locator('[data-billing-range-preset="current-month"]').click();
      await expect(page.locator("#billingFrom")).toHaveValue(`${today.slice(0, 7)}-01`);
      await expect(page.locator("#billingTo")).toHaveValue(today);
    } finally {
      await bossContext.close();
    }
  });

  test("multi-day task is a continuous monthly span without an untimed label", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");
      const span = await page.evaluate(() => {
        const start = new Date();
        start.setHours(12, 0, 0, 0);
        start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
        const end = new Date(start);
        end.setDate(end.getDate() + 7);
        const key = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
        return { start: key(start), end: key(end) };
      });
      const title = "PW večdnevno opravilo";
      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormTask").fill(title);
      await page.locator("#todoFormDateTimeSection > summary").click();
      await page.locator("#todoFormDate").fill(span.start);
      await page.locator("#todoFormEndDate").fill(span.end);
      await page.locator("#todoFormEndDate").blur();
      await expect(page.locator("#todoFormStart")).toBeDisabled();
      await expect(page.locator("#todoFormStart").locator("xpath=..")).toBeHidden();
      await page.locator("#saveTodoDialog").click();
      await expect(page.locator("#todoDialog")).toBeHidden();

      await page.locator("#calendarViewBtn").click();
      const startSpan = page.locator(`.day[data-date="${span.start}"] .day-multiday-event.is-span-start`);
      const continuation = page.locator(`.day[data-date="${span.end}"] .day-multiday-event.is-span-continuation`);
      await expect(startSpan).toHaveText(title);
      await expect(continuation).toHaveText("");
      expect(await page.locator(".day-multiday-event").evaluateAll((items) => items.every((item) => !item.textContent.includes("Brez ure")))).toBeTruthy();
    } finally {
      await context.close();
    }
  });

  test("background session checks renew safely and never throw the user to login", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");
      const originalUrl = page.url();
      await page.route("**/api/sync-state", (route) => route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "expired" })
      }));

      // A stale background probe must first use /api/me to refresh its
      // security context. The user remains in the currently open view.
      await page.evaluate(() => checkServerChanges());
      await expect(page.locator("#app")).toBeVisible();
      expect(page.url()).toBe(originalUrl);
      expect(await page.evaluate(() => sessionStorage.getItem("indus-ure-auto-login-at"))).toBeNull();

      await page.route("**/api/me", (route) => route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({ error: "expired" })
      }));
      await page.evaluate(() => checkServerChanges());
      await expect(page.locator("#app")).toBeVisible();
      await expect(page.locator("#appNotice")).toContainText("Trenutni pogled ostane odprt");
      expect(page.url()).toBe(originalUrl);
    } finally {
      await context.close();
    }
  });

  test("session return state restores the last calendar view and month after login", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");
      await page.evaluate(() => {
        state.current = new Date(2025, 5, 1);
        setView("calendar");
        rememberSessionRecoveryUiState();
      });
      await page.reload({ waitUntil: "networkidle" });
      await expect(page.locator("#app")).toBeVisible();
      await expect(page.locator("#calendarViewBtn")).toHaveClass(/active/);
      expect(await page.evaluate(() => `${state.current.getFullYear()}-${String(state.current.getMonth() + 1).padStart(2, "0")}`)).toBe("2025-06");
      expect(await page.evaluate(() => sessionStorage.getItem("indus-ure-session-return"))).toBeNull();
    } finally {
      await context.close();
    }
  });

  test("all-day task can be dropped into the day timeline as a quarter-hour time slot", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 980, height: 860 } });
    const page = await context.newPage();
    const title = "PW celodnevno v časovnico";
    try {
      await localLogin(page, "ibro");
      const date = await page.evaluate(() => {
        const value = new Date();
        return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
      });
      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormTask").fill(title);
      await page.locator("#todoFormDateTimeSection > summary").click();
      await page.locator("#todoFormDate").fill(date);
      await page.locator("#saveTodoDialog").click();
      await expect(page.locator("#todoDialog")).toBeHidden();

      await page.locator("#calendarViewBtn").click();
      await page.locator(`.day[data-date="${date}"] .day-head`).click();
      await expect(page.locator("#dayTimelineDialog")).toBeVisible();
      const source = page.locator(".day-all-day-item", { hasText: title });
      await expect(source).toBeVisible();
      const [sourceBox, scrollBox, timelineBox] = await Promise.all([
        source.boundingBox(),
        page.locator("#dayTimelineScroll").boundingBox(),
        page.locator("#dayTimeline").boundingBox()
      ]);
      expect(sourceBox).toBeTruthy();
      expect(scrollBox).toBeTruthy();
      expect(timelineBox).toBeTruthy();
      const targetX = timelineBox.x + timelineBox.width * 0.55;
      const targetY = scrollBox.y + Math.min(scrollBox.height - 44, 150);
      await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(targetX, targetY, { steps: 8 });
      await expect(page.locator(".day-timeline-event.is-drop-preview")).toBeVisible();
      await page.mouse.up();
      await expect(page.locator("#saveDayTimeline")).toBeEnabled();
      const timed = page.locator(".day-timeline-event", { hasText: title });
      await expect(timed).toBeVisible();
      const times = await timed.evaluate((node) => ({ start: node.dataset.start, end: node.dataset.end }));
      expect(times.start).toMatch(/^\d{2}:(00|15|30|45)$/);
      expect(times.end).toMatch(/^\d{2}:(00|15|30|45)$/);
      await page.locator("#saveDayTimeline").click();
      await expect(page.locator("#saveDayTimeline")).toBeDisabled();
    } finally {
      await context.close();
    }
  });

  test("all-day drop stays editable and daily controls fit a phone viewport", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true
    });
    const page = await context.newPage();
    const title = "PW long all day task that must still fit the daily timeline controls on a narrow phone";
    try {
      await localLogin(page, "ibro");
      const date = await page.evaluate(() => {
        const value = new Date();
        return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
      });
      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormTask").fill(title);
      await page.locator("#todoFormDateTimeSection > summary").click();
      await page.locator("#todoFormDate").fill(date);
      await page.locator("#saveTodoDialog").click();
      await expect(page.locator("#todoDialog")).toBeHidden();

      await page.locator("#calendarViewBtn").click();
      await page.locator(`.day[data-date="${date}"] .day-head`).click();
      await expect(page.locator("#dayTimelineDialog")).toBeVisible();
      await expect(page.locator("#dayTimelineTitle")).toHaveText(/^(Pon|Tor|Sre|\u010cet|Pet|Sob|Ned), \d{1,2}\. (jan|feb|mar|apr|maj|jun|jul|avg|sep|okt|nov|dec) \d{4}$/);

      const initialGeometry = await page.evaluate(() => {
        const dialog = document.querySelector("#dayTimelineDialog");
        const save = document.querySelector("#saveDayTimeline");
        const close = document.querySelector("#closeDayTimeline");
        const box = (node) => {
          const rect = node.getBoundingClientRect();
          return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
        };
        return {
          dialog: box(dialog),
          save: box(save),
          close: box(close),
          dialogScrollWidth: dialog.scrollWidth,
          dialogClientWidth: dialog.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth
        };
      });
      for (const control of [initialGeometry.save, initialGeometry.close]) {
        expect(control.left).toBeGreaterThanOrEqual(initialGeometry.dialog.left - 1);
        expect(control.right).toBeLessThanOrEqual(initialGeometry.dialog.right + 1);
        expect(control.top).toBeGreaterThanOrEqual(initialGeometry.dialog.top - 1);
        expect(control.bottom).toBeLessThanOrEqual(initialGeometry.dialog.bottom + 1);
      }
      expect(initialGeometry.dialogScrollWidth).toBeLessThanOrEqual(initialGeometry.dialogClientWidth + 1);
      expect(initialGeometry.documentScrollWidth).toBeLessThanOrEqual(initialGeometry.viewportWidth + 1);

      const source = page.locator(".day-all-day-item", { hasText: title });
      await expect(source).toBeVisible();
      const [sourceBox, scrollBox, timelineBox] = await Promise.all([
        source.boundingBox(),
        page.locator("#dayTimelineScroll").boundingBox(),
        page.locator("#dayTimeline").boundingBox()
      ]);
      expect(sourceBox).toBeTruthy();
      expect(scrollBox).toBeTruthy();
      expect(timelineBox).toBeTruthy();
      const targetX = timelineBox.x + timelineBox.width * 0.52;
      const targetY = scrollBox.y + Math.min(scrollBox.height - 40, Math.max(44, 150));
      await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
      await page.mouse.down();
      await page.mouse.move(targetX, targetY, { steps: 8 });
      await expect(page.locator(".day-timeline-event.is-drop-preview")).toBeVisible();
      await page.mouse.up();

      const timed = page.locator(".day-timeline-event", { hasText: title });
      await expect(timed).toBeVisible();
      await expect(page.locator("#saveDayTimeline")).toBeEnabled();
      const times = await timed.evaluate((node) => ({ start: node.dataset.start, end: node.dataset.end }));
      expect(times.start).toMatch(/^\d{2}:(00|15|30|45)$/);
      expect(times.end).toMatch(/^\d{2}:(00|15|30|45)$/);

      // The single fresh draft is saved before opening the editor. This is the
      // practical follow-up to a drop and avoids leaving a user at a dead card.
      await timed.click();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormStart")).toHaveValue(times.start);
      await expect(page.locator("#todoFormEnd")).toHaveValue(times.end);
      await page.locator("#closeTodoDialog").click();
      await expect(page.locator("#dayTimelineDialog")).toBeVisible();
      await expect(page.locator("#saveDayTimeline")).toBeDisabled();

      const persisted = await page.evaluate(async (taskTitle) => {
        const response = await fetch("/api/todos");
        const data = await response.json();
        return data.todos.find((todo) => todo.title === taskTitle) || null;
      }, title);
      expect(persisted).toMatchObject({ date, start: times.start, end: times.end });
    } finally {
      await context.close();
    }
  });

  test("daily timeline moves a timed event to the adjacent day only after a deliberate horizontal drag", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 980, height: 860 } });
    const page = await context.newPage();
    const title = "PW dnevni premik med dnevi";
    try {
      await localLogin(page, "ibro");
      const dates = await page.evaluate(() => {
        const current = new Date();
        const next = new Date(current);
        next.setDate(next.getDate() + 1);
        const key = (value) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
        return { current: key(current), next: key(next) };
      });
      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormTask").fill(title);
      await page.locator("#todoFormDateTimeSection > summary").click();
      await page.locator("#todoFormDate").fill(dates.current);
      await page.locator("#todoFormStart").fill("09:00");
      await page.locator("#todoFormEnd").fill("11:00");
      await page.locator("#saveTodoDialog").click();
      await expect(page.locator("#todoDialog")).toBeHidden();

      await page.locator("#calendarViewBtn").click();
      await page.locator(`.day[data-date="${dates.current}"] .day-head`).click();
      const event = page.locator(".day-timeline-event", { hasText: title });
      await expect(event).toBeVisible();
      const box = await event.boundingBox();
      expect(box).toBeTruthy();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 128, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      expect(await page.evaluate(() => state.dayTimelineDate)).toBe(dates.next);
      await expect(page.locator("#saveDayTimeline")).toBeEnabled();
      const moved = page.locator(".day-timeline-event", { hasText: title });
      await expect(moved).toHaveAttribute("data-start", "09:00");
      await expect(moved).toHaveAttribute("data-end", "11:00");
      await page.locator("#saveDayTimeline").click();
      await expect(page.locator("#saveDayTimeline")).toBeDisabled();
      const savedDate = await page.evaluate(async (taskTitle) => {
        const response = await fetch("/api/todos");
        const data = await response.json();
        return data.todos.find((todo) => todo.title === taskTitle)?.date || "";
      }, title);
      expect(savedDate).toBe(dates.next);
    } finally {
      await context.close();
    }
  });

  test("queued task retries automatically after a transient server outage", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const title = "PW samodejni sync";
    let dropResponseAfterServerSave = true;
    try {
      await localLogin(page, "ibro");
      await page.route("**/api/todos", async (route, request) => {
        if (request.method() === "POST" && dropResponseAfterServerSave) {
          dropResponseAfterServerSave = false;
          const response = await route.fetch();
          expect(response.ok()).toBeTruthy();
          // The server has committed the create, but the browser loses its response.
          await route.abort("failed");
          return;
        }
        await route.continue();
      });

      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormTask").fill(title);
      await page.locator("#todoFormClient").fill(CLIENT_ALIAS);
      await page.locator("#saveTodoDialog").click();

      await expect(page.locator("#todoDialog")).toBeHidden();
      await expect(page.locator("#offlineSyncNotice")).toContainText("Povezava je na voljo");
      await page.unroute("**/api/todos");

      // No browser online event is dispatched here. The retry timer itself
      // must resend the queued mutation while navigator.onLine stays true.
      await expect(page.locator("#offlineSyncNotice")).toBeHidden({ timeout: 10_000 });
      await expect(page.locator("#todoItems")).toContainText(title);
      await expect.poll(() => page.locator("#todoItems .todo-item").filter({ hasText: title }).count(), { timeout: 10_000 }).toBe(1);
    } finally {
      await context.close();
    }
  });
  test("terminal offline conflict can be reviewed and discarded", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");

      // Simulate a mutation which the server has permanently rejected after a
      // reassignment or deletion. Such operations deliberately stay in
      // IndexedDB until the user reviews them; they must not create a banner
      // that survives forever without a way to resolve it.
      await page.evaluate(async () => {
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open("indus-ure-offline", 3);
          request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains("todoOps")) db.createObjectStore("todoOps", { keyPath: "id", autoIncrement: true });
            if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "userId" });
          };
          request.onerror = () => reject(request.error);
          request.onsuccess = () => resolve(request.result);
        });
        try {
          await new Promise((resolve, reject) => {
            const transaction = database.transaction("todoOps", "readwrite");
            transaction.objectStore("todoOps").add({
              userId: "ibro",
              todoId: "missing-pw-conflict",
              kind: "update",
              todo: {
                id: "missing-pw-conflict",
                title: "PW lokalna sprememba",
                client: "PW stranka",
                notes: "Lokalni opis za preverjanje konflikta."
              },
              conflict: true,
              lastError: "Tega opravila ne moreš urejati.",
              lastErrorCode: "todo_not_editable",
              failedAt: new Date().toISOString()
            });
            transaction.onerror = () => reject(transaction.error);
            transaction.oncomplete = () => resolve();
          });
        } finally {
          database.close();
        }
      });

      await page.reload({ waitUntil: "networkidle" });
      await expect(page.locator("#offlineSyncNotice")).toContainText("sprememba potrebuje pregled");
      await page.locator("#offlineSyncNotice .offline-sync-review").click();
      await expect(page.locator("#offlineConflictsDialog")).toBeVisible();
      await expect(page.locator("#offlineConflictsList")).toContainText("PW lokalna sprememba");
      await expect(page.locator("#offlineConflictsList")).toContainText("Lokalni opis za preverjanje konflikta.");

      await page.locator('[data-offline-conflict-action="discard"]').click();
      await expect(page.locator("#appConfirmDialog")).toBeVisible();
      await page.locator("#appConfirmAccept").click();
      await expect(page.locator("#offlineConflictsDialog")).toBeHidden();
      await expect(page.locator("#offlineSyncNotice")).toBeHidden();

      // Reload validates that the discarded operation was removed from the
      // persistent browser queue, rather than merely hidden for this page.
      await page.reload({ waitUntil: "networkidle" });
      await expect(page.locator("#offlineSyncNotice")).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test("AJPES search fills an editable client draft without creating it", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "bojan");
      await page.locator("#toolsMenu > summary").click();
      await page.locator("#clientsMenuBtn").click();
      await expect(page.locator("#ajpesSearch")).toBeVisible();
      await page.route("**/api/ajpes/search?**", async (route) => {
        await route.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            results: [{
              registryNumber: "5000152000",
              name: "PIETA - POGREBNA DEJAVNOST FRANC TR\u0160AR S.P.",
              search: "PIETA - POGREBNA DEJAVNOST FRANC TR\u0160AR S.P.",
              address: "Gabr\u010de 009",
              postal: "1360",
              city: "Vrhnika",
              country: "Slovenija",
              legalForm: "Samostojni podjetnik posameznik s.p."
            }]
          })
        });
      });
      await page.locator("#newClientSearch").fill("Pieta");
      await page.locator("#ajpesSearch").fill("PIETA");
      await page.locator("#ajpesSearchButton").click();
      await expect(page.locator(".ajpes-result")).toContainText("PIETA - POGREBNA DEJAVNOST");
      await page.locator(".ajpes-result").click();
      await expect(page.locator("#newClientName")).toHaveValue("PIETA - POGREBNA DEJAVNOST FRANC TR\u0160AR S.P.");
      await expect(page.locator("#newClientSearch")).toHaveValue("Pieta");
      await expect(page.locator("#newClientAddress")).toHaveValue("Gabr\u010de 009");
      await expect(page.locator("#newClientRegistryNumber")).toHaveValue("5000152000");
      await expect(page.locator("#ajpesResults")).toBeHidden();
    } finally {
      await context.close();
    }
  });
});
