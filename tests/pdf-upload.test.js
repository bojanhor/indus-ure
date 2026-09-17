"use strict";
const test=require("node:test"), assert=require("node:assert/strict"), crypto=require("node:crypto");
test("PDF stream rejects invalid signature, truncated header and chunked oversize with no staged files", async t => {
 const fs=require("node:fs"), fsp=fs.promises, path=require("node:path"), os=require("node:os");
 const {Readable,Transform}=require("node:stream"), {pipeline}=require("node:stream/promises");
 const {createAttachmentTransfer}=require("../outputs/attachment-transfer");
 const dir=await fsp.mkdtemp(path.join(os.tmpdir(),"indus-pdf-stream-"));
 t.after(()=>fsp.rm(dir,{recursive:true,force:true}));
 let writes=0;
 const transfer=createAttachmentTransfer({
  requireUser:async()=>({id:"bojan"}), runSerializedWork:async()=>{writes++;throw Error("Invalid PDF reached persistence");},
  moduleValues:{fs,fsp,path,crypto,Transform,pipeline,MEDIA_DIR:dir,MAX_PDF_BYTES:1024}
 });
 for(const chunks of [[Buffer.from("not PDF")],[Buffer.from("%PD")],[Buffer.from("%PDF-"),Buffer.alloc(1024)]]) {
  const req=Readable.from(chunks);req.method="POST";req.headers={"content-type":"application/pdf"};
  await assert.rejects(transfer.handleAttachmentUpload(req,{},new URL("http://localhost/api/todos/pdf")),error=>[400,413].includes(error.status));
  assert.deepEqual(await fsp.readdir(path.join(dir,".uploads")),[]);
 }
 assert.equal(writes,0);
});
const {startIsolatedTestApp,TEST_PASSWORD}=require("./e2e/test-app.cjs");
async function login(app,userId){
 const r=await fetch(app.baseUrl+"/api/test-login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({userId,password:TEST_PASSWORD})});
 assert.equal(r.status,200); const cookie=r.headers.get("set-cookie").split(";",1)[0],data=await r.json();
 return {Cookie:cookie,"X-CSRF-Token":data.csrfToken};
}
test("50 MiB PDF streams, is privately readable, saves as metadata, and rejects oversize PDF", {timeout:60000}, async t=>{
 const app=await startIsolatedTestApp(); t.after(()=>app.stop());
 const boss=await login(app,"bojan"), worker=await login(app,"ibro");
 const pdf=Buffer.alloc(50*1048576,32); pdf.write("%PDF-1.4\n"); pdf.write("\n%%EOF",pdf.length-6);
 const upload=()=>fetch(app.baseUrl+"/api/todos/pdf",{method:"POST",headers:{...boss,"Content-Type":"application/pdf","X-Indus-File-Name":"velik.pdf"},body:pdf});
 const result=await upload(); assert.equal(result.status,201,await result.clone().text()); const {photo}=await result.json();
 assert.equal(photo.mimeType,"application/pdf");assert.equal(photo.name,"velik.pdf");assert.equal(photo.data,undefined);
 const oversizedDefault=await fetch(app.baseUrl+"/api/todos/pdf",{method:"POST",headers:{...boss,"Content-Type":"application/pdf"},body:Buffer.concat([pdf,Buffer.from("x")])});
 assert.equal(oversizedDefault.status,413,await oversizedDefault.clone().text());
 const download=await fetch(app.baseUrl+photo.url,{headers:boss});assert.equal(download.status,200);
 const bytes=Buffer.from(await download.arrayBuffer());assert.equal(bytes.length,pdf.length);
 assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"),photo.attachmentId);
 const denied=await fetch(app.baseUrl+photo.url,{headers:worker}); assert.ok([403,404].includes(denied.status));
 const anonymous=await fetch(app.baseUrl+"/api/todos/pdf",{method:"POST",body:"%PDF-1.4"});assert.equal(anonymous.status,401);
 const csrf=await fetch(app.baseUrl+"/api/todos/pdf",{method:"POST",headers:{Cookie:boss.Cookie},body:"%PDF-1.4"});assert.equal(csrf.status,403);
 const saved=await fetch(app.baseUrl+"/api/todos",{method:"POST",headers:{...boss,"Content-Type":"application/json"},body:JSON.stringify({title:"Velik PDF test",client:"QA PDF",status:"open",assigneeIds:["bojan"],photos:[photo]})});
 assert.equal(saved.status,200,await saved.clone().text());
 const savedData=await saved.json();const todo=savedData.todos[0];
 assert.equal(todo.photos[0].attachmentId,photo.attachmentId);assert.ok(JSON.stringify(todo).length<20000);
 const focused=await fetch(app.baseUrl+"/api/todos/"+todo.id,{headers:boss});assert.equal(focused.status,200);
 assert.equal((await focused.json()).todo.photos[0].mimeType,"application/pdf");
 const configResponse=await fetch(app.baseUrl+"/api/app-config",{headers:boss});const config=await configResponse.json();
 config.config.uploads.pdfMaxMb=1;
 const configSaved=await fetch(app.baseUrl+"/api/app-config",{method:"PUT",headers:{...boss,"Content-Type":"application/json"},body:JSON.stringify(config)});
 assert.equal(configSaved.status,200,await configSaved.clone().text());
 const oldDownload=await fetch(app.baseUrl+photo.url,{headers:boss});assert.equal(oldDownload.status,200);await oldDownload.body.cancel();
 // An oversized Content-Length is rejected before the body is consumed.
 const oversized=await fetch(app.baseUrl+"/api/todos/pdf",{method:"POST",headers:{...boss,"Content-Type":"application/pdf"},body:Buffer.alloc(1048577)});
 assert.equal(oversized.status,413,await oversized.clone().text());
});
test("config API is boss-only, CSRF protected, revision checked; diagnostics are absent", {timeout:20000},async t=>{
 const app=await startIsolatedTestApp();t.after(()=>app.stop());const boss=await login(app,"bojan"),worker=await login(app,"ibro");
 const url=app.baseUrl+"/api/app-config";
 assert.equal((await fetch(url)).status,401);
 assert.equal((await fetch(url,{headers:worker})).status,403);
 const initial=await(await fetch(url,{headers:boss})).json();
 const body=JSON.stringify(initial);
 assert.equal((await fetch(url,{method:"PUT",headers:{Cookie:boss.Cookie,"Content-Type":"application/json"},body})).status,403);
 initial.config.editor.defaultDurationMinutes=90;
 const headers={...boss,"Content-Type":"application/json"};
 const response=await fetch(url,{method:"PUT",headers,body:JSON.stringify(initial)});assert.equal(response.status,200);
 assert.equal((await response.json()).previous.editor.defaultDurationMinutes,60);
 assert.equal((await fetch(url,{method:"PUT",headers,body:JSON.stringify(initial)})).status,409);
 const invalid=await(await fetch(url,{headers:boss})).json();invalid.config.uploads.pdfMaxMb=10000;
 assert.equal((await fetch(url,{method:"PUT",headers,body:JSON.stringify(invalid)})).status,400);
 assert.equal((await fetch(app.baseUrl+"/api/todo-editor-diagnostics",{headers:boss})).status,404);
 const shell=await(await fetch(app.baseUrl)).text();assert.doesNotMatch(shell,/reportTodoEditorOpenTiming|todo-editor-diagnostics/);
 assert.match(shell,/"defaultDurationMinutes":90/);
});
