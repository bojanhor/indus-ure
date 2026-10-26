const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');
test.use({ serviceWorkers: 'block', hasTouch: true });
let app;
test.beforeEach(async () => { app = await startIsolatedTestApp(); });
test.afterEach(async () => { await app?.stop(); });

for (const pointer of ['mouse', 'touch']) test(`${pointer}: no ordering dragpads, saved order and shorter spans retained, cards still open`, async ({ page, browserName }, info) => {
  test.skip(pointer === 'touch' && browserName !== 'chromium', 'Trusted touch dispatcher requires Chromium.');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(app.baseUrl);
  await page.locator('#localTestUser').selectOption('bojan');
  await page.locator('#localTestPassword').fill(TEST_PASSWORD);
  await page.locator('#localTestLoginBtn').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
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
  await page.locator('#calendarViewBtn').click();
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
