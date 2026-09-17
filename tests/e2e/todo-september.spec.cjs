const { test, expect } = require("@playwright/test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./test-app.cjs");
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });
async function login(page) {
  await page.goto(app.baseUrl);
  await page.locator("#localTestUser").selectOption("bojan");
  await page.locator("#localTestPassword").fill(TEST_PASSWORD);
  await page.locator("#localTestLoginBtn").click();
  await expect(page.locator("#app")).toBeVisible();
  await page.waitForLoadState("networkidle");
}

test("duration follows start, midnight persists, manual customer hours stay independent", async ({ page }) => {
  await login(page);
  await page.evaluate(() => openTodoDialog({ _standaloneHours: true, status: "execution", date: "2032-03-19" }));
  await page.evaluate(() => {
    $("todoFormStart").value = "08:15"; $("todoFormEnd").value = "10:45";
    $("todoFormClientBillableHours").dataset.manual = "true";
    $("todoFormClientBillableHours").value = "4";
    renderTodoFormQuickTimePicker();
  });
  if (!await page.locator("#todoFormQuickTimeStart").isVisible()) await page.locator("#todoFormDateTimeSection > summary").click();
  await page.locator("#todoFormQuickTimeStart").click();
  await page.locator('[data-time-picker-hour="23"]').click();
  await page.locator('[data-time-picker-minute="0"]').click();
  await expect(page.locator("#todoFormQuickTimeEnd")).toHaveText("Do 24:00");
  await expect(page.locator("#todoFormQuickTimeDuration")).toHaveText("Skupaj 1 h");
  await expect(page.locator("#todoFormClientBillableHours")).toHaveValue("4");
});

test("client pencil preserves unsaved task and updates selected alias", async ({ page }) => {
  await login(page);
  await page.evaluate(async () => {
    await api("/api/clients", { method: "POST", body: JSON.stringify({ name: "Pencil QA", search: "Pencil QA" }) });
    await loadAll();
  });
  await page.locator("#newTodoButton").click();
  await page.locator("#todoFormTask").fill("Unsaved task survives");
  await page.locator("#todoFormClient").fill("Pencil QA");
  await page.getByRole("button", { name: "Uredi stranko: Pencil QA", exact: true }).click();
  await expect(page.locator("#clientEditDialog")).toBeVisible();
  await page.locator("#clientEditSearch").fill("Pencil new alias");
  await page.locator("#clientEditForm button[type=submit]").click();
  await expect(page.locator("#clientEditDialog")).toBeHidden();
  await expect(page.locator("#todoDialog")).toBeVisible();
  await expect(page.locator("#todoFormTask")).toHaveValue("Unsaved task survives");
  await expect(page.locator("#todoFormClient")).toHaveValue("Pencil new alias");
});

test("Back places orientation separator where settled client disappeared, including empty list", async ({ page }) => {
  await login(page);
  await page.evaluate(() => {
    state.clients = ["A", "B", "C"].map(name => ({ id: name, clientId: name, name }));
    state.todos = state.clients.map(c => ({ id: `row-${c.id}`, title: c.name, clientId: c.id, client: c.name, status: "execution", done: true, date: "2026-09-16", start: "08:00", end: "09:00", syncUser: "ibro", assigneeIds: ["ibro"] }));
    state.clientBills = []; state.entries = []; state.reportClient = ""; state.reportClientId = "";
    state.reportClientSort = "name_asc"; $("reportClient").value = "";
    setView("report"); renderReport();
  });
  await page.locator('.open-client-report[data-client-id="B"]').click();
  await page.evaluate(() => { state.todos = state.todos.filter(t => t.clientId !== "B"); renderReport(); });
  await page.locator("#reportBackToClients").click();
  await expect(page.locator(".client-billing-return-marker")).toBeVisible();
  expect(await page.locator("#clientDetailList").evaluate(el => [...el.children].map(c => c.dataset.clientId || "marker"))).toEqual(["A", "marker", "C"]);
  await page.locator('.open-client-report[data-client-id="A"]').click();
  await page.evaluate(() => { state.todos = []; renderReport(); });
  await page.locator("#reportBackToClients").click();
  await expect(page.locator(".client-billing-return-marker")).toBeVisible();
});

