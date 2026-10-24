const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');
test.use({ serviceWorkers: 'block', hasTouch: true });
let app;
test.beforeEach(async () => { app = await startIsolatedTestApp(); });
test.afterEach(async () => { await app?.stop(); });
for (const pointer of ['mouse', 'touch']) test(`${pointer}: untimed month/day ordering, shared persistence, shorter spans first and empty checkmark closes`, async ({ page, browserName }, info) => {
  test.skip(pointer === 'touch' && browserName !== 'chromium', 'Trusted touch dispatcher requires Chromium.');
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
    applyBootstrapSnapshot(await api('/api/bootstrap'));
    state.current = parseDate(date); state.view = 'calendar'; render();
  }, date);
  await page.locator('#calendarViewBtn').click();
  const day = page.locator(`.day[data-date="${date}"]`);
  const singles = day.locator('.day-single-untimed .day-todo');
  await expect(singles).toHaveCount(2);
  const secondId = await singles.nth(1).getAttribute('data-calendar-order-id');
  await singles.nth(1).locator('.calendar-order-handle').focus();
  await singles.nth(1).locator('.calendar-order-handle').press('ArrowUp');
  await expect(singles.first()).toHaveAttribute('data-calendar-order-id', secondId);
  const boxes = await day.evaluate(el => ({ one: el.querySelector('.day-single-untimed').getBoundingClientRect().bottom, multi: el.querySelector('.day-multiday-lanes').getBoundingClientRect().top, titles: [...el.querySelectorAll('.day-multiday-event')].map(e => e.textContent) }));
  expect(boxes.multi).toBeGreaterThanOrEqual(boxes.one);
  expect(boxes.titles[0]).toContain('QA Short'); expect(boxes.titles[1]).toContain('QA Long');
  const laneY = await page.locator('.day[data-date="2026-10-21"] .day-multiday-lanes').evaluate(el => el.getBoundingClientRect().top);
  expect(Math.abs(laneY - boxes.multi)).toBeLessThan(2);
  if (pointer === 'touch') await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(date => openDayTimeline(date), date);
  const allDay = page.locator('.day-all-day-item');
  await expect(allDay).toHaveCount(4);
  await expect(allDay.nth(0)).toHaveAttribute('data-calendar-order-id', secondId);
  await expect(allDay.nth(2)).toContainText('QA Short');
  await expect(allDay.nth(3)).toContainText('QA Long');
  // Real held pointer gesture on the dedicated ordering handle.
  const handle = await allDay.nth(0).locator('.calendar-order-handle').boundingBox();
  const target = await allDay.nth(1).boundingBox();
  if (pointer === 'touch') {
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }] });
    await page.waitForTimeout(350);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: target.x + target.width / 2, y: target.y + target.height - 3 }] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.detach();
  } else {
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down(); await page.waitForTimeout(350);
    await page.mouse.move(target.x + target.width / 2, target.y + target.height - 3, { steps: 8 });
    await page.mouse.up();
  }
  await expect(allDay.nth(1)).toHaveAttribute('data-calendar-order-id', secondId);
  await expect(page.locator('#saveDayTimeline')).toBeEnabled();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath('calendar-order-day-mobile.png') });
  await page.locator('#saveDayTimeline').click();
  await expect(page.locator('#dayTimelineDialog')).not.toBeVisible();
  await page.screenshot({ path: info.outputPath('calendar-order-month-mobile.png') });
  await page.reload(); await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.evaluate(date => { state.current = parseDate(date); renderMonth(); openDayTimeline(date); }, date);
  await expect(page.locator('.day-all-day-item').nth(1)).toHaveAttribute('data-calendar-order-id', secondId);
  const shared = await page.evaluate(async () => (await api('/api/todos')).todos.filter(t => t.title === 'QA A').map(t => t.calendarOrder));
  expect(new Set(shared).size).toBe(1);
  const afterEdit = await page.evaluate(async id => {
    const current = (await api('/api/todos/' + id)).todo;
    await api('/api/todos/' + id, { method: 'PUT', body: JSON.stringify({ ...current, assigneeIds: ['bojan'] }) });
    const next = (await api('/api/todos/' + id)).todo;
    await api('/api/todos/' + id, { method: 'PUT', body: JSON.stringify({ ...next, assigneeIds: ['bojan', 'ibro'] }) });
    return { expected: current.calendarOrder, actual: (await api('/api/todos')).todos.filter(t => t.assignmentGroupId === current.assignmentGroupId).map(t => t.calendarOrder) };
  }, secondId);
  expect(afterEdit.actual).toEqual([afterEdit.expected, afterEdit.expected]);
});
