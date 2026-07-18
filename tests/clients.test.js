const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createClientId,
  isStableClientId,
  isUsableTaxId,
  normalizeStoredClient,
  normalizeTaxId,
  resolveStableClientId
} = require("../outputs/client-identity");
const { normalizeDb, validateTodo } = require("../outputs/server");

const serverPath = path.join(__dirname, "../outputs/server.js");
const storePath = path.join(__dirname, "../outputs/postgres-store.js");

test("davcna stevilka je poslovni podatek, trajni ID pa UUID", () => {
  const id = createClientId();
  assert.equal(isStableClientId(id), true);
  assert.equal(normalizeTaxId(" tax:si 123-45678 "), "SI12345678");
  assert.equal(isUsableTaxId("SI12345678"), true);
  assert.equal(isStableClientId("SI12345678"), false);
});

test("ad-hoc stranka lahko obstaja samo z vzdevkom", () => {
  const client = normalizeStoredClient({ search: "Jerin", source: "ad-hoc", createdBy: "bojan" });
  assert.equal(client.search, "Jerin");
  assert.equal(client.name, "Jerin");
  assert.equal(client.source, "ad-hoc");
  assert.equal(client.needsReview, true);
  assert.equal(isStableClientId(client.clientId), true);
});

test("stari uvozeni zapis dobi lokalni trajni ID brez zunanje povezave", () => {
  const id = "3956478d-92e9-425d-8a1e-3d58c7937ded";
  const client = normalizeStoredClient({ id, clientId: id, name: "NOVAK d.o.o.", search: "Novak", source: "external-import", sheetRow: 8 });
  assert.equal(client.clientId, id);
  assert.equal(client.source, "legacy-import");
  assert.equal("sheetRow" in client, false);
});

test("iskanje stranke vedno vrne njen lokalni ID", () => {
  const id = createClientId();
  const clients = [normalizeStoredClient({ clientId: id, name: "ABC RENT", search: "Jerin", taxId: "SI12345678" })];
  assert.equal(resolveStableClientId(clients, "jerin"), id);
  assert.equal(resolveStableClientId(clients, "SI12345678"), id);
  assert.equal(resolveStableClientId(clients, "ne obstaja"), "");
});

test("normalizacija obdrzi reference opravil na lokalno stranko", () => {
  const id = createClientId();
  const database = {
    users: {},
    entries: [],
    todos: [{ id: "task-1", title: "Servis", client: "Jerin", clientId: id, status: "open", syncUser: "ibro" }],
    debts: [],
    clients: [{ clientId: id, name: "ABC RENT", search: "Jerin", taxId: "SI12345678" }]
  };
  normalizeDb(database);
  assert.equal(database.todos[0].clientId, id);
  assert.equal(database.todos[0].client, "ABC RENT");
});

test("opravilo zahteva prepoznano stranko sele po razresitvi", () => {
  assert.equal(validateTodo({ title: "Servis", client: "Jerin", clientId: "" }, { requireClientId: true }), "Stranke ni bilo mogoce identificirati.");
  assert.equal(validateTodo({ title: "Interno", client: "", clientId: "" }, { requireClientId: true }), "");
});

test("stranke so v relacijski tabeli; Sheet API ni del streznika", () => {
  const source = fs.readFileSync(serverPath, "utf8");
  const store = fs.readFileSync(storePath, "utf8");
  assert.match(store, /create table if not exists indus_clients/);
  assert.match(store, /client_id text primary key/);
  assert.doesNotMatch(source, /GOOGLE_SHEETS/);
  assert.doesNotMatch(source, /syncClientsWithSheets/);
  assert.doesNotMatch(source, /upsertClientInSheets/);
});