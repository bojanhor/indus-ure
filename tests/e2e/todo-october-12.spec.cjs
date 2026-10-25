const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');
test.use({ serviceWorkers: 'block' });
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });
async function login(page, user = 'bojan') {
  await page.goto(app.baseUrl);
  await page.locator('#localTestUser').selectOption(user);
  await page.locator('#localTestPassword').fill(TEST_PASSWORD);
  await page.locator('#localTestLoginBtn').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

test('two sessions refresh month and open day, retry failed snapshot, preserve unsaved edits', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  const reader = await a.newPage(), writer = await b.newPage();
  try {
    await login(reader); await login(writer);
    await reader.locator('#calendarViewBtn').click();
    const title = 'Živi koledar oktober QA';
    const created = await writer.evaluate(async title => {
      const result = await api('/api/todos', { method: 'POST', body: JSON.stringify({ title, date: dateKey(new Date()), status: 'open', assigneeIds: ['bojan'] }) });
      return result.todos.find(t => t.title === title);
    }, title);
    const oldRevision = await reader.evaluate(() => state.syncRevision);
    await reader.evaluate(() => refreshSessionSecurityContext());
    expect(await reader.evaluate(() => state.syncRevision)).toBe(oldRevision);
    await reader.route('**/api/bootstrap', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"QA retry"}' }));
    await reader.evaluate(() => autoRefreshSharedData());
    expect(await reader.evaluate(() => state.syncRevision)).toBe(oldRevision);
    await reader.unroute('**/api/bootstrap');
    await reader.evaluate(() => autoRefreshSharedData());
    await expect(reader.locator('.day-todo-title').filter({ hasText: title })).toBeVisible();
    await reader.evaluate(date => openDayTimeline(date), created.date);
    await writer.evaluate(async todo => {
      await api(`/api/todos/${todo.id}`, { method: 'PUT', body: JSON.stringify({ ...todo, start: '12:00', end: '13:00', baseUpdatedAt: todo.updatedAt }) });
    }, created);
    await reader.evaluate(() => autoRefreshSharedData());
    await expect(reader.locator('.day-timeline-event').filter({ hasText: title })).toContainText('12:00');
    await reader.evaluate(id => {
      const todo = state.todos.find(t => t.id === id);
      saveDayTimelineDraft(todo, '14:00', '15:00', todo.date); renderDayTimeline();
    }, created.id);
    await reader.evaluate(() => autoRefreshSharedData());
    expect(await reader.evaluate(() => state.dayTimelineDrafts.size)).toBe(1);
  } finally { await a.close(); await b.close(); }
});

