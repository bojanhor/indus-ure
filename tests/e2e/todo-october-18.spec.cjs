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

test('worker card atomically saves billing; preview matches confirmation and historical mileage is immutable', async ({ page }, info) => {
  await login(page);
  const original = await page.evaluate(async () => (await api('/api/workers/billing')).workers);
  await page.evaluate(() => openWorkersDialog());
  const card = page.locator('[data-worker-id="ibro"]');
  await card.locator('[data-worker-hourly-rate]').fill('25');
  await card.locator('[data-worker-commute-km]').fill('7');
  await card.locator('[data-worker-km-rate]').fill('0.49');
  await card.locator('[data-worker-export-title]').fill('Monter QA');
  await card.locator('[data-save-worker]').click();
  await expect(card.locator('[data-worker-km-rate]')).toHaveValue('0.49');
  await page.waitForLoadState('networkidle');
  const saved = await page.evaluate(async () => (await api('/api/workers/billing')).workers);
  expect(saved.find(w => w.id === 'ibro')).toMatchObject({ hourlyRate: 25, commuteKmOneWay: 7, workerOwnVehicleKmRate: 0.49, exportTitle: 'Monter QA' });
  expect(saved.find(w => w.id === 'bojan')).toEqual(original.find(w => w.id === 'bojan'));
  await page.setViewportSize({ width: 390, height: 844 });
  await card.locator('.worker-billing-settings').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('worker-billing-mobile.png') });
  expect(await card.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.locator('#closeWorkers').click();
  await page.evaluate(async () => {
    await api('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'Personal km QA', client: 'QA customer', syncUser: 'ibro', assigneeIds: ['ibro'], status: 'execution', date: '2026-01-02', start: '08:00', end: '09:00', billingKm: 3, commuteEligible: true }) });
    await loadAll(); setWorkContext('admin'); setView('billing'); state.billingWorkerId = 'ibro';
    saveBillingRangeSelection('ibro', { from: '2026-01-02', to: '2026-01-02' }); renderBillingView();
  });
  await expect(page.locator('#billingDayList')).toContainText('0,49');
  await expect(page.locator('#billingDayList')).toContainText('33,33');
  const payroll = await page.evaluate(async () => (await api('/api/payrolls', { method: 'POST', body: JSON.stringify({ workerId: 'ibro', from: '2026-01-02', to: '2026-01-02' }) })).payroll);
  expect(payroll.lines[0]).toMatchObject({ kmRate: 0.49, km: 17, totalAmount: 33.33 });
  await page.evaluate(async () => {
    const worker = (await api('/api/workers')).workers.find(w => w.id === 'ibro');
    await api('/api/workers/ibro', { method: 'PUT', body: JSON.stringify({ ...worker, billing: { ...worker.billing, workerOwnVehicleKmRate: 0 } }) });
  });
  const after = await page.evaluate(async () => (await api('/api/payrolls')).payrolls);
  expect(after.find(p => p.id === payroll.id).lines).toEqual(payroll.lines);
  const zero = await page.evaluate(async () => (await api('/api/quick-create?mode=hours')).workers.find(w => w.id === 'ibro').workerOwnVehicleKmRate);
  expect(zero).toBe(0);
  await page.evaluate(() => openAppSettings());
  await expect(page.locator('#appSettingsDialog h3')).toHaveText('Malica, arhiv in tehnične nastavitve');
  await expect(page.locator('#settingsWorkerOwnVehicleKmRate, #workerBillingRows')).toHaveCount(0);
  await page.locator('#saveAppSettings').click();
  await expect(page.locator('#appSettingsDialog')).toBeHidden();
});

test('invalid billing is rejected atomically; worker cannot change personal rates', async ({ browser }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  const boss = await a.newPage(), worker = await b.newPage();
  try {
    await login(boss); await login(worker, 'ibro');
    expect(await boss.evaluate(async () => {
      const before = (await api('/api/workers')).workers.find(w => w.id === 'ibro');
      const statuses = [];
      for (const invalid of [-1, 1001, '', null, true, 'NaN']) {
        try { await api('/api/workers/ibro', { method: 'PUT', body: JSON.stringify({ ...before, name: 'MUST NOT SAVE', billing: { workerOwnVehicleKmRate: invalid } }) }); statuses.push(200); }
        catch (error) { statuses.push(error.status); }
      }
      const after = (await api('/api/workers')).workers.find(w => w.id === 'ibro');
      return { statuses, unchanged: JSON.stringify(before) === JSON.stringify(after) };
    })).toEqual({ statuses: [400,400,400,400,400,400], unchanged: true });
    expect(await worker.evaluate(async () => {
      try { await api('/api/workers/billing', { method: 'PUT', body: JSON.stringify({ userId: 'ibro', hourlyRate: 99, workerOwnVehicleKmRate: 0.9 }) }); return 200; }
      catch (error) { return error.status; }
    })).toBe(403);
  } finally { await a.close(); await b.close(); }
});

test('billing selection has an empty unchecked box and a high contrast white check', async ({ page }, info) => {
  await login(page);
  await page.evaluate(async () => {
    const result = await api('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'Selection contrast QA', client: 'Contrast QA', status: 'execution', syncUser: 'bojan', assigneeIds: ['bojan'], date: '2026-10-01', start: '08:00', end: '09:00' }) });
    const todo = result.todos.find(t => t.title === 'Selection contrast QA');
    await loadAll(); setView('report'); openClientReport(todo.client, todo.clientId);
  });
  const input = page.locator('[data-client-bill-event-id]').first(), box = input.locator('..');
  await input.check();
  await expect(box).toHaveCSS('background-color', 'rgb(7, 90, 75)');
  await expect(box).toHaveCSS('color', 'rgb(255, 255, 255)');
  await expect(box.locator('.client-billing-select-icon')).toBeVisible();
  await page.screenshot({ path: info.outputPath('billing-selected.png') });
  await input.uncheck();
  await expect(box.locator('.client-billing-select-icon')).toBeHidden();
  await page.screenshot({ path: info.outputPath('billing-unselected.png') });
  await input.focus(); await input.press('Space'); await expect(input).toBeChecked();
});

test('whole month fits width AND height on phone/tablet/desktop and event still opens', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await page.evaluate(async () => {
    for (let i = 0; i < 12; i++) {
      await api('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'Month fit QA ' + i, client: 'QA client', assigneeIds: ['bojan'], status: 'open', date: '2026-10-15' }) });
    }
    await loadAll(); state.current = new Date(2026, 9, 1); state.calendarOpened = true;
  });
  await page.locator('#calendarViewBtn').click();
  await page.locator('#monthFitToggle').click();
  for (const size of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 900 }, { width: 844, height: 390 }]) {
    await page.setViewportSize(size);
    await expect.poll(async () => page.evaluate(() => {
      const box = $('monthGrid').getBoundingClientRect();
      return box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight;
    })).toBe(true);
    await expect(page.locator('#calendar .day')).toHaveCount(42);
    await expect(page.locator('#monthTitle')).toBeInViewport();
    await expect(page.locator('#monthFitToggle')).toBeInViewport();
    await page.screenshot({ path: info.outputPath('month-fit-' + size.width + '.png') });
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.day-todo').filter({ hasText: 'Month fit QA 0' }).click();
  await expect(page.locator('#todoDialog')).toBeVisible();
  await page.locator('#closeTodoDialog').click();
  await page.locator('#nextMonth').click();
  await expect(page.locator('#monthTitle')).toContainText('november');
  await expect(page.locator('#monthFitToggle')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#monthFitToggle').click();
  await expect(page.locator('#monthGrid')).toHaveCSS('transform', 'none');
});
