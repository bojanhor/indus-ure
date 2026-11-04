const { test, expect } = require('@playwright/test');
const { TEST_PASSWORD, startIsolatedTestApp } = require('./test-app.cjs');
test.use({serviceWorkers:'block'});
let app;
test.beforeEach(async()=>{app=await startIsolatedTestApp();});
test.afterEach(async()=>{await app?.stop();});
async function login(page,user='bojan'){
  await page.goto(app.baseUrl);
  await page.locator('#localTestUser').selectOption(user);
  await page.locator('#localTestPassword').fill(TEST_PASSWORD);
  await page.locator('#localTestLoginBtn').click();
  await expect(page.locator('#app')).toBeVisible(); await page.waitForLoadState('networkidle');
}

test('workers: global discard and atomic save including invalid second worker and stale snapshot',async({page})=>{
  await login(page); await page.evaluate(()=>openWorkersDialog());
  const a=page.locator('[data-worker-id="bojan"]'),b=page.locator('[data-worker-id="ibro"]');
  await expect(page.locator('.worker-management-card[open]')).toHaveCount(0);
  await a.locator('summary').click(); await b.locator('summary').click();
  const names=()=>page.evaluate(async()=>(await api('/api/workers')).workers.map(w=>w.name));
  const before=await names();
  await a.locator('[data-worker-name]').fill('QA Boss'); await b.locator('[data-worker-name]').fill('QA Worker');
  await page.locator('#cancelWorkers').click(); expect(await names()).toEqual(before);
  await page.evaluate(()=>openWorkersDialog()); await a.locator('summary').click(); await b.locator('summary').click();
  await a.locator('[data-worker-name]').fill('QA Boss'); await b.locator('[data-worker-name]').fill('');
  const fail=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/workers' && r.request().method()==='PUT');
  await page.locator('#saveAllWorkers').click(); expect((await fail).status()).toBe(400); expect(await names()).toEqual(before);
  await b.locator('[data-worker-name]').fill('QA Worker');
  await page.locator('#showInactiveWorkers').check(); await expect(a.locator('[data-worker-name]')).toHaveValue('QA Boss');
  const success=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/workers' && r.request().method()==='PUT');
  await page.locator('#saveAllWorkers').click(); expect((await success).status()).toBe(200);
  await expect.poll(names).toEqual(expect.arrayContaining(['QA Boss','QA Worker']));
  await expect(page.locator('#saveAllWorkers')).toBeEnabled();
  expect(await page.evaluate(async()=>(await api('/api/workers')).workers.find(w=>w.id==='ibro').timeEntryPermissionsConfigured)).toBe(false);
  const stale=await page.evaluate(async()=>{const w=(await api('/api/workers')).workers.find(x=>x.id==='ibro');
    await api('/api/workers/ibro',{method:'PUT',body:JSON.stringify({...w,name:'Concurrent'})});
    try{await api('/api/workers',{method:'PUT',body:JSON.stringify({workers:[{id:w.id,base:w,changes:{...w,name:'Stale'}}]})});return 200;}catch(e){return e.status;}
  }); expect(stale).toBe(409); expect(await names()).toContain('Concurrent');
});

