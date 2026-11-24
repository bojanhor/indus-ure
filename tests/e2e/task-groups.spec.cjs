const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');
test.use({ serviceWorkers: 'block', hasTouch: true });
let app;
test.beforeEach(async () => { app = await startIsolatedTestApp(); });
test.afterEach(async () => { await app?.stop(); });
async function login(page, worker = 'bojan') {
  await page.goto(app.baseUrl);
  await page.locator('#localTestUser').selectOption(worker);
  await page.locator('#localTestPassword').fill(TEST_PASSWORD);
  await page.locator('#localTestLoginBtn').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
}
const api = (page, url, method = 'GET', data) => page.evaluate(async ({ url, method, data }) => {
  try { return { result: await windowApi(), status: 200 }; }
  catch (error) { return { status: error.status, error: error.message }; }
  function windowApi() { return api(url, { method, ...(data && { body: JSON.stringify(data) }) }); }
}, { url, method, data });
const move = (page, sourceId, targetGroupId, fromGroupId = '') => api(page, '/api/todos/reorder', 'POST', { sourceId, targetGroupId, fromGroupId, placement: 'after' });
async function seed(page) {
  const { result } = await api(page, '/api/clients', 'POST', { name: 'Skupine preizkus' });
  for (const todo of [
    { title: 'Samo Bojan', assigneeIds: ['bojan'], date: '2026-11-20', urgent: true },
    { title: 'Samo Ibro', assigneeIds: ['ibro'], date: '2026-11-20' },
    { title: 'Samostojno', assigneeIds: ['bojan'] },
    { title: 'Ne sodi v skupino', assigneeIds: ['ibro'], date: '2026-11-20', status: 'execution', syncUser: 'ibro', start: '08:00', end: '09:00' }
  ]) {
    const created = await api(page, '/api/todos', 'POST', { status: 'open', clientId: result.client.clientId, client: result.client.name, ...todo });
    expect(created.status).toBe(200);
  }
  const snapshot = (await api(page, '/api/bootstrap')).result;
  await page.evaluate(snapshot => { applyBootstrapSnapshot(snapshot); setWorkContext('admin'); setView('todos'); }, snapshot);
  return Object.fromEntries(snapshot.todos.map(todo => [todo.title, todo]));
}
async function reload(page) {
  const snapshot = (await api(page, '/api/bootstrap')).result;
  await page.evaluate(snapshot => { applyBootstrapSnapshot(snapshot); render(); }, snapshot);
}
async function drag(page, source, target, pointer) {
  // A read-only sync can replace rows before the gesture has even begun.
  await expect(async () => {
    await source.scrollIntoViewIfNeeded({ timeout: 1500 });
    await target.scrollIntoViewIfNeeded({ timeout: 1500 });
  }).toPass({ timeout: 5000 });
  const a = await source.boundingBox(), b = await target.boundingBox();
  const from = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
  const to = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  if (pointer === 'mouse') {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 5 }); await page.mouse.up();
  } else {
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
      await expect(page.locator('html')).toHaveClass(/todo-drag-active/);
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] });
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await session.detach(); }
  }
}

