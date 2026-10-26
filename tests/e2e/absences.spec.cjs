const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');
test.use({ serviceWorkers: 'block' });
let app;
test.beforeEach(async () => { app = await startIsolatedTestApp(); });
test.afterEach(async () => { await app?.stop(); });
async function login(page, user = 'bojan') {
  await page.goto(app.baseUrl);
  await page.locator('#localTestUser').selectOption(user);
  await page.locator('#localTestPassword').fill(TEST_PASSWORD);
  await page.locator('#localTestLoginBtn').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
}
const call = (page, path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
  try { return { status: 200, data: await api(path, { method, ...(body ? { body: JSON.stringify(body) } : {}) }) }; }
  catch (error) { return { status: error.status, error: error.message }; }
}, { path, method, body });

for (const user of ['bojan', 'ibro']) test(`${user}: month plus opens absence for selected date without losing task draft`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page, user);
  const before = (await call(page, '/api/todos')).data.todos.length;
  await page.evaluate(() => { state.current = new Date(2026, 9, 1); });
  await page.locator('#calendarViewBtn').click();
  await page.locator('.day[data-date="2026-10-26"] .quick-add').click();
  await expect(page.locator('#todoDialog')).toBeVisible();
  await page.locator('#todoFormTask').fill('Keep this unfinished task');
  await page.locator('#todoCreationAbsence').click();
  await expect(page.locator('#todoDialog')).toBeHidden();
  await expect(page.locator('#absenceDialog')).toBeVisible();
  await expect(page.locator('#absenceDate')).toHaveValue('2026-10-26');
  await expect(page.locator('#absenceEndDate')).toHaveValue('2026-10-26');
  if (user === 'bojan') await expect(page.locator('#absenceWorker')).toBeVisible();
  else { await expect(page.locator('#absenceWorker')).toBeHidden(); await expect(page.locator('#absenceWorkerName')).toHaveText('Ibro'); }
  await page.screenshot({ path: info.outputPath('absence-from-month-plus.png') });
  await page.locator('#saveAbsence').click();
  await expect(page.locator('#absenceDialog')).toBeHidden();
  expect((await call(page, '/api/absences')).data.absences.some(a => a.workerId === user && a.date === '2026-10-26')).toBe(true);
  expect((await call(page, '/api/todos')).data.todos.length).toBe(before);
  await page.locator('.day[data-date="2026-10-26"] .quick-add').click();
  await expect(page.locator('#todoFormTask')).toHaveValue('Keep this unfinished task');
  await page.locator('#closeTodoDialog').click();
  await page.evaluate(() => openDayTimeline('2026-10-26'));
  await page.evaluate(() => openNewTodoFromDayTimeline($('dayTimeline').getBoundingClientRect().top + 100));
  await expect(page.locator('#todoDialog')).toBeVisible();
  await page.locator('#todoCreationAbsence').click();
  await expect(page.locator('#absenceDialog')).toBeVisible();
  await page.locator('#closeAbsence').click();
  await expect(page.locator('#dayTimelineDialog')).toBeVisible();
});

