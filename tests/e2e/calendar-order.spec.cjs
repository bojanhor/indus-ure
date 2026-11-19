const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');
test.use({ serviceWorkers: 'block', hasTouch: true });
let app;
test.beforeEach(async () => { app = await startIsolatedTestApp(); });
test.afterEach(async () => { await app?.stop(); });

test('multi-day bars repeat profiles and title every Monday, including the last day and clipped months', async ({ page }, info) => {
  await page.goto(app.baseUrl);
  await page.locator('#localTestUser').selectOption('bojan');
  await page.locator('#localTestPassword').fill(TEST_PASSWORD);
  await page.locator('#localTestLoginBtn').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.evaluate(async () => {
    for (const [title, date, endDate, assigneeIds] of [
      ['QA Saturday to Monday', '2026-11-21', '2026-11-23', ['ibro']],
      ['QA Sunday to Tuesday', '2026-11-22', '2026-11-24', ['bojan', 'ibro']],
      ['QA Previous month', '2026-10-29', '2026-11-23', ['bojan', 'ibro']]
    ]) await api('/api/todos', { method: 'POST', body: JSON.stringify({ title, status: 'open', date, endDate, assigneeIds }) });
    await loadAll(); setWorkContext('admin'); setView('calendar');
    state.calendarWorkerIds = null; state.current = parseDate('2026-11-23'); renderMonth();
  });
  for (const context of ['admin', 'worker:ibro']) {
    await page.evaluate(context => setWorkContext(context), context);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const segment = (date, title) => page.locator(`.day[data-date="${date}"] .day-multiday-event`).and(page.getByRole('button', { name: new RegExp(title) }));
      for (const [title, dates, names] of [
        ['QA Saturday to Monday', ['2026-11-21', '2026-11-23'], ['Ibro']],
        ['QA Sunday to Tuesday', ['2026-11-22', '2026-11-23'], ['Bojan', 'Ibro']],
        ['QA Previous month', ['2026-10-29', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23'], ['Bojan', 'Ibro']]
      ]) for (const date of dates) {
        const bar = segment(date, title);
        await expect(bar.locator('.day-multiday-event-title')).toHaveText(title);
        await expect(bar.locator('.day-todo-worker-name')).toHaveText(names);
        await expect(bar.locator('.avatar')).toHaveCount(names.length);
      }
      await expect(segment('2026-11-22', 'QA Saturday to Monday')).toBeEmpty();
      await expect(segment('2026-11-24', 'QA Sunday to Tuesday')).toBeEmpty();
      const monday = segment('2026-11-23', 'QA Saturday to Monday');
      await expect(monday).toHaveClass(/is-span-end/);
      await monday.scrollIntoViewIfNeeded();
      await expect(monday).toBeVisible();
      await page.screenshot({ path: info.outputPath(`monday-${context.replace(':', '-')}-${width}.png`) });
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.evaluate(() => setWorkContext('admin'));
  const before = await page.evaluate(() => state.todos.filter(t => t.title.startsWith('QA ')).map(t => ({ id: t.id, date: t.date, endDate: t.endDate })));
  await page.locator('.day[data-date="2026-11-23"] .day-multiday-event-title').filter({ hasText: 'QA Saturday to Monday' }).click();
  await expect(page.locator('#todoFormTask')).toHaveValue('QA Saturday to Monday');
  await page.locator('#closeTodoDialog').click();
  await expect(page.locator('#todoDialog')).toBeHidden();
  const after = await page.evaluate(() => state.todos.filter(t => t.title.startsWith('QA ')).map(t => ({ id: t.id, date: t.date, endDate: t.endDate })));
  expect(after).toEqual(before);
});

for (const pointer of ['mouse', 'touch']) test(`${pointer}: no ordering dragpads, saved order and shorter spans retained, cards still open`, async ({ page, browserName }, info) => {
  test.skip(pointer === 'touch' && browserName !== 'chromium', 'Trusted touch dispatcher requires Chromium.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.baseUrl);
  await page.locator('#localTestUser').selectOption('bojan');
  await page.locator('#localTestPassword').fill(TEST_PASSWORD);
  await page.locator('#localTestLoginBtn').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.locator('#calendarViewBtn').click(); // First open selects the actual current month.
  const date = '2026-10-20';
  await page.evaluate(async date => {
    for (const [title, endDate] of [['QA A', date], ['QA B', date], ['QA Short', '2026-10-21'], ['QA Long', '2026-10-24']]) {
      await api('/api/todos', { method: 'POST', body: JSON.stringify({ title, status: 'open', date, endDate, assigneeIds: ['bojan', 'ibro'] }) });
    }
    const todos = (await api('/api/todos')).todos;
    await api('/api/todos/calendar-order', { method: 'POST', body: JSON.stringify({ sourceId: todos.find(t => t.title === 'QA B').id, targetId: todos.find(t => t.title === 'QA A').id, placement: 'before' }) });
    applyBootstrapSnapshot(await api('/api/bootstrap'));
    state.current = parseDate(date); state.view = 'calendar'; render();
  }, date);
  const day = page.locator(`.day[data-date="${date}"]`);
  await expect(page.locator('.calendar-order-handle')).toHaveCount(0);
  await expect(day.locator('.day-single-untimed .day-todo').first()).toContainText('QA B');
  await expect(day.locator('.day-multiday-event').nth(0)).toContainText('QA Short');
  await expect(day.locator('.day-multiday-event').nth(1)).toContainText('QA Long');
  await page.screenshot({ path: info.outputPath('month-without-dragpads.png') });
  await page.evaluate(date => openDayTimeline(date), date);
  const cards = page.locator('.day-all-day-item');
  await expect(cards).toHaveCount(4);
  await expect(cards.first()).toContainText('QA B');
  await expect(page.locator('.calendar-order-handle')).toHaveCount(0);
  if (pointer === 'touch') await cards.first().tap(); else await cards.first().click();
  await expect(page.locator('#todoDialog')).toBeVisible();
  await expect(page.locator('#todoFormTask')).toHaveValue('QA B');
  await expect(page.locator('#todoCreationAbsence')).toBeHidden();
  await page.locator('#closeTodoDialog').click();
  await expect(page.locator('#dayTimelineDialog')).toBeVisible();
  await expect(page.locator('#saveDayTimeline')).toBeEnabled();
  await page.screenshot({ path: info.outputPath('day-without-dragpads.png') });
  await page.locator('#saveDayTimeline').click();
  await expect(page.locator('#dayTimelineDialog')).toBeHidden();
});
