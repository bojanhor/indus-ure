const { test, expect } = require('@playwright/test');
const { startIsolatedTestApp, TEST_PASSWORD } = require('./test-app.cjs');
test.use({ serviceWorkers: 'block' });
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp({ authMode: 'lan' }); });
test.afterAll(async () => { await app?.stop(); });
const lan = { 'X-Real-IP': '192.168.50.37' };

test('public launch goes directly to Google, preserves link, prevents retry loop and supports manual retry', async ({ page }) => {
  const oauth = [];
  const requests = [];
  page.on('request', req => { if (req.url().includes('/api/auth/google-url')) requests.push(req.url()); });
  await page.route('https://accounts.google.com/**', route => { oauth.push(route.request().url()); return route.fulfill({ body: '<h1>Isolated Google redirect destination</h1>', contentType: 'text/html' }); });
  await page.goto(app.baseUrl + '/?todo=qa-link');
  await expect(page.getByRole('heading', { name: 'Isolated Google redirect destination' })).toBeVisible();
  expect(oauth).toHaveLength(1);
  expect(new URL(requests[0]).searchParams.get('return_to')).toBe('/?todo=qa-link');
  expect(new URL(requests[0]).searchParams.get('automatic')).toBe('1');
  await page.goto(app.baseUrl);
  await expect(page.locator('#loginScreen')).toBeVisible();
  await expect(page.locator('#loginMessage')).toContainText('Samodejna prijava ni bila zaključena');
  await expect(page.locator('#localTestLoginPanel')).toBeHidden();
  expect(oauth).toHaveLength(1);
  await page.locator('#googleLoginBtn').click();
  await expect(page.getByRole('heading', { name: 'Isolated Google redirect destination' })).toBeVisible();
  expect(oauth).toHaveLength(2);
  expect(new URL(oauth[1]).searchParams.get('prompt')).toBe('select_account');
});

test('LAN shows both login choices, email/password works, boss configures separate passwords', async ({ browser }, info) => {
  const bossContext = await browser.newContext({ extraHTTPHeaders: lan });
  const workerContext = await browser.newContext({ extraHTTPHeaders: lan, viewport: { width: 390, height: 844 } });
  const boss = await bossContext.newPage(), worker = await workerContext.newPage();
  try {
    await bossContext.request.post(app.baseUrl + '/api/test-login', { data: { userId: 'bojan', password: TEST_PASSWORD } });
    await boss.goto(app.baseUrl);
    await expect(boss.locator('#app')).toBeVisible();
    await boss.locator('#toolsMenu > summary').click();
    await boss.getByRole('button', { name: 'Delavci', exact: true }).click();
    const card = boss.locator('[data-worker-id="ibro"]');
    await card.locator('[data-worker-lan-password]').fill('Ibro-QA-geslo-2026');
    await card.locator('[data-worker-lan-password-repeat]').fill('Ibro-QA-geslo-2026');
    await card.locator('[data-set-lan-password]').click();
    await expect(card).toContainText('Geslo je nastavljeno.');
    await expect(card.locator('[data-worker-lan-password]')).toHaveValue('');
    await worker.goto(app.baseUrl);
    await expect(worker.locator('#lanLoginEmail')).toBeVisible();
    await expect(worker.locator('#localTestUser')).toBeHidden();
    await expect(worker.locator('#googleLoginBtn')).toBeVisible();
    await worker.screenshot({ path: info.outputPath('lan-login-mobile.png'), fullPage: true });
    await worker.locator('#lanLoginEmail').fill('ibrahim.etemaj04@gmail.com');
    await worker.locator('#localTestPassword').fill('Ibro-QA-geslo-2026');
    await worker.locator('#localTestLoginBtn').click();
    await expect(worker.locator('#app')).toBeVisible();
    await expect(worker.locator('#userName')).toHaveText('Ibro');
    // Public logout must not immediately sign the same account in again.
    await bossContext.setExtraHTTPHeaders({});
    await boss.locator('#closeWorkers').click();
    await boss.locator('#toolsMenu > summary').click();
    await boss.locator('#logoutBtn').click();
    await expect(boss.locator('#loginMessage')).toContainText('Odjavljen si');
    await expect(boss.locator('#localTestLoginPanel')).toBeHidden();
  } finally { await bossContext.close(); await workerContext.close(); }
});

test('LAN Google button does not require filling the password form; expired callback does not loop', async ({ page }) => {
  await page.setExtraHTTPHeaders(lan);
  await page.route('https://accounts.google.com/**', route => route.fulfill({ body: '<h1>Google QA</h1>', contentType: 'text/html' }));
  await page.goto(app.baseUrl);
  await page.locator('#googleLoginBtn').click();
  await expect(page.getByRole('heading', { name: 'Google QA' })).toBeVisible();
  await page.setExtraHTTPHeaders({});
  await page.goto(app.baseUrl + '/?login=expired');
  await expect(page.locator('#loginScreen')).toBeVisible();
  await expect(page.locator('#loginMessage')).toContainText('Samodejna prijava');
});
