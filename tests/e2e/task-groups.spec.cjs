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
async function chooseGroupTime(page, hour, minute) {
  const picker = page.locator('#taskGroupQuickTimePicker');
  await picker.locator(`[data-time-picker-hour="${hour}"]`).click();
  await picker.locator(`[data-time-picker-minute="${minute}"]`).click();
}
test('chooser remembers five groups, keeps editor changes and lets the boss choose a group owner', async ({ page, context }) => {
  await login(page);
  const todos = await seed(page);
  const groups = [];
  for (const name of ['Žito', 'Brez', 'Cesta', 'Delo', 'Elektrika', 'Franc']) {
    const res = await api(page, '/api/task-groups', 'POST', { title: name });
    expect(res.status, res.error).toBe(200);
    groups.push(res.result.id);
  }
  const denied = await context.request.post(app.baseUrl + '/api/test-login', { data: { userId: 'ibro', password: TEST_PASSWORD } });
  expect(denied.ok()).toBeTruthy();
  expect((await api(page, '/api/task-groups', 'POST', { title: 'Ne sme uspeti', ownerId: 'bojan' })).status).toBe(403);
  expect((await context.request.post(app.baseUrl + '/api/test-login', { data: { userId: 'bojan', password: TEST_PASSWORD } })).ok()).toBeTruthy();
  await reload(page);
  await page.getByRole('button', { name: 'Uredi opravilo: Samostojno', exact: true }).click();
  await expect(page.locator('#todoGroupEditorButton')).toBeEnabled();
  await page.locator('#todoFormNotes').fill('Neshranjen opis');
  for (const id of [...groups, '']) {
    await page.locator('#todoGroupEditorButton').click();
    const chooser = page.locator('#todoGroupDropDialog');
    await expect(chooser).toBeVisible();
    if (id) {
      await page.locator('#todoGroupDropChoice').selectOption(id);
      await page.locator('#todoGroupDropSave').click();
    } else {
      const recent = chooser.locator('optgroup[label="Nazadnje uporabljene"] option');
      // The current group is omitted; already five used, including it.
      await expect(recent).toHaveText(['Elektrika', 'Delo', 'Cesta', 'Brez']);
      await page.locator('#todoGroupDropSearch').fill('zito');
      await expect(chooser.locator('select option').filter({ hasText: 'Žito' })).toHaveCount(1);
      await page.locator('#todoGroupDropRemove').click();
    }
    await expect(chooser).toBeHidden();
    await expect(page.locator('#todoFormNotes')).toHaveValue('Neshranjen opis');
  }
  await page.locator('#closeTodoDialog').click();
  if (await page.locator('#appConfirmDialog').isVisible()) await page.locator('#appConfirmAccept').click();
  await page.locator('#newTaskGroup').click();
  await page.locator('#taskGroupOwner').selectOption('ibro');
  await page.locator('#taskGroupForm [name="title"]').fill('Ibrova prazna skupina');
  await page.locator('#saveTaskGroup').click();
  await expect(page.locator('#taskGroupDialog')).toBeHidden();
  const snapshot = (await api(page, '/api/task-groups')).result;
  expect(snapshot.taskGroups.find(g => g.title === 'Ibrova prazna skupina')).toMatchObject({ ownerId: 'ibro', eventIds: [] });
  expect(snapshot.taskGroups.find(g => g.id === groups.at(-1)).eventIds).not.toContain(todos.Samostojno.assignmentGroupId);
});

