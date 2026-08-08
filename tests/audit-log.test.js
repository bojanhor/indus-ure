const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  AUDIT_LOG_RETENTION_DAYS,
  recordAuditLog,
  visibleAuditLogForUser,
  purgeExpiredAuditLog
} = require("../outputs/server");

const DAY_MS = 24 * 60 * 60 * 1000;
const boss = { id: "bojan", name: "Bojan", role: "boss" };
const ibro = { id: "ibro", name: "Ibro", role: "worker" };
const maja = { id: "maja", name: "Maja", role: "worker" };

test("audit labels use proper guillemets instead of mojibake", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  const labelFunction = source.match(/function undoActionLabel[\s\S]*?\n}/)?.[0] || "";
  assert.match(labelFunction, /izbrisal dogodek \\u00bb/);
  assert.match(labelFunction, /izbrisal stranko \\u00bb/);
  assert.doesNotMatch(labelFunction, /\u00c2\u00bb|\u00c2\u00ab/);
});

function testDb() {
  return { auditLog: [] };
}

function isoMinutesAgo(minutes) {
  return new Date(Date.now() - minutes * 60 * 1000).toISOString();
}

test("varnostni dnevnik ima tridesetdnevno hrambo in po njej odstrani samo zapise izven roka", () => {
  const now = Date.now();
  const db = {
    auditLog: [
      { id: "old-event", createdAt: new Date(now - 31 * DAY_MS).toISOString(), targetId: "old-work" },
      { id: "recent-event", createdAt: new Date(now - 29 * DAY_MS).toISOString(), targetId: "recent-work" }
    ]
  };

  assert.equal(AUDIT_LOG_RETENTION_DAYS, 30);
  const removed = purgeExpiredAuditLog(db, now);
  assert.equal(removed, 1);
  assert.deepEqual(db.auditLog.map((event) => event.targetId || event.context?.targetId), ["recent-work"]);
});

test("dnevnik ne shrani gesel, žetonov, piškotkov ali vsebine prilog", () => {
  const db = testDb();
  const secrets = {
    password: "gpt-should-never-be-stored",
    nested: {
      accessToken: "access-token-should-never-be-stored",
      oauthSecret: "oauth-secret-should-never-be-stored",
      authorization: "Bearer should-never-be-stored"
    },
    cookie: "indus-ure-session=should-never-be-stored",
    email: "private@example.test",
    note: "password=should-never-be-stored",
    attachmentName: "slika.jpg",
    attachment: {
      dataUrl: "data:image/jpeg;base64,should-never-be-stored",
      bytes: "should-never-be-stored",
      content: "should-never-be-stored"
    }
  };
  recordAuditLog(db, {
    actor: boss,
    action: "prijava preverjena",
    targetType: "session",
    targetId: "session-1",
    details: secrets,
    occurredAt: isoMinutesAgo(1)
  });

  const serialized = JSON.stringify(db.auditLog[0]);
  for (const forbidden of [
    "gpt-should-never-be-stored",
    "access-token-should-never-be-stored",
    "oauth-secret-should-never-be-stored",
    "Bearer should-never-be-stored",
    "indus-ure-session=should-never-be-stored",
    "private@example.test",
    "password=should-never-be-stored",
    "data:image/jpeg;base64,should-never-be-stored"
  ]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(serialized, /slika\.jpg/);

  // A later caller-side mutation must not alter the immutable stored audit fact.
  secrets.attachmentName = "spremenjeno-po-vpisu.jpg";
  assert.match(JSON.stringify(db.auditLog[0]), /slika\.jpg/);
  assert.doesNotMatch(JSON.stringify(db.auditLog[0]), /spremenjeno-po-vpisu\.jpg/);
});

test("šef vidi vse, delavec pa samo lastne ali njemu dodeljene varnostne dogodke", () => {
  const db = testDb();
  recordAuditLog(db, {
    actor: ibro,
    action: "spremenjeno opravilo",
    targetType: "todo",
    targetId: "ibro-own",
    occurredAt: isoMinutesAgo(3)
  });
  recordAuditLog(db, {
    actor: boss,
    action: "dodeljeno opravilo",
    targetType: "todo",
    targetId: "ibro-assigned",
    details: { assigneeIds: ["ibro"] },
    occurredAt: isoMinutesAgo(2)
  });
  recordAuditLog(db, {
    actor: maja,
    action: "spremenjeno opravilo",
    targetType: "todo",
    targetId: "maja-private",
    details: { assigneeIds: ["maja"] },
    occurredAt: isoMinutesAgo(1)
  });

  const ids = (user) => visibleAuditLogForUser(db, user).map((event) => event.targetId || event.context?.targetId);
  assert.deepEqual(ids(boss), ["maja-private", "ibro-assigned", "ibro-own"]);
  assert.deepEqual(ids(ibro), ["ibro-assigned", "ibro-own"]);
  assert.deepEqual(ids(maja), ["maja-private"]);
});
