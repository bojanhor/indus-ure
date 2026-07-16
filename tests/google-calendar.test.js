const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  GOOGLE_CALENDAR_SCOPE_VERSION,
  INDUS_GOOGLE_APP_ID,
  TODO_STATUS_DEFINITIONS,
  buildCalendarIcs,
  deleteOwnedGoogleEvent,
  isIndusOwnedGoogleEvent,
  pushGoogleItem,
  googleEventMatchesRequest,
  entryFromGoogleEvent,
  entryToGoogleEvent,
  googleEventChanged,
  localItemChanged,
  normalizeDb,
  parseGoogleEventDescription,
  reconcileGoogleCalendar,
  remoteGoogleChangeWins,
  todoFromGoogleEvent,
  todoToGoogleEvent,
  validateTodo
} = require("../outputs/server");

const user = { id: "bojan", name: "Bojan" };
const client = { id: "SI12345678", clientId: "SI12345678", taxId: "SI12345678", name: "NOVAK d.o.o.", search: "Novak" };
const db = { clients: [client] };

function baseEntry() {
  return {
    id: "entry-1",
    date: "2026-07-15",
    start: "08:00",
    end: "10:00",
    client: client.name,
    clientId: client.clientId,
    status: "unbilled",
    work: "Servis",
    material: "Filter",
    people: "Ibro",
    km: 12,
    materialCost: 0,
    notes: "Poklici pred prihodom",
    syncUser: "bojan",
    createdBy: "bojan",
    createdByName: "Bojan",
    createdAt: "2026-07-15T06:00:00.000Z",
    updatedAt: "2026-07-15T06:00:00.000Z",
    googleEventId: "event-1",
    googleUpdatedAt: "2026-07-15T06:01:00.000Z",
    googleSyncedLocalAt: "2026-07-15T06:00:00.000Z",
    history: []
  };
}

function fakeCalendar(initialEvents = []) {
  const stored = new Map(initialEvents.map((event) => [event.id, structuredClone(event)]));
  const calls = { list: 0, get: [], patch: [], insert: [], delete: [] };
  let inserted = 0;
  const notFound = () => {
    const error = new Error("not found");
    error.code = 404;
    return error;
  };
  const api = {
    events: {
      list: async () => {
        calls.list++;
        return { data: { items: [...stored.values()].map((event) => structuredClone(event)) } };
      },
      get: async ({ eventId }) => {
        calls.get.push(eventId);
        if (!stored.has(eventId)) throw notFound();
        return { data: structuredClone(stored.get(eventId)) };
      },
      patch: async ({ eventId, requestBody }) => {
        calls.patch.push({ eventId, requestBody: structuredClone(requestBody) });
        if (!stored.has(eventId)) throw notFound();
        const event = { ...stored.get(eventId), ...structuredClone(requestBody), id: eventId, updated: "2026-07-15T10:00:00.000Z" };
        stored.set(eventId, event);
        return { data: structuredClone(event) };
      },
      insert: async ({ requestBody }) => {
        const id = "inserted-" + (++inserted);
        calls.insert.push({ id, requestBody: structuredClone(requestBody) });
        const event = { ...structuredClone(requestBody), id, updated: "2026-07-15T10:00:00.000Z" };
        stored.set(id, event);
        return { data: structuredClone(event) };
      },
      delete: async ({ eventId }) => {
        calls.delete.push(eventId);
        stored.delete(eventId);
        return { data: {} };
      }
    }
  };
  return { api, calls, stored };
}

test("Google opis ohrani strukturirana polja brez podvajanja", () => {
  const entry = baseEntry();
  const event = entryToGoogleEvent(entry);
  const parsed = parseGoogleEventDescription(event.description);
  assert.equal(parsed.isIndus, true);
  assert.equal(parsed.fields.stranka, client.name);
  assert.equal(parsed.fields.davcna, client.clientId);
  assert.equal(parsed.fields.delo, "Servis");
  assert.equal(parsed.notes, "Poklici pred prihodom");
  assert.equal(event.description.includes("Opombe: INDUS URE"), false);
});