test('add from an open group, verify inherited dates and detach by changing the date in the editor', async ({ page }) => {
  const date = '2026-11-25', next = '2026-11-26', separate = '2026-11-27';
  await login(page);
  const todos = await seed(page);
  const { result: created } = await api(page, '/api/task-groups', 'POST', { title: 'Termin preizkus', date });
  await move(page, todos['Samo Ibro'].id, created.id);
  await reload(page);
  await page.evaluate(id => taskGroupUi.open(id), created.id);
  await page.locator('#addTaskGroupMember').click();
  await page.locator('#todoGroupDropSearch').fill('samostojno');
  await page.locator('#todoGroupDropChoice').selectOption(todos.Samostojno.id);
  await page.locator('#todoGroupDropSave').click();
  await expect(page.locator('#taskGroupEvents button').filter({ hasText: 'Samostojno' })).toContainText('25. 11. 2026');
  await expect(page.locator('#taskGroupEvents button').filter({ hasText: 'Samo Ibro' })).toContainText('20. 11. 2026');
  await page.locator('#closeTaskGroup').click();
  const group = (await api(page, '/api/task-groups/' + created.id)).result.group;
  expect((await api(page, '/api/task-groups/' + created.id, 'PUT', { ...group, date: next, endDate: next })).status).toBe(200);
  await reload(page);
  await page.evaluate(date => { state.current = parseDate(date); state.calendarBrowseMonth = true; setView('calendar'); }, next);
  const groupCard = page.locator(`.day[data-date="${next}"] [data-calendar-group-id="${created.id}"]`);
  await expect(groupCard).toBeVisible();
  await expect(page.locator('#calendar .day-todo').filter({ hasText: 'Samostojno' })).toHaveCount(0);
  await expect(page.locator('#calendar .day-todo').filter({ hasText: 'Samo Ibro' })).toHaveCount(0);
  await expect(page.locator('#calendar .day-todo').filter({ hasText: 'Samo Bojan' })).toBeVisible();
  await page.evaluate(date => openDayTimeline(date), next);
  await expect(page.locator('#dayTimelineDialog .day-all-day-item').getByText('Samostojno')).toBeVisible();
  await page.locator('#closeDayTimeline').click();
  await groupCard.click();
  const groupEvent = page.locator('#taskGroupEvents button').filter({ hasText: 'Samostojno' });
  await expect(groupEvent).toContainText('26. 11. 2026');
  await groupEvent.click();
  await expect(page.locator('#todoFormDate')).toHaveValue(next);
  expect((await api(page, '/api/todos/' + todos.Samostojno.id)).result.todo.date).toBe('');
  await page.locator('#todoFormDate').fill(separate);
  await page.locator('#todoFormDate').dispatchEvent('change');
  await page.locator('#saveTodoDialog').click();
  await expect(page.locator('#todoDialog')).toBeHidden();
  expect((await api(page, '/api/task-groups/' + created.id)).result.group.eventIds).not.toContain(todos.Samostojno.assignmentGroupId);
  await page.locator('#closeTaskGroup').click();
  await expect(page.locator(`.day[data-date="${separate}"] .day-todo`).filter({ hasText: 'Samostojno' })).toBeVisible();
});

test('undated groups keep dated members out of the month until they leave the group', async ({ page }) => {
  await login(page);
  const todo = (await seed(page))['Samo Ibro'];
  const { result: group } = await api(page, '/api/task-groups', 'POST', { title: 'Skupina brez datuma' });
  expect((await move(page, todo.id, group.id)).status).toBe(200);
  await reload(page);
  await page.evaluate(() => { state.current = parseDate('2026-11-20'); state.calendarBrowseMonth = true; setView('calendar'); });
  const task = page.locator('.day[data-date="2026-11-20"] .day-todo').filter({ hasText: todo.title });
  await expect(task).toHaveCount(0);
  await expect(page.locator(`#calendar [data-calendar-group-id="${group.id}"]`)).toHaveCount(0);
  expect((await move(page, todo.id, '', group.id)).status).toBe(200);
  await reload(page);
  await expect(task).toBeVisible();
});

test('month group arrow opens an inline list, separate from the modal, with clickable members', async ({ page }, info) => {
  const date = '2026-11-20';
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const todos = await seed(page);
  const { result: group } = await api(page, '/api/task-groups', 'POST', { title: 'Razširljiva skupina', date, start: '10:30', end: '11:30' });
  for (const todo of [todos.Samostojno, todos['Samo Ibro']]) expect((await move(page, todo.id, group.id)).status).toBe(200);
  await reload(page);
  await page.evaluate(date => { state.current = parseDate(date); state.calendarBrowseMonth = true; setView('calendar'); }, date);
  const day = page.locator(`.day[data-date="${date}"]`);
  const card = day.locator(`[data-calendar-group-id="${group.id}"]`);
  const toggle = day.getByRole('button', { name: 'Prikaži opravila v skupini: Razširljiva skupina' });
  const panel = day.locator('.month-group-members');
  await expect(panel).toBeHidden();
  await toggle.tap();
  const expanded = day.getByRole('button', { name: 'Skrij opravila v skupini: Razširljiva skupina' });
  await expect(expanded).toHaveAttribute('aria-expanded', 'true');
  await expect(panel.locator('.task-group-event-link')).toHaveCount(2);
  await expect(page.locator('#taskGroupDialog')).toBeHidden();
  await expect(page.locator('#calendar .day-todo').filter({ hasText: 'Samo Ibro' })).toHaveCount(0);
  const [buttonBox, cardBox, panelBox] = await Promise.all([expanded.boundingBox(), card.boundingBox(), panel.boundingBox()]);
  expect(buttonBox.x + buttonBox.width).toBeGreaterThan(cardBox.x + cardBox.width - 8);
  expect(panelBox.y).toBeGreaterThanOrEqual(cardBox.y + cardBox.height);
  expect(panelBox.x).toBeGreaterThan(cardBox.x);
  await page.screenshot({ path: info.outputPath('month-group-inline-phone.png') });
  await card.click({ position: { x: 12, y: 10 } });
  await expect(page.locator('#taskGroupDialog')).toBeVisible();
  expect(await panel.locator('.day-timeline-event-title').allTextContents())
    .toEqual(await page.locator('#taskGroupEvents .day-timeline-event-title').allTextContents());
  await page.locator('#closeTaskGroup').click();
  await panel.getByRole('button', { name: /Samo Ibro/ }).tap();
  await expect(page.locator('#todoFormTask')).toHaveValue('Samo Ibro');
  await page.locator('#closeTodoDialog').click();
  await expect(panel).toBeVisible();
  await page.evaluate(() => { state.calendarWorkerIds = ['ibro']; renderMonth(); });
  await expect(panel.locator('.day-timeline-event-title')).toHaveText(['Samo Ibro']);
  await expanded.press('Enter');
  await expect(panel).toBeHidden();
});

