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
});
