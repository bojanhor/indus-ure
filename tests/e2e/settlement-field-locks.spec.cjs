const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');
test.use({ serviceWorkers: 'block' });
let app;
test.beforeEach(async () => { app = await startIsolatedTestApp(); });
test.afterEach(async () => { await app?.stop(); });
async function login(page, user = 'bojan') {
  await page.goto(app.baseUrl);
  await page.locator('#localTestUser').selectOption(user);
  await page.locator('#localTestPassword').fill(TEST_PASSWORD);
  await page.locator('#localTestLoginBtn').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
}
async function setup(page, lock) {
  return page.evaluate(async lock => {
    await api('/api/todos', { method: 'POST', body: JSON.stringify({ title: 'Separate lock QA', client: 'QA customer',
      status: 'execution', date: '2026-01-02', start: '08:00', end: '09:00', assigneeIds: ['ibro'],
      billingKm: 20, billingHourlyRate: 15, clientKm: 28, notes: 'Client description' }) });
    await loadAll(); setWorkContext('admin');
    const todo = state.todos.find(t => t.title === 'Separate lock QA');
    if (lock === 'client') await api('/api/client-bills', { method: 'POST', body: JSON.stringify({ clientId: todo.clientId, eventIds: [todo.assignmentGroupId] }) });
    else await api('/api/payrolls', { method: 'POST', body: JSON.stringify({ workerId: 'ibro', from: todo.date, to: todo.date }) });
    await loadAll();
    return { todo: (await api('/api/todos/' + todo.id)).todo, bills: (await api('/api/client-bills')).clientBills,
      payrolls: (await api('/api/payrolls')).payrolls };
  }, lock);
}
async function read(page, id) {
  return page.evaluate(async id => ({ todo: (await api('/api/todos/' + id)).todo,
    bills: (await api('/api/client-bills')).clientBills, payrolls: (await api('/api/payrolls')).payrolls }), id);
}
async function attempt(page, path, method, body) {
  return page.evaluate(async ({ path, method, body }) => {
    try { await api(path, { method, body: JSON.stringify(body) }); return 200; } catch (e) { return e.status; }
  }, { path, method, body });
}
test('client settled: form edits worker only, Undo restores, confirmed snapshot unchanged', async ({page}, info) => {
  await login(page); const before = await setup(page, 'client'), id = before.todo.id;
  await page.goto(app.baseUrl + '/?todo=' + id);
  await expect(page.locator('#todoFormBillingKm')).toBeEnabled();
  for (const field of ['todoFormStart','todoFormClientKm','todoFormTask','todoFormMaterial'])
    await expect(page.locator('#'+field)).toBeDisabled();
  await page.locator('#todoFormBillingKm').fill('0');
  await page.locator('#todoFormHourlyRate').fill('17.5');
  await page.locator('#saveTodoWithoutClosing').click();
  await expect.poll(async () => (await read(page,id)).todo.billingKm).toBe(0);
  await expect(page.locator('#todoFormBillingKm')).toBeEnabled();
  await page.setViewportSize({width:390,height:844});
  await page.locator('#todoFormBillingKm').scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('client-locked-worker-open.png')});
  await page.locator('#closeTodoDialog').click();
  const after = await read(page,id);
  expect(after.bills).toEqual(before.bills); expect(after.payrolls).toEqual(before.payrolls);
  expect(after.todo).toMatchObject({billingKm:0,billingHourlyRate:17.5,clientKm:28});
  expect(after.todo.settlement.pending).not.toBe(true);
  expect(await attempt(page,'/api/todos/'+id+'/settlement-fields','POST',{baseUpdatedAt:after.todo.updatedAt,changes:{billingKm:1,clientKm:1}})).toBe(403);
  expect((await read(page,id)).todo.billingKm).toBe(0);
  await page.evaluate(async () => { const j=await api('/api/undo-journal'); await api('/api/undo-journal/'+j.actions.find(a=>a.canUndo).id,{method:'POST',body:JSON.stringify({confirm:true})}); });
  expect((await read(page,id)).todo.billingKm).toBe(20);
  expect((await read(page,id)).bills).toEqual(before.bills);
});
test('worker settled: form edits client only, shared write routes reject and payroll unchanged', async ({page}, info) => {
  await login(page); const before=await setup(page,'worker'),id=before.todo.id;
  await page.goto(app.baseUrl+'/?todo='+id);
  await expect(page.locator('#todoFormClientKm')).toBeEnabled();
  for(const field of ['todoFormBillingKm','todoFormHourlyRate','todoFormWorkFromHome','todoFormStart','todoFormTask'])
    await expect(page.locator('#'+field)).toBeDisabled();
  await page.locator('#todoFormClientKm').fill('36');
  await page.locator('#todoFormClientBillableHours').fill('2');
  await page.locator('#saveTodoDialog').click(); await expect(page.locator('#todoDialog')).toBeHidden();
  const after=await read(page,id);
  expect(after.payrolls).toEqual(before.payrolls); expect(after.bills).toEqual(before.bills);
  expect(after.todo).toMatchObject({billingKm:20,clientKm:36,clientBillableMinutes:120});
  const base={baseUpdatedAt:after.todo.updatedAt};
  expect(await attempt(page,'/api/todos/'+id,'PUT',{...after.todo,billingKm:1})).toBe(403);
  expect(await attempt(page,'/api/todos/'+id,'DELETE',base)).toBe(403);
  expect(await attempt(page,'/api/todos/'+id+'/client-billing-fields','POST',{...base,title:'changed'})).toBe(403);
  expect(await attempt(page,'/api/todos/'+id+'/settlement-fields','POST',{...base,changes:{billingKm:1}})).toBe(403);
  expect(await attempt(page,'/api/todos/time-batch','POST',{items:[{id,...base,start:'09:00',end:'10:00'}]})).toBe(403);
  await page.goto(app.baseUrl+'/?todo='+id);
  await expect(page.locator('#todoFormClientKm')).toBeEnabled();
  await page.setViewportSize({width:390,height:844}); await page.locator('#todoFormClientKm').scrollIntoViewIfNeeded();
  await page.screenshot({path:info.outputPath('worker-locked-client-open.png')});
  await page.locator('#closeTodoDialog').click();
  expect((await read(page,id)).payrolls).toEqual(before.payrolls);
});
test('concurrent confirmation blocks stale form; both locks, nonboss and invalid values fail safely', async ({page,browser}) => {
  await login(page); const before=await setup(page,'client'),id=before.todo.id;
  const path='/api/todos/'+id+'/settlement-fields';
  expect(await attempt(page,path,'POST',{baseUpdatedAt:before.todo.updatedAt,changes:{billingKm:-1}})).toBe(400);
  expect(await attempt(page,path,'POST',{baseUpdatedAt:'stale',changes:{billingKm:1}})).toBe(409);
  const ctx=await browser.newContext(); const worker=await ctx.newPage();
  try { await login(worker,'ibro'); expect(await attempt(worker,path,'POST',{baseUpdatedAt:before.todo.updatedAt,changes:{billingKm:1}})).toBe(403); }
  finally {await ctx.close();}
  await page.goto(app.baseUrl+'/?todo='+id); await expect(page.locator('#todoFormBillingKm')).toBeEnabled();
  await page.evaluate(async () => { await api('/api/payrolls',{method:'POST',body:JSON.stringify({workerId:'ibro',from:'2026-01-02',to:'2026-01-02'})}); });
  const locked=await read(page,id);
  expect(await attempt(page,path,'POST',{baseUpdatedAt:before.todo.updatedAt,changes:{billingKm:999}})).toBe(403);
  expect((await read(page,id)).todo.billingKm).toBe(20);
  await page.locator('#closeTodoDialog').click();
  await page.goto(app.baseUrl+'/?todo='+id);
  await expect(page.locator('#todoFormBillingKm')).toBeDisabled();
  await expect(page.locator('#todoFormClientKm')).toBeDisabled();
  await expect(page.locator('#saveTodoDialog')).toBeDisabled();
  await expect(page.locator('#closeTodoDialog')).toBeEnabled();
  expect((await read(page,id)).payrolls).toEqual(locked.payrolls);
  expect((await read(page,id)).bills).toEqual(before.bills);
});
