const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
let app;
test.beforeEach(async () => { app = await startIsolatedTestApp(); });
test.afterEach(async () => { await app?.stop(); });

for (const width of [390, 1280]) {
  test(`trash search filters locally, clears to all, and restores only its selected result (${width}px)`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(app.baseUrl);
    await page.locator("#localTestUser").selectOption("bojan");
    await page.locator("#localTestPassword").fill(TEST_PASSWORD);
    await page.locator("#localTestLoginBtn").click();
    await expect(page.locator("#app")).toBeVisible();
    const ids = await page.evaluate(async () => {
      const ids = [];
      for (const [title, name] of [["Popis luči", "Anže Zupin"], ["Montaža", "Anže Zupin"], ["Servis omare", "Miro Janežič"]]) {
        const { client } = await api("/api/clients", { method: "POST", body: JSON.stringify({ name }) });
        const data = await api("/api/todos", { method: "POST", body: JSON.stringify({ title, client: client.name,
          clientId: client.clientId, status: "open", date: "2032-09-09", syncUser: "bojan", assigneeIds: ["bojan"] }) });
        const todo = data.todos.find(t => t.title === title);
        ids.push(todo.id);
        await api(`/api/todos/${encodeURIComponent(todo.id)}`, { method: "DELETE" });
      }
      await loadAll();
      return ids;
    });
    const openTrash = async () => {
      await page.locator("#toolsMenu > summary").click();
      await page.locator("#trashMenuBtn").click();
      await expect(page.locator("#deletedTodosDialog")).toBeVisible();
    };
    await openTrash();
    const cards = page.locator("#deletedTodosList .deleted-todo-card");
    const search = page.getByRole("searchbox", { name: "Išči v košu" });
    await expect(cards).toHaveCount(3);
    const requests = [];
    const track = request => { if (new URL(request.url()).pathname.startsWith("/api/todos")) requests.push(request.url()); };
    page.on("request", track);
    const before = await page.evaluate(() => JSON.stringify(state.deletedTodos));
    await search.fill("  ANZE  ");
    await expect(cards).toHaveCount(2);
    await search.fill("anze luci");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Popis luči");
    await expect(page.locator("#deletedTodosMeta")).toContainText("Prikazano 1 od 3");
    await search.press("Enter");
    await expect(page.locator("#deletedTodosDialog")).toBeVisible();
    await search.fill("neobstoječe opravilo");
    await expect(cards).toHaveCount(0);
    await expect(page.locator("#deletedTodosList")).toHaveText("Ni zadetkov za vpisani filter.");
    await search.fill("<img src=x onerror=alert(1)>");
    await expect(page.locator("#deletedTodosDialog img")).toHaveCount(0);
    await search.fill("   ");
    await expect(cards).toHaveCount(3);
    await search.fill("popis");
    await expect(cards).toHaveCount(1);
    expect(await page.evaluate(() => JSON.stringify(state.deletedTodos))).toBe(before);
    expect(requests).toEqual([]);
    page.off("request", track);
    const bounds = await page.locator("#deletedTodosDialog").evaluate(el => ({ width: el.clientWidth, scroll: el.scrollWidth }));
    expect(bounds.scroll).toBeLessThanOrEqual(bounds.width + 1);
    await page.screenshot({ path: test.info().outputPath(`trash-search-${width}.png`) });
    const restored = page.waitForResponse(r => r.url().endsWith(`/api/todos/${ids[0]}/restore`) && r.request().method() === "POST");
    await cards.first().getByRole("button", { name: "Obnovi", exact: true }).click();
    expect((await restored).status()).toBe(200);
    await expect(search).toHaveValue("popis");
    await expect(cards).toHaveCount(0);
    await expect(page.locator("#deletedTodosMeta")).toContainText("Prikazano 0 od 2");
    await search.fill("");
    await expect(cards).toHaveCount(2);
    await search.fill("miro");
    await page.locator("#closeDeletedTodos").click();
    await openTrash();
    await expect(search).toHaveValue("");
    await expect(cards).toHaveCount(2);
    // An empty trash is distinct from a filter with no matching results.
    for (const id of ids.slice(1)) {
      await page.locator(`[data-deleted-todo-id="${id}"] .restore-deleted-todo`).click();
      await expect(page.locator(`[data-deleted-todo-id="${id}"]`)).toHaveCount(0);
    }
    await expect(page.locator("#deletedTodosList")).toHaveText("Koš je prazen.");
    await search.fill("popis");
    await expect(page.locator("#deletedTodosList")).toHaveText("Koš je prazen.");
  });
}