test('worker icon and permissions persist; removal hides worker without deleting history', async ({ page }, info) => {
  await login(page);
  const id = await page.evaluate(async () => {
    const { worker } = await api('/api/workers', { method: 'POST', body: JSON.stringify({ name: 'Ikona QA' }) });
    const { workers } = await api('/api/workers');
    const ibro = workers.find(w => w.id === 'ibro');
    await api('/api/workers/ibro', { method: 'PUT', body: JSON.stringify({ ...ibro, timeEntryForIds: ['ibro', worker.id] }) });
    await api('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'Zgodovina ikone QA', date: dateKey(new Date()), status: 'open', assigneeIds: [worker.id] }) });
    await openWorkersDialog(); return worker.id;
  });
  const card = page.locator(`[data-worker-id="${id}"]`);
  await card.locator('[data-worker-avatar-initial]').selectOption('ž');
  await card.locator('[data-worker-avatar-color]').fill('#ffd000');
  await card.locator('[data-save-worker]').click();
  await expect(card.locator('[data-worker-avatar-initial]')).toHaveValue('ž');
  const saved = await page.evaluate(async id => {
    const { workers } = await api('/api/workers');
    return { icon: workers.find(w => w.id === id), ibro: workers.find(w => w.id === 'ibro') };
  }, id);
  expect(saved.ibro.timeEntryForIds).toContain(id);
  expect(saved.icon.avatarColor).toBe('#ffd000');
  const invalid = await page.evaluate(async worker => {
    try { await api(`/api/workers/${worker.id}`, { method: 'PUT', body: JSON.stringify({ ...worker, avatarInitial: '<', avatarColor: 'red' }) }); }
    catch (error) { return error.status; }
  }, saved.icon);
  expect(invalid).toBe(400);
  await page.locator('#closeWorkers').click();
  await page.locator('#calendarViewBtn').click();
  const avatar = page.locator('.day-todo').filter({ hasText: 'Zgodovina ikone QA' }).locator('.avatar');
  await expect(avatar).toHaveText('ž');
  await expect(avatar).toHaveCSS('background-color', 'rgb(255, 208, 0)');
  await page.evaluate(() => openWorkersDialog());
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('worker-settings-mobile.png') });
  await card.locator('[data-remove-worker]').click();
  await page.locator('#appConfirmAccept').click();
  await expect(card).toHaveCount(0);
  expect((await page.evaluate(async () => (await api('/api/workers')).workers.find(w => w.id === 'ibro'))).timeEntryForIds).not.toContain(id);
  await page.locator('#showInactiveWorkers').check();
  await expect(card).toHaveCount(1);
  await expect(card.locator('[data-reactivate-worker]')).toBeVisible();
  expect(await page.evaluate(async () => (await api('/api/todos')).todos.some(t => t.title === 'Zgodovina ikone QA'))).toBe(true);
  await card.locator('[data-reactivate-worker]').click();
  await expect(card.locator('[data-save-worker]')).toBeEnabled();
});

test('month opens at today and orders have an orange stripe, not a filled card', async ({ page }, info) => {
  await login(page);
  await page.evaluate(async () => {
    await api('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'Oranžno naročilo QA', date: dateKey(new Date()), status: 'order', assigneeIds: ['bojan'] }) });
    await api('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'Nujno naročilo QA', date: dateKey(new Date()), status: 'order', urgent: true, assigneeIds: ['bojan'] }) });
    await loadAll(); state.current = new Date(2020, 0, 1);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#calendarViewBtn').click();
  const today = page.locator('.day.today');
  await expect(today).toBeInViewport();
  const order = today.locator('.day-todo').filter({ hasText: 'Oranžno naročilo QA' });
  await expect(order).toHaveCSS('border-left-color', 'rgb(216, 136, 63)');
  await expect(order).toHaveCSS('background-color', 'rgb(247, 249, 248)');
  await expect(order).not.toHaveClass(/has-change-notice/);
  await expect(today.locator('.day-todo').filter({ hasText: 'Nujno naročilo QA' })).toHaveCSS('border-left-color', 'rgb(217, 48, 37)');
  await page.screenshot({ path: info.outputPath('monthly-orders-mobile.png') });
});

test('editor keeps save and close inside the visible viewport while keyboard shrinks and pans it', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.locator('#newTodoButton').click();
  await page.locator('#todoFormNotes').fill('Dolgo besedilo\n'.repeat(30));
  await page.locator('#todoFormNotes').focus();
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport, 'height', { configurable: true, value: 350 });
    Object.defineProperty(window.visualViewport, 'offsetTop', { configurable: true, value: 120 });
    window.visualViewport.dispatchEvent(new Event('resize'));
    window.visualViewport.dispatchEvent(new Event('scroll'));
  });
  for (const id of ['saveTodoDialog', 'closeTodoDialog']) {
    const box = await page.locator(`#${id}`).boundingBox();
    expect(box.y).toBeGreaterThanOrEqual(120);
    expect(box.y + box.height).toBeLessThanOrEqual(470);
  }
  await page.screenshot({ path: info.outputPath('keyboard-visible-actions.png') });
  await page.locator('#closeTodoDialog').click();
  await expect(page.locator('#todoDialog')).toBeHidden();
});
