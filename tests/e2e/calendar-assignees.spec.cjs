const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');

test.use({ serviceWorkers: 'block', hasTouch: true });
let app;
test.beforeEach(async () => { app = await startIsolatedTestApp(); });
test.afterEach(async () => { await app?.stop(); });

async function setup(page, user = 'bojan', context = 'worker:bojan') {
  await page.goto(app.baseUrl);
  await page.locator('#localTestUser').selectOption(user);
  await page.locator('#localTestPassword').fill(TEST_PASSWORD);
  await page.locator('#localTestLoginBtn').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
  return page.evaluate(async ({ user, context }) => {
    const result = await api('/api/todos', { method: 'POST', body: JSON.stringify({
      title: 'Shared calendar QA', client: 'Isolated QA', status: 'open',
      date: '2026-10-20', assigneeIds: ['bojan', 'ibro']
    }) });
    await loadAll();
    if (state.user.role === 'boss') setWorkContext(context);
    state.current = new Date(2026, 9, 1); state.calendarOpened = true; setView('calendar');
    return result.todos.find(todo => todo.title === 'Shared calendar QA' && todo.syncUser === user).id;
  }, { user, context });
}

const selected = page => page.locator('#todoFormAssignees input:checked').evaluateAll(nodes => nodes.map(n => n.value).sort());
const stored = (page, id) => page.evaluate(async id => (await api('/api/todos/' + id)).todo.assigneeIds.sort(), id);
async function openMonth(page) {
  await page.locator('#calendar .day-todo').filter({ hasText: 'Shared calendar QA' }).tap();
  await expect(page.locator('#todoDialog')).toBeVisible();
  await expect(page.locator('#todoFormTask')).toBeEnabled();
  await expect(page.locator('#todoFormOpeningStatus')).toBeHidden();
}
async function save(page) {
  await page.locator('#saveTodoDialog').click();
  await expect(page.locator('#todoDialog')).toBeHidden();
  await page.waitForFunction(() => state.todoMutationPending === 0);
  await page.waitForLoadState('networkidle');
}
async function close(page) {
  await page.locator('#closeTodoDialog').click();
  await expect(page.locator('#todoDialog')).toBeHidden();
  await page.waitForFunction(() => !state.todoEditLock && !state.todoLockPending);
}

for (const [user, context] of [['bojan', 'worker:bojan'], ['ibro', 'worker:ibro'], ['bojan', 'admin']]) {
  test(`${context}: month and day preserve all coworkers; explicit checkbox changes persist`, async ({ page }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const id = await setup(page, user, context);
    expect(await stored(page, id)).toEqual(['bojan', 'ibro']);
    for (const completed of [false, true]) {
      await page.evaluate(value => { state.showCompletedCalendarTodos = value; renderMonth(); }, completed);
      await openMonth(page);
      expect(await selected(page)).toEqual(['bojan', 'ibro']);
      await close(page);
    }
    await page.evaluate(() => { state.showCompletedCalendarTodos = false; renderMonth(); });
    await openMonth(page);
    await page.locator('#todoFormAssignees').scrollIntoViewIfNeeded();
    await page.screenshot({ path: info.outputPath('shared-assignees-mobile.png') });
    await page.locator('#todoFormNotes').fill('Unrelated text edit must preserve both participants');
    await save(page);
    expect(await stored(page, id)).toEqual(['bojan', 'ibro']);
    await openMonth(page);
    expect(await selected(page)).toEqual(['bojan', 'ibro']);
    const colleague = user === 'bojan' ? 'ibro' : 'bojan';
    await page.locator(`#todoFormAssignees input[value="${colleague}"]`).tap();
    expect(await selected(page)).toEqual([user]);
    await save(page);
    expect(await stored(page, id)).toEqual([user]);
    await openMonth(page);
    await page.locator(`#todoFormAssignees input[value="${colleague}"]`).tap();
    await save(page);
    expect(await stored(page, id)).toEqual(['bojan', 'ibro']);
    await page.evaluate(() => openDayTimeline('2026-10-20'));
    await page.locator('#dayAllDayItems .day-all-day-item').filter({ hasText: 'Shared calendar QA' }).tap();
    await expect(page.locator('#todoFormTask')).toBeEnabled();
    expect(await selected(page)).toEqual(['bojan', 'ibro']);
    await close(page);
  });
}

test('moving a personal month card does not submit or remove coworker assignments', async ({ page }) => {
  const id = await setup(page);
  const card = page.locator('#calendar .day-todo').filter({ hasText: 'Shared calendar QA' });
  const target = page.locator('#calendar .day[data-date="2026-10-21"]');
  await card.scrollIntoViewIfNeeded();
  const from = await card.boundingBox(), to = await target.boundingBox();
  const request = page.waitForRequest(r => r.method() === 'PUT' && r.url().endsWith('/api/todos/' + id));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  expect((await request).postDataJSON()).not.toHaveProperty('assigneeIds');
  await expect.poll(() => page.evaluate(async id => (await api('/api/todos/' + id)).todo.date, id)).toBe('2026-10-21');
  expect(await stored(page, id)).toEqual(['bojan', 'ibro']);
  await page.waitForTimeout(500); // Clear the drag's click-suppression window.
  await openMonth(page);
  expect(await selected(page)).toEqual(['bojan', 'ibro']);
});

test('offline calendar move retains displayed coworkers and syncs without an assignment update', async ({ page }) => {
  const id = await setup(page);
  const card = page.locator('#calendar .day-todo').filter({ hasText: 'Shared calendar QA' });
  await card.scrollIntoViewIfNeeded();
  const from = await card.boundingBox();
  const to = await page.locator('#calendar .day[data-date="2026-10-21"]').boundingBox();
  await page.context().setOffline(true);
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
  await page.waitForFunction(id => state.todoMutationPending === 0 && state.todos.find(t => t.id === id)?.offlinePending, id);
  const pending = await page.evaluate(async id => ({
    todo: state.todos.find(t => t.id === id),
    op: (await offlineTodoOps()).find(op => op.todoId === id)
  }), id);
  expect(pending.todo.assigneeIds.sort()).toEqual(['bojan', 'ibro']);
  expect(pending.op.todo).not.toHaveProperty('assigneeIds');
  expect(pending.op.todo.date).toBe('2026-10-21');
  await page.context().setOffline(false);
  await page.evaluate(async () => { state.offlineMode = false; await flushOfflineTodoQueue(); });
  await expect.poll(() => page.evaluate(async () => (await offlineTodoOps()).length)).toBe(0);
  expect(await stored(page, id)).toEqual(['bojan', 'ibro']);
  expect(await page.evaluate(async id => (await api('/api/todos/' + id)).todo.date, id)).toBe('2026-10-21');
});