test('default hour permissions allow self OR external; boss chooses every worker singly', async ({ browser }) => {
  const bossContext = await browser.newContext(), workerContext = await browser.newContext();
  const boss = await bossContext.newPage(), worker = await workerContext.newPage();
  try {
    await login(boss);
    const external = (await call(boss, '/api/workers', 'POST', { name: 'Zunanji izvajalci' })).data.worker;
    const other = (await call(boss, '/api/workers', 'POST', { name: 'Štajerc QA' })).data.worker;
    await login(worker, 'ibro');
    await worker.locator('#writeHoursButton').click();
    await expect(worker.locator('#todoFormAssignees input')).toHaveCount(2);
    await expect(worker.locator('#todoFormAssignees input[type=radio]')).toHaveCount(2);
    await expect(worker.locator(`#todoFormAssignees input[value="${other.id}"]`)).toHaveCount(0);
    await expect(worker.locator('#todoFormAssignees input[value="bojan"]')).toHaveCount(0);
    await worker.locator('#todoFormAssignees input[value="ibro"]').check();
    await worker.locator(`#todoFormAssignees input[value="${external.id}"]`).check();
    await expect(worker.locator('#todoFormAssignees input:checked')).toHaveCount(1);
    await expect(worker.locator('#todoFormAssignees input[value="ibro"]')).not.toBeChecked();
    const entry = { title: 'Zunanji QA', status: 'execution', date: '2026-10-20', start: '08:00', end: '09:00', client: 'QA stranka', assigneeIds: [external.id] };
    const created = await call(worker, '/api/todos', 'POST', entry);
    expect(created.status).toBe(200);
    const saved = created.data.todos.find(t => t.title === entry.title);
    expect(saved.syncUser).toBe(external.id);
    expect(saved.createdBy).toBe('ibro');
    for (const assigneeIds of [['bojan'], [other.id]]) {
      expect((await call(worker, '/api/todos', 'POST', { ...entry, assigneeIds })).status).toBe(403);
      expect((await call(worker, `/api/todos/${saved.id}`, 'PUT', { ...saved, assigneeIds, baseUpdatedAt: saved.updatedAt })).status).toBe(403);
    }
    expect((await call(worker, '/api/todos', 'POST', { ...entry, assigneeIds: ['ibro', external.id] })).status).toBe(400);
    expect((await call(worker, '/api/todos', 'POST', { ...entry, status: 'meal', title: 'Malica zunanjih QA', start: '12:00', end: '12:30', assigneeIds: [external.id] })).data.todos.find(t => t.status === 'meal' && t.date === entry.date).syncUser).toBe(external.id);
    expect((await call(boss, '/api/todos', 'POST', { ...entry, status: 'meal', assigneeIds: ['ibro', external.id] })).status).toBe(400);
    expect((await call(worker, '/api/todos', 'POST', { ...entry, assigneeIds: undefined, syncUser: other.id })).status).toBe(403);
    await boss.evaluate(async () => applyBootstrapSnapshot(await api('/api/bootstrap')));
    await boss.locator('#writeHoursButton').click();
    await expect(boss.locator('#todoFormAssignees input[type=radio]')).toHaveCount(4);
    expect((await call(boss, '/api/todos', 'POST', { ...entry, title: 'Štajerc ure QA', assigneeIds: [other.id] })).status).toBe(200);
    expect((await call(boss, '/api/todos', 'POST', { ...entry, assigneeIds: ['ibro', other.id] })).status).toBe(400);
  } finally { await bossContext.close(); await workerContext.close(); }
});

