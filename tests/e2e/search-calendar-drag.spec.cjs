const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');
let app;
test.beforeEach(async () => { app = await startIsolatedTestApp(); });
test.afterEach(async () => { await app?.stop(); });
test.use({ hasTouch: true, serviceWorkers: 'block', viewport: { width: 1280, height: 1000 } });

for (const pointer of ['mouse', 'touch']) test(`${pointer}: search result drops into month without changing time, duration or coworkers`, async ({ page, browserName }, info) => {
  test.skip(pointer === 'touch' && browserName !== 'chromium', 'Trusted touch dispatcher requires Chromium.');
  if (pointer === 'touch') await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(app.baseUrl);
  await page.locator('#localTestUser').selectOption('bojan');
  await page.locator('#localTestPassword').fill(TEST_PASSWORD);
  await page.locator('#localTestLoginBtn').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
  const items = await page.evaluate(async () => {
    const out = [];
    for (const [title, date, endDate, start, end] of [
      ['Search drag undated', '', '', '', ''],
      ['Search drag timed', '2026-10-02', '2026-10-02', '10:15', '12:30'],
      ['Search drag span', '2026-10-02', '2026-10-04', '', '']
    ]) {
      const result = await api('/api/todos', { method: 'POST', body: JSON.stringify({ title, status: 'open', date, endDate, start, end, assigneeIds: ['bojan', 'ibro'] }) });
      out.push(result.todos.find(t => t.title === title));
    }
    await loadAll(); state.current = new Date(2026, 9, 1); setView('calendar');
    return out;
  });
  const touch = pointer === 'touch' ? await page.context().newCDPSession(page) : null;
  try {
    for (const todo of items) {
      await page.locator('#clientSearch').fill(todo.title);
      const result = page.locator('#searchPanel .search-result-open').filter({ hasText: todo.title }).first();
      await expect(result).toHaveClass(/search-result-calendar-drag/);
      const target = page.locator('.day[data-date="2026-10-19"]');
      await target.evaluate(el => el.scrollIntoView({ block: 'end' }));
      const from = await result.boundingBox(), to = await target.boundingBox();
      const x = from.x + Math.min(40, from.width / 2), y = from.y + from.height / 2;
      const tx = to.x + to.width / 2, ty = to.y + to.height - 30;
      const request = page.waitForRequest(r => r.method() === 'PUT' && r.url().endsWith('/api/todos/' + todo.id));
      if (touch) {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await page.waitForTimeout(450);
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: tx, y: ty }] });
        await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.mouse.move(x, y); await page.mouse.down(); await page.waitForTimeout(450);
        await page.mouse.move(tx, ty, { steps: 8 }); await page.mouse.up();
      }
      expect((await request).postDataJSON()).not.toHaveProperty('assigneeIds');
      await expect.poll(() => page.evaluate(async id => (await api('/api/todos/' + id)).todo.date, todo.id)).toBe('2026-10-19');
      const saved = await page.evaluate(async id => (await api('/api/todos/' + id)).todo, todo.id);
      expect(saved.start).toBe(todo.start); expect(saved.end).toBe(todo.end);
      expect(saved.endDate).toBe(todo.title.endsWith('span') ? '2026-10-21' : '2026-10-19');
      expect(saved.assigneeIds.sort()).toEqual(['bojan', 'ibro']);
      await expect(page.locator('#todoDialog')).toBeHidden();
      await page.waitForTimeout(500);
    }
    await page.screenshot({ path: info.outputPath('search-calendar-drop.png') });
    const result = page.locator('#searchPanel .search-result-open').first();
    if (touch) await result.tap(); else await result.click();
    await expect(page.locator('#todoDialog')).toBeVisible();
    await expect(page.locator('#todoFormTask')).toHaveValue('Search drag span');
    await page.locator('#closeTodoDialog').click();
  } finally { await touch?.detach(); }
});
