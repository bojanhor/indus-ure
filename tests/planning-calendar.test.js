"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const planning = require("../outputs/planning-calendar");
const { APP, SCOPES, calendarPlans, controlledEvent, createGooglePlanningCalendar } = require("../outputs/google-planning-calendar");
const { createCalendarSyncStore } = require("../outputs/calendar-sync-store");
const { createCalendarHttp } = require("../outputs/calendar-http");
const copy = value => JSON.parse(JSON.stringify(value));
const definitions = { open: { label: "Čaka", googleColorId: "8" }, in_progress: { label: "V teku", googleColorId: "9" } };
const baseUrl = "https://ure.example.test";
const ownerEmail = "owner@example.test";
const task = (extra = {}) => ({ id: "a", assignmentGroupId: "shared", title: "Montaža", client: "Stranka", notes: "Preveri omaro.", status: "open", syncUser: "ibro", date: "2026-10-25", start: "08:00", end: "10:00", ...extra });
function dbFixture() { return { users: { bojan: { id: "bojan", name: "Bojan", role: "boss", email: ownerEmail }, ibro: { id: "ibro", name: "Ibro", role: "worker", email: "ibro@example.test" } }, todos: [task()] }; }
function apiError(code) { return Object.assign(new Error(`API ${code}`), { code }); }
function fakeApi() {
  const calendars = new Map(), events = new Map(), acls = new Map(), calls = [];
  let serial = 0;
  const wrap = (name, fn) => async args => { calls.push([name, copy(args)]); return { data: copy(await fn(args)) }; };
  const api = {
    calendarList: { list: wrap("calendarList.list", () => ({ items: [...calendars.values()] })) },
    calendars: {
      get: wrap("calendars.get", ({ calendarId }) => { if (!calendars.has(calendarId)) throw apiError(404); return calendars.get(calendarId); }),
      insert: wrap("calendars.insert", ({ requestBody }) => {
        const id = `calendar-${++serial}@group.calendar.google.com`; calendars.set(id, { id, ...requestBody }); events.set(id, new Map());
        acls.set(id, [
          { id: `user:${id}`, role: "owner", scope: { type: "user", value: id } },
          { id: "owner", role: "owner", scope: { type: "user", value: ownerEmail } }
        ]); return calendars.get(id);
      }),
      patch: wrap("calendars.patch", ({ calendarId, requestBody }) => Object.assign(calendars.get(calendarId), requestBody))
    },
    acl: {
      list: wrap("acl.list", ({ calendarId }) => ({ items: acls.get(calendarId) })),
      insert: wrap("acl.insert", ({ calendarId, requestBody }) => { const rule = { id: `acl-${++serial}`, ...requestBody }; acls.get(calendarId).push(rule); return rule; }),
      patch: wrap("acl.patch", ({ calendarId, ruleId, requestBody }) => Object.assign(acls.get(calendarId).find(rule => rule.id === ruleId), requestBody)),
      delete: wrap("acl.delete", ({ calendarId, ruleId }) => { acls.set(calendarId, acls.get(calendarId).filter(rule => rule.id !== ruleId)); return {}; })
    },
    events: {
      list: wrap("events.list", ({ calendarId }) => ({ items: [...events.get(calendarId).values()].filter(event => event.status !== "cancelled" && event.extendedProperties?.private?.indusApp === APP) })),
      get: wrap("events.get", ({ calendarId, eventId }) => { const event = events.get(calendarId).get(eventId); if (!event) throw apiError(404); if (event.status === "cancelled") throw apiError(410); return event; }),
      insert: wrap("events.insert", ({ calendarId, requestBody }) => { if (events.get(calendarId).has(requestBody.id)) throw apiError(409); const event = { ...requestBody, etag: "v1" }; events.get(calendarId).set(event.id, event); return event; }),
      update: wrap("events.update", ({ calendarId, eventId, requestBody }) => { const event = { id: eventId, ...requestBody, etag: "v2" }; events.get(calendarId).set(eventId, event); return event; }),
      delete: wrap("events.delete", ({ calendarId, eventId }) => { events.get(calendarId).get(eventId).status = "cancelled"; return {}; })
    }
  };
  return { api, calendars, events, acls, calls };
}
function fixture(t) {
  let state = { enabled: true, tokens: { refresh_token: "private-test-token" }, ownerEmail, baseUrl }, time = Date.now();
  const db = dbFixture(), remote = fakeApi();
  const store = { load: async () => copy(state), locked: work => work({ load: async () => copy(state), save: async value => { state = copy(value); } }) };
  const service = createGooglePlanningCalendar({ store, readDb: async () => copy(db), createApi: () => remote.api, baseUrl, definitions, now: () => time });
  t.after(() => service.stop());
  return { service, db, remote, store, state: () => state, advance: () => { time += 1000000; }, run: () => service.run({ force: true }) };
}