test('multi-day group can expand again on Monday without duplicating its list', async ({ page }, info) => {
  const date = '2026-11-20';
  await login(page);
  const todo = (await seed(page))['Samo Ibro'];
  const { result: group } = await api(page, '/api/task-groups', 'POST', { title: 'Večdnevna skupina', date, endDate: '2026-11-24' });
  expect((await move(page, todo.id, group.id)).status).toBe(200);
  await reload(page);
  await page.evaluate(date => { state.current = parseDate(date); state.calendarBrowseMonth = true; setView('calendar'); }, date);
  const start = page.locator('.day[data-date="2026-11-20"]');
  const monday = page.locator('.day[data-date="2026-11-23"]');
  const tuesday = page.locator('.day[data-date="2026-11-24"]');
  const open = day => day.getByRole('button', { name: 'Prikaži opravila v skupini: Večdnevna skupina' });
  await open(start).click();
  await expect(start.locator('.month-group-members')).toBeVisible();
  await open(monday).click();
  await expect(start.locator('.month-group-members')).toBeHidden();
  const panel = monday.locator('.month-group-members');
  await expect(panel.getByRole('button', { name: /Samo Ibro/ })).toBeVisible();
  await expect(page.locator('#calendar .month-group-members:not([hidden])')).toHaveCount(1);
  const segment = day => day.locator(`[data-calendar-group-id="${group.id}"]`);
  await expect.poll(async () => Math.abs((await segment(monday).boundingBox()).y - (await segment(tuesday).boundingBox()).y)).toBeLessThan(1);
  expect(await start.evaluate(day => day.scrollLeft)).toBe(0);
  expect(await monday.evaluate(day => day.scrollLeft)).toBe(0);
  await page.screenshot({ path: info.outputPath('month-group-inline-span.png') });
});

