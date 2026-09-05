const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");

const CLIENT_ALIAS = "PW stranka";
const ENTRY_TITLE = "PW vpis ur";
const ENTRY_DATE = "2025-06-15";
const DISK_ENTRY_DATE = "2032-01-12";

let app;

async function localLogin(page, userId, path = "/", { expectApp = true } = {}) {
  await page.goto(`${app.baseUrl}${path}`, { waitUntil: "networkidle" });
  await expect(page.locator("#localTestLoginPanel")).toBeVisible();
  await page.locator("#localTestUser").selectOption(userId);
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  if (expectApp) await expect(page.locator("#app")).toBeVisible();
  else await expect(page.locator("#todoDialog")).toBeVisible();
}

async function chooseQuickTime(page, selector) {
  const choice = page.locator(selector);
  await choice.evaluate((element) => {
    element.scrollIntoView({ block: "center", inline: "nearest" });
    element.click();
  });
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

  test("meni delavcev ostane pregleden na telefonu in namizju", async ({ browser }) => {
    for (const viewport of [
      { name: "phone", width: 390, height: 844 },
      { name: "desktop", width: 1280, height: 900 }
    ]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      try {
        await localLogin(page, "bojan");
        await page.locator("#toolsMenu > summary").click();
        await page.locator("#workersMenuBtn").click();
        await expect(page.locator("#workersDialog")).toBeVisible();
        await expect(page.locator(".worker-management-card")).toHaveCount(2);
        const layout = await page.locator("#workersDialog").evaluate((dialog) => {
          const box = dialog.getBoundingClientRect();
          const body = dialog.querySelector(".modal-body");
          const create = dialog.querySelector(".worker-create-panel");
          const card = dialog.querySelector(".worker-management-card");
          const details = card.querySelector(".worker-management-details");
          const inputs = [...dialog.querySelectorAll("input, select")].map((input) => {
            const rect = input.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, type: input.type };
          });
          const createBox = create.getBoundingClientRect();
          const detailsBox = details.getBoundingClientRect();
          return {
            left: box.left, right: box.right, top: box.top, bottom: box.bottom,
            viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
            horizontalOverflow: Math.max(0, body.scrollWidth - body.clientWidth),
            createWidth: createBox.width,
            detailsWidth: detailsBox.width,
            inputs
          };
        });
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(viewport.width + 1);
        expect(layout.top).toBeGreaterThanOrEqual(0);
        expect(layout.bottom).toBeLessThanOrEqual(viewport.height + 1);
        expect(layout.horizontalOverflow).toBeLessThanOrEqual(1);
        expect(layout.createWidth).toBeGreaterThan(250);
        expect(layout.detailsWidth).toBeGreaterThan(250);
        for (const input of layout.inputs) {
          expect(input.left).toBeGreaterThanOrEqual(layout.left - 1);
          expect(input.right).toBeLessThanOrEqual(layout.right + 1);
          if (input.type === "checkbox") {
            expect(input.width).toBeGreaterThanOrEqual(16);
            expect(input.width).toBeLessThanOrEqual(22);
          }
        }
      } finally {
        await context.close();
      }
    }
  });

  test("potrditev obračuna stranki med shranjevanjem blokira cel pogled", async ({ browser }) => {
    const clientName = "PW obračun z indikatorjem";
    const workerContext = await browser.newContext();
    const workerPage = await workerContext.newPage();
    try {
      await localLogin(workerPage, "ibro");
      await workerPage.locator("#writeHoursButton").click();
      await workerPage.locator("#todoFormClient").fill(clientName);
      await workerPage.locator("#quickAddClientBtn").click();
      await workerPage.locator("#quickClientName").fill(clientName);
      await workerPage.locator("#quickClientForm button[type=submit]").click();
      await expect(workerPage.locator("#quickClientDialog")).toBeHidden();
      await workerPage.locator("#todoFormTask").fill("PW vpis za obračun z indikatorjem");
      await workerPage.locator("#todoFormStart").fill("08:00");
      await workerPage.locator("#todoFormEnd").fill("09:00");
      await workerPage.locator("#saveTodoDialog").click();
      await expect(workerPage.locator("#appConfirmDialog")).toBeVisible();
      await workerPage.locator("#appConfirmAccept").click();
      await expect(workerPage.locator("#todoDialog")).toBeHidden();
    } finally {
      await workerContext.close();
    }

    const bossContext = await browser.newContext();
    const page = await bossContext.newPage();
    let releaseClientBill = () => {};
    const clientBillStarted = new Promise((resolve) => { releaseClientBill = resolve; });
    let allowClientBill = () => {};
    const allowResponse = new Promise((resolve) => { allowClientBill = resolve; });
    try {
      await localLogin(page, "bojan");
      await page.locator("#toolsMenu > summary").click();
      await page.locator("#clientBillingMenuBtn").click();
      await page.locator("#reportClient").fill(clientName);
      await expect(page.locator("#confirmClientBill")).toBeEnabled();

      await page.route("**/api/client-bills", async (route, request) => {
        if (request.method() === "POST") {
          releaseClientBill();
          await allowResponse;
        }
        await route.continue();
      });
      await page.locator("#confirmClientBill").click();
      await page.locator("#appConfirmAccept").click();
      await clientBillStarted;
      await expect(page.locator("#clientBillProcessing")).toBeVisible();
      await expect(page.locator("#confirmClientBill")).toBeDisabled();
      allowClientBill();
      await expect(page.locator("#clientBillProcessing")).toBeHidden();
      await page.unroute("**/api/client-bills");
    } finally {
      allowClientBill();
      await bossContext.close();
    }
  });

  test("new task draft restores itself after browser reload and X discards it", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");
      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormTask").fill("PW preklop osnutka");
      await page.locator("#todoFormNotes").fill("Besedilo mora ostati.");
      await page.locator("#todoFormStatusField > summary").click();
      await page.locator('[data-status="internal"]').click();
      await expect(page.locator("#todoFormClient")).toHaveValue("Bojan Horvat s.p.");

      await page.locator('[data-create-mode="hours"]').click();
      await expect(page.locator("#todoFormTitle")).toHaveText("Vpis ur");
      await expect(page.locator("#todoFormStatus")).toHaveValue("execution");
      await expect(page.locator("#todoFormTask")).toHaveValue("PW preklop osnutka");
      await expect(page.locator("#todoFormNotes")).toHaveValue("Besedilo mora ostati.");
      await expect(page.locator("#todoFormClient")).toHaveValue("Bojan Horvat s.p.");

      await page.locator('[data-create-mode="task"]').click();
      await expect(page.locator("#todoFormStatus")).toHaveValue("internal");
      await expect(page.locator("#todoFormTask")).toHaveValue("PW preklop osnutka");
      const storedDraft = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith("indus-ure-creation-draft:"))?.[1] || "");
      expect(storedDraft).toContain("PW preklop osnutka");
      await page.reload({ waitUntil: "networkidle" });
      await expect(page.locator("#app")).toBeVisible();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormClient")).toHaveValue("Bojan Horvat s.p.");
      await expect(page.locator("#todoFormTask")).toHaveValue("PW preklop osnutka");
      await expect(page.locator("#todoFormDraftNotice")).toBeVisible();
      await page.locator("#todoDialog").evaluate((node) => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await expect(page.locator("#todoDialog")).toBeVisible();
      await page.locator("#closeTodoDialog").click();
      await expect(page.locator("#todoDialog")).toBeHidden();
      await page.locator("#newTodoButton").click();
      await expect(page.locator("#todoFormTask")).toHaveValue("");
      await page.locator("#todoDialog").evaluate((node) => node.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await expect(page.locator("#todoDialog")).toBeHidden();
    } finally {
      await context.close();
    }
  });

  test("file picker can add ten gallery photos to a new task before it is saved", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");
      let serverImageUploads = 0;
      await page.route("**/api/todos/image", async (route) => {
        serverImageUploads += 1;
        await route.fulfill({
          status: 201,
          contentType: "application/json",
          body: JSON.stringify({
            photo: {
              id: `pw-image-upload-${serverImageUploads}`,
              attachmentId: `${"a".repeat(63)}${serverImageUploads.toString(16)}`,
              name: `testna-fotografija-${serverImageUploads}.png`,
              comment: "",
              mimeType: "image/jpeg",
              url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLk7wAAAABJRU5ErkJggg==",
              thumbnailUrl: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLk7wAAAABJRU5ErkJggg=="
            }
          })
        });
      });
      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormAttachmentInput").setInputFiles(Array.from({ length: 10 }, (_, index) => ({
        name: `testna-fotografija-${index + 1}.png`,
        mimeType: "image/png",
        buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLk7wAAAABJRU5ErkJggg==", "base64")
      })));
      await expect(page.locator("#todoFormPhotoList img").first()).toBeVisible();
      await expect(page.locator("#todoFormPhotoList .todo-form-photo-row")).toHaveCount(10);
      await expect(page.locator("#todoFormPhotoList")).toContainText("testna-fotografija-10.png");
      expect(serverImageUploads).toBe(10);
    } finally {
      await context.close();
    }
  });

  test("a text ordering marker remains in its manual bucket and is also shown under ordering", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");
      const buckets = await page.evaluate(() => {
        const todos = [
          { id: "pw-order-unsorted", title: "Naroči kabel za test", client: "PW stranka", status: "open", syncUser: "ibro", assigneeIds: ["ibro"], sharedManualBucket: "unsorted", order: -900 },
          { id: "pw-order-sorted", title: "Še naroči stikalo", client: "PW stranka", status: "open", syncUser: "ibro", assigneeIds: ["ibro"], sharedManualBucket: "sorted", order: -899 }
        ];
        state.todos.push(...todos);
        state.todoSortMode = "manual";
        document.querySelector("#todoSortMode").value = "manual";
        renderTodos();
        const sectionFor = (item) => {
          let previous = item.previousElementSibling;
          while (previous && !previous.dataset.todoSection) previous = previous.previousElementSibling;
          return previous?.dataset.todoSection || "";
        };
        return Object.fromEntries(todos.map((todo) => [
          todo.id,
          [...document.querySelectorAll(`[data-todo-id="${todo.id}"]`)].map(sectionFor)
        ]));
      });
      expect(buckets["pw-order-unsorted"]).toEqual(["ordering", "unsorted"]);
      expect(buckets["pw-order-sorted"]).toEqual(["ordering", "sorted"]);
      await expect(page.locator('[data-todo-id="pw-order-unsorted"][data-todo-ordering-reference="true"] .drag-handle')).toBeDisabled();
    } finally {
      await context.close();
    }
  });

  test("manual change marker stays visible to the boss until it is explicitly acknowledged", async ({ browser }) => {
    const ibroContext = await browser.newContext();
    const ibroPage = await ibroContext.newPage();
    const title = "PW oznaka spremembe za potrditev";
    let todoId = "";
    try {
      await localLogin(ibroPage, "ibro");
      await ibroPage.locator("#newTodoButton").click();
      await ibroPage.locator("#todoFormTask").fill(title);
      await ibroPage.locator("#todoFormClient").fill(CLIENT_ALIAS);
      const created = ibroPage.waitForResponse((response) => response.request().method() === "POST"
        && new URL(response.url()).pathname === "/api/todos");
      await ibroPage.locator("#saveTodoDialog").click();
      expect((await created).ok()).toBeTruthy();
      await expect(ibroPage.locator("#todoDialog")).toBeHidden();
      todoId = await ibroPage.evaluate(async (taskTitle) => {
        const response = await fetch("/api/todos");
        const data = await response.json();
        return data.todos.find((todo) => todo.title === taskTitle)?.id || "";
      }, title);
      expect(todoId).toBeTruthy();
      await ibroPage.locator(`[data-todo-id="${todoId}"] .edit-todo`).click();
      await expect(ibroPage.locator("#todoFormNotifyOthers")).toBeVisible();
      await ibroPage.locator("#todoFormNotifyOthers").check();
      const marked = ibroPage.waitForResponse((response) => response.request().method() === "PUT"
        && new URL(response.url()).pathname === `/api/todos/${todoId}`);
      await ibroPage.locator("#saveTodoWithoutClosing").click();
      expect((await marked).ok()).toBeTruthy();
      await ibroPage.locator("#closeTodoDialog").click();
      await expect(ibroPage.locator("#todoDialog")).toBeHidden();
    } finally {
      await ibroContext.close();
    }

    const bossContext = await browser.newContext();
    const bossPage = await bossContext.newPage();
    try {
      await localLogin(bossPage, "bojan");
      const card = bossPage.locator(`[data-todo-id="${todoId}"]`).first();
      await expect(card).toHaveClass(/has-change-notice/);
      const acknowledged = bossPage.waitForResponse((response) => response.request().method() === "POST"
        && new URL(response.url()).pathname === `/api/todos/${todoId}/change-notice/seen`);
      await card.locator(".edit-todo").click();
      expect((await acknowledged).ok()).toBeTruthy();
      await expect(bossPage.locator("#todoDialog")).toBeVisible();
      await expect(bossPage.locator("#todoFormChangeNotice")).toBeHidden();
      await bossPage.locator("#closeTodoDialog").click();
      await expect(bossPage.locator("#todoDialog")).toBeHidden();
      await expect(card).not.toHaveClass(/has-change-notice/);
    } finally {
      await bossContext.close();
    }
  });

  test("disk save keeps new task, time entry and material entry open for further editing", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");

      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormTask").fill("PW disk opravilo");
      await page.locator("#todoFormClient").fill(CLIENT_ALIAS);
      await page.locator("#saveTodoWithoutClosing").click();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormId")).not.toHaveValue("");
      await expect(page.locator("#deleteTodoFromDialog")).toBeVisible();
      await expect(page.locator("#todoCreationTabs")).toBeHidden();
      await page.locator("#closeTodoDialog").click();

      await page.locator("#writeHoursButton").click();
      await page.locator("#todoFormTask").fill("PW disk ure");
      await page.locator("#todoFormClient").fill(CLIENT_ALIAS);
      await page.locator("#todoFormDate").fill(DISK_ENTRY_DATE);
      await page.locator("#todoFormStart").fill("08:00");
      await page.locator("#todoFormEnd").fill("09:00");
      await page.locator("#todoFormBillingKm").fill("1");
      await page.locator("#todoFormClientKm").fill("1");
      await page.locator("#saveTodoWithoutClosing").click();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormId")).not.toHaveValue("");
      await expect(page.locator("#deleteTodoFromDialog")).toBeVisible();
      await page.locator("#closeTodoDialog").click();

      await page.locator("#materialEntryButton").click();
      await page.locator("#todoFormTask").fill("PW disk material");
      await page.locator("#todoFormClient").fill(CLIENT_ALIAS);
      await page.locator("#saveTodoWithoutClosing").click();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormId")).not.toHaveValue("");
      await expect(page.locator("#deleteTodoFromDialog")).toBeVisible();
    } finally {
      await context.close();
    }
  });

  test("task name suggestions contain only projects for the selected client", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "bojan");
      await page.locator("#newTodoButton").click();
      const suggestions = await page.evaluate(() => {
        const target = { clientId: "pw-suggestions-target", name: "PW ciljna stranka", search: "PW ciljna stranka" };
        const other = { clientId: "pw-suggestions-other", name: "PW druga stranka", search: "PW druga stranka" };
        state.clients.push(target, other);
        const date = new Date().toISOString().slice(0, 10);
        state.todos.push(
          { id: "pw-target-project", title: "PW samo ciljna", client: target.name, clientId: target.clientId, date },
          { id: "pw-other-project", title: "PW samo druga", client: other.name, clientId: other.clientId, date },
        );
        const input = document.querySelector("#todoFormClient");
        input.value = target.search;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return [...document.querySelectorAll("#todoFormTaskSuggestions option")].map((option) => option.value);
      });
      expect(suggestions).toEqual(["PW samo ciljna"]);
      const emptySuggestions = await page.evaluate(() => {
        const input = document.querySelector("#todoFormClient");
        input.value = "";
        input.dispatchEvent(new Event("input", { bubbles: true }));
        return document.querySelectorAll("#todoFormTaskSuggestions option").length;
      });
      expect(emptySuggestions).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("saving an event closes immediately and submits only once in the background", async ({ browser }) => {
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
      // The primary checkmark intentionally closes the form before the
      // network write completes. That removes the duplicate-save surface
      // without interrupting the user with a progress banner.
      await expect(dialog).toBeHidden();
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect.poll(() => postCount).toBe(1);
      releasePost();
      await expect.poll(() => page.locator("#todoItems").innerText()).toContain("PW vidno shranjevanje");
      expect(postCount).toBe(1);
      await page.unroute("**/api/todos");
    } finally {
      releasePost?.();
      await context.close();
    }
  });

  test("existing event shows its read-only shell before a delayed edit lock", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const title = "PW takojšnje odpiranje";
    let releaseLock = null;
    let editorTiming = null;
    const allowLock = new Promise((resolve) => { releaseLock = resolve; });
    try {
      await localLogin(page, "ibro");
      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormTask").fill(title);
      await page.locator("#todoFormClient").fill(CLIENT_ALIAS);
      await page.locator("#saveTodoDialog").click();
      await expect(page.locator("#todoDialog")).toBeHidden();

      await page.route("**/api/todos/*/lock", async (route, request) => {
        if (request.method() === "POST") await allowLock;
        await route.continue();
      });
      await page.route("**/api/todo-editor-diagnostics", async (route, request) => {
        editorTiming = JSON.parse(request.postData() || "{}");
        await route.continue();
      });
      const card = page.locator(".todo-item", { hasText: title }).first();
      await card.locator(".edit-todo").click();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormOpeningStatus")).toBeVisible();
      await expect(page.locator("#saveTodoDialog")).toBeDisabled();

      releaseLock();
      await expect(page.locator("#todoFormOpeningStatus")).toBeHidden();
      await expect(page.locator("#saveTodoDialog")).toBeEnabled();
      await expect.poll(() => editorTiming?.result).toBe("ready");
      expect(editorTiming).toMatchObject({ todoId: expect.any(String), attachmentCount: 0 });
      expect(editorTiming).not.toHaveProperty("title");
      expect(editorTiming).not.toHaveProperty("client");
      await page.unroute("**/api/todos/*/lock");
      await page.unroute("**/api/todo-editor-diagnostics");
    } finally {
      releaseLock?.();
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
      await expect(page.locator("#todoFormDateTimeSection")).toHaveAttribute("open", "");
      await expect(page.locator("#todoFormQuickTimePicker")).toBeVisible();
      await expect(page.locator("#todoFormQuickTimeDial")).toBeHidden();
      await chooseQuickTime(page, '[data-time-picker-target="start"]');
      await expect(page.locator("#todoFormQuickTimeDial")).toBeVisible();
      await chooseQuickTime(page, '[data-time-picker-hour="8"]');
      await chooseQuickTime(page, '[data-time-picker-minute="0"]');
      await expect(page.locator('[data-time-picker-target="end"]')).toHaveClass(/active/);
      await expect(page.locator('[data-time-picker-target="end"]')).toHaveText('Do 09:00');
      await chooseQuickTime(page, '[data-time-picker-hour="10"]');
      await chooseQuickTime(page, '[data-time-picker-minute="0"]');
      await expect(page.locator("#todoFormQuickTimeDial")).toBeHidden();
      await expect(page.locator("#todoFormStart")).toHaveValue("08:00");
      await expect(page.locator("#todoFormEnd")).toHaveValue("10:00");

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

  test("material entry stays a compact delivery form", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");
      await page.locator("#materialEntryButton").click();
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormTitle")).toHaveText("Vpis materiala");
      await expect(page.locator("#todoFormTimeFields")).toBeHidden();
      await expect(page.locator("#todoFormEndDateField")).toBeHidden();
      await expect(page.locator("#todoFormMaterialAmount")).toHaveCount(0);
      await expect(page.locator("#todoFormExternalDelivery")).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
  test("note entry is client-only and never exposes a worker time entry", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");
      await page.locator("#newTodoButton").click();
      await page.locator("#todoFormStatusField > summary").click();
      await page.locator('[data-status="note"]').click();
      await expect(page.locator("#todoFormTitle")).toHaveText("Nov zapisek");
      await expect(page.locator("#todoFormAssigneesField")).toBeHidden();
      await expect(page.locator("#todoFormBillingKmField")).toBeHidden();
      await expect(page.locator("#todoFormHourlyRateField")).toBeHidden();
      await expect(page.locator("#todoFormDateTimeSection")).toBeVisible();
    } finally {
      await context.close();
    }
  });
  test("boss downloads the selected customer report as a real PDF on a touch browser", async ({ browser }) => {
    const context = await browser.newContext({
      acceptDownloads: true,
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true
    });
    const page = await context.newPage();
    try {
      await localLogin(page, "bojan");
      await page.locator("#toolsMenu > summary").click();
      await page.locator("#clientBillingMenuBtn").click();
      await expect(page.locator(".report-screen")).toBeVisible();
      await page.locator("#reportClient").fill(CLIENT_ALIAS);
      await expect(page.locator("#exportReportPdf")).toBeEnabled();
      expect(await page.evaluate(() => window.matchMedia("(pointer: coarse)").matches)).toBeTruthy();

      const popupPromise = page.waitForEvent("popup");
      await page.locator("#exportReportPdf").click();
      const popup = await popupPromise;
      const downloadPromise = popup.waitForEvent("download");
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/^obračun-.*\.pdf$/i);
      const stream = await download.createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(Buffer.concat(chunks).subarray(0, 4).toString()).toBe("%PDF");
    } finally {
      await context.close();
    }
  });

  test("worker shares an individual event as a direct PDF download on desktop", async ({ browser }) => {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    const title = "PW deljenje posameznega dogodka";
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
      await page.locator(`[data-todo-id="${todoId}"] .edit-todo`).click();
      await expect(page.locator("#shareTodoPdf")).toBeVisible();
      const downloadPromise = page.waitForEvent("download");
      await page.locator("#shareTodoPdf").click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toMatch(/^dogodek-.*\.pdf$/i);
      const stream = await download.createReadStream();
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      expect(Buffer.concat(chunks).subarray(0, 4).toString()).toBe("%PDF");
    } finally {
      await context.close();
    }
  });

  test("authenticated reload uses one bootstrap snapshot without the login image", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");
      const requestedApiPaths = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.origin === app.baseUrl) requestedApiPaths.push(url.pathname);
      });
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(page.locator("#app")).toBeVisible();
      await expect.poll(() => requestedApiPaths.includes("/api/bootstrap")).toBeTruthy();
      expect(requestedApiPaths).not.toContain("/api/todos");
      expect(requestedApiPaths).not.toContain("/api/entries");
      expect(requestedApiPaths).not.toContain("/api/clients");
      const resources = await page.evaluate(() => performance.getEntriesByType("resource").map((entry) => entry.name));
      expect(resources.some((name) => name.includes("indus-hero-electro.png"))).toBeFalsy();
    } finally {
      await context.close();
    }
  });

  test("quick home-screen task opens only its form and returns to the normal app on close", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const requests = [];
    page.on("request", (request) => {
      if (request.url().startsWith(app.baseUrl)) requests.push(new URL(request.url()).pathname);
    });
    try {
      await localLogin(page, "ibro", "/?quick=task", { expectApp: false });
      await expect(page.locator("#todoDialog")).toBeVisible();
      await expect(page.locator("#todoFormTitle")).toHaveText("Novo opravilo");
      await expect(page.locator("body")).toHaveClass(/quick-create/);
      await expect(page.locator("#app")).toBeHidden();
      expect(requests).toContain("/api/quick-create");
      expect(requests).not.toContain("/api/bootstrap");
      await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest?quick=task");
      // The quick form closes synchronously and then intentionally uses
      // location.replace().  Waiting for a load navigation here is brittle:
      // Playwright reports the replaced document as aborted even though the
      // normal app has already become visible.  Assert the observable result
      // instead: no quick mode, the regular app is present and the URL is root.
      await page.locator("#closeTodoDialog").click();
      await expect(page.locator("#app")).toBeVisible();
      await expect.poll(() => new URL(page.url()).searchParams.has("quick")).toBeFalsy();
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
      await page.route("**/api/bootstrap", async (route, request) => {
        const requestUrl = new URL(request.url());
        if (request.method() === "GET" && requestUrl.pathname === "/api/bootstrap") {
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
        return response.request().method() === "GET" && requestUrl.pathname === "/api/bootstrap" && response.ok();
      });
      releaseFullSnapshot();
      await resumedSnapshot;
      await page.unroute("**/api/bootstrap");
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
      await expect(workerPage.locator("#todoFormDateTimeSection")).toHaveAttribute("open", "");
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
        // The current monthly grid ends on the following Sunday, therefore
        // keep the whole asserted span inside the visible grid even when a
        // month starts on Monday.
        end.setDate(end.getDate() + 6);
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
      await expect(page.locator("#dayTimelineDialog")).toBeHidden();
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
      await expect(page.locator("#dayTimelineDialog")).toBeHidden();
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
          const request = indexedDB.open("indus-ure-offline", 4);
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


  test("history safely undoes only the latest business action through the menu", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const title = "PW zgodovina sprememb";
    try {
      await localLogin(page, "bojan");
      await page.locator("#materialEntryButton").click();
      await page.locator("#todoFormTask").fill(title);
      await page.locator("#todoFormClient").fill(CLIENT_ALIAS);
      await page.locator("#quickAddClientBtn").click();
      await expect(page.locator("#quickClientDialog")).toBeVisible();
      await page.locator("#quickClientName").fill(CLIENT_ALIAS);
      await page.locator("#quickClientForm button[type=submit]").click();
      await expect(page.locator("#quickClientDialog")).toBeHidden();
      await page.locator("#saveTodoDialog").click();
      await expect(page.locator("#todoDialog")).toBeHidden();

      await page.locator("#toolsMenu > summary").click();
      await page.locator("#undoHistoryBtn").click();
      await expect(page.locator("#undoHistoryDialog")).toBeVisible();
      await expect(page.locator("#undoHistoryList")).toContainText(title);
      await page.locator("[data-undo-history-id]").first().click();
      await expect(page.locator("#appConfirmDialog")).toBeVisible();
      await page.locator("#appConfirmAccept").click();
      await expect(page.locator("#undoHistoryList")).toContainText("Razveljavljeno");
      await expect(page.locator("#todoItems")).not.toContainText(title);
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
  test("time validation does not leak into the next hours form", async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await localLogin(page, "ibro");
      await page.locator("#writeHoursButton").click();
      await page.locator("#todoFormTask").fill("PW invalid time");
      await page.locator("#todoFormDate").fill(ENTRY_DATE);
      await page.locator("#todoFormStart").evaluate((input) => {
        input.value = "10:00";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.locator("#todoFormEnd").evaluate((input) => {
        input.value = "08:00";
        input.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await page.locator("#saveTodoDialog").click();
      await expect(page.locator(".form-validation-error")).toContainText("Ura do mora biti kasneje kot ura od.");

      await page.locator("#closeTodoDialog").click();
      await expect(page.locator("#todoDialog")).toBeHidden();
      await page.locator("#writeHoursButton").click();
      await expect(page.locator(".form-validation-error")).toBeHidden();

      await chooseQuickTime(page, '[data-time-picker-target="start"]');
      await chooseQuickTime(page, '[data-time-picker-hour="8"]');
      await chooseQuickTime(page, '[data-time-picker-minute="0"]');
      await chooseQuickTime(page, '[data-time-picker-hour="17"]');
      await chooseQuickTime(page, '[data-time-picker-minute="0"]');
      await expect(page.locator("#todoFormStart")).toHaveValue("08:00");
      await expect(page.locator("#todoFormEnd")).toHaveValue("17:00");
      await expect(page.locator("#todoFormQuickTimeDuration")).toHaveText("Skupaj 9 h");
      await expect(page.locator(".form-validation-error")).toBeHidden();
    } finally {
      await context.close();
    }
  });
});
