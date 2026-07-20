const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  GOOGLE_DRIVE_SCOPE_VERSION,
  buildCalendarIcs,
  cleanTodoDriveFiles,
  createSession,
  normalizeDb,
  sessionForToken,
  validateTodo
} = require("../outputs/server");

const serverPath = path.join(__dirname, "../outputs/server.js");
const htmlPath = path.join(__dirname, "../outputs/index.html");

test("Google Calendar in Sheets nista vec delovni integraciji", () => {
  const source = fs.readFileSync(serverPath, "utf8");
  assert.doesNotMatch(source, /async function syncGoogleForUser/);
  assert.doesNotMatch(source, /syncClientsWithSheets/);
  assert.doesNotMatch(source, /GOOGLE_SHEETS_ID/);
  assert.match(source, /Google Calendar sinhronizacija je bila odstranjena/);
  assert.match(source, /function buildCalendarIcs/);
  assert.match(source, /GOOGLE_GMAIL_COMPOSE_SCOPE/);
  assert.match(source, /gmail\.compose/);
});

test("stari Calendar OAuth token se odstrani, Drive token pa potrebuje trenutni scope", () => {
  const database = {
    users: {
      bojan: { id: "bojan", email: "bojan@indus.si", google: { tokens: { refresh_token: "old" }, calendarId: "old-calendar", scopeVersion: 2 } }
    },
    entries: [], todos: [], debts: [], clients: []
  };
  normalizeDb(database);
  assert.equal(database.users.bojan.google.tokens, null);
  assert.equal(database.users.bojan.google.driveScopeVersion, 0);

  const driveDatabase = {
    users: {
      bojan: { id: "bojan", email: "bojan@indus.si", google: { tokens: { refresh_token: "drive" }, connectedAt: "2026-07-18", driveScopeVersion: GOOGLE_DRIVE_SCOPE_VERSION } }
    },
    entries: [], todos: [], debts: [], clients: []
  };
  normalizeDb(driveDatabase);
  assert.equal(driveDatabase.users.bojan.google.tokens.refresh_token, "drive");
});

test("ICS ostane samo za branje in ne zahteva Google Calendar", () => {
  const ics = buildCalendarIcs({
    entries: [],
    todos: [{ id: "a", assignmentGroupId: "a", title: "Servis", date: "2026-07-20", start: "08:00", end: "09:00", status: "open", syncUser: "ibro", client: "Jerin", createdByName: "Ibro" }]
  }, { userId: "ibro", combined: false });
  assert.match(ics, /BEGIN:VCALENDAR/);
  assert.match(ics, /TODO: Servis/);
  assert.doesNotMatch(ics, /googleapis/i);
});

test("skupni koledar ohrani dogodek, dokler ima vsaj en izvajalec neobračunan vnos", () => {
  const ics = buildCalendarIcs({
    users: { ibro: { name: "Ibro" }, maja: { name: "Maja" } },
    entries: [],
    todos: [
      { id: "a", assignmentGroupId: "shared", title: "Montaža", date: "2026-07-20", start: "08:00", end: "09:00", status: "execution", syncUser: "ibro", archivedAt: "2026-07-21T12:00:00.000Z" },
      { id: "b", assignmentGroupId: "shared", title: "Montaža", date: "2026-07-20", start: "08:00", end: "09:00", status: "execution", syncUser: "maja", archivedAt: "" }
    ]
  }, { combined: true });
  assert.match(ics, /TODO: Montaža/);
});
test("Drive priponke sprejmejo Dokumente, Preglednice in upravljane videe", () => {
  const id = "1_z_1I_wX8-VR0K9rXj7BHRFwc--00Ul5";
  const videoId = "1wsPGlRaN2M7biJK4zq3KnLSYRXzJX6S1";
  const files = cleanTodoDriveFiles([
    { url: `https://docs.google.com/document/d/${id}/edit`, name: "Dokument" },
    { kind: "video", url: `https://drive.google.com/file/d/${videoId}/view`, name: "Video", mimeType: "video/mp4" },
    { url: "https://example.com/foreign", name: "Neveljavno" }
  ]);
  assert.equal(files.length, 2);
  assert.equal(files[0].kind, "document");
  assert.equal(files[1].kind, "video");
  assert.equal(files[1].mimeType, "video/mp4");
});

test("zakljuceno opravilo se brez datuma in ur zavrne", () => {
  assert.equal(validateTodo({ title: "Delo", status: "execution", date: "", start: "", end: "" }), "Za zakljuceno opravilo vnesi datum ter uro od in do.");
  assert.equal(validateTodo({ title: "Delo", status: "execution", date: "2026-07-20", start: "08:00", end: "09:00" }), "");
});

test("seja ima ločen HttpOnly token ter CSRF vrednost v strežniški bazi", () => {
  const db = { sessions: {} };
  const token = createSession(db, "bojan", 1000);
  assert.equal(token.length, 64);
  const session = sessionForToken(db, token, 1001);
  assert.equal(session.userId, "bojan");
  assert.ok(session.csrfToken.length >= 32);
});

test("PWA ne hrani API ali zasebnih prilog v service-worker predpomnilniku", () => {
  const worker = fs.readFileSync(path.join(__dirname, "../outputs/service-worker.js"), "utf8");
  const html = fs.readFileSync(htmlPath, "utf8");
  assert.match(worker, /url\.pathname\.startsWith\("\/api\/"\)/);
  assert.match(worker, /url\.pathname === "\/calendar\.ics"/);
  assert.match(html, /indexedDB\.open\(offlineTodoDbName, offlineDbVersion\)/);
  assert.match(html, /sessionExpiresAt/);
  assert.match(html, /navigator\.serviceWorker\.register\("\/service-worker\.js"\)/);
});

test("browser ZIP backup izrecno izključi OAuth in strežniške skrivnosti", () => {
  const source = fs.readFileSync(serverPath, "utf8");
  assert.match(source, /indus-ure-browser-backup-v1/);
  assert.match(source, /"OAuth tokens", "server secrets"/);
  assert.match(source, /\/api\/backup\/restore/);
  assert.match(source, /x-indus-restore-confirm/);
});