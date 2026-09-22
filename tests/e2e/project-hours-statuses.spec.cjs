const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");

const allowed = ["open", "in_progress", "internal", "order", "order_car", "order_warehouse", "add_to_car", "return", "return_and_bill"];
const excluded = ["bill", "execution", "meal", "drive", "purchase", "note", "material"];
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 900 }]) {
  test(`project hours: every working status saves a separate entry and keeps the source (${viewport.width}px)`, async ({ browser }) => {
    test.setTimeout(120_000);
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    try {
      await page.goto(app.baseUrl);
      await page.locator("#localTestUser").selectOption("ibro");
      await page.locator("#localTestPassword").fill(TEST_PASSWORD);
      await page.locator("#localTestLoginBtn").click();
      await expect(page.locator("#app")).toBeVisible();
      for (const [index, status] of allowed.entries()) {
        const title = `Project hours ${viewport.width} ${status}`;
        const source = await page.evaluate(async ({ title, status, index, width }) => {
          const result = await api("/api/todos", { method: "POST", body: JSON.stringify({
            title, status, client: "Status test client", syncUser: "ibro", assigneeIds: ["ibro"],
            date: `2032-${width === 390 ? "10" : "11"}-${String(index + 1).padStart(2, "0")}`,
            notes: "Izvorni opis ostane", material: "Izvorni material ostane", ordered: status.startsWith("order")
          }) });
          await loadAll();
          return result.todos.find(todo => todo.title === title);
        }, { title, status, index, width: viewport.width });
        await page.locator(".todo-item").filter({ hasText: title }).locator(".edit-todo").click();
        await expect(page.locator("#writeHoursFromTodo")).toBeVisible();
        await expect(page.locator("#todoFooterWriteHours")).toBeVisible();
        if (status === "order") await page.screenshot({ path: test.info().outputPath("project-order-hours-button.png") });
        // Exercise both the toolbar icon and the mirrored footer button.
        await page.locator(index % 2 ? "#todoFooterWriteHours" : "#writeHoursFromTodo").click();
        await expect(page.locator("#todoFormStatus")).toHaveValue("execution");
        await expect(page.locator("#todoFormId")).toHaveValue("");
        await expect(page.locator("#todoFormTask")).toHaveValue(title);
        await expect(page.locator("#todoFormDate")).toHaveValue(source.date);
        await expect(page.locator("#todoFormNotes")).toHaveValue("");
        await expect(page.locator("#writeHoursFromTodo")).toBeHidden();
        await page.locator("#todoFormNotes").fill("Opravljeno delo za projekt");
        await page.locator("#todoFormClientKm").fill("1");
        await page.locator("#todoFormBillingKm").fill("1");
        const responsePromise = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/todos");
        await page.locator("#saveTodoDialog").click();
        const response = await responsePromise;
        expect(response.ok()).toBe(true);
        expect(response.request().postDataJSON().sourceProjectTodoId, status).toBe(source.id);
        const result = await response.json();
        expect(result.todos.find(todo => todo.id === source.id)).toMatchObject(source);
        const entry = result.todos.find(todo => todo.sourceProjectTodoId === source.id);
        expect(entry).toMatchObject({ status: "execution", sourceProjectTitle: title, clientId: source.clientId, syncUser: "ibro", notes: "Opravljeno delo za projekt" });
        expect(entry.id).not.toBe(source.id);
        await expect(page.locator("#projectCompletionDialog")).toBeVisible();
        await page.locator("#rescheduleProject").click();
        await expect(page.locator("#todoFormId")).toHaveValue(source.id);
        await expect(page.locator("#todoFormStatus")).toHaveValue(status);
        await expect(page.locator("#todoFormNotes")).toHaveValue(source.notes);
        await page.locator("#closeTodoDialog").click();
        await expect(page.locator("#todoDialog")).toBeHidden();
      }
    } finally {
      await context.close();
    }
  });
}

test("billing-only, note, material and time-entry records never offer project hours", async ({ page }) => {
  await page.goto(app.baseUrl);
  await page.locator("#localTestUser").selectOption("bojan");
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
  for (const [index, status] of excluded.entries()) {
    await page.evaluate(async ({ status, index }) => {
      const title = `Excluded hours ${status}`;
      const client = state.clients.find(item => item.name === "Excluded status client");
      const result = await api("/api/todos", { method: "POST", body: JSON.stringify({
        title, status, client: "Excluded status client", clientId: client?.clientId || client?.id || "", syncUser: "bojan", assigneeIds: ["bojan"],
        date: `2032-12-${String(index + 1).padStart(2, "0")}`, start: "08:00", end: "09:00"
      }) });
      await loadAll();
      await openTodoDialog(result.todos.find(todo => todo.title === title));
    }, { status, index });
    await expect(page.locator("#todoDialog")).toBeVisible();
    await expect(page.locator("#writeHoursFromTodo")).toBeHidden();
    await expect(page.locator("#todoFooterWriteHours")).toBeHidden();
    await page.locator("#closeTodoDialog").click();
    await expect(page.locator("#todoDialog")).toBeHidden();
  }
});
