const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');

test.use({ serviceWorkers: 'block', hasTouch: true });
let app;
const date = '2032-04-01';
const title = 'Opravilo za preizkus spusta';
const groupTitle = 'Ciljna skupina';
const action = (page, name) => page.locator(`#todoDragActions [data-todo-drag-action="${name}"]`);
const picker = page => page.locator('#todoGroupDropDialog');
test.beforeEach(async ({ page, context }) => {
  app = await startIsolatedTestApp();
  expect((await context.request.post(app.baseUrl + '/api/test-login', { data: { userId: 'bojan', password: TEST_PASSWORD } })).ok()).toBeTruthy();
  await page.goto(app.baseUrl);
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
});
test.afterEach(async () => { await app?.stop(); });

function call(page, url, data) {
  return page.evaluate(async ({ url, data }) => {
    try { return { status: 200, data: await api(url, data ? { method: 'POST', body: JSON.stringify(data) } : {}) }; }
    catch (error) { return { status: error.status, error: error.message }; }
  }, { url, data });
}
async function seed(page, { undated = false, secondGroup = false } = {}) {
  const created = await call(page, '/api/todos', {
    title, status: 'open', client: 'Ciljna stranka', assigneeIds: ['bojan', 'ibro'],
    ...(undated ? {} : { date, start: '10:00', end: '11:30' })
  });
  expect(created.status, created.error).toBe(200);
  const source = created.data.todos.find(item => item.title === title && item.syncUser === 'bojan');
  const group = (await call(page, '/api/task-groups', { title: groupTitle, date: '2032-04-02', endDate: '2032-04-02' })).data;
  if (secondGroup) await call(page, '/api/task-groups', { title: 'Druga skupina' });
  await page.evaluate(async () => { await loadAll(); setWorkContext('admin'); });
  return { source, id: group.id };
}
async function openMonth(page) {
  await page.evaluate(date => { state.current = parseDate(date); state.calendarBrowseMonth = true; setView('calendar'); }, date);
}
async function center(locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}
async function mouseDrop(page, source, target, hold = false) {
  await source.scrollIntoViewIfNeeded();
  const start = await center(source);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  if (hold) await expect(source).toHaveClass(/is-drag-ready/);
  await page.mouse.move(start.x + 17, start.y + 6, { steps: 3 });
  await expect(page.locator('#todoDragActions')).toBeVisible();
  const to = await center(target);
  await page.mouse.move(to.x, to.y, { steps: 7 });
  await page.mouse.up();
  await expect(page.locator('#todoDragActions')).toBeHidden();
}
async function touchDrop(page, source, target, screenshot) {
  await source.scrollIntoViewIfNeeded();
  const start = await center(source);
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
    await expect(target).toBeVisible();
    const to = await center(target);
    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] });
    await expect(target).toHaveClass(/is-drop-target/);
    if (screenshot) await page.screenshot({ path: screenshot });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.locator('#todoDragActions')).toBeHidden();
  } finally { await session.detach(); }
}
async function search(page) {
  const input = page.locator('#clientSearch');
  if (await input.inputValue() !== title) await input.fill(title);
  return page.locator('#searchPanel .search-result-open').filter({ hasText: title }).first();
}
async function groupMembers(page, id) {
  return (await call(page, '/api/task-groups/' + id)).data.group.eventIds;
}
test('bottom drop panel leaves the last calendar row reachable during a drag', async ({ page }, info) => {
  await page.setViewportSize({ width: 1100, height: 630 });
  const { source } = await seed(page, { undated: true });
  await openMonth(page);
  const result = await search(page);
  const lastRow = page.locator('#calendar .day').last();
  await lastRow.evaluate(el => el.scrollIntoView({ block: 'end' }));
  const from = await center(result);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 18, from.y + 12, { steps: 3 });
  const tray = page.locator('#todoDragActions');
  await expect(tray).toBeVisible();
  const trayBox = await tray.boundingBox();
  expect(Math.abs(trayBox.x + trayBox.width / 2 - 550)).toBeLessThan(18);
  const initialBottom = (await lastRow.boundingBox()).y + (await lastRow.boundingBox()).height;
  // Hold the pointer just above the action bar to scroll the underlying month.
  await page.mouse.move(1010, trayBox.y - 12, { steps: 5 });
  await expect.poll(async () => {
    const box = await lastRow.boundingBox(); return box.y + box.height;
  }).toBeLessThanOrEqual(Math.min(trayBox.y, initialBottom - 10));
  await page.screenshot({ path: info.outputPath('bottom-drop-panel-and-last-row.png') });
  const to = await center(lastRow);
  await page.mouse.move(to.x, to.y, { steps: 4 });
  const targetDate = await lastRow.getAttribute('data-date');
  await page.mouse.up();
  await expect.poll(async () => (await call(page, '/api/todos/' + source.id)).data.todo.date).toBe(targetDate);
});

