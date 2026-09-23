const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');
// Request assertions use page routes; a controlling SW otherwise owns fetches.
test.use({ serviceWorkers: 'block' });
let app;
test.beforeAll(async () => { app = await startIsolatedTestApp(); });
test.afterAll(async () => { await app?.stop(); });
async function login(page) {
  await page.goto(app.baseUrl);
  await page.locator('#localTestPassword').fill(TEST_PASSWORD);
  const hydrated = page.waitForResponse(r => new URL(r.url()).pathname === '/api/bootstrap' && !new URL(r.url()).search);
  await page.locator('#localTestLoginBtn').click();
  await expect(page.locator('#app')).toBeVisible(); await hydrated; await page.waitForLoadState('networkidle');
}
test('bulk client picker uses touch/keyboard suggestions and selected IDs; inline material saves with Undo', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  const seeded = await page.evaluate(async () => {
    const create = async (title, client, start, end) => {
      const data = await api('/api/todos', { method: 'POST', body: JSON.stringify({ title, client, status: 'execution', date: '2032-06-03', start, end, syncUser: 'ibro', assigneeIds: ['ibro'] }) });
      return data.todos.find(t => t.title === title);
    };
    const a = await create('Material QA selected', 'Source QA', '08:00', '09:00');
    const b = await create('Material QA unselected', 'Source QA', '09:00', '10:00');
    const target = await create('Material QA target', 'Target QA', '10:00', '11:00');
    await loadAll(); setView('report'); openClientReport(a.client, a.clientId);
    return { a, b, target };
  });
  const material = page.locator(`[data-todo-id="${seeded.a.id}"][data-client-billing-inline-field="material"]`);
  await material.fill('2x kabel; telefon 041 123 456');
  await expect(material.locator('+ .field-contact-links a')).toHaveAttribute('href', 'tel:041123456');
  const response = page.waitForResponse(r => r.url().endsWith(`/api/todos/${seeded.a.id}/client-billing-fields`) && r.request().method() === 'POST');
  await material.press('Tab'); expect((await response).status()).toBe(200);
  await expect(material).toHaveValue('2x kabel; telefon 041 123 456');
  const stored = await page.evaluate(id => api(`/api/todos/${id}`), seeded.a.id);
  expect(stored.todo.material).toBe('2x kabel; telefon 041 123 456');
  expect(stored.todo.start).toBe('08:00'); expect(stored.todo.end).toBe('09:00');
  await page.evaluate(async () => {
    const journal = await api('/api/undo-journal');
    const action = journal.actions.find(item => item.canUndo);
    await api(`/api/undo-journal/${action.id}`, { method: 'POST', body: JSON.stringify({ confirm: true }) });
    await loadAll(); renderReport();
  });
  await expect(material).toHaveValue('');
  const selected = page.locator('[data-client-bill-event-id]');
  await selected.nth(1).uncheck();
  const before = await selected.evaluateAll(inputs => inputs.map(input => input.checked));
  await page.locator('#bulkClientTarget').fill('Target');
  await expect(page.locator('#bulkClientSuggestions')).toBeVisible();
  await page.screenshot({ path: info.outputPath('bulk-client-picker-mobile.png') });
  const option = page.locator('#bulkClientSuggestions [data-bulk-client-index]').first();
  await option.dispatchEvent('mousedown');
  await expect(page.locator('#bulkClientSuggestions')).toBeVisible();
  await option.click();
  await expect(page.locator('#bulkClientTarget')).toHaveValue('Target QA');
  expect(await selected.evaluateAll(inputs => inputs.map(input => input.checked))).toEqual(before);
  expect(await page.locator('#bulkClientTarget').getAttribute('data-selected-client-id')).toBe(seeded.target.clientId);
  await page.locator('#bulkClientTarget').fill('Source'); await page.locator('#bulkClientTarget').press('Enter');
  await expect(page.locator('#bulkClientSuggestions')).toBeHidden();
  await page.locator('#bulkClientTarget').fill('New adhoc QA');
  await expect(page.locator('#bulkClientSuggestions')).toContainText('adhoc');
  expect(await page.locator('#bulkClientTarget').getAttribute('data-selected-client-id')).toBe('');
  await page.locator('#bulkClientTarget').press('Escape');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('billing-material-mobile.png') });
});