test("sprememba naslova na telefonu spremeni delo in ne podvoji stranke", () => {
  const existing = baseEntry();
  const remote = {
    ...entryToGoogleEvent(existing),
    id: existing.googleEventId,
    summary: "Menjava filtra",
    updated: "2026-07-15T07:00:00.000Z"
  };
  const imported = entryFromGoogleEvent(remote, user, db, existing);
  assert.equal(imported.client, client.name);
  assert.equal(imported.clientId, client.clientId);
  assert.equal(imported.work, "Menjava filtra");
  assert.equal(entryToGoogleEvent(imported).summary, `${client.name} - Menjava filtra`);
});

test("sprememba strukturiranega opisa na telefonu se uvozi", () => {
  const existing = baseEntry();
  const remote = {
    ...entryToGoogleEvent(existing),
    id: existing.googleEventId,
    description: entryToGoogleEvent({ ...existing, work: "Nova nastavitev", km: 22, notes: "Nova opomba" }).description,
    updated: "2026-07-15T07:00:00.000Z"
  };
  const imported = entryFromGoogleEvent(remote, user, db, existing);
  assert.equal(imported.work, "Nova nastavitev");
  assert.equal(imported.km, 22);
  assert.equal(imported.notes, "Nova opomba");
});

test("celodnevni INDUS dogodek ostane dopust", () => {
  const existing = { ...baseEntry(), status: "vacation", client: "", clientId: "", start: "00:00", end: "23:59", work: "Dopust" };
  const remote = { ...entryToGoogleEvent(existing), id: "vacation-1", updated: "2026-07-15T07:00:00.000Z" };
  const imported = entryFromGoogleEvent(remote, user, db, existing);
  assert.equal(imported.status, "vacation");
  assert.equal(imported.date, "2026-07-15");
  assert.equal(imported.start, "00:00");
});

test("INDUS celodnevni Google dogodek ostane opravilo", () => {
  const todo = {
    id: "todo-local-1",
    title: "Poklici stranko",
    date: "2026-07-16",
    client: client.name,
    clientId: client.clientId,
    notes: "Po kosilu",
    status: "open",
    syncUser: "bojan"
  };
  const remote = {
    ...todoToGoogleEvent(todo),
    id: "todo-1",
    updated: "2026-07-15T07:00:00.000Z"
  };
  const imported = todoFromGoogleEvent(remote, user, db);
  assert.equal(imported.title, "Poklici stranko");
  assert.equal(imported.clientId, client.clientId);
  assert.equal(imported.notes, "Po kosilu");
});

test("opravilo z uro postane casovni Google dogodek", () => {
  const todo = {
    id: "todo-timed-1",
    title: "Servis",
    date: "2026-07-16",
    start: "08:30",
    end: "10:15",
    status: "open",
    syncUser: "bojan"
  };
  const event = todoToGoogleEvent(todo);
  assert.deepEqual(event.start, { dateTime: "2026-07-16T08:30:00", timeZone: "Europe/Ljubljana" });
  assert.deepEqual(event.end, { dateTime: "2026-07-16T10:15:00", timeZone: "Europe/Ljubljana" });
  const imported = todoFromGoogleEvent({ ...event, id: "todo-timed-event" }, user, db, todo);
  assert.equal(imported.date, todo.date);
  assert.equal(imported.start, todo.start);
  assert.equal(imported.end, todo.end);
});

test("ura opravila zahteva datum in veljaven par od-do", () => {
  assert.equal(validateTodo({ title: "Brez ure", date: "", start: "", end: "" }), "");
  assert.equal(validateTodo({ title: "Manjka do", date: "2026-07-16", start: "08:00", end: "" }), "Vnesi obe uri: od in do.");
  assert.equal(validateTodo({ title: "Brez datuma", date: "", start: "08:00", end: "09:00" }), "Za opravilo z uro vnesi tudi datum.");
  assert.equal(validateTodo({ title: "Napacen vrstni red", date: "2026-07-16", start: "10:00", end: "09:00" }), "Ura do mora biti kasneje kot ura od.");
  assert.equal(validateTodo({ title: "Veljavno", date: "2026-07-16", start: "08:00", end: "09:00" }), "");
});

