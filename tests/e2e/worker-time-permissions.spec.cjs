const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');
test.use({ serviceWorkers: 'block' });
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp({ authMode: 'lan' }); });
test.afterAll(async () => { await app?.stop(); });
async function login(page, email = '') {
  if (!email) await page.context().request.post(app.baseUrl + '/api/test-login', { data: { userId: 'bojan', password: TEST_PASSWORD } });
  await page.goto(app.baseUrl);
  if (email) {
    await page.locator('#lanLoginEmail').fill(email);
    await page.locator('#localTestPassword').fill(TEST_PASSWORD);
    await page.locator('#localTestLoginBtn').click();
  }
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
}
const call = (page, path, method = 'GET', body) => page.evaluate(async ({ path, method, body }) => {
  try { return { status: 200, data: await api(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) }; }
  catch (error) { return { status: error.status, error: error.message }; }
}, { path, method, body });

test('boss edits per-worker hour allowlist; generic worker sees grants, revocation is enforced, absences stay self-only', async ({ browser }, info) => {
  const lan = { extraHTTPHeaders: { 'X-Real-IP': '192.168.50.37' } };
  const bossContext = await browser.newContext(lan), workerContext = await browser.newContext(lan);
  const boss = await bossContext.newPage(), worker = await workerContext.newPage();
  try {
    await login(boss);
    const external = (await call(boss, '/api/workers', 'POST', { name: 'Zunanji izvajalci' })).data.worker;
    const actor = (await call(boss, '/api/workers', 'POST', { name: 'Maja QA', email: 'maja-qa@example.test' })).data.worker;
    const target = (await call(boss, '/api/workers', 'POST', { name: 'Štajerc QA' })).data.worker;
    expect((await call(boss, `/api/workers/${actor.id}/lan-password`, 'PUT', { password: TEST_PASSWORD })).status).toBe(200);
    await login(worker, actor.email);
    await worker.locator('#writeHoursButton').click();
    await expect(worker.locator('#todoFormAssignees input')).toHaveCount(2);
    await expect(worker.locator(`#todoFormAssignees input[value="${target.id}"]`)).toHaveCount(0);
    await worker.locator('#closeTodoDialog').click();
    expect((await call(worker, `/api/workers/${actor.id}`, 'PUT', { ...actor, timeEntryForIds: ['bojan'] })).status).toBe(403);
    for (const ids of ['bojan', ['missing-worker'], [1]]) {
      expect((await call(boss, `/api/workers/${actor.id}`, 'PUT', { ...actor, timeEntryForIds: ids })).status).toBe(400);
    }
    await boss.evaluate(() => openWorkersDialog());
    await boss.setViewportSize({ width: 390, height: 844 });
    const card = boss.locator(`[data-worker-id="${actor.id}"]`);
    const check = id => card.locator(`[data-worker-time-entry-for][value="${id}"]`);
    await expect(check(actor.id)).toBeChecked();
    await expect(check(external.id)).toBeChecked();
    await check(external.id).uncheck();
    await check(target.id).check();
    await card.locator('.worker-permissions').scrollIntoViewIfNeeded();
    await boss.screenshot({ path: info.outputPath('worker-hour-permissions-mobile.png') });
    await card.locator('[data-save-worker]').click();
    await expect.poll(async () => (await call(boss, '/api/workers')).data.workers.find(w => w.id === actor.id).timeEntryForIds).toEqual([actor.id, target.id]);
    await worker.evaluate(() => autoRefreshSharedData());
    await expect.poll(() => worker.evaluate(() => state.user.timeEntryForIds)).toContain(target.id);
    await worker.locator('#writeHoursButton').click();
    await expect(worker.locator('#todoFormAssignees input[type=radio]')).toHaveCount(2);
    await expect(worker.locator(`#todoFormAssignees input[value="${external.id}"]`)).toHaveCount(0);
    await worker.locator(`#todoFormAssignees input[value="${target.id}"]`).check();
    await worker.locator('#todoFormClient').fill('QA stranka');
    await worker.locator('#todoFormTask').fill('Dovoljen vpis QA');
    await worker.locator('#todoFormDate').fill('2032-03-17');
    await worker.locator('#todoFormStart').fill('08:00');
    await worker.locator('#todoFormEnd').fill('09:00');
    await worker.locator('#saveTodoDialog').click();
    await worker.locator('#appConfirmAccept').click();
    await expect(worker.locator('#todoDialog')).not.toBeVisible();
    const saved = (await call(worker, '/api/todos')).data.todos.find(t => t.title === 'Dovoljen vpis QA');
    expect(saved.syncUser).toBe(target.id);
    expect(saved.createdBy).toBe(actor.id);
    const entry = { ...saved, id: undefined, date: '2032-03-18', endDate: '2032-03-18', assigneeIds: [actor.id, target.id] };
    expect((await call(worker, '/api/todos', 'POST', entry)).status).toBe(400);
    expect((await call(worker, '/api/todos', 'POST', { ...entry, assigneeIds: [external.id] })).status).toBe(403);
    await worker.evaluate(() => absenceUi.open());
    await expect(worker.locator('#absenceWorker')).not.toBeVisible();
    await expect(worker.locator('#absenceWorkerName')).toHaveText('Maja QA');
    expect((await call(worker, '/api/absences', 'POST', { workerId: target.id, date: '2032-03-17', endDate: '2032-03-17', reason: 'vacation', viewerIds: [] })).status).toBe(403);
    await worker.locator('#closeAbsence').click();
    // Revoke while the worker still holds the old permission list in memory.
    await check(target.id).uncheck();
    await card.locator('[data-save-worker]').click();
    await expect.poll(async () => (await call(boss, '/api/workers')).data.workers.find(w => w.id === actor.id).timeEntryForIds).toEqual([actor.id]);
    expect((await call(worker, '/api/todos', 'POST', { ...entry, assigneeIds: [target.id] })).status).toBe(403);
    expect((await call(worker, `/api/todos/${saved.id}`, 'PUT', { ...saved, assigneeIds: [target.id], baseUpdatedAt: saved.updatedAt })).status).toBe(403);
    expect((await call(worker, '/api/todos/time-batch', 'POST', { items: [{ id: saved.id, date: saved.date, start: '09:00', end: '10:00', baseUpdatedAt: saved.updatedAt }] })).status).toBe(403);
    expect((await call(worker, `/api/todos/${saved.id}/time`, 'POST', { start: '09:00', end: '10:00' })).status).toBe(403);
    await check(actor.id).uncheck();
    await card.locator('[data-save-worker]').click();
    await expect.poll(async () => (await call(boss, '/api/workers')).data.workers.find(w => w.id === actor.id).timeEntryForIds).toEqual([]);
    await worker.reload(); await expect(worker.locator('#app')).toBeVisible();
    await worker.locator('#writeHoursButton').click();
    await expect(worker.locator('#todoFormAssignees')).toContainText('Nimaš dovoljenja');
    await expect(worker.locator('#todoFormAssignees input')).toHaveCount(0);
    expect((await call(worker, '/api/todos', 'POST', { ...entry, assigneeIds: [actor.id] })).status).toBe(403);
    // Boss remains unrestricted; ordinary profile saves without this field preserve permissions.
    const freshActor = (await call(boss, '/api/workers')).data.workers.find(w => w.id === actor.id);
    delete freshActor.timeEntryForIds;
    expect((await call(boss, `/api/workers/${actor.id}`, 'PUT', freshActor)).data.worker.timeEntryForIds).toEqual([]);
    await expect(boss.locator('[data-worker-id="bojan"] [data-worker-time-entry-for]:not(:checked)')).toHaveCount(0);
    await expect(boss.locator('[data-worker-id="bojan"] [data-worker-time-entry-for]:enabled')).toHaveCount(0);
  } finally { await bossContext.close().catch(() => {}); await workerContext.close().catch(() => {}); }
});