test("only checked billing rows transfer to adhoc target and transferred rows are highlighted", async ({ page }) => {
  await login(page);
  await page.evaluate(async () => {
    for (const [i, client] of ["Bulk UI source", "Bulk UI source", "Bulk UI target"].entries()) {
      await api("/api/todos", { method: "POST", body: JSON.stringify({ title: `Bulk UI ${i}`, client, date: "2032-04-01", start: `${String(8+i).padStart(2,"0")}:00`, end: `${String(9+i).padStart(2,"0")}:00`, status: "execution", syncUser: "ibro", assigneeIds: ["ibro"] }) });
    }
    await loadAll(); state.reportClient = ""; state.reportClientId = ""; $("reportClient").value = "";
    setView("report"); renderReport();
  });
  await page.locator('.open-client-report[data-client-name="Bulk UI source"]').click();
  await page.locator("#clearClientBillSelection").click();
  await expect(page.locator("#bulkChangeReportClient")).toBeDisabled();
  await page.locator('[data-client-bill-event-id]').first().check();
  await page.locator("#bulkClientTarget").fill("Bulk UI target");
  await page.locator("#bulkChangeReportClient").click();
  await expect(page.locator("#appConfirmMessage")).toContainText("Samo 1 označenih");
  await page.locator("#appConfirmAccept").click();
  await expect(page.locator("#clientDetailTitle")).toHaveText("Poročilo: Bulk UI target");
  await expect(page.locator(".client-billing-row")).toHaveCount(2);
  await expect(page.locator(".client-billing-row.is-reassigned")).toHaveCount(1);
  await expect(page.locator('[data-client-bill-event-id]:checked')).toHaveCount(1);
  const sourceCount = await page.evaluate(() => state.todos.filter(t => t.client === "Bulk UI source").length);
  expect(sourceCount).toBe(1);
  await page.locator("#clearClientBillSelection").click();
  await page.locator('.is-reassigned [data-client-bill-event-id]').check();
  await page.locator("#bulkClientTarget").fill("Brand new adhoc UI");
  await page.locator("#bulkChangeReportClient").click();
  await expect(page.locator("#appConfirmMessage")).toContainText("nova adhoc");
  await page.locator("#appConfirmAccept").click();
  await expect(page.locator("#clientDetailTitle")).toHaveText("Poročilo: Brand new adhoc UI");
  await expect(page.locator(".client-billing-row")).toHaveCount(1);
});

