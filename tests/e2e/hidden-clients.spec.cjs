const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
let app;
test.use({ viewport: { width: 390, height: 844 } });
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });

async function login(page, user = "bojan") {
  await page.goto(app.baseUrl);
  await page.locator("#localTestUser").selectOption(user);
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
}

test("boss can hide and restore an active client without changing tasks or billing", async ({ page }) => {
  await login(page);
  const fixture = await page.evaluate(async () => {
    const { client } = await api("/api/clients", { method: "POST", body: JSON.stringify({ name: "Hidden client QA", search: "Alias hide QA" }) });
    for (const status of ["open", "execution"]) {
      await api("/api/todos", { method: "POST", body: JSON.stringify({ title: `Hidden QA ${status}`, client: client.name, clientId: client.clientId, status, date: "2032-04-01", start: "08:00", end: "09:00", syncUser: "ibro", assigneeIds: ["ibro"] }) });
    }
    await loadAll();
    return { client, todos: state.todos.filter(todo => todo.clientId === client.clientId), bills: state.clientBills };
  });
  await page.locator("#newTodoButton").click();
  await page.locator("#todoFormClient").fill(fixture.client.search);
  await page.getByRole("button", { name: `Uredi stranko: ${fixture.client.search}`, exact: true }).click();
  await page.getByLabel("Skrij pri novih opravilih", { exact: true }).check();
  await page.locator("#saveClientEdit").click();
  await expect(page.locator("#clientEditDialog")).toBeHidden();
  await page.locator("#todoFormClient").fill("Alias hide");
  await expect(page.locator("#todoFormClientSuggestions")).toBeHidden();
  await page.locator("#closeTodoDialog").click();
  await expect(page.locator("#todoDialog")).toBeHidden();
  await page.reload();
  await expect(page.locator("#app")).toBeVisible();
  await page.evaluate(() => loadAll());
  expect(await page.evaluate(id => ({ todos: state.todos.filter(todo => todo.clientId === id), bills: state.clientBills }), fixture.client.clientId))
    .toEqual({ todos: fixture.todos, bills: fixture.bills });

  // All creation tabs share the picker; nothing reappears after refresh.
  for (const name of ["Nov dogodek", "Vpis ur", "Vpis materiala", "Zapisek"]) {
    await page.locator("#newTodoButton").click();
    await page.getByRole("tab", { name, exact: true }).click();
    await page.locator("#todoFormClient").fill("Hidden client QA");
    await expect(page.locator("#todoFormClientSuggestions")).toBeHidden();
    await page.locator("#closeTodoDialog").click();
    await expect(page.locator("#todoDialog")).toBeHidden();
  }

  // Existing records remain editable, and historical/report lookup keeps the client.
  await page.evaluate(id => openTodoDialog(state.todos.find(todo => todo.clientId === id && todo.status === "open")), fixture.client.clientId);
  await expect(page.locator("#todoFormClient")).toHaveValue(fixture.client.search);
  await page.locator("#todoFormClient").fill("Alias hide");
  await expect(page.locator(".client-autocomplete-option").filter({ hasText: fixture.client.search })).toBeVisible();
  await page.locator("#closeTodoDialog").click();
  await expect(page.locator("#todoDialog")).toBeHidden();
  await page.evaluate(() => setView("clients"));
  await page.locator("#clientsSearch").fill(fixture.client.search);
  const row = page.locator(".client-row").filter({ hasText: fixture.client.name });
  await expect(row.getByText("Skrita pri novih opravilih", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Uredi", exact: true }).click();
  await expect(page.getByLabel("Skrij pri novih opravilih", { exact: true })).toBeChecked();
  await page.screenshot({ path: test.info().outputPath("hidden-client-setting.png") });
  await page.getByLabel("Skrij pri novih opravilih", { exact: true }).uncheck();
  await page.locator("#saveClientEdit").click();
  await expect(page.locator("#clientEditDialog")).toBeHidden();
  await page.evaluate(() => setView("todos"));
  await page.locator("#newTodoButton").click();
  await page.locator("#todoFormClient").fill(fixture.client.search);
  await expect(page.locator(".client-autocomplete-option").filter({ hasText: fixture.client.search })).toBeVisible();
});

test("hidden clients resist legacy fallback and missing fields; workers cannot change visibility", async ({ page, browser }) => {
  await login(page);
  const client = await page.evaluate(async () => {
    const { client } = await api("/api/clients", { method: "POST", body: JSON.stringify({ name: "Hidden permissions QA", hiddenFromNewTasks: true }) });
    // Older clients omit the new field; that must never reactivate the client.
    const updated = await api("/api/clients", { method: "POST", body: JSON.stringify({ clientId: client.clientId, name: client.name }) });
    if (!updated.client.hiddenFromNewTasks) throw new Error("Legacy update lost visibility setting");
    await loadAll();
    state.todos.push({ id: "legacy-name-only", client: client.name, title: "Legacy fallback", status: "open" });
    if (clientSuggestionValues().some(row => row.value === client.name)) throw new Error("Legacy reference reintroduced hidden client");
    if (!findClient(client.clientId)) throw new Error("Hidden client lost from historical lookup");
    return client;
  });
  const context = await browser.newContext();
  try {
    const worker = await context.newPage();
    await login(worker, "ibro");
    const status = await worker.evaluate(async client => {
      const attempt = async body => {
        try { await api("/api/clients", { method: "POST", body: JSON.stringify(body) }); return 200; }
        catch (error) { return error.status; }
      };
      return [
        await attempt({ ...client, hiddenFromNewTasks: false }),
        await attempt({ name: "Worker cannot hide new client", hiddenFromNewTasks: true }),
        await attempt({ ...client, hiddenFromNewTasks: "false" }),
        await attempt({ clientId: client.clientId, name: client.name, search: client.search })
      ];
    }, client);
    expect(status).toEqual([403, 403, 400, 200]);
    await worker.locator("#newTodoButton").click();
    await worker.locator("#todoFormClient").fill(client.name);
    await expect(worker.locator("#todoFormClientSuggestions")).toBeHidden();
    await worker.locator("#closeTodoDialog").click();
    await expect(worker.locator("#todoDialog")).toBeHidden();
    await worker.evaluate(async id => { await loadAll(); openClientEditDialog(id); }, client.clientId);
    await expect(worker.locator("#clientEditVisibilityArea")).toBeHidden();
    expect(await worker.evaluate(id => findClient(id).hiddenFromNewTasks, client.clientId)).toBe(true);
  } finally { await context.close(); }
});
