"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs/promises"), path = require("node:path"), os = require("node:os");
const { defaults, validateConfig, createAppConfig } = require("../outputs/app-config");
const clone = () => JSON.parse(JSON.stringify(defaults));
test("technical configuration validates defaults, bounds, unknown fields and linked limits", () => {
  assert.deepEqual(validateConfig(defaults), defaults);
  assert.equal(defaults.uploads.pdfMaxMb, 50);
  for (const alter of [
    c => c.uploads.pdfMaxMb = 101, c => c.uploads.pdfMaxMb = "50",
    c => c.uploads.path = "/etc/passwd", c => c.auth = {enabled:false},
    c => delete c.locks, c => c.locks.heartbeatSeconds = 60,
    c => c.reports.pdfTotalMb = 50, c => c.network.uploadTimeoutSeconds = 30,
    c => c.editor.defaultStart = "24:00"
  ]) {
    const c = clone(); c.network.requestTimeoutSeconds = 60;
    alter(c); assert.throws(() => validateConfig(c));
  }
});
test("atomic config persists, rejects stale/concurrent saves and preserves previous version", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "indus-config-"));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const file = path.join(dir, "app-config.json");
  const store = createAppConfig({file, environment:{}});
  await store.ensure();
  const before = store.snapshot(), next = clone(); next.uploads.pdfMaxMb = 60;
  const results = await Promise.allSettled([store.save(next,before.revision),store.save(next,before.revision)]);
  assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
  assert.equal(results.find(r=>r.status==="rejected").reason.status,409);
  assert.deepEqual(store.previous(), defaults);
  assert.equal(createAppConfig({file, environment:{}}).get().uploads.pdfMaxMb,60);
  const invalid = clone(); invalid.history.trashDays = 0;
  await assert.rejects(store.save(invalid, store.snapshot().revision));
  assert.equal(JSON.parse(await fs.readFile(file,"utf8")).uploads.pdfMaxMb,60);
  assert.deepEqual((await fs.readdir(dir)).sort(),["app-config.json","app-config.json.previous"]);
});
test("file config wins over old environment variables after first creation", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),"indus-config-env-")); t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const file=path.join(dir,"app-config.json");
  const store=createAppConfig({file,environment:{MAX_TODO_IMAGE_BYTES:String(30*1048576)}});
  await store.ensure(); assert.equal(store.get().uploads.imageMaxMb,30);
  assert.equal(createAppConfig({file,environment:{MAX_TODO_IMAGE_BYTES:String(50*1048576)}}).get().uploads.imageMaxMb,30);
});

test("lowered upload count never truncates or rejects unchanged historical attachments",()=>{
 const {validateTodo}=require("../outputs/server");
 const photos=Array.from({length:41},(_,i)=>({attachmentId:i.toString(16).padStart(64,"0")}));
 const todo={title:"Old attachments",status:"open",photos},db={todos:[]};
 assert.equal(validateTodo(todo,{db,previousTodo:todo}),"");
 assert.match(validateTodo(todo,{db}),/40 prilog/);
});