test("phone photo editor has readable multiline text, large touch selection, move, edit, undo and save", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.locator("#newTodoButton").click();
  await expect(page.locator("#todoForm")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator("#saveTodoDialog")).toBeEnabled();
  await page.evaluate(() => {
    const canvas = document.createElement("canvas"); canvas.width = 1920; canvas.height = 1440;
    const ctx = canvas.getContext("2d"); ctx.fillStyle = "#dde7eb"; ctx.fillRect(0,0,1920,1440);
    ctx.fillStyle = "#546873"; ctx.fillRect(200,300,900,500);
    const photo = { id: "mobile-qa-photo", data: canvas.toDataURL("image/png"), mimeType: "image/png" };
    state.todoDialogPhotos = [photo]; openPhotoEditor(photo);
  });
  await expect(page.locator("#photoEditorDialog")).toBeVisible();
  await page.locator("#photoEditorAddText").click();
  await page.locator("#photoEditorText").fill("Priklop črpalke\nPreveri varovalko");
  await page.locator("#photoEditorConfirmPending").click();
  await expect(page.locator("#photoEditorTextTools")).toBeVisible();
  const size = await page.evaluate(() => state.photoEditor.texts[0].size * $("photoEditorCanvas").getBoundingClientRect().width / $("photoEditorCanvas").width);
  expect(size).toBeGreaterThan(18);
  expect(await page.locator("#photoEditorTextLarger").evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
  await page.locator("#photoEditorTextLarger").click();
  await page.locator("#photoEditorText").fill("Popravljeno\nDruga vrstica");
  await page.locator("#photoEditorText").blur();
  const before = await page.evaluate(() => ({ ...state.photoEditor.texts[0] }));
  const point = await page.evaluate(() => { const c = $("photoEditorCanvas"), r = c.getBoundingClientRect(), t = state.photoEditor.texts[0]; return { x: r.left + t.x*r.width/c.width, y: r.top + t.y*r.height/c.height }; });
  await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 35, point.y + 25, { steps: 4 }); await page.mouse.up();
  expect(await page.evaluate(() => state.photoEditor.texts[0].x)).toBeGreaterThan(before.x);
  await page.locator("#photoEditorUndo").click();
  expect(await page.evaluate(() => state.photoEditor.texts[0].x)).toBe(before.x);
  await page.screenshot({ path: testInfo.outputPath("phone-photo-text.png") });
  await page.locator("#photoEditorFinishText").click();
  await expect(page.locator("#photoEditorTextEditor")).toBeHidden();
  await page.locator("#photoEditorSave").click();
  await expect(page.locator("#photoEditorDialog")).toBeHidden();
  expect(await page.evaluate(() => state.todoDialogPhotos[0].data.startsWith("data:image/jpeg"))).toBe(true);
});

test("reorder orientation survives expansion and drag start but clears on search; multi-worker calendar border preserves urgency", async ({ page }) => {
  await login(page);
  await page.evaluate(() => {
    state.todos = [
      { id: "mark-a", assignmentGroupId: "group-a", title: "Shared plan", status: "open", date: "2026-09-17", assigneeIds: ["bojan", "ibro"], syncUser: "bojan", notes: "Details to expand" },
      { id: "mark-b", assignmentGroupId: "group-b", title: "Urgent shared plan", status: "open", date: "2026-09-18", assigneeIds: ["bojan", "ibro"], syncUser: "bojan", urgent: true }
    ];
    state.todos.push(...state.todos.map(t => ({ ...t, id: t.id + "-ibro", syncUser: "ibro" })));
    state.current = new Date(2026, 8, 1); state.todoSortMode = "manual";
    setView("todos"); renderTodos();
    state.todoReorderOrigin = { previousId: "mark-a", nextId: "mark-b" }; renderTodoReorderOrigin();
  });
  await expect(page.locator(".todo-reorder-origin")).toHaveCount(1);
  await page.locator('[data-todo-id="mark-a"] .todo-details-toggle').click();
  await expect(page.locator(".todo-reorder-origin")).toHaveCount(1);
  await page.locator('[data-todo-id="mark-a"] .drag-handle').click();
  await expect(page.locator(".todo-reorder-origin")).toHaveCount(1);
  await page.locator("#clientSearch").fill("some search");
  await expect(page.locator(".todo-reorder-origin")).toHaveCount(0);
  await page.locator("#clientSearch").press("Escape");
  await page.getByRole("button", { name: "Koledar", exact: true }).click();
  const shared = page.locator('.day-todo.multi-assignee:not(.urgent)').filter({ hasText: "Shared plan" });
  await expect(shared).toHaveCount(1);
  expect(await shared.evaluate(el => getComputedStyle(el).borderLeftWidth)).toBe("7px");
  const urgent = page.locator('.day-todo.multi-assignee.urgent');
  await expect(urgent).toHaveCount(1);
  expect(await urgent.evaluate(el => getComputedStyle(el).borderLeftColor)).toBe("rgb(217, 48, 37)");
});