test('undated manual view, resettable search and authenticated share link',async({page,browser})=>{
  await login(page);
  const fixture=await page.evaluate(async()=>{
    const ids=[]; for(const [title,date,assigneeIds] of [['Lookup no date','',['bojan','ibro']],['Lookup dated','2026-11-02',['bojan']]]){
      await api('/api/todos',{method:'POST',body:JSON.stringify({title,date,status:'open',assigneeIds})}); ids.push(title);
    } await loadAll(); setWorkContext('admin');setView('todos');return ids.map(title=>state.todos.find(t=>t.title===title).id);
  });
  await page.locator('#todoSortMode').selectOption('manual_undated');
  await expect(page.locator('#todoItems')).toContainText('Lookup no date'); await expect(page.locator('#todoItems')).not.toContainText('Lookup dated');
  await page.locator('#clientSearch').fill('Lookup'); await page.locator('[data-search-filter="undated"]').check();
  await expect(page.locator('#searchPanel .result')).toHaveCount(1);
  await page.locator('#clientSearch').fill('Look'); await expect(page.locator('[data-search-filter="undated"]')).not.toBeChecked();
  await page.locator('[data-search-filter="undated"]').check();
  await page.locator('[data-close-search]').click(); await page.locator('#clientSearch').fill('Lookup');
  await expect(page.locator('#searchPanel .result')).toHaveCount(2); await expect(page.locator('[data-search-filter="undated"]')).not.toBeChecked();
  await page.locator('#searchPanel .search-result-open').filter({hasText:'Lookup no date'}).click();
  await page.locator('#shareTodoPdf').click(); await expect(page.locator('#shareEventExport')).toBeVisible();
  const link=await page.locator('#shareEventLink').inputValue();
  expect(new URL(link).searchParams.has('completion')).toBe(false);
  await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async v=>{window.qaCopied=v;}}}));
  await page.locator('#shareEventCopy').click(); expect(await page.evaluate(()=>window.qaCopied)).toBe(link);
  await page.locator('#closeTodoDialog').click();
  const ctx=await browser.newContext();try{
    const worker=await ctx.newPage();await login(worker,'ibro');await worker.goto(link);await expect(worker.locator('#todoFormTask')).toHaveValue('Lookup no date');
    await expect(worker.locator('#todoFormAssignees input[value="bojan"]')).toBeChecked();
    await worker.locator('#closeTodoDialog').click();
    await worker.goto(app.baseUrl+'/?todo='+fixture[1]);await expect(worker.locator('#app')).toBeVisible();await expect(worker.getByText(/Opravilo ne obstaja ali ni na voljo/).first()).toBeVisible();
    await expect(worker.locator('#todoDialog')).not.toBeVisible();
  } finally {await ctx.close();}
});

test('month aligns each multi-day bar only across its dates; isolated timed Monday stays near its heading',async({page},info)=>{
  await login(page);
  await page.evaluate(async()=>{
    for(const [title,date,endDate,start,end,status] of [
      ['Busy Tuesday A','2026-11-03'],['Busy Tuesday B','2026-11-03'],['Busy Tuesday C','2026-11-03'],
      ['Covered Wednesday','2026-11-04'],['Span Thu–Sat','2026-11-05','2026-11-07'],
      ['Overlap Wed–Fri','2026-11-04','2026-11-06'],['Monday work','2026-11-02','','08:00','09:00','execution']]){
      await api('/api/todos',{method:'POST',body:JSON.stringify({title,date,endDate:endDate||date,start:start||'',end:end||'',status:status||'open',client:'QA',assigneeIds:['bojan']})});
    }
    await loadAll();setWorkContext('admin');setView('calendar');state.current=new Date(2026,10,1);state.showCompletedCalendarTodos=true;renderMonth();
  });
  for(const width of [1280,390]){
    await page.setViewportSize({width,height:900}); await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
    const pos=await page.evaluate(()=>{
      const day=n=>document.querySelector('.day[data-date="2026-11-0'+n+'"]');
      const rect=e=>e.getBoundingClientRect(); const parts=t=>[...document.querySelectorAll('.day-multiday-event')].filter(e=>e.getAttribute('aria-label').includes(t)).map(e=>rect(e).top);
      return {mondayGap:rect(day(2).querySelector('.day-todo')).top-rect(day(2).querySelector('.day-head')).bottom,
        busyBottom:rect(day(3).querySelector('.day-single-untimed')).bottom,span:parts('Span Thu'),overlap:parts('Overlap Wed'),unused:day(2).querySelectorAll('.day-multiday-slot').length};
    });
    expect(pos.unused).toBe(0);expect(pos.mondayGap).toBeLessThan(25);
    for(const ys of [pos.span,pos.overlap]){expect(ys).toHaveLength(3);expect(Math.max(...ys)-Math.min(...ys)).toBeLessThan(2);}
    expect(Math.min(...pos.overlap)).toBeLessThan(pos.busyBottom);
    await page.screenshot({path:info.outputPath('calendar-'+width+'.png')});
  }
});