for (const pointer of ['mouse', 'touch']) test(`${pointer}: drag into and out of a group, preserve priorities, and open a timed group in both calendars`, async ({ page, browserName }, info) => {
  test.skip(pointer === 'touch' && browserName !== 'chromium', 'Trusted touch dispatcher requires Chromium.');
  await page.setViewportSize({ width: pointer === 'touch' ? 390 : 1280, height: 950 });
  await login(page); await seed(page);
  await page.locator('#newTaskGroup').click();
  await page.locator('#taskGroupForm [name="title"]').fill('Nepomembno');
  await page.locator('#taskGroupForm [name="date"]').fill('2026-11-20');
  await page.locator('#taskGroupForm [name="start"]').fill('10:00');
  await page.locator('#taskGroupForm [name="end"]').fill('11:30');
  await page.locator('#saveTaskGroup').click();
  await expect(page.locator('#taskGroupDialog')).toBeHidden();
  const group = page.locator('.task-group-card').filter({ hasText: 'Nepomembno' });
  const row = page.locator('.todo-item').filter({ has: page.getByRole('button', { name: 'Uredi opravilo: Samo Ibro', exact: true }) });
  await drag(page, row.locator('.drag-handle'), group.locator('.task-group-toggle'), pointer);
  await expect(group.locator('.task-group-body')).toContainText('Samo Ibro');
  await expect(group.locator('.task-group-toggle')).not.toContainText('Nujna skupina');
  await group.locator('.task-group-toggle').click();
  await expect(group.locator('.task-group-body')).toBeHidden();
  await group.locator('.task-group-toggle').click();
  await page.screenshot({ path: info.outputPath('task-group-board.png') });
  await drag(page, group.locator('.task-group-body .drag-handle'), page.locator('.todo-item').filter({ has: page.getByRole('button', { name: 'Uredi opravilo: Samostojno', exact: true }) }), pointer);
  await expect(group.locator('.task-group-body')).not.toContainText('Samo Ibro');
  await drag(page, row.locator('.drag-handle'), group.locator('.task-group-toggle'), pointer);
  await expect(group.locator('.task-group-body')).toContainText('Samo Ibro');
  await page.evaluate(() => { state.current = parseDate('2026-11-20'); setView('calendar'); });
  const day = page.locator('.day[data-date="2026-11-20"]');
  await expect(day.locator('.day-todo').filter({ hasText: 'Samo Ibro' })).toHaveCount(1);
  await day.locator('.task-group-cal').click();
  await expect(page.locator('#taskGroupEvents')).toContainText('Samo Ibro');
  await page.screenshot({ path: info.outputPath('task-group-calendar.png') });
  await page.locator('#taskGroupEvents button').click();
  await expect(page.locator('#todoFormTask')).toHaveValue('Samo Ibro');
  await page.locator('#closeTodoDialog').click();
  await expect(page.locator('#taskGroupDialog')).toBeVisible();
  await page.locator('#closeTaskGroup').click();
  await page.evaluate(() => openDayTimeline('2026-11-20'));
  await expect(page.locator('.day-timeline-event.task-group-cal .day-resize-handle')).toHaveCount(0);
  await page.locator('.day-timeline-event.task-group-cal').click();
  await expect(page.locator('#taskGroupEvents')).toContainText('Samo Ibro');
  await page.locator('#closeTaskGroup').click();
  await expect(page.locator('#dayTimelineDialog')).toBeVisible();
});

test('shared group rights, stale moves, task completion, Google deep links and dissolve/Undo', async ({ page, browser }) => {
  await login(page);
  const todos = await seed(page);
  const worker = await browser.newPage();
  try {
    await login(worker, 'ibro');
    const first = (await api(page, '/api/task-groups', 'POST', { title: 'Mešana', date: '2026-11-21', endDate: '2026-11-23' })).result;
    const second = (await api(page, '/api/task-groups', 'POST', { title: 'Zasebna' })).result;
    const groupUrl = '/api/task-groups/' + first.id;
    expect((await api(worker, groupUrl)).status).toBe(404);
    expect((await move(page, todos['Ne sodi v skupino'].id, first.id)).status).toBe(403);
    expect((await move(page, 'org:' + first.id, second.id)).status).toBe(403);
    expect((await move(page, todos['Samo Bojan'].id, first.id)).status).toBe(200);
    expect((await move(page, todos['Samo Ibro'].id, first.id)).status).toBe(200);
    await reload(page);
    const parent = page.locator(`.task-group-card[data-task-group-id="${first.id}"]`);
    await expect(parent.locator('.task-group-toggle')).toContainText('Vsebuje nujno');
    await expect(parent.locator('.task-group-toggle')).not.toContainText('Nujna skupina');
    await expect(parent.locator('.task-group-body .todo-task-title, .task-group-body .todo-summary').first()).toContainText('Samo Bojan');
    expect((await api(page, '/api/todos/reorder', 'POST', {
      sourceId: 'org:' + first.id, targetId: todos.Samostojno.id, placement: 'after'
    })).status).toBe(200);
    await reload(page);
    expect(await parent.evaluate(el => el.previousElementSibling?.querySelector('.todo-summary')?.getAttribute('aria-label'))).toBe('Uredi opravilo: Samostojno');
    expect((await move(page, todos['Samo Ibro'].id, second.id)).status).toBe(409);
    expect((await move(worker, todos['Samo Ibro'].id, second.id, first.id)).status).toBe(404);
    expect((await move(worker, todos['Samo Bojan'].id, '', first.id)).status).toBe(403);
    const group = (await api(worker, groupUrl)).result.group;
    expect(group.eventIds).toEqual([todos['Samo Ibro'].assignmentGroupId]);
    expect((await api(worker, groupUrl, 'PUT', { ...group, title: 'Ibro uredil' })).status).toBe(200);
    expect((await api(page, groupUrl, 'PUT', group)).status).toBe(409);
    await worker.goto(app.baseUrl + '/?group=' + first.id);
    await expect(worker.locator('#taskGroupTitle')).toHaveText('Skupina: Ibro uredil');
    await expect(worker.locator('#taskGroupEvents')).toContainText('Samo Ibro');
    await expect(worker.locator('#taskGroupEvents')).not.toContainText('Samo Bojan');
    const openBefore = (await api(page, '/api/todos/' + todos['Samo Ibro'].id)).result.todo;
    const done = await api(page, '/api/todos/' + openBefore.id, 'PUT', {
      ...openBefore, status: 'execution', start: '10:00', end: '11:00', syncUser: 'ibro'
    });
    expect(done.status, done.error).toBe(200);
    expect((await api(worker, groupUrl)).status).toBe(404);
    const current = (await api(page, groupUrl)).result.group;
    expect(current.eventIds).toEqual([todos['Samo Bojan'].assignmentGroupId]);
    expect((await api(page, groupUrl, 'DELETE', { revision: current.revision })).status).toBe(200);
    expect((await api(page, '/api/todos/' + todos['Samo Bojan'].id)).status).toBe(200);
    const journal = (await api(page, '/api/undo-journal')).result;
    const undo = journal.actions.find(item => item.canUndo);
    expect(undo.action).toContain('razpustil skupino');
    expect((await api(page, '/api/undo-journal/' + undo.id, 'POST', { confirm: true })).status).toBe(200);
    await reload(page);
    expect((await api(page, groupUrl)).result.group.eventIds).toEqual(current.eventIds);
  } finally { await worker.close(); }
});