test("selection matches planning visibility; excludes ALL work/material statuses and legacy entries", () => {
  const excluded = ["execution", "meal", "drive", "purchase", "material"];
  const todos = [task(), ...excluded.map((status, i) => task({ id: `excluded-${i}`, status })), task({ id: "trash", trashedAt: "today" }), task({ id: "archive", archivedAt: "today" }), task({ id: "imported", imported: true }), task({ id: "undated", date: "" }), task({ id: "other", assignmentGroupId: "other", syncUser: "bojan" })];
  assert.deepEqual(planning.select(todos, { userId: "ibro" }).map(todo => todo.id), ["a"]);
  assert.equal(planning.select(todos, { combined: true }).length, 2);
});
test("shared planning appears once in combined and once per assigned worker", () => {
  const db = dbFixture(); db.todos.push(task({ id: "b", syncUser: "bojan" }));
  const plans = calendarPlans(db, baseUrl, definitions);
  assert.equal(Object.keys(plans[0].events).length, 1);
  assert.match(Object.values(plans[0].events)[0].description, /Ibro, Bojan/);
  assert.ok(plans.every(plan => Object.keys(plan.events).length === 1));
});
test("all-day, multi-day, DST and timed values retain Ljubljana wall-clock and exclusive end", () => {
  const db = dbFixture();
  let event = Object.values(calendarPlans(db, baseUrl, definitions)[0].events)[0];
  assert.deepEqual(event.start, { dateTime: "2026-10-25T08:00:00", timeZone: "Europe/Ljubljana" });
  db.todos[0].end = "24:00";
  event = Object.values(calendarPlans(db, baseUrl, definitions)[0].events)[0];
  assert.deepEqual(event.end, { dateTime: "2026-10-26T00:00:00", timeZone: "Europe/Ljubljana" });
  db.todos[0].start = ""; db.todos[0].end = ""; db.todos[0].endDate = "2026-10-27";
  event = Object.values(calendarPlans(db, baseUrl, definitions)[0].events)[0];
  assert.deepEqual(event.end, { date: "2026-10-28" });
  assert.equal(planning.nextDay("2026-12-31"), "2027-01-01");
});
test("projection contains a deep link and no billing fields or attachments", () => {
  const db = dbFixture(); Object.assign(db.todos[0], { amount: 1234, hourlyRate: 99, photos: [{ secret: "hidden.jpg" }], clientBillableMinutes: 120 });
  const body = Object.values(calendarPlans(db, baseUrl, definitions)[0].events)[0];
  assert.match(body.source.url, /\?todo=a$/); assert.doesNotMatch(JSON.stringify(body), /1234|hidden.jpg|hourlyRate|clientBillableMinutes/);
  assert.equal(body.visibility, "default", "reader must see event details"); assert.equal(body.guestsCanModify, false);
});
test("first sync creates separate calendars and grants only reader; stable retries do not duplicate", async t => {
  const f = fixture(t); await f.run();
  assert.equal(f.state().lastError, ""); assert.equal(f.remote.calendars.size, 3);
  assert.equal(f.remote.calls.filter(([name]) => name === "events.insert").length, 2);
  const rules = [...f.remote.acls.values()].flat().filter(rule => rule.role !== "owner");
  assert.equal(rules.length, 1); assert.equal(rules[0].role, "reader"); assert.equal(rules[0].scope.value, "ibro@example.test");
  await f.run(); assert.equal(f.remote.calls.filter(([name]) => name === "events.insert").length, 2);
  assert.equal(f.remote.calls.filter(([name]) => name === "events.update").length, 0);
  for (const [id, rules] of f.remote.acls) {
    assert.equal(rules.filter(rule => rule.role === "owner").length, 2);
    assert.ok(rules.some(rule => rule.role === "owner" && rule.scope.value === id));
    assert.ok(rules.some(rule => rule.role === "owner" && rule.scope.value === ownerEmail));
  }
  assert.equal(f.remote.calls.filter(([name, args]) => ["acl.patch", "acl.delete"].includes(name) && (args.ruleId === "owner" || args.ruleId.startsWith("user:calendar-"))).length, 0);
});