async function drag(page, source, target, pointer) {
  // A read-only sync can replace rows before the gesture has even begun.
  await expect(async () => {
    await source.scrollIntoViewIfNeeded({ timeout: 1500 });
    await target.evaluate(el => el.scrollIntoView({ block: 'center' }));
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

for (const [worker, width] of [['bojan', 1280], ['ibro', 390]]) {
  test(`month plus creates a group on the clicked day and stays in the calendar (${worker})`, async ({ page }, info) => {
    const date = '2032-04-06';
    const title = 'Skupina iz koledarja';
    await page.setViewportSize({ width, height: 844 });
    await login(page, worker);
    await page.locator('#newTodoButton').click();
    await expect(page.locator('#todoCreationGroup')).toBeHidden();
    await page.locator('#closeTodoDialog').click();
    await expect(page.locator('body')).not.toHaveClass(/\bmodal-open\b/);
    await page.evaluate(date => {
      state.current = parseDate(date);
      state.calendarBrowseMonth = true;
      setView('calendar');
    }, date);
    const day = page.locator(`#calendar .day[data-date="${date}"]`);
    await day.locator('.quick-add').click();
    await expect(page.locator('#todoCreationGroup')).toBeVisible();
    if (worker === 'ibro') {
      await page.locator('#todoCreationTabs [data-create-mode="hours"]').click();
      await expect(page.locator('#todoCreationTabs [data-create-mode="hours"]')).toHaveAttribute('aria-selected', 'true');
      await expect(page.locator('#todoCreationGroup')).toBeVisible();
    }
    await page.screenshot({ path: info.outputPath('month-plus-with-group.png') });
    await page.locator('#todoCreationGroup').click();
    await expect(page.locator('#todoDialog')).toBeHidden();
    await expect(page.locator('#taskGroupTitle')).toHaveText('Nova skupina');
    await expect(page.locator('#taskGroupDate')).toHaveValue(date);
    await expect(page.locator('#taskGroupEndDate')).toHaveValue(date);
    await expect(page.locator('#taskGroupQuickTimeStart')).toHaveText('Od ---');
    await expect(page.locator('#taskGroupQuickTimeEnd')).toHaveText('Do ---');
    await page.locator('#taskGroupForm [name="title"]').fill(title);
    await page.locator('#saveTaskGroup').click();
    await expect(page.locator('#taskGroupDialog')).toBeHidden();
    await expect(page.locator('#calendarViewBtn')).toHaveClass(/active/);
    await expect(day.locator('.task-group-cal').filter({ hasText: title })).toBeFocused();
    const { result } = await api(page, '/api/task-groups');
    expect(result.taskGroups.find(group => group.title === title)).toMatchObject({
      date, endDate: date, start: '', end: '', ownerId: worker, eventIds: []
    });
    expect((await api(page, '/api/todos')).result.todos).toEqual([]);
  });
}

for (const pointer of ['mouse', 'touch']) test(`${pointer}: drag into and out of a group, preserve priorities, and open a timed group in both calendars`, async ({ page, browserName }, info) => {
  test.skip(pointer === 'touch' && browserName !== 'chromium', 'Trusted touch dispatcher requires Chromium.');
  await page.setViewportSize({ width: pointer === 'touch' ? 390 : 1280, height: 950 });
  await login(page); await seed(page);
  await page.locator('#newTaskGroup').click();
  await page.locator('#taskGroupForm [name="title"]').fill('Nepomembno');
  await page.locator('#taskGroupForm [name="date"]').fill('2026-11-20');
  await page.locator('#taskGroupQuickTimeStart').click();
  await chooseGroupTime(page, 10, 0);
  await chooseGroupTime(page, 11, 30);
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
  await expect(day.locator('.day-todo').filter({ hasText: 'Samo Ibro' })).toHaveCount(0);
  await expect(day.locator('.task-group-cal')).toHaveCSS('border-left-color', 'rgb(31, 111, 139)');
  await day.locator('.task-group-cal').click();
  await expect(page.locator('#taskGroupEvents')).toContainText('Samo Ibro');
  await expect(page.locator('#taskGroupEvents .day-todo-worker-name')).toHaveText('Ibro');
  await page.screenshot({ path: info.outputPath('task-group-calendar.png') });
  await page.locator('#taskGroupEvents button').click();
  await expect(page.locator('#todoFormTask')).toHaveValue('Samo Ibro');
  await page.locator('#closeTodoDialog').click();
  await expect(page.locator('#taskGroupDialog')).toBeVisible();
  await page.locator('#closeTaskGroup').click();
  await page.evaluate(() => openDayTimeline('2026-11-20'));
  await expect(page.locator('.day-timeline-event.task-group-cal .day-resize-handle')).toHaveCount(0);
  await expect(page.locator('.day-timeline-event.task-group-cal')).toHaveCSS('border-left-color', 'rgb(31, 111, 139)');
  await page.locator('.day-timeline-event.task-group-cal').click();
  await expect(page.locator('#taskGroupEvents')).toContainText('Samo Ibro');
  await page.locator('#closeTaskGroup').click();
  await expect(page.locator('#dayTimelineDialog')).toBeVisible();
});

test('group editor reuses date shortcuts and clock; multi-day and all-day clear time only', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.locator('#newTaskGroup').click();
  await page.locator('#taskGroupForm [name="title"]').fill('Termin QA');
  await page.locator('#setTaskGroupDateToday').click();
  const today = await page.evaluate(() => dateKey(new Date()));
  const next = await page.evaluate(today => shiftDateKey(today, 1), today);
  await expect(page.locator('#taskGroupDate')).toHaveValue(today);
  await expect(page.locator('#taskGroupEndDate')).toHaveValue(today);
  await expect(page.locator('#taskGroupDateWeekday')).not.toBeEmpty();
  await page.locator('#advanceTaskGroupDate').click();
  await expect(page.locator('#taskGroupDate')).toHaveValue(next);
  await expect(page.locator('#taskGroupEndDate')).toHaveValue(next);
  await page.locator('#taskGroupQuickTimeStart').click();
  await page.screenshot({ path: info.outputPath('group-clock-mobile.png') });
  await chooseGroupTime(page, 22, 45);
  await chooseGroupTime(page, 23, 15);
  await expect(page.locator('#taskGroupQuickTimeDuration')).toHaveText('Skupaj 30 min');
  await page.locator('#taskGroupQuickTimeEnd').click();
  await page.locator('#taskGroupQuickTimeAllDay').click();
  await expect(page.locator('#taskGroupQuickTimeStart')).toHaveText('Od ---');
  await expect(page.locator('#taskGroupQuickTimeEnd')).toHaveText('Do ---');
  await expect(page.locator('#taskGroupDate')).toHaveValue(next);
  await expect(page.locator('#taskGroupEndDate')).toHaveValue(next);
  await page.locator('#taskGroupQuickTimeStart').click();
  await chooseGroupTime(page, 10, 0);
  await chooseGroupTime(page, 11, 15);
  await page.locator('#setTaskGroupEndDateTomorrow').click();
  const after = await page.evaluate(next => shiftDateKey(next, 1), next);
  await expect(page.locator('#taskGroupEndDate')).toHaveValue(after);
  await expect(page.locator('#taskGroupQuickTimePicker')).toBeHidden();
  await expect(page.locator('#taskGroupStart')).toHaveValue('');
  await expect(page.locator('#taskGroupEnd')).toHaveValue('');
  await page.locator('#saveTaskGroup').click();
  await expect(page.locator('#taskGroupDialog')).toBeHidden();
  const group = (await api(page, '/api/task-groups')).result.taskGroups.find(item => item.title === 'Termin QA');
  expect(group).toMatchObject({ date: next, endDate: after, start: '', end: '' });
  await page.locator(`.task-group-card[data-task-group-id="${group.id}"] .task-group-edit`).click();
  await page.locator('#clearTaskGroupDate').click();
  await expect(page.locator('#taskGroupDate')).toHaveValue('');
  await expect(page.locator('#taskGroupEndDate')).toHaveValue('');
  await expect(page.locator('#taskGroupQuickTimeStart')).toHaveText('Od ---');
});

test('group uses daily cards with real coworkers and aligned date columns', async ({ page }, info) => {
  await login(page);
  const todos = await seed(page);
  const shared = (await api(page, '/api/todos', 'POST', {
    title: 'Skupno popravilo zelo dolgega naziva <QA>', status: 'open',
    assigneeIds: ['bojan', 'ibro'], date: '2026-11-22', endDate: '2026-11-24'
  })).result.todos.find(todo => todo.title.startsWith('Skupno popravilo'));
  const group = (await api(page, '/api/task-groups', 'POST', { title: 'Tabela QA' })).result;
  for (const item of [todos['Samo Ibro'], shared, todos.Samostojno]) {
    expect((await move(page, item.id, group.id)).status).toBe(200);
  }
  await page.goto(app.baseUrl + '/?group=' + group.id);
  const list = page.locator('#taskGroupEvents');
  const rows = list.locator('.task-group-event-link.day-all-day-item');
  await expect(rows).toHaveCount(3);
  const together = rows.filter({ hasText: 'Skupno popravilo' });
  await expect(together.locator('.day-todo-worker-name')).toHaveText(['Bojan', 'Ibro']);
  await expect(together.locator('.avatar')).toHaveCount(2);
  await expect(together.locator('.task-group-event-when')).toHaveText('22. 11. 2026 – 24. 11. 2026');
  await expect(rows.filter({ hasText: 'Samostojno' }).locator('.task-group-event-when')).toHaveCount(0);
  const dates = list.locator('.task-group-event-when');
  await expect(dates).toHaveCount(2);
  expect(Math.abs((await dates.nth(0).boundingBox()).x - (await dates.nth(1).boundingBox()).x)).toBeLessThan(1);
  await page.screenshot({ path: info.outputPath('group-daily-rows-desktop.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  const title = await together.locator('.day-event-heading').boundingBox();
  const timing = await together.locator('.task-group-event-when').boundingBox();
  expect(timing.y).toBeGreaterThanOrEqual(title.y + title.height);
  expect(timing.x + timing.width).toBeLessThanOrEqual(390);
  await page.screenshot({ path: info.outputPath('group-daily-rows-mobile.png') });
  await together.press('Enter');
  await expect(page.locator('#todoFormTask')).toHaveValue('Skupno popravilo zelo dolgega naziva <QA>');
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
