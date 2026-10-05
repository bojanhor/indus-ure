const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');
test.use({ serviceWorkers: 'block' });
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });
async function login(page) {
  await page.goto(app.baseUrl);
  await page.locator('#localTestPassword').fill(TEST_PASSWORD);
  await page.locator('#localTestLoginBtn').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
}

test('single-row confirmation ignores other checkboxes, preserves them, cancels safely and is undoable', async ({ page }, info) => {
  await login(page);
  const todos = await page.evaluate(async () => {
    const result = [];
    for (const title of ['Samo ta vpis QA', 'Drugi vpis QA', 'Neizbrani vpis QA']) {
      const data = await api('/api/todos', { method: 'POST', body: JSON.stringify({ title, client: 'Posamezen obračun QA', status: 'execution', date: `2032-06-${10 + result.length}`, start: '08:00', end: '09:00', syncUser: 'ibro', assigneeIds: ['ibro'] }) });
      const todo = data.todos.find(t => t.title === title);
      result.push({ ...todo, eventId: todoEventId(todo) });
    }
    await loadAll(); setView('report'); openClientReport(result[0].client, result[0].clientId);
    return result;
  });
  const checkbox = i => page.locator(`[data-client-bill-event-id="${todos[i].eventId}"]`);
  const one = page.locator(`[data-confirm-client-event-id="${todos[0].eventId}"]`);
  await checkbox(2).uncheck();
  await checkbox(0).uncheck();
  await one.click();
  await expect(page.locator('#appConfirmMessage')).toContainText('1 izbran vpis');
  await expect(page.locator('#appConfirmMessage')).toContainText(todos[0].title);
  await page.locator('#appConfirmCancel').click();
  await expect(checkbox(0)).not.toBeChecked();
  await expect(checkbox(1)).toBeChecked();
  const labels = page.locator('.report-worker-labels').first();
  await expect(labels.locator('input').first()).toHaveAttribute('data-client-billing-inline-field', 'reportWorkerName');
  for (const input of await labels.locator('input').all()) expect((await input.boundingBox()).width).toBeLessThanOrEqual(240);
  await page.screenshot({ path: info.outputPath('single-confirm-desktop.png') });
  let requests = [];
  await page.route('**/api/client-bills', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    requests.push(route.request().postDataJSON());
    await route.continue();
  });
  await one.click(); await page.locator('#appConfirmAccept').click();
  await expect(one).toHaveCount(0);
  expect(requests).toHaveLength(1);
  expect(requests[0].eventIds).toEqual([todos[0].eventId]);
  await expect(checkbox(1)).toBeChecked();
  await expect(checkbox(2)).not.toBeChecked();
  await page.evaluate(async () => {
    const journal = await api('/api/undo-journal');
    const action = journal.actions.find(item => item.canUndo);
    await api(`/api/undo-journal/${action.id}`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
    await loadAll(); renderReport();
  });
  await expect(one).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('single-confirm-mobile.png') });
});

test('contacts below date share one database, retain selected IDs and offer native phone/email links and share', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const seeded = await page.evaluate(async () => {
    const { client } = await api('/api/clients', { method: 'POST', body: JSON.stringify({ name: 'Kontakti QA', contacts: [{ name: 'Ana', phone: '041 123 456' }, { name: 'Bine', email: 'bine@example.si' }] }) });
    const data = await api('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'Kontaktno opravilo QA', client: client.name, clientId: client.clientId, status: 'open', date: '2032-06-11', assigneeIds: ['ibro'], clientContactIds: [client.contacts[0].id] }) });
    const todo = data.todos.find(t => t.title === 'Kontaktno opravilo QA');
    await loadAll(); await openTodoDialog(todo);
    window.sharedContactsQA = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: async payload => sharedContactsQA.push(payload) });
    return { client, todo };
  });
  const section = page.locator('#todoFormClientContactsField');
  expect(await section.evaluate(el => el.previousElementSibling.id)).toBe('todoFormDateTimeSection');
  await expect(page.locator('#todoFormClientContactPickerToggle')).toBeHidden();
  await section.locator('summary').click();
  const phone = section.locator('a[href="tel:041123456"]');
  const mail = section.locator('a[href^="mailto:"]');
  await expect(phone).toBeVisible(); await expect(mail).toBeVisible();
  expect(await mail.getAttribute('target')).toBe(null);
  await expect(section.locator('input').first()).toBeChecked();
  await section.getByRole('button', { name: 'Deli kontakt Bine', exact: true }).click();
  expect(await page.evaluate(() => sharedContactsQA[0].text)).toBe('Bine\nbine@example.si');
  await expect(section.locator('input').nth(1)).not.toBeChecked();
  await page.screenshot({ path: info.outputPath('contacts-mobile.png') });
  await page.locator('#todoFormClientContactPickerToggle').click();
  await expect(page.locator('#clientEditDialog')).toBeVisible();
  const rows = page.locator('#clientEditContacts .client-edit-contact-row');
  await expect(rows).toHaveCount(3);
  await rows.last().locator('.client-edit-contact-name').fill('Cene');
  await rows.last().locator('.client-edit-contact-email').fill('cene@example.si');
  await rows.nth(0).locator('.client-edit-contact-phone').fill('041 999 888');
  await page.locator('#saveClientEdit').click();
  await expect(page.locator('#clientEditDialog')).toBeHidden();
  await expect(section.locator('input')).toHaveCount(3);
  await expect(section.locator('input').first()).toBeChecked();
  await expect(section.locator('a[href="tel:041999888"]')).toBeVisible();
  await expect(section.locator('a[href^="mailto:"]').last()).toHaveText('cene@example.si');
  await section.locator('input').nth(2).check();
  await page.locator('#saveTodoDialog').click();
  await expect(page.locator('#todoDialog')).toBeHidden();
  const stored = await page.evaluate(id => api(`/api/todos/${id}`), seeded.todo.id);
  expect(stored.todo.clientContactIds).toContain(seeded.client.contacts[0].id);
  expect(stored.todo.clientContacts.some(c => c.email === 'cene@example.si')).toBe(true);
  await page.evaluate(() => setView('clients'));
  await page.locator('#clientsSearch').fill('cene@example.si');
  const clientRow = page.locator('#clientsSearchResults .client-row').filter({ hasText: 'Kontakti QA' });
  await expect(clientRow).toBeVisible();
  await clientRow.getByRole('button', { name: 'Deli kontakt Cene', exact: true }).click();
  expect(await page.evaluate(() => sharedContactsQA.at(-1).text)).toBe('Cene\ncene@example.si');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