test("calendar with only the connected owner still synchronizes", async t => {
  const f = fixture(t), insert = f.remote.api.calendars.insert;
  f.remote.api.calendars.insert = async args => {
    const result = await insert(args);
    f.remote.acls.set(result.data.id, f.remote.acls.get(result.data.id).filter(rule => rule.scope.value === ownerEmail));
    return result;
  };
  await f.run();
  assert.equal(f.state().lastError, "");
  assert.equal(f.state().calendars.combined.count, 1);
});

for (const [label, extraOwner, removeHuman] of [
  ["a different human owner", { role: "owner", scope: { type: "user", value: "other@example.test" } }, false],
  ["another calendar's self-owner", { role: "owner", scope: { type: "user", value: "other@group.calendar.google.com" } }, false],
  ["a group masquerading as the connected owner", { role: "owner", scope: { type: "group", value: ownerEmail } }, false],
  ["the calendar identity without its connected human owner", null, true]
]) {
  test(`owner preflight rejects ${label} before ACL or event mutations`, async t => {
    const f = fixture(t); await f.run();
    const id = f.state().calendars.combined.id;
    const existing = f.remote.acls.get(id).filter(rule => !removeHuman || rule.scope.value !== ownerEmail);
    const unwantedReader = { id: "unwanted-reader", role: "reader", scope: { type: "user", value: "reader@example.test" } };
    f.remote.acls.set(id, [unwantedReader, ...existing, ...(extraOwner ? [{ id: "unexpected-owner", ...extraOwner }] : [])]);
    const before = copy(f.remote.acls.get(id));
    const calls = f.remote.calls.length;
    await f.run();
    assert.match(f.state().lastError, removeHuman ? /Pravica povezanega lastnika/ : /dodatnega lastnika/);
    assert.deepEqual(f.remote.acls.get(id), before);
    assert.equal(f.remote.calls.slice(calls).filter(([name, args]) => args.calendarId === id
      && /^(acl|events)\.(insert|update|patch|delete)$/.test(name)).length, 0);
  });
}

