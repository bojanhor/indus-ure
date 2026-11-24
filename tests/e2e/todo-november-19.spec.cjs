const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');
test.use({serviceWorkers:'block'});
let app;
test.beforeEach(async ({page}) => {
  app = await startIsolatedTestApp();
  await page.goto(app.baseUrl);
  await page.locator('#localTestPassword').fill(TEST_PASSWORD);
  await page.locator('#localTestLoginBtn').click();
  await expect(page.locator('#app')).toBeVisible();
  await page.waitForLoadState('networkidle');
});
test.afterEach(async () => { await app?.stop(); });

test('search has independent client and worker icons; opening does not alter a confirmed record', async ({page},info) => {
  const before=await page.evaluate(async () => {
    const created=[];
    for (const [i,title] of ['Client only','Both','Worker only','Neither'].entries()) {
      const r=await api('/api/todos',{method:'POST',body:JSON.stringify({title:'Search QA '+title,client:'Search customer QA',
        status:'execution',date:`2026-01-0${i+2}`,start:'08:00',end:'09:00',assigneeIds:['ibro']})});
      created.push(r.todos.find(t=>t.title==='Search QA '+title));
    }
    await api('/api/client-bills',{method:'POST',body:JSON.stringify({clientId:created[0].clientId,eventIds:created.slice(0,2).map(t=>t.assignmentGroupId)})});
    await api('/api/payrolls',{method:'POST',body:JSON.stringify({workerId:'ibro',from:'2026-01-03',to:'2026-01-04'})});
    await loadAll();setWorkContext('admin');
    return {todo:(await api('/api/todos/'+created[1].id)).todo, bills:state.clientBills,payrolls:state.payrolls};
  });
  await page.locator('#clientSearch').fill('Search QA');
  await page.locator('[data-search-filter="completed"]').check();
  const result=title=>page.locator('.search-result-open').filter({hasText:'Search QA '+title});
  const worker='[aria-label="Obračun izvajalca potrjen"][role="img"]';
  const client='[aria-label="Obračun stranki potrjen"][role="img"]';
  for(const [title,w,c] of [['Client only',0,1],['Both',1,1],['Worker only',1,0],['Neither',0,0]]) {
    await expect(result(title).locator(worker)).toHaveCount(w);
    await expect(result(title).locator(client)).toHaveCount(c);
  }
  await page.screenshot({path:info.outputPath('search-settlements-desktop.png')});
  await page.setViewportSize({width:390,height:844});
  await expect(result('Both').locator(client)).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  await page.screenshot({path:info.outputPath('search-settlements-phone.png')});
  await result('Both').click();
  await expect(page.locator('#todoDialog')).toBeVisible();
  await expect(page.locator('#todoFormBillingKm')).toBeDisabled();
  await page.locator('#closeTodoDialog').click();
  const after=await page.evaluate(async id=>({todo:(await api('/api/todos/'+id)).todo,bills:(await api('/api/client-bills')).clientBills,payrolls:(await api('/api/payrolls')).payrolls}),before.todo.id);
  expect(after).toEqual(before);
  // Standalone time entry remains available even though planning-task shortcuts are gone.
  await page.evaluate(()=>setView('todos'));
  await page.locator('#writeHoursButton').click();
  await expect(page.locator('#todoFormStatus')).toHaveValue('execution');
  await expect(page.locator('#writeHoursFromTodo')).toBeHidden();
  await expect(page.locator('#todoFooterWriteHours')).toBeHidden();
});

test('PDF export opens options before making a request; cancellation is inert and downloads use current choices', async ({page},info) => {
  await page.evaluate(async () => {
    const r=await api('/api/todos',{method:'POST',body:JSON.stringify({title:'Montaža razsvetljave QA',client:'PDF november QA',
      status:'execution',date:'2026-01-02',start:'08:00',end:'11:00',assigneeIds:['ibro'],clientBillableMinutes:240,
      notes:'Preizkus ločenega prikaza časa in obračunskih ur.',material:'2 svetilki'})});
    const t=r.todos.find(t=>t.title==='Montaža razsvetljave QA');
    await loadAll();setWorkContext('admin');setView('report');openClientReport(t.client,t.clientId);
  });
  let requests=0;page.on('request',r=>{if(r.url().includes('/api/client-report/pdf-ticket'))requests++;});
  await page.locator('#exportReportPdf').click();
  await expect(page.locator('#reportExportSettingsDialog')).toBeVisible();
  expect(requests).toBe(0);
  expect(await page.locator('[data-report-option]').evaluateAll(xs=>xs.slice(0,3).map(x=>x.dataset.reportOption))).toEqual(['showWorkerName','showTimes','showHours']);
  await page.locator('#closeReportExportSettings').click();
  await expect(page.locator('#reportExportSettingsDialog')).toBeHidden();expect(requests).toBe(0);
  await page.locator('#exportReportPdf').click();
  await page.locator('[data-report-option="showTimes"]').check();
  await page.setViewportSize({width:390,height:844});
  await page.screenshot({path:info.outputPath('pdf-options-phone.png')});
  const first=page.waitForEvent('download');await page.locator('#confirmReportPdfExport').click();
  await (await first).saveAs(info.outputPath('report-all.pdf'));
  await expect(page.locator('#reportExportSettingsDialog')).toBeHidden();expect(requests).toBe(1);
  await page.locator('#exportReportPdf').click();
  for(const key of ['showWorkerName','showWorkerTitle','showHours']) await page.locator(`[data-report-option="${key}"]`).uncheck();
  const second=page.waitForEvent('download');await page.locator('#confirmReportPdfExport').click();
  await (await second).saveAs(info.outputPath('report-time-only.pdf'));
  await expect(page.locator('#reportExportSettingsDialog')).toBeHidden();expect(requests).toBe(2);
});