test('absence UI, private access, read-only viewers, live sync, conflict protection, no work entries and reversible delete', async ({ browser }, info) => {
  const bossContext = await browser.newContext(), workerContext = await browser.newContext();
  const boss = await bossContext.newPage(), worker = await workerContext.newPage();
  try {
    await login(boss); await login(worker, 'ibro');
    const baseline = await call(boss, '/api/todos');
    await boss.locator('#absenceEntryButton').click();
    await expect(boss.locator('#calendarAbsenceButton')).toHaveCount(0);
    await expect(boss.locator('#absenceWorker')).toBeVisible();
    await boss.locator('#absenceWorker').selectOption('bojan');
    await boss.locator('#absenceReason').selectOption('illness');
    const today = await boss.evaluate(() => dateKey(new Date()));
    const tomorrow = await boss.evaluate(() => shiftDateKey(dateKey(new Date()), 1));
    await boss.locator('#absenceDate').fill(today); await boss.locator('#absenceEndDate').fill(tomorrow);
    await expect(boss.locator('#absenceViewers input[value="bojan"]')).toBeChecked();
    await expect(boss.locator('#absenceViewers input[value="ibro"]')).not.toBeChecked();
    await boss.locator('#saveAbsence').click();
    await expect(boss.locator('#absenceDialog')).not.toBeVisible();
    const item = (await call(boss, '/api/absences')).data.absences.find(a => a.workerId === 'bojan');
    expect((await call(worker, `/api/absences/${item.id}`)).status).toBe(404);
    expect((await call(worker, `/api/absences/${item.id}`, 'PUT', { ...item, baseUpdatedAt: item.updatedAt })).status).toBe(404);
    expect((await call(worker, '/api/bootstrap?initial=1')).data.absences).toEqual([]);
    expect((await call(worker, '/api/undo-journal')).data.actions.some(a => /odsotnost/.test(a.action))).toBe(false);
    expect((await call(worker, '/api/absences', 'POST', { ...item, workerId: 'bojan' })).status).toBe(403);
    const updated = await call(boss, `/api/absences/${item.id}`, 'PUT', { ...item, viewerIds: ['ibro'], baseUpdatedAt: item.updatedAt });
    expect(updated.status).toBe(200);
    expect((await call(boss, `/api/absences/${item.id}`, 'PUT', { ...item, baseUpdatedAt: item.updatedAt })).status).toBe(409);
    await worker.locator('#calendarViewBtn').click();
    await worker.evaluate(() => autoRefreshSharedData());
    const cards = worker.locator('.day-multiday-event').filter({ hasText: 'Odsotnost' });
    await expect(cards.first()).toBeVisible();
    await cards.first().click();
    await expect(worker.locator('#absenceTitle')).toContainText('samo ogled');
    await expect(worker.locator('#saveAbsence')).not.toBeVisible();
    expect((await call(worker, `/api/absences/${item.id}`, 'DELETE', { baseUpdatedAt: updated.data.absences[0].updatedAt })).status).toBe(403);
    await worker.locator('#closeAbsence').click();
    await worker.evaluate(date => openDayTimeline(date), tomorrow);
    await worker.locator('.day-all-day-item').filter({ hasText: 'Odsotnost' }).click();
    await expect(worker.locator('#absenceDialog')).toBeVisible();
    await worker.locator('#closeAbsence').click();
    await worker.locator('#dayAbsenceButton').click();
    await expect(worker.locator('#absenceWorker')).toHaveValue('ibro');
    await expect(worker.locator('#absenceWorker')).not.toBeVisible();
    await expect(worker.locator('#absenceWorkerName')).toHaveText('Ibro');
    await worker.locator('#saveAbsence').click();
    await expect(worker.locator('#absenceDialog')).not.toBeVisible();
    const own = (await call(worker, '/api/absences')).data.absences.find(a => a.workerId === 'ibro');
    expect(own.canEdit).toBe(true);
    expect((await call(boss, '/api/todos')).data.todos.length).toBe(baseline.data.todos.length);
    await boss.evaluate(() => autoRefreshSharedData());
    await boss.locator('#calendarViewBtn').click();
    await boss.setViewportSize({ width: 390, height: 844 });
    await boss.screenshot({ path: info.outputPath('absence-month-mobile.png') });
    await boss.evaluate(id => absenceUi.open(state.absences.find(a => a.id === id)), own.id);
    await boss.screenshot({ path: info.outputPath('absence-editor-mobile.png') });
    await boss.locator('#deleteAbsence').click(); await boss.locator('#appConfirmAccept').click();
    await expect(boss.locator('#absenceDialog')).not.toBeVisible();
    expect((await call(boss, `/api/absences/${own.id}`)).status).toBe(404);
    const journal = (await call(boss, '/api/undo-journal')).data;
    expect(JSON.stringify(journal)).toContain('izbrisal odsotnost');
    const undo = journal.actions.find(a => a.canUndo);
    expect((await call(boss, `/api/undo-journal/${undo.id}`, 'POST', { confirm: true })).status).toBe(200);
    expect((await call(boss, `/api/absences/${own.id}`)).data.absence.reason).toBe(own.reason);
  } finally { await bossContext.close(); await workerContext.close(); }
});