test('themed group form, new group location and searchable headings with matching members only', async ({ page, browser }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const todos = await seed(page);
  await page.locator('#todoSortMode').selectOption('client');
  await page.locator('#newTaskGroup').click();
  const title = page.locator('#taskGroupForm [name="title"]');
  await expect(title).toHaveCSS('border-radius', '8px');
  await expect(title).toHaveCSS('min-height', '42px');
  await expect(page.locator('#saveTaskGroup')).toHaveText('✓');
  await title.fill('Skupina Nabrano');
  await page.screenshot({ path: info.outputPath('themed-group-form.png') });
  await page.locator('#saveTaskGroup').click();
  const card = page.locator('.task-group-card').filter({ hasText: 'Skupina Nabrano' });
  await expect(page.locator('#taskGroupDialog')).toBeHidden();
  await expect(page.locator('#todoSortMode')).toHaveValue('manual');
  await expect(card.locator('.task-group-head')).toHaveClass(/search-result-highlight/);
  await expect(card.locator('.task-group-toggle')).toBeFocused();
  await expect(card.locator('.task-group-head')).toBeInViewport();
  await reload(page);
  await expect(card.locator('.task-group-head')).toHaveClass(/search-result-highlight/);
  await expect(card.locator('.task-group-toggle')).toBeFocused();
  const id = await card.getAttribute('data-task-group-id');
  expect((await move(page, todos['Samo Ibro'].id, id)).status).toBe(200);
  expect((await move(page, todos['Samo Bojan'].id, id)).status).toBe(200);
  await reload(page);
  const search = page.locator('#clientSearch');
  const groupResult = page.locator('#searchPanel .search-task-group');
  const child = groupResult.locator('.search-task-group-members .result');
  await search.fill('Nabrano');
  await expect(groupResult).toHaveCount(1);
  await expect(child).toHaveCount(0);
  await search.fill('Samo Ibro');
  await expect(groupResult.locator('.search-task-group-header')).toContainText('Skupina Nabrano');
  await expect(child).toHaveCount(1);
  await expect(child.first()).toContainText('Samo Ibro');
  await expect(groupResult).not.toContainText('Samo Bojan');
  const placement = await groupResult.evaluate(group => {
    const head = group.querySelector('.search-task-group-header').getBoundingClientRect();
    const row = group.querySelector('.search-task-group-members .result').getBoundingClientRect();
    return { indented: row.left > head.left + 8, below: row.top >= head.bottom - 1 };
  });
  expect(placement).toEqual({ indented: true, below: true });
  await page.screenshot({ path: info.outputPath('group-search-mobile.png') });
  await groupResult.getByRole('button', { name: 'Pokaži skupino v seznamu: Skupina Nabrano' }).click();
  await expect(search).toBeEmpty();
  await expect(card.locator('.task-group-toggle')).toBeFocused();
  await search.fill('Nabrano');
  await groupResult.getByRole('button', { name: 'Odpri skupino: Skupina Nabrano' }).click();
  await expect(page.locator('#taskGroupEvents')).toContainText('Samo Ibro');
  await expect(page.locator('#saveTaskGroup')).toBeHidden();
  await page.locator('#editTaskGroup').click();
  await expect(title).toBeFocused();
  await expect(page.locator('#saveTaskGroup')).toBeVisible();
  await page.locator('#closeTaskGroup').click();

  const worker = await browser.newPage();
  try {
    await login(worker, 'ibro');
    await worker.locator('#clientSearch').fill('Samo');
    const visibleGroup = worker.locator('#searchPanel .search-task-group');
    await expect(visibleGroup).toContainText('Samo Ibro');
    await expect(visibleGroup).not.toContainText('Samo Bojan');
    await worker.locator('#clientSearch').fill('Samo Bojan');
    await expect(worker.locator('#searchPanel .result')).toHaveCount(0);
  } finally { await worker.close(); }
});

