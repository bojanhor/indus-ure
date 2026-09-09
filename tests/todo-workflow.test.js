const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { EditHandover } = require('../outputs/edit-handover');
const { moveAttachmentFile, pruneUnusedTodoAttachments } = require('../outputs/server');
const { startIsolatedTestApp, TEST_PASSWORD } = require('./e2e/test-app.cjs');

test('predaja ne prenese zaklepa po 20 s brez varnega shranjevanja ali izteka lease', () => {
  const h = new EditHandover();
  const owner = {id:'bojan',name:'Bojan'};
  const lock = {userId:'bojan',token:'secret'};
  const r = h.request('a',lock,owner,'',1000);
  assert.equal(r.deadline,21000);
  assert.equal(h.owner(lock,owner,'wrong','poll','',1100).status,'not-owner');
  assert.equal(h.request('a',lock,owner,r.requestId,22000).status,'waiting');
  assert.equal(h.request('a',null,owner,r.requestId,23000).status,'ready');
  assert.equal(h.request('b',null,owner,r.requestId,23000).status,'expired');
  assert.equal(h.request('a',null,{id:'ibro'},r.requestId,23000).status,'expired');
});
test('prevzem podpira zavrnitev in zaščiti aktivno prošnjo drugega delavca', () => {
  const h = new EditHandover(); const owner={id:'bojan'}; const next={id:'ibro'};
  const lock={userId:'bojan',token:'t'};
  const r=h.request('a',lock,next,'',1000);
  assert.equal(h.request('a',lock,{id:'third'},'',1100).status,'busy');
  assert.equal(h.owner(lock,owner,'t','deny',r.requestId,1200).status,'denied');
  assert.equal(h.request('a',lock,next,r.requestId,1300).status,'denied');
});
test('ponoven prenos nikoli ne prepiše ali lasti že shranjene vsebine', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'indus-attachment-'));
  try {
    const dest=path.join(dir,'object.jpg'); const tmp=path.join(dir,'upload.jpg');
    await fs.writeFile(dest,'original'); await fs.writeFile(tmp,'duplicate');
    assert.equal(await moveAttachmentFile(tmp,dest),false);
    assert.equal(await fs.readFile(dest,'utf8'),'original');
    await fs.writeFile(tmp,'new');
    assert.equal(await moveAttachmentFile(tmp,path.join(dir,'new.jpg')),true);
  } finally { await fs.rm(dir,{recursive:true,force:true}); }
});
test('preklic staginga ne izbriše priloge, uporabljene v drugem dogodku', () => {
  const id='a'.repeat(64); const unused='b'.repeat(64);
  const db={todos:[{photos:[{attachmentId:id}]}],debts:[],undoJournal:[],settings:{pendingAttachments:{}},attachments:{[id]:{},[unused]:{}}};
  pruneUnusedTodoAttachments(db);
  assert.ok(db.attachments[id]); assert.equal(db.attachments[unused],undefined);
});
test('HTTP predaja: dve napravi istega uporabnika, zavrnitev, sprostitev in pravice', {timeout:20000}, async()=>{
  const app=await startIsolatedTestApp();
  try {
    const login=async userId=>{
      const r=await fetch(app.baseUrl+'/api/test-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({userId,password:TEST_PASSWORD})});
      const d=await r.json(); assert.equal(r.status,200);
      return {'Content-Type':'application/json',Cookie:r.headers.get('set-cookie').split(';')[0],'X-CSRF-Token':d.csrfToken};
    };
    const a=await login('bojan'); const b=await login('bojan'); const c=await login('ibro');
    const post=async(p,headers,body,method='POST')=>{const r=await fetch(app.baseUrl+p,{method,headers,body:JSON.stringify(body)});return {status:r.status,data:await r.json()};};
    const created=await post('/api/todos',a,{title:'Predaja QA',client:'Test',status:'open',syncUser:'bojan',assigneeIds:['bojan']});
    assert.equal(created.status,200,JSON.stringify(created.data));
    const id=created.data.todos.find(t=>t.title==='Predaja QA').id;
    const url='/api/todos/'+id+'/lock';
    const held=await post(url,a,{});assert.equal(held.status,200);
    assert.equal((await post(url,b,{})).status,409);
    assert.equal((await post(url+'/handover',c,{action:'request'})).status,404);
    const req=await post(url+'/handover',b,{action:'request'});
    const poll=await post(url+'/handover',a,{action:'poll',lockToken:held.data.lockToken});
    assert.equal(poll.data.requestId,req.data.requestId);
    await post(url+'/handover',a,{action:'deny',requestId:req.data.requestId,lockToken:held.data.lockToken});
    assert.equal((await post(url+'/handover',b,{action:'request',requestId:req.data.requestId})).data.status,'denied');
    const cancelled=await post(url+'/handover',b,{action:'request'});
    assert.equal((await post(url+'/handover',b,{action:'cancel',requestId:cancelled.data.requestId})).data.status,'cancelled');
    assert.equal((await post(url+'/handover',a,{action:'poll',lockToken:held.data.lockToken})).data.status,'idle');
    const next=await post(url+'/handover',b,{action:'request'});
    await post(url,a,{lockToken:held.data.lockToken},'DELETE');
    assert.equal((await post(url+'/handover',b,{action:'request',requestId:next.data.requestId})).data.status,'ready');
    assert.equal((await post(url,b,{})).status,200);
  } finally { await app.stop(); }
});