test("stabilni UUID se v Google opis ne zapise kot davcna", () => {
  const todo = {
    id: "todo-client-id", title: "Preveri", date: "2026-07-16", status: "open",
    client: "NOVAK d.o.o.", clientId: "b56af468-0b15-4af8-ae30-698105615319", syncUser: "bojan"
  };
  assert.equal(parseGoogleEventDescription(todoToGoogleEvent(todo).description).fields.davcna, "");
  assert.equal(parseGoogleEventDescription(todoToGoogleEvent(todo, "SI12345678").description).fields.davcna, "SI12345678");
});

test("statusi opravil uporabljajo dogovorjene Google barve", () => {
  const expected = {
    open: ["\u010caka", "8"],
    in_progress: ["V teku", "9"],
    execution: ["Zaklju\u010deno", "10"],
    order: ["Naro\u010di", "11"],
    order_car: ["Naro\u010di Avto", "11"],
    order_warehouse: ["Naro\u010di Sklad.", "11"],
    add_to_car: ["Dodaj v avto", "4"],
    return_and_bill: ["Vrne naj/Pora\u010dunaj", "6"],
    return: ["!!Vrni", "3"]
  };
  assert.deepEqual(Object.keys(TODO_STATUS_DEFINITIONS), Object.keys(expected));
  for (const [status, [label, colorId]] of Object.entries(expected)) {
    const todo = { id: `todo-${status}`, title: "Preveri", date: "2026-07-16", status, syncUser: "bojan" };
    const event = todoToGoogleEvent(todo);
    assert.equal(event.colorId, colorId);
    assert.equal(event.extendedProperties.private.indusApp, INDUS_GOOGLE_APP_ID);
    assert.equal(parseGoogleEventDescription(event.description).fields.status, label);
    assert.equal(todoFromGoogleEvent({ ...event, id: `event-${status}` }, user, db, todo).status, status);
  }
});

test("stara oznaka Izvedba se prebere kot Zakljuceno", () => {
  const todo = { id: "legacy-execution", title: "Preveri", date: "2026-07-16", status: "execution", syncUser: "bojan" };
  const current = todoToGoogleEvent(todo);
  const legacy = {
    ...current,
    id: "legacy-event",
    description: current.description.replace("Zaklju\u010deno", "Izvedba")
  };
  assert.equal(todoFromGoogleEvent(legacy, user, db, todo).status, "execution");
});

test("lastnistvo Google dogodka zahteva popolno INDUS oznako in ujemanje", () => {
  const item = {
    id: "todo-owned",
    title: "Preveri",
    date: "2026-07-16",
    status: "open",
    syncUser: "bojan",
    googleEventId: "event-owned",
    photos: []
  };
  const owned = { ...todoToGoogleEvent(item), id: item.googleEventId };
  assert.equal(isIndusOwnedGoogleEvent(owned, item, "bojan", "todo"), true);

  const legacy = JSON.parse(JSON.stringify(owned));
  delete legacy.extendedProperties.private.indusApp;
  assert.equal(isIndusOwnedGoogleEvent(legacy, item, "bojan", "todo"), true);
  assert.equal(isIndusOwnedGoogleEvent({ id: item.googleEventId }, item, "bojan", "todo"), false);

  const wrongUser = JSON.parse(JSON.stringify(owned));
  wrongUser.extendedProperties.private.indusUser = "ibro";
  assert.equal(isIndusOwnedGoogleEvent(wrongUser, item, "bojan", "todo"), false);
  const wrongId = JSON.parse(JSON.stringify(owned));
  wrongId.extendedProperties.private.indusId = "drug-id";
  assert.equal(isIndusOwnedGoogleEvent(wrongId, item, "bojan", "todo"), false);
});