test("owner preflight checks all ACL pages before any write", async t => {
  const f = fixture(t); await f.run();
  const id = f.state().calendars.combined.id, list = f.remote.api.acl.list;
  const before = f.remote.calls.length;
  f.remote.api.acl.list = async args => args.calendarId !== id ? list(args)
    : args.pageToken ? { data: { items: [{ role: "owner", scope: { type: "user", value: "late-owner@example.test" } }] } }
      : { data: { items: f.remote.acls.get(id), nextPageToken: "second-page" } };
  await f.run();
  assert.match(f.state().lastError, /dodatnega lastnika/);
  assert.equal(f.remote.calls.slice(before).filter(([name, args]) => args.calendarId === id
    && /^(acl|events)\.(insert|update|patch|delete)$/.test(name)).length, 0);
});
test("title/date/status/assignee edits update/remove only the app projection", async t => {
  const f = fixture(t); await f.run();
  f.db.todos[0].title = "Spremenjeno"; f.db.todos[0].date = "2026-11-01"; f.db.todos[0].syncUser = "bojan";
  await f.run();
  const combinedId = f.state().calendars.combined.id;
  const active = [...f.remote.events.get(combinedId).values()].filter(event => event.status !== "cancelled");
  assert.equal(active.length, 1); assert.match(active[0].summary, /Spremenjeno/); assert.match(active[0].start.dateTime, /2026-11-01/);
  assert.equal(f.state().calendars["worker:ibro"].count, 0); assert.equal(f.state().calendars["worker:bojan"].count, 1);
  f.db.todos[0].status = "execution"; await f.run(); assert.ok(Object.values(f.state().calendars).every(calendar => calendar.count === 0));
});
test("delete then Undo recreates one event despite Google tombstones", async t => {
  const f = fixture(t); await f.run(); const before = f.state().calendars.combined;
  f.db.todos[0].trashedAt = "now"; await f.run();
  delete f.db.todos[0].trashedAt; await f.run();
  const events = [...f.remote.events.get(before.id).values()];
  assert.equal(events.filter(event => event.status !== "cancelled").length, 1);
  assert.equal(events.filter(event => event.status === "cancelled").length, 1);
  assert.equal(f.state().lastError, "");
});
test("Google-side edits never change the database and are replaced by authoritative planning", async t => {
  const f = fixture(t); await f.run(); const dbBefore = JSON.stringify(f.db);
  const calendar = f.state().calendars.combined;
  [...f.remote.events.get(calendar.id).values()][0].summary = "Napačno v Googlu";
  await f.run(); assert.equal(JSON.stringify(f.db), dbBefore);
  assert.match([...f.remote.events.get(calendar.id).values()][0].summary, /Montaža/);
});
test("worker deactivation and email changes revoke old access", async t => {
  const f = fixture(t); await f.run(); const id = f.state().calendars["worker:ibro"].id;
  f.db.users.ibro.email = "new@example.test"; await f.run();
  assert.deepEqual(f.remote.acls.get(id).filter(rule => rule.role !== "owner").map(rule => rule.scope.value), ["new@example.test"]);
  f.db.users.ibro.active = false; await f.run();
  assert.equal(f.remote.acls.get(id).filter(rule => rule.role !== "owner").length, 0);
  assert.equal(f.state().calendars["worker:ibro"].count, 0);
});
test("never touches unrelated calendars/events; refuses a mismatching calendar marker", async t => {
  const f = fixture(t); await f.run(); const id = f.state().calendars.combined.id;
  f.remote.events.get(id).set("personal", { id: "personal", summary: "Private" });
  f.db.todos = []; await f.run(); assert.equal(f.remote.events.get(id).get("personal").summary, "Private");
  f.remote.calendars.get(id).description = "Not managed";
  const count = f.remote.calls.filter(([name, args]) => name.startsWith("events.") && args.calendarId === id).length;
  await f.run(); assert.match(f.state().lastError, /Oznaka/);
  assert.equal(f.remote.calls.filter(([name, args]) => name.startsWith("events.") && args.calendarId === id).length, count);
});
test("interrupted creation is discovered, not duplicated", async t => {
  const f = fixture(t); const original = f.remote.api.calendars.insert; let once = true;
  f.remote.api.calendars.insert = async args => { const result = await original(args); if (once) { once = false; throw apiError(503); } return result; };
  await f.run(); assert.equal(f.remote.calendars.size, 3); assert.ok(f.state().calendars.combined.creating);
  await f.run(); assert.equal(f.remote.calendars.size, 3); assert.equal(f.state().lastError, "");
});
test("explicit creation rejection can retry after API is enabled", async t => {
  const f = fixture(t), original = f.remote.api.calendars.insert;
  f.remote.api.calendars.insert = async () => { throw apiError(403); };
  await f.run(); assert.match(f.state().lastError, /zavrnil/); assert.equal(f.state().calendars.combined, undefined);
  f.remote.api.calendars.insert = original; await f.run(); assert.equal(f.state().lastError, "");
});
test("rate limits persist retry state; disconnected/paused state performs no external calls", async t => {
  const f = fixture(t); f.remote.api.calendarList.list = async () => { throw apiError(429); };
  await f.run(); assert.ok(f.state().retryAt > Date.now()); assert.match(f.state().lastError, /omejuje/);
  const before = f.remote.calls.length; await f.service.run(); assert.equal(f.remote.calls.length, before);
  await f.service.setEnabled(false); await f.run(); assert.equal(f.remote.calls.length, before);
});
test("worker status excludes combined/other calendars and all credentials", async t => {
  const f = fixture(t); await f.run(); const status = await f.service.status(f.db.users.ibro, false);
  assert.equal(status.calendars.length, 1); assert.equal(status.calendars[0].key, "worker:ibro");
  assert.doesNotMatch(JSON.stringify(status), /private-test-token|ownerEmail|worker:bojan|combined/);
});
test("restart recovers pending desired state from source; unchanged snapshots avoid Google calls", async t => {
  const f = fixture(t); await f.run(); const calls = f.remote.calls.length;
  await f.service.run(); assert.equal(f.remote.calls.length, calls);
  f.db.todos[0].title = "Po restartu"; await f.service.run(); assert.ok(f.remote.calls.length > calls);
});
test("operational store serializes writes and persists without touching business snapshots", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "indus-calendar-test-")); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "private.json"); const store = createCalendarSyncStore({ file });
  await Promise.all(Array.from({ length: 10 }, () => store.locked(async io => { const state = await io.load(); state.counter = (state.counter || 0) + 1; await io.save(state); })));
  assert.equal((await store.load()).counter, 10); assert.deepEqual(await fs.readdir(dir), ["private.json"]);
  await store.close();
});
test("Google's explicit offset does not cause perpetual timed event updates", () => {
  const event = Object.values(calendarPlans(dbFixture(), baseUrl, definitions)[0].events)[0];
  const remote = copy(event); remote.start.dateTime += "+01:00"; remote.end.dateTime += "+01:00";
  assert.deepEqual(controlledEvent(event), controlledEvent(remote));
});
test("copied operational state cannot publish from a different database deployment", async t => {
  const f = fixture(t);
  const clone = createGooglePlanningCalendar({ store: f.store, readDb: async () => { throw new Error("must not read business state"); },
    createApi: () => { throw new Error("must not contact Google"); }, baseUrl, definitions, deploymentKey: "different-database" });
  t.after(() => clone.stop());
  await clone.run({ force: true });
  assert.equal((await clone.status(f.db.users.bojan, true)).connected, false);
  assert.equal(f.remote.calls.length, 0);
});
test("separate calendar failure does not prevent revocation for an inactive worker", async t => {
  const f = fixture(t); await f.run(); const id = f.state().calendars["worker:ibro"].id;
  f.remote.calendars.get(f.state().calendars.combined.id).description = "Wrong marker";
  f.db.users.ibro.active = false; await f.run();
  assert.equal(f.remote.acls.get(id).filter(rule => rule.role !== "owner").length, 0);
});
test("runtime kill switch also blocks manual/forced synchronization", async t => {
  const f = fixture(t);
  const stopped = createGooglePlanningCalendar({ store: f.store, readDb: async () => { throw new Error("disabled runtime must not read"); },
    createApi: () => { throw new Error("disabled runtime must not publish"); }, baseUrl, definitions, runtimeEnabled: false });
  t.after(() => stopped.stop());
  stopped.schedule(true); await stopped.run({ force: true });
  assert.equal(f.remote.calls.length, 0);
});
test("calendar HTTP rejects workers' writes and binds OAuth to owner and initiating session", async () => {
  let response, authOptions, connected = false;
  const boss = dbFixture().users.bojan;
  const service = { status: async () => ({}), connect: async () => { connected = true; } };
  const http = createCalendarHttp({ service, requireUser: async req => req.user,
    sendJson: (_res, code, body) => { response = { code, body }; }, sendText: (_res, code, body) => { response = { code, body }; },
    readBody: async () => ({}), googleReady: () => true, ownerEmail, baseUrl,
    googleClient: () => ({ generateAuthUrl: options => { authOptions = options; return "https://accounts.google.com/test"; },
      getToken: async () => ({ tokens: { refresh_token: "test", scope: SCOPES.join(" ") } }), setCredentials() {} }),
    googleProfile: async () => ({ email: ownerEmail, verified_email: true }) });
  await http.handle({ user: dbFixture().users.ibro, method: "POST" }, {}, new URL(`${baseUrl}/api/planning-calendar/sync`)); assert.equal(response.code, 403);
  const req = { user: boss, method: "POST", indusSession: { csrfToken: "session-a" } };
  await http.handle(req, {}, new URL(`${baseUrl}/api/planning-calendar/auth`)); assert.equal(response.code, 200);
  assert.deepEqual(authOptions.scope, ["openid", "email", ...SCOPES]);
  await http.handle({ ...req, method: "GET", indusSession: { csrfToken: "session-b" } }, {}, new URL(`${baseUrl}/api/google/callback?state=${authOptions.state}&code=test`));
  assert.equal(response.code, 401); assert.equal(connected, false);
  await http.handle(req, {}, new URL(`${baseUrl}/api/planning-calendar/auth`));
  const res = { writeHead: code => { response = { code }; }, end() {} };
  await http.handle({ ...req, method: "GET" }, res, new URL(`${baseUrl}/api/google/callback?state=${authOptions.state}&code=test`));
  assert.equal(connected, true); assert.equal(response.code, 303);
});
