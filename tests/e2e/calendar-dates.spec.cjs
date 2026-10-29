const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');

test.use({ serviceWorkers: 'block' });
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });
async function openMonth(page, date) {
  await page.evaluate(date => { state.current = parseDate(date); setView('calendar'); render(); }, date);
}
test.beforeEach(async ({ page, context }) => {
  expect((await context.request.post(app.baseUrl + '/api/test-login', { data: { userId: 'bojan', password: TEST_PASSWORD } })).ok()).toBeTruthy();
  await page.goto(app.baseUrl);
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
});

test('monthly calendar labels statutory holidays and six ISO weeks, including adjoining years', async ({ page }, info) => {
  await openMonth(page, '2026-10-01');
  await expect(page.locator('#calendar > .day')).toHaveCount(42);
  await expect(page.locator('#calendar > .calendar-week-number')).toHaveText(['40', '41', '42', '43', '44', '45']);
  const holiday = page.locator('.day[data-date="2026-10-31"] .day-number');
  await expect(holiday).toHaveCSS('color', 'rgb(179, 38, 30)');
  await expect(holiday).toHaveAttribute('title', 'Dan reformacije — dela prost dan');
  await expect(page.locator('.day[data-date="2026-11-01"] .day-number')).toHaveCSS('color', 'rgb(179, 38, 30)');
  await expect(page.locator('.day[data-date="2026-10-25"]')).not.toHaveClass(/is-work-free-holiday/);
  await page.screenshot({ path: info.outputPath('month-holidays-and-weeks-desktop.png') });
  await openMonth(page, '2027-01-01');
  await expect(page.locator('.calendar-week-number').first()).toHaveAttribute('data-week', '2026-W53');
  await expect(page.locator('.calendar-week-number').nth(1)).toHaveAttribute('data-week', '2027-W01');
  await openMonth(page, '2026-04-01');
  for (const date of ['2026-04-05', '2026-04-06', '2026-04-27']) {
    await expect(page.locator(`.day[data-date="${date}"] .day-number`)).toHaveCSS('color', 'rgb(179, 38, 30)');
  }
  await openMonth(page, '2026-05-01');
  await expect(page.locator('.day[data-date="2026-05-24"] .day-number')).toHaveAttribute('title', 'Binkoštna nedelja — dela prost dan');
  // The extra week column must not take a day out of the normal click targets.
  await page.locator('.day[data-date="2026-05-24"] .day-head').click();
  await expect(page.locator('#dayTimelineDialog')).toBeVisible();
  await expect(page.locator('#dayTimelineTitle')).toContainText('24. maj');
});

test('week gutter aligns with all seven days at phone/tablet/desktop sizes and in whole-month fit', async ({ page }, info) => {
  await openMonth(page, '2026-10-01');
  for (const size of [{ width: 390, height: 844 }, { width: 900, height: 700 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    const normal = await page.evaluate(() => {
      const headers = [...document.querySelectorAll('.weekdays > div')].map(el => el.getBoundingClientRect());
      const cells = [...document.querySelector('#calendar').children];
      return cells.every((el, i) => {
        const box = el.getBoundingClientRect(), header = headers[i % 8];
        const row = cells[Math.floor(i / 8) * 8].getBoundingClientRect();
        return Math.abs(box.left - header.left) < 1 && Math.abs(box.width - header.width) < 1
          && Math.abs(box.top - row.top) < 1 && Math.abs(box.bottom - row.bottom) < 1;
      });
    });
    expect(normal, `aligned week/date columns at ${size.width}px`).toBe(true);
    await page.locator('#monthFitToggle').click();
    await expect.poll(() => page.locator('#monthGrid').evaluate(el => {
      const box = el.getBoundingClientRect();
      return box.left >= -1 && box.right <= innerWidth + 1 && box.top >= -1 && box.bottom <= innerHeight + 1;
    })).toBe(true);
    await page.screenshot({ path: info.outputPath(`month-weeks-fit-${size.width}.png`) });
    await page.locator('#monthFitToggle').click();
  }
});
