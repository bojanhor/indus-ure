const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');

test.use({ serviceWorkers: 'block' });
let app;
test.beforeEach(async () => { app = await startIsolatedTestApp(); });
test.afterEach(async () => { await app?.stop(); });

for (const width of [1280, 390]) {
  test(`creation tabs use the selected worker rate and preserve intentional overrides at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(app.baseUrl);
    await page.locator('#localTestUser').selectOption('bojan');
    await page.locator('#localTestPassword').fill(TEST_PASSWORD);
    await page.locator('#localTestLoginBtn').click();
    await expect(page.locator('#app')).toBeVisible();
    await page.waitForLoadState('networkidle');
    const workerId = await page.evaluate(async () => {
      const worker = (await api('/api/workers', { method: 'POST', body: JSON.stringify({ name: 'Štajerc QA' }) })).worker;
      for (const [userId, hourlyRate] of [['bojan', 25], [worker.id, 15]]) {
        await api('/api/workers/billing', { method: 'PUT', body: JSON.stringify({ userId, hourlyRate }) });
      }
      await refreshAfterWorkerManagement(); setWorkContext('admin'); setView('todos');
      return worker.id;
    });
    const rate = page.locator('#todoFormHourlyRate');
    const selectWorker = () => page.locator(`#todoFormAssignees input[value="${workerId}"]`).check();
    const switchMode = async mode => {
      await page.locator(`#todoCreationTabs [data-create-mode="${mode}"]`).click();
      await expect(page.locator(`#todoCreationTabs [data-create-mode="${mode}"]`)).toHaveAttribute('aria-selected', 'true');
    };
    await page.locator('#newTodoButton').click();
    await selectWorker();
    await page.locator('#todoFormTask').fill('QA selected worker default');
    await switchMode('hours');
    await expect(rate).toHaveValue('15');
    await expect(page.locator(`#todoFormAssignees input[value="${workerId}"]`)).toBeChecked();
    await page.screenshot({ path: info.outputPath('selected-worker-default.png') });

    // An explicit rate, including zero, survives a tab round trip and reload.
    for (const value of ['17.5', '0']) {
      await rate.fill(value);
      await switchMode('task');
      await switchMode('hours');
      await expect(rate).toHaveValue(value);
      await page.evaluate(() => persistTodoCreationDraft());
      await page.reload();
      await expect(page.locator('#todoDialog')).toBeVisible();
      await expect(rate).toHaveValue(value);
    }
    // Changing the worker while the rate is hidden must discard the old
    // worker's override, just as changing the worker in the hours form does.
    await switchMode('task');
    await page.locator(`#todoFormAssignees input[value="${workerId}"]`).uncheck();
    await page.locator('#todoFormAssignees input[value="bojan"]').check();
    await switchMode('hours');
    await expect(rate).toHaveValue('25');
    await selectWorker();
    await expect(rate).toHaveValue('15');
    await switchMode('task');
    await switchMode('hours');
    await expect(rate).toHaveValue('15');
    await page.locator('#todoFormClient').fill('QA stranka');
    await page.locator('#todoFormTask').click();
    await page.locator('#todoFormDate').fill('2026-10-30');
    await page.evaluate(() => {
      document.getElementById('todoFormStart').value = '07:30';
      document.getElementById('todoFormEnd').value = '08:30';
    });
    await page.locator('#todoFormBillingKm').fill('3');
    await page.locator('#todoFormClientKm').fill('3');
    await page.locator('#saveTodoDialog').click();
    await expect(page.locator('#todoDialog')).toBeHidden();
    expect(await page.evaluate(async id => {
      const todo = (await api('/api/todos')).todos.find(t => t.title === 'QA selected worker default');
      return { worker: todo.syncUser === id, rate: todo.billingHourlyRate };
    }, workerId)).toEqual({ worker: true, rate: 15 });

    // Previously persisted planning drafts contain a hidden numeric rate,
    // but no indication that it was only a default for the original worker.
    await page.evaluate(id => openTodoDialog({ _creationMode: 'task', _standaloneHours: true, _adminCreate: true,
      _draftAssigneeIds: [id], title: 'Legacy planning draft', billingHourlyRate: 25, _skipPersistedDraft: true }), workerId);
    await expect(rate).toHaveValue('15');
    await page.locator('#closeTodoDialog').click();
    await expect(page.locator('#todoDialog')).toBeHidden();
    await page.evaluate(id => openTodoDialog({ _standaloneHours: true, _adminCreate: true,
      _draftAssigneeIds: [id, 'bojan'], billingHourlyRate: null, _skipPersistedDraft: true }), workerId);
    expect(await page.evaluate(() => Number(document.getElementById('todoFormHourlyRate').value)))
      .toBe(await page.evaluate(() => workerDefaultHourlyRate(selectedTodoFormAssignees()[0])));
    await page.locator('#closeTodoDialog').click();
  });

  test(`boss keeps administration and edits an individual payroll entry at ${width}px`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(app.baseUrl);
    await page.locator('#localTestUser').selectOption('bojan');
    await page.locator('#localTestPassword').fill(TEST_PASSWORD);
    await page.locator('#localTestLoginBtn').click();
    await expect(page.locator('#app')).toBeVisible();
    await page.waitForLoadState('networkidle');
    const fixture = await page.evaluate(async () => {
      const worker = (await api('/api/workers', { method: 'POST', body: JSON.stringify({ name: 'Štajerc QA' }) })).worker;
      await api('/api/workers/billing', { method: 'PUT', body: JSON.stringify({ userId: worker.id, hourlyRate: 25 }) });
      await refreshAfterWorkerManagement();
      for (const userId of [worker.id, 'bojan']) {
        await api('/api/todos', { method: 'POST', body: JSON.stringify({ title: `Urna postavka QA ${userId}`, client: 'QA stranka', status: 'execution', date: '2026-10-30', start: '08:00', end: '09:00', syncUser: userId, assigneeIds: [userId], clientKm: 1, billingKm: 1 }) });
      }
      await loadAll(); setWorkContext('admin'); setView('billing');
      state.calendarWorkerIds = ['bojan'];
      localStorage.setItem(calendarWorkerFilterStorageKey(), JSON.stringify(state.calendarWorkerIds));
      state.billingWorkerId = worker.id;
      saveBillingRangeSelection(worker.id, { from: '2026-10-30', to: '2026-10-30' });
      renderBillingView();
      return { workerId: worker.id, todoId: state.todos.find(t => t.syncUser === worker.id).id };
    });
    await expect(page.locator('#billingDayList')).toContainText('25,00');
    await page.locator('.billing-open-day[data-date="2026-10-30"]').click();
    await expect(page.locator('#dayTimelineDialog')).toBeVisible();
    expect(await page.evaluate(() => ({ context: state.workContext, stored: localStorage.getItem(workContextKey) })))
      .toEqual({ context: 'admin', stored: 'admin' });
    await expect(page.locator('.day-timeline-event')).toHaveCount(1);
    await expect(page.locator('#dayTimelineWorkerFilter > summary')).toHaveText('Štajerc QA');
    await page.locator('#nextDayTimeline').click();
    await expect(page.locator('.day-timeline-event')).toHaveCount(0);
    await expect(page.locator('#dayTimelineWorkerFilter > summary')).toHaveText('Štajerc QA');
    await page.locator('#prevDayTimeline').click();
    await expect(page.locator('.day-timeline-event')).toHaveCount(1);
    await page.locator('#dayTimelineWorkerFilter > summary').click();
    await page.locator('#dayTimelineWorkerFilter [data-calendar-worker-id=""]').check();
    await expect(page.locator('.day-timeline-event')).toHaveCount(2);
    await page.locator('#dayTimelineWorkerFilter [data-calendar-worker-id=""]').uncheck();
    await expect(page.locator('.day-timeline-event')).toHaveCount(0);
    await page.locator(`#dayTimelineWorkerFilter [data-calendar-worker-id="${fixture.workerId}"]`).check();
    await page.locator('#dayTimelineWorkerFilter > summary').click();
    expect(await page.evaluate(() => state.calendarWorkerIds)).toEqual(['bojan']);
    for (const rate of ['30.75', '0']) {
      const event = page.locator(`.day-timeline-event[data-todo-id="${fixture.todoId}"]`);
      await event.scrollIntoViewIfNeeded();
      await event.click({ position: { x: 20, y: 20 } });
      const input = page.locator('#todoFormHourlyRate');
      await expect(input).toBeVisible();
      await expect(input).toBeEnabled();
      await input.fill(rate);
      await page.screenshot({ path: info.outputPath(`individual-rate-${rate}.png`) });
      await page.locator('#saveTodoDialog').click();
      await expect(page.locator('#todoDialog')).toBeHidden();
      await expect(page.locator('#dayTimelineDialog')).toBeVisible();
      await expect(page.locator('.day-timeline-event')).toHaveCount(1);
      await expect.poll(() => page.evaluate(async id => (await api('/api/todos')).todos.find(t => t.id === id).billingHourlyRate, fixture.todoId)).toBe(Number(rate));
      expect(await page.evaluate(() => state.workContext)).toBe('admin');
    }
    await page.locator('#closeDayTimeline').click();
    await expect(page.locator('#billingWorker')).toBeVisible();
    await expect(page.locator('#billingWorker')).toHaveValue(fixture.workerId);
    await expect(page.locator('#billingDayList')).toContainText('0,00');
    expect(await page.evaluate(() => state.calendarWorkerIds)).toEqual(['bojan']);
    expect(await page.evaluate(async id => (await api('/api/workers/billing')).workers.find(w => w.id === id).hourlyRate, fixture.workerId)).toBe(25);
    await page.reload();
    await expect(page.locator('#app')).toBeVisible();
    expect(await page.evaluate(() => state.workContext)).toBe('admin');
    await page.evaluate(() => openDayTimeline('2026-10-30'));
    await expect(page.locator('#dayTimelineWorkerFilter > summary')).toHaveText('Bojan');
    await expect(page.locator('.day-timeline-event')).toHaveCount(1);
    await expect(page.locator(`.day-timeline-event[data-todo-id="${fixture.todoId}"]`)).toHaveCount(0);
  });
}