test("neoznacenega Google dogodka ni dovoljeno spremeniti ali izbrisati", async () => {
  const item = {
    id: "todo-local",
    title: "Preveri",
    date: "2026-07-16",
    status: "open",
    syncUser: "bojan",
    googleEventId: "foreign-event",
    photos: [],
    updatedAt: "2026-07-15T08:00:00.000Z"
  };
  const calls = { get: 0, patch: 0, insert: 0, delete: 0 };
  const calendar = { events: {
    get: async () => { calls.get++; return { data: { id: "foreign-event", summary: "Zaseben dogodek" } }; },
    patch: async () => { calls.patch++; return { data: {} }; },
    insert: async () => { calls.insert++; return { data: {} }; },
    delete: async () => { calls.delete++; return { data: {} }; }
  } };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await pushGoogleItem(calendar, "calendar", item, todoToGoogleEvent(item), "todo"), false);
    assert.equal(await deleteOwnedGoogleEvent(calendar, "calendar", item, "todo"), false);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(calls.get, 2);
  assert.equal(calls.patch, 0);
  assert.equal(calls.insert, 0);
  assert.equal(calls.delete, 0);
});

test("sinhronizacija nima vec poti za uvoz neoznacenega dogodka", () => {
  const source = fs.readFileSync(path.join(__dirname, "../outputs/server.js"), "utf8");
  assert.doesNotMatch(source, /if \(event\.id && !db\.entries\.some/);
  assert.match(source, /verifyOwnedGoogleEvent/);
  assert.match(source, /calendar\.events\.get/);
});

test("enosmerni sync prepisuje samo INDUS dogodke in nikoli ne uvaza iz Google", async () => {
  const local = {
    id: "todo-local",
    title: "Naslov iz aplikacije",
    date: "2026-07-16",
    client: client.name,
    clientId: client.clientId,
    notes: "Opis iz aplikacije",
    status: "open",
    done: false,
    syncUser: "bojan",
    googleEventId: "owned-event",
    createdAt: "2026-07-15T06:00:00.000Z",
    updatedAt: "2026-07-15T08:00:00.000Z",
    photos: []
  };
  const missing = {
    ...local,
    id: "todo-missing",
    title: "Manjkajoci dogodek",
    googleEventId: "deleted-event"
  };
  const remoteEdited = {
    ...todoToGoogleEvent({ ...local, title: "Naslov spremenjen v Google", notes: "Google opis" }),
    id: "owned-event",
    updated: "2026-07-15T09:00:00.000Z"
  };
  const staleItem = { ...local, id: "todo-stale", googleEventId: "stale-event" };
  const stale = {
    ...todoToGoogleEvent(staleItem),
    id: "stale-event",
    updated: "2026-07-15T07:00:00.000Z"
  };
  const foreign = {
    id: "foreign-event",
    summary: "Zaseben Google dogodek",
    start: { date: "2026-07-17" },
    end: { date: "2026-07-18" }
  };
  const calendar = fakeCalendar([remoteEdited, stale, foreign]);
  const syncDb = { entries: [], todos: [local, missing] };

  const first = await reconcileGoogleCalendar(calendar.api, "calendar", syncDb, user);
  assert.deepEqual(first, { pushed: 2, removed: 1, pulled: 0, conflicts: 0 });
  assert.equal(local.title, "Naslov iz aplikacije");
  assert.equal(local.notes, "Opis iz aplikacije");
  assert.equal(syncDb.todos.length, 2);
  assert.deepEqual(calendar.calls.delete, ["stale-event"]);
  assert.equal(calendar.calls.patch.length, 1);
  assert.equal(calendar.calls.patch[0].eventId, "owned-event");
  assert.equal(calendar.calls.patch[0].requestBody.summary, "TODO: Naslov iz aplikacije");
  assert.equal(calendar.calls.insert.length, 1);
  assert.equal(calendar.stored.has("foreign-event"), true);
  assert.equal(calendar.stored.get("foreign-event").summary, "Zaseben Google dogodek");
  assert.equal(googleEventMatchesRequest(calendar.stored.get("owned-event"), todoToGoogleEvent(local)), true);

  const second = await reconcileGoogleCalendar(calendar.api, "calendar", syncDb, user);
  assert.deepEqual(second, { pushed: 0, removed: 0, pulled: 0, conflicts: 0 });
  assert.equal(calendar.calls.patch.length, 1);

  const source = fs.readFileSync(path.join(__dirname, "../outputs/server.js"), "utf8");
  const syncSource = source.match(/async function syncGoogleForUser[\s\S]*?\n}/)?.[0] || "";
  assert.doesNotMatch(syncSource, /entryFromGoogleEvent|todoFromGoogleEvent|pulled\+\+/);
  const html = fs.readFileSync(path.join(__dirname, "../outputs/index.html"), "utf8");
  assert.doesNotMatch(html, /prebrano iz Google/);
});

