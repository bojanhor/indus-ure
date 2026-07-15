const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  GOOGLE_CALENDAR_SCOPE_VERSION,
  entryFromGoogleEvent,
  entryToGoogleEvent,
  googleEventChanged,
  localItemChanged,
  normalizeDb,
  parseGoogleEventDescription,
  remoteGoogleChangeWins,
  todoFromGoogleEvent,
  todoToGoogleEvent
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

test("rocno ustvarjen celodnevni Google dogodek postane opravilo", () => {
  const remote = {
    id: "todo-1",
    summary: "TODO: Poklici stranko",
    description: todoToGoogleEvent({ id: "x", title: "Poklici stranko", date: "2026-07-16", client: client.name, clientId: client.clientId, notes: "Po kosilu", status: "open" }).description,
    start: { date: "2026-07-16" },
    end: { date: "2026-07-17" },
    updated: "2026-07-15T07:00:00.000Z"
  };
  const imported = todoFromGoogleEvent(remote, user, db);
  assert.equal(imported.title, "Poklici stranko");
  assert.equal(imported.clientId, client.clientId);
  assert.equal(imported.notes, "Po kosilu");
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