test('PDF options persist per user context and are sent unchanged to PDF/Gmail; contact actions stay native', async ({ page }, info) => {
  await login(page);
  const client = await page.evaluate(async () => {
    const data = await api('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'PDF settings QA', client: 'PDF settings client QA', status: 'execution', date: '2032-06-05', start: '08:00', end: '09:00', syncUser: 'bojan', assigneeIds: ['bojan'] }) });
    const todo = data.todos.find(t => t.title === 'PDF settings QA');
    await api('/api/clients', { method: 'POST', body: JSON.stringify({ clientId: todo.clientId, name: todo.client, email: 'qa@example.invalid' }) });
    await loadAll(); setView('report'); openClientReport(todo.client, todo.clientId);
    return { name: todo.client, id: todo.clientId };
  });
  await page.locator('#reportExportSettings').click();
  const options = page.locator('#reportExportSettingsDialog [data-report-option]');
  await expect(options).toHaveCount(4);
  for (const input of await options.all()) await expect(input).toBeChecked();
  await page.locator('[data-report-option="showWorkerName"]').uncheck();
  await page.locator('[data-report-option="showDates"]').uncheck();
  await page.screenshot({ path: info.outputPath('pdf-settings.png') });
  await page.locator('#closeReportExportSettings').click();
  // Closing a modal traverses its same-document history entry asynchronously.
  // Network-idle does not wait for that traversal; don't race it with reload.
  await page.waitForFunction(() => !modalHistoryTokens.has($('reportExportSettingsDialog')) && !modalHistoryIgnoreNextPopstate);
  await page.reload(); await expect(page.locator('#app')).toBeVisible();
  await page.getByRole('button', { name: 'Obračun strank', exact: true }).click(); await page.locator('#reportExportSettings').click();
  await expect(page.locator('[data-report-option="showWorkerName"]')).not.toBeChecked();
  await expect(page.locator('[data-report-option="showDates"]')).not.toBeChecked();
  await expect(page.locator('[data-report-option="showHours"]')).toBeChecked();
  await page.locator('#closeReportExportSettings').click();
  await page.evaluate(client => openClientReport(client.name, client.id), client);
  for (const [endpoint, button] of [['pdf-ticket', 'exportReportPdf'], ['gmail-draft', 'createReportGmailDraft']]) {
    let payload;
    await page.route(`**/api/client-report/${endpoint}`, route => {
      payload = route.request().postDataJSON();
      return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'QA: prestrežen izvoz, brez pošiljanja' }) });
    });
    await page.locator(`#${button}`).click();
    await expect.poll(() => payload?.exportOptions).toEqual({ hoursMode: 'client_billable', showWorkerTitle: true, showWorkerName: false, showHours: true, showDates: false });
    await page.locator('#closeAppNotice').click();
  }
  await page.evaluate(() => { setWorkContext('worker:ibro'); });
  // The same controls deliberately have independent preferences in another context.
  await page.evaluate(() => $('reportExportSettings').click());
  await expect(page.locator('[data-report-option="showWorkerName"]')).toBeChecked();
  await page.locator('#closeReportExportSettings').click();
  await page.evaluate(() => { setWorkContext('admin'); setView('todos'); });
  await page.locator('#newTodoButton').click();
  await page.getByLabel('Ime opravila', { exact: true }).fill('Telefon 041 123 456');
  await page.locator('#todoFormNotes').fill('Kontakt servis@example.si; https://example.si/servis');
  await expect(page.locator('#todoFormTaskField + .field-contact-links a')).toHaveAttribute('href', 'tel:041123456');
  const email = page.locator('label:has(#todoFormNotes) + .field-contact-links a').first();
  await expect(email).toHaveAttribute('href', 'mailto:servis@example.si');
  await expect(email).not.toHaveAttribute('target');
  await expect(page.locator('label:has(#todoFormNotes) + .field-contact-links a').last()).toHaveAttribute('rel', 'noopener noreferrer');
  await page.locator('#todoFormNotes').fill('Brez kontaktov');
  await expect(page.locator('label:has(#todoFormNotes) + .field-contact-links')).toHaveCount(0);
});
