"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const qs = require("qs");
const { google } = require("googleapis");

test("qs enforces the comma array limit for bracketed input", () => {
  assert.throws(() => qs.parse("a[]=1,2,3,4", {
    comma: true, arrayLimit: 3, throwOnLimitExceeded: true
  }), RangeError);
});
test("qs safely serializes an untrusted constructor/isBuffer key", () => {
  const input = JSON.parse('{"a":{"constructor":{"isBuffer":"x"}}}');
  assert.doesNotThrow(() => qs.stringify(input));
});
test("Google Drive, Gmail and People use correct query/body encoding after qs upgrade", { timeout: 15000 }, async () => {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    seen.push({ method: req.method, url: new URL(req.url, "http://localhost"), body });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ files: [], connections: [], otherContacts: [], id: "local-test" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const rootUrl = `http://127.0.0.1:${server.address().port}/`;
  // Fail closed if any API accidentally ignores our loopback root.
  const fetchImplementation = (url, options) => {
    assert.equal(new URL(String(url)).origin, new URL(rootUrl).origin);
    return fetch(url, options);
  };
  const options = { rootUrl, auth: "local-test-key", fetchImplementation };
  try {
    const drive = google.drive({ version: "v3", ...options });
    const gmail = google.gmail({ version: "v1", ...options });
    const people = google.people({ version: "v1", ...options });
    const query = "name = 'Črpalka & omara + 1' and trashed = false";
    const token = "next/+ & č";
    await drive.files.list({ q: query, pageSize: 10, fields: "files(id,name)", pageToken: token });
    await drive.files.get({ fileId: "qa-file", fields: "id,name,size,md5Checksum" });
    await people.people.connections.list({ resourceName: "people/me", personFields: "names,emailAddresses", pageSize: 1000, pageToken: token });
    await people.otherContacts.list({ readMask: "names,emailAddresses", pageSize: 1000, pageToken: token });
    const raw = Buffer.from("Subject: Local QA\r\n\r\nŽivjo").toString("base64url");
    await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
    await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
    assert.equal(seen.length, 6);
    assert.equal(seen[0].url.searchParams.get("q"), query);
    assert.equal(seen[0].url.searchParams.get("pageToken"), token);
    assert.equal(seen[1].url.searchParams.get("fields"), "id,name,size,md5Checksum");
    assert.equal(seen[2].url.searchParams.get("personFields"), "names,emailAddresses");
    assert.equal(seen[2].url.searchParams.get("pageToken"), token);
    assert.equal(seen[3].url.searchParams.get("readMask"), "names,emailAddresses");
    assert.equal(seen[3].url.searchParams.get("pageToken"), token);
    assert.equal(seen[4].method, "POST");
    assert.deepEqual(JSON.parse(seen[4].body), { raw });
    assert.deepEqual(JSON.parse(seen[5].body), { message: { raw } });
    assert.ok(seen.every(item => item.url.searchParams.get("key") === "local-test-key"));
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const nodemailer = require("nodemailer");
const MailMessage = require("nodemailer/lib/mailer/mail-message");
const { execFileSync } = require("node:child_process");
const root = path.join(__dirname, "..");

test("actual app and backup alert functions preserve sender, recipient and message", async () => {
  const sent = [];
  const transport = nodemailer.createTransport({ jsonTransport: true });
  const localMailer = { createTransport: () => ({
    sendMail: async options => {
      const info = await transport.sendMail(options);
      sent.push(JSON.parse(info.message.toString()));
      return info;
    }
  }) };
  // Execute the actual production functions, without starting the backup job
  // or reading production credentials. Only the mail transport is substituted.
  const extract = (filename, start, end) => {
    const source = fs.readFileSync(path.join(root, filename), "utf8");
    const from = source.indexOf(start);
    const to = source.indexOf(end, from);
    assert.ok(from >= 0 && to > from, "production alert function must exist");
    return source.slice(from, to);
  };
  const context = vm.createContext({
    ALERT_SMTP_URL: "local-test-only", ALERT_EMAIL_FROM: "alerts@example.test",
    ALERT_EMAIL_TO: "owner@example.test", alertTransport: null,
    require: name => { assert.equal(name, "nodemailer"); return localMailer; },
    nodemailer: localMailer, console
  });
  vm.runInContext(
    extract("outputs/server.js", "async function sendOperationalAlertEmail(", "async function collapseUnreadOperationalAlerts(")
    + extract("scripts/backup-indus-ure.js", "async function notifyFailure(", "async function driveForOwner("), context);
  assert.equal(await context.sendOperationalAlertEmail({
    title: "Preizkus opozorila", message: "Šumniki čšž", createdAt: "local-test", code: "qa"
  }), true);
  await context.notifyFailure({id:"qa-backup", finishedAt:"local-test", error:"Preizkus čšž"});
  assert.equal(sent.length, 2);
  for (const mail of sent) {
    assert.deepEqual(mail.to.map(item => item.address), ["owner@example.test"]);
    assert.equal(mail.from.address, "alerts@example.test");
    assert.ok(mail.text.includes("čšž"));
  }
  assert.match(sent[0].subject, /Preizkus opozorila/);
  assert.match(sent[1].text, /qa-backup/);
});

test("Nodemailer legacy content resolver respects file and URL access guards", async () => {
  const transport = nodemailer.createTransport({
    streamTransport: true, disableFileAccess: true, disableUrlAccess: true
  });
  const mail = new MailMessage(transport, {
    from:"a@example.test", to:"b@example.test",
    html:{path:path.join(root,"package.json")},
    attachments:[{href:"http://127.0.0.1:1/not-requested",filename:"qa.txt"}]
  });
  const resolve = (data,key) => new Promise((res,rej) =>
    mail.resolveContent(data,key,(error,value)=>error?rej(error):res(value)));
  await assert.rejects(resolve(mail.data,"html"), {code:"EFILEACCESS"});
  await assert.rejects(resolve(mail.data.attachments,0), {code:"EURLACCESS"});
});
test("Nodemailer enforces the configured recipient limit", async () => {
  const transport = nodemailer.createTransport({jsonTransport:true,maxRecipients:2});
  await assert.rejects(transport.sendMail({
    from:"a@example.test",to:"b@example.test,c@example.test,d@example.test",text:"local"
  }), /recipient/i);
});
test("Nodemailer handles a long address list in a bounded isolated process", {timeout:10000}, () => {
  const output = execFileSync(process.execPath, ["-e",
    'const parse=require("nodemailer/lib/addressparser");const start=Date.now();const result=parse("a@example.test,".repeat(200000));if(result.length!==200000)process.exit(2);console.log(JSON.stringify({count:result.length,ms:Date.now()-start}));'
  ], {cwd:root,timeout:8000,windowsHide:true,encoding:"utf8",
      env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot||""}});
  assert.equal(JSON.parse(output).count,200000);
});