for (const pointer of ['mouse', 'touch']) test(`${pointer}: search drag joins a group or reorders a task without changing dates, while click still opens`, async ({ page, browserName }, info) => {
  test.skip(pointer === 'touch' && browserName !== 'chromium', 'Trusted touch dispatcher requires Chromium.');
  await page.setViewportSize({ width: pointer === 'touch' ? 390 : 1280, height: 950 });
  await login(page);
  const todos = await seed(page);
  const sourceId = todos['Samo Ibro'].id;
  const { result: group } = await api(page, '/api/task-groups', 'POST', { title: 'Ciljna mapa' });
  await reload(page);
  await page.locator('#todoSortMode').selectOption('client');
  const search = page.locator('#clientSearch');
  const panel = page.locator('#searchPanel');
  await search.fill('Samo Ibro');
  const result = panel.getByRole('button', { name: 'Odpri opravilo: Samo Ibro' });
  await expect(result).toHaveClass(/search-result-board-drag/);
  if (pointer === 'touch') await result.tap(); else await result.click();
  await expect(page.locator('#todoFormTask')).toHaveValue('Samo Ibro');
  await page.locator('#closeTodoDialog').click();
  await expect(page.locator('#todoDialog')).toBeHidden();
  await search.fill('Samo Ibro');
  const goal = page.locator(`.task-group-card[data-task-group-id="${group.id}"]`);
  const section = page.locator('#todoItems > .todo-item').filter({ has: page.getByRole('button', { name: 'Uredi opravilo: Samostojno', exact: true }) });
  const touch = pointer === 'touch' ? await page.context().newCDPSession(page) : null;
  let requests = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/api/todos/reorder')) requests++; });
  async function startDrag() {
    await result.scrollIntoViewIfNeeded();
    const box = await result.boundingBox();
    const from = { x: box.x + 30, y: box.y + Math.min(20, box.height / 2) };
    if (touch) await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
    else { await page.mouse.move(from.x, from.y); await page.mouse.down(); }
    await expect(panel).toHaveClass(/search-board-drag-active/);
    return from;
  }
  async function drop(loc, placement = 'middle') {
    await loc.evaluate(el => el.scrollIntoView({ block: 'center' }));
    const box = await loc.boundingBox();
    const to = { x: box.x + box.width / 2, y: box.y + (placement === 'before' ? 8 : box.height / 2) };
    const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith('/api/todos/reorder'));
    if (touch) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } else {
      await page.mouse.move(to.x, to.y, { steps: 5 }); await page.mouse.up();
    }
    const received = await response;
    expect(received.ok(), await received.text()).toBe(true);
    await expect(panel).not.toHaveClass(/search-board-drag-active/);
    await expect(page.locator('#todoDialog')).toBeHidden();
    return received.request().postDataJSON();
  }
  try {
    // Touch panning before the hold must not start a write or open the task.
    if (touch) {
      const box = await result.boundingBox();
      const from = { x: box.x + 30, y: box.y + 25 };
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x, y: from.y - 66 }] });
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(panel).not.toHaveClass(/search-board-drag-active/);
      await expect(page.locator('#todoDialog')).toBeHidden();
      expect(requests).toBe(0);
    }
    await startDrag();
    await expect(page.locator('#todoSortMode')).toHaveValue('manual');
    await expect(goal).not.toContainText('Povleci opravilo v skupino.');
    const joined = await drop(goal.locator('.task-group-head'));
    expect(joined).toMatchObject({ sourceId, targetGroupId: group.id, fromGroupId: '' });
    await expect(goal.locator('.task-group-body')).toContainText('Samo Ibro');
    await expect(panel.locator('.search-task-group-members')).toContainText('Samo Ibro');
    await page.screenshot({ path: info.outputPath('search-drag-into-group.png') });
    await startDrag();
    const reordered = await drop(section, 'before');
    expect(reordered).toMatchObject({ sourceId, targetId: todos.Samostojno.id, targetGroupId: '', fromGroupId: group.id, placement: 'before' });
    await expect(goal.locator('.task-group-body')).not.toContainText('Samo Ibro');
    const apiTodo = (await api(page, '/api/todos/' + sourceId)).result.todo;
    for (const k of ['date', 'endDate', 'start', 'end', 'assigneeIds', 'urgent', 'status', 'clientId']) expect(apiTodo[k]).toEqual(todos['Samo Ibro'][k]);
    expect(apiTodo.sharedManualOrder).toBeLessThan((await api(page, '/api/todos/' + todos.Samostojno.id)).result.todo.sharedManualOrder);
    expect(requests).toBe(2);
  } finally { await touch?.detach(); }
});