test("konflikt zmaga novejsa sprememba, nespremenjen vnos pa se ne posilja", () => {
  const synced = baseEntry();
  assert.equal(localItemChanged(synced), false);
  assert.equal(googleEventChanged({ updated: synced.googleUpdatedAt }, synced), false);
  const local = { ...synced, updatedAt: "2026-07-15T08:00:00.000Z" };
  assert.equal(localItemChanged(local), true);
  assert.equal(remoteGoogleChangeWins({ updated: "2026-07-15T07:00:00.000Z" }, local), false);
  assert.equal(remoteGoogleChangeWins({ updated: "2026-07-15T09:00:00.000Z" }, local), true);
});

test("staro polno Calendar dovoljenje se pri migraciji zavrze", () => {
  const database = {
    users: {
      bojan: { id: "bojan", email: "bojan@indus.si", google: { tokens: { refresh_token: "legacy" }, calendarId: "primary", scopeVersion: 1 } },
      marko: { email: "marko@indus.si", name: "Marko", role: "worker" }
    },
    entries: [], todos: [], debts: [], clients: []
  };
  normalizeDb(database);
  assert.equal(database.users.bojan.google.tokens, null);
  assert.equal(database.users.bojan.google.calendarId, "");
  assert.equal(database.users.bojan.google.scopeVersion, 0);
  assert.equal(database.users.marko.id, "marko");
  assert.equal(database.users.marko.role, "worker");
  assert.equal(database.users.marko.google.scopeVersion, 0);
  assert.equal(GOOGLE_CALENDAR_SCOPE_VERSION, 2);
});

test("OAuth uporablja samo namenski Calendar obseg in ne isce koledarja po imenu", () => {
  const source = fs.readFileSync(path.join(__dirname, "../outputs/server.js"), "utf8");
  assert.match(source, /auth\/calendar\.app\.created/);
  assert.doesNotMatch(source, /auth\/calendar["']/);
  assert.doesNotMatch(source, /calendarList\.list/);
});

test("nujno opravilo je oznaceno tudi v Google dogodku", () => {
  const event = todoToGoogleEvent({
    id: "urgent-1", title: "Servis", date: "2026-07-20", start: "", end: "",
    client: "Jerin", clientId: "SI12345678", notes: "", status: "open",
    urgent: true, syncUser: "ibro"
  });
  assert.equal(event.summary, "NUJNO: TODO: Servis");
  assert.match(event.description, /Nujno: DA/);
});

test("koledarski feed delavca je locen sefovski pa zdruzi dodelitve", () => {
  const shared = {
    assignmentGroupId: "group-1", title: "Skupno", date: "2026-07-20",
    start: "", end: "", client: "", notes: "", status: "open", done: false,
    urgent: false, createdBy: "bojan", createdByName: "Bojan"
  };
  const db = {
    users: { ibro: { name: "Ibro" }, bojan: { name: "Bojan" } },
    entries: [],
    todos: [
      { ...shared, id: "todo-ibro", syncUser: "ibro" },
      { ...shared, id: "todo-bojan", syncUser: "bojan" }
    ]
  };
  const worker = buildCalendarIcs(db, { userId: "ibro" });
  assert.match(worker, /X-WR-CALNAME:INDUS URE - Ibro/);
  assert.match(worker, /UID:todo-todo-ibro@indus-ure/);
  assert.doesNotMatch(worker, /todo-bojan/);
  const combined = buildCalendarIcs(db, { combined: true });
  assert.equal((combined.match(/UID:todo-group-1@indus-ure/g) || []).length, 1);
});
