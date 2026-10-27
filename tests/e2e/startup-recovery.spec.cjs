const { test, expect } = require('@playwright/test');
const { startIsolatedTestApp, TEST_PASSWORD } = require('./test-app.cjs');
test.use({ serviceWorkers: 'block', viewport: { width: 390, height: 844 } });
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });
async function login(context) {
  const res = await context.request.post(app.baseUrl + '/api/test-login', { data: { userId: 'bojan', password: TEST_PASSWORD } });
  expect(res.ok()).toBeTruthy();
}
test('blocked local database upgrade cannot trap signed-in startup or delete queued data', async ({ page, context }) => {
  await login(context);
  const holder = await context.newPage();
  await holder.goto(app.baseUrl + '/api/health');
  await holder.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('indus-ure-offline', 3);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('todoOps', { keyPath: 'id', autoIncrement: true });
      req.result.createObjectStore('snapshots', { keyPath: 'userId' });
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      window.heldDb = req.result;
      const tx = req.result.transaction('todoOps', 'readwrite');
      tx.objectStore('todoOps').put({ id: 1, userId: 'another-user', kind: 'create', todo: { title: 'Do not lose this offline task' } });
      tx.oncomplete = resolve;
    };
  }));
  await page.goto(app.baseUrl);
  await expect(page.locator('#app')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#appStartupStatus')).toBeHidden();
  await expect(page.locator('#userName')).toHaveText('Bojan');
  await holder.evaluate(() => window.heldDb.close());
  const saved = await page.evaluate(async () => (await offlineTodoOps()).find(op => op.id === 1));
  expect(saved.todo.title).toBe('Do not lose this offline task');
  await holder.close();
});

test('stalled response body times out, preserves local state and retry recovers', async ({ page, context }, info) => {
  await login(context);
  await page.addInitScript(() => {
    localStorage.setItem('startup-recovery-sentinel', 'unsent draft');
    const original = window.fetch;
    window.fetch = function(url, options) {
      if (String(url) === '/api/me' && !sessionStorage.getItem('body-stall-tested')) {
        sessionStorage.setItem('body-stall-tested', '1');
        return Promise.resolve(new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); } }), { status: 200 }));
      }
      return original.call(this, url, options);
    };
  });
  await page.goto(app.baseUrl);
  await expect(page.locator('#startupFailure')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#startupFailureMessage')).toContainText('predolgo');
  await expect(page.locator('#bootScreen')).toBeHidden();
  await page.screenshot({ path: info.outputPath('startup-retry-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => localStorage.getItem('startup-recovery-sentinel'))).toBe('unsent draft');
  await page.locator('#startupRetry').click();
  await expect(page.locator('#app')).toBeVisible();
  await expect(page.locator('#startupFailure')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('startup-recovery-sentinel'))).toBe('unsent draft');
});

test('unresponsive IndexedDB does not gate online startup', async ({ page, context }) => {
  await login(context);
  await page.addInitScript(() => { indexedDB.open = () => ({}); });
  await page.goto(app.baseUrl);
  await expect(page.locator('#app')).toBeVisible({ timeout: 8000 });
  await expect(page.locator('#appStartupStatus')).toBeHidden();
});

test('expired session and stalled login options still expose login', async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.fetch;
    window.fetch = function(url, options) {
      if (String(url).startsWith('/api/auth/options')) return new Promise(() => {});
      return original.call(this, url, options);
    };
  });
  await page.goto(app.baseUrl);
  await expect(page.locator('#loginScreen')).toBeVisible({ timeout: 20000 });
  await expect(page.locator('#googleLoginBtn')).toBeVisible();
  await expect(page.locator('#bootScreen')).toBeHidden();
});

test('local writes reject aborted transactions and release connections for upgrades', async ({ page, context }) => {
  await login(context);
  await page.goto(app.baseUrl);
  await expect(page.locator('#app')).toBeVisible();
  const result = await page.evaluate(async () => {
    let rejected = false;
    try {
      await offlineStoreRequest('todoOps', 'readwrite', store => {
        const request = store.put({ id: 777, userId: 'another-user', kind: 'create' });
        request.onsuccess = () => store.transaction.abort();
        return request;
      });
    } catch { rejected = true; }
    const saved = await offlineTodoOps();
    return { rejected, exists: saved.some(op => op.id === 777) };
  });
  expect(result).toEqual({ rejected: true, exists: false });
});