test('month: dropping on the calendar group changes membership, never date, time or coworkers', async ({ page }) => {
  const { source, id } = await seed(page);
  await openMonth(page);
  const task = page.locator('#calendar .day-todo').filter({ hasText: title });
  const group = page.locator(`#calendar [data-calendar-group-id="${id}"]`);
  await mouseDrop(page, task, group);
  await expect.poll(() => groupMembers(page, id)).toEqual([source.assignmentGroupId]);
  const latest = (await call(page, '/api/todos/' + source.id)).data.todo;
  expect(latest).toMatchObject({ date, endDate: date, start: '10:00', end: '11:30', assigneeIds: ['bojan','ibro'] });
  await expect(page.locator('#todoGroupDropDialog')).toBeHidden();
});

test('search: choose an existing group or create a new one without leaving an empty group on a rejected move', async ({ page }, info) => {
  const { source, id } = await seed(page, { undated: true, secondGroup: true });
  const result = await search(page);
  await mouseDrop(page, result, action(page, 'group'));
  await expect(picker(page)).toBeVisible();
  await expect(page.locator('#todoGroupDropEvent')).toHaveText(title);
  await page.locator('#todoGroupDropChoice').selectOption(id);
  await page.locator('#todoGroupDropSave').click();
  await expect(picker(page)).toBeHidden();
  await expect.poll(() => groupMembers(page, id)).toEqual([source.assignmentGroupId]);
  await expect(page.locator(`#searchPanel [data-search-group-id="${id}"] .search-result-open`).filter({ hasText: title })).toBeVisible();
  await mouseDrop(page, await search(page), action(page, 'group'));
  await page.locator('#todoGroupDropChoice').selectOption('new:');
  await page.locator('#todoGroupDropName').fill('Nova iz spusta');
  await page.screenshot({ path: info.outputPath('create-group-from-drop.png') });
  await page.locator('#todoGroupDropSave').click();
  await expect(picker(page)).toBeHidden();
  const groups = (await call(page, '/api/task-groups')).data.taskGroups;
  expect(groups.find(g => g.title === 'Nova iz spusta').eventIds).toEqual([source.assignmentGroupId]);
  expect(groups.find(g => g.id === id).eventIds).toEqual([]);

  const rejected = await call(page, '/api/todos/reorder', {
    sourceId: source.id, fromGroupId: id, newGroupTitle: 'Ne sme ostati prazna', placement: 'after'
  });
  expect(rejected.status).toBe(409);
  expect((await call(page, '/api/task-groups')).data.taskGroups.map(group => group.id)).toEqual(groups.map(group => group.id));
});

test('touch month: trash can be cancelled; confirmation moves the entire shared event to the trash', async ({ page, browserName }, info) => {
  test.skip(browserName !== 'chromium', 'Trusted touch dispatcher requires Chromium.');
  await page.setViewportSize({ width: 390, height: 844 });
  const { source } = await seed(page);
  await openMonth(page);
  const task = page.locator('#calendar .day-todo').filter({ hasText: title });
  await touchDrop(page, task, action(page, 'trash'), info.outputPath('trash-hover-mobile.png'));
  await expect(page.locator('#appConfirmMessage')).toContainText(title);
  await page.screenshot({ path: info.outputPath('trash-confirm-mobile.png') });
  await page.locator('#appConfirmCancel').click();
  await expect(task).toBeVisible();
  await touchDrop(page, task, action(page, 'trash'));
  await page.locator('#appConfirmAccept').click();
  await expect(task).toHaveCount(0);
  await expect.poll(async () => (await call(page, '/api/todos')).data.todos.filter(t => t.assignmentGroupId === source.assignmentGroupId).length).toBe(0);
  await expect.poll(async () => (await call(page, '/api/todos/trash')).data.todos.find(t => t.assignmentGroupId === source.assignmentGroupId)?.assigneeIds.sort())
    .toEqual(['bojan', 'ibro']);
});

test('calendar search: dialog cancellation responds immediately after a drag', async ({ page }) => {
  const { source } = await seed(page);
  await openMonth(page);
  await mouseDrop(page, await search(page), action(page, 'trash'));
  await expect(page.locator('#appConfirmTitle')).toHaveText('Premik v koš');
  // Cancel while the source result is still protected from a ghost click.
  await page.evaluate(() => $("appConfirmCancel").click());
  await expect(page.locator('#appConfirmDialog')).toBeHidden();
  expect((await call(page, '/api/todos/' + source.id)).data.todo.title).toBe(title);
});

test('daily timed event: held drag opens the group chooser without generating a time draft', async ({ page }) => {
  const { source, id } = await seed(page);
  await page.evaluate(date => openDayTimeline(date), date);
  const card = page.locator('#dayTimelineEvents .day-timeline-event').filter({ hasText: title });
  await mouseDrop(page, card, action(page, 'group'), true);
  await expect(picker(page)).toBeVisible();
  await page.locator('#todoGroupDropChoice').selectOption(id);
  await page.locator('#todoGroupDropSave').click();
  await expect(picker(page)).toBeHidden();
  await expect(page.locator('#dayTimelineDialog')).toBeVisible();
  await expect.poll(() => groupMembers(page, id)).toEqual([source.assignmentGroupId]);
  expect(await page.evaluate(() => state.dayTimelineDrafts.size)).toBe(0);
  await expect(card).toContainText('10:00-11:30');
});
