const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  createClientId,
  isStableClientId,
  isUsableTaxId,
  normalizeRegistryNumber,
  normalizeStoredClient,
  normalizeTaxId,
  resolveStableClientId
} = require("../outputs/client-identity");
const {
  normalizeDb,
  pruneUnusedAdHocClients,
  validateTodo,
  cleanClient,
  ajpesRecordToClientDraft,
  searchAjpesPublicRegister,
  validateClient,
  clientDeletionBlocker,
  deleteClientIfSafe,
  canDeleteClient,
  applyTodoClientContactSelection
} = require("../outputs/server");

const serverPath = path.join(__dirname, "../outputs/server.js");
const storePath = path.join(__dirname, "../outputs/postgres-store.js");

test("davčna številka je poslovni podatek, trajni ID pa UUID", () => {
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

test("stari uvoženi zapis dobi lokalni trajni ID brez zunanje povezave", () => {
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

test("telefon stranke se varno prevede v stabilne kontakte", () => {
  const legacy = normalizeStoredClient({ name: "ABC", phone: "+386 40 111 222" });
  assert.equal(legacy.contacts.length, 1);
  assert.equal(legacy.contacts[0].name, "");
  assert.equal(legacy.contacts[0].phone, "+386 40 111 222");
  assert.equal(isStableClientId(legacy.contacts[0].id), true);
  assert.equal(legacy.phone, "+386 40 111 222");

  const invalid = cleanClient({
    name: "ABC",
    contacts: [{ phone: "+386 40 111 222" }, { name: "Ana", phone: "+386 40 222 333" }]
  });
  assert.match(validateClient(invalid), /ime kontakta/);

  const valid = cleanClient({
    name: "ABC",
    contacts: [{ name: "Ana", phone: "+386 40 111 222" }, { name: "Bine", phone: "+386 40 222 333" }]
  });
  assert.equal(validateClient(valid), "");
  assert.equal(valid.phone, "+386 40 111 222");
  assert.equal(isStableClientId(valid.contacts[0].id), true);

  const preserved = cleanClient({ name: "ABC", phone: "+386 40 999 999" }, { existingClient: valid });
  assert.equal(preserved.contacts[0].id, valid.contacts[0].id);
  assert.equal(preserved.contacts[0].phone, "+386 40 999 999");
  assert.equal(preserved.contacts[1].id, valid.contacts[1].id);
});

test("AJPES mati\u010dna \u0161tevilka je zunanji podatek, lokalni ID pa ostane UUID", () => {
  const client = normalizeStoredClient({
    name: "Primer d.o.o.",
    search: "Primer",
    registryNumber: "5000152-000",
    source: "ajpes"
  });
  assert.equal(normalizeRegistryNumber("5000152-000"), "5000152000");
  assert.equal(normalizeRegistryNumber("123"), "");
  assert.equal(client.registryNumber, "5000152000");
  assert.equal(client.source, "ajpes");
  assert.equal(isStableClientId(client.clientId), true);
  assert.notEqual(client.clientId, client.registryNumber);
  assert.equal(resolveStableClientId([client], "5000152000"), client.clientId);
});

test("javni AJPES zapis se varno prevede v osnutek stranke", async () => {
  const sourceRecord = {
    "Mati\u010dna \u0161tevilka": "5000152000",
    "Popolno ime": "PRIMER PODJETJE d.o.o.",
    "Pravnoorganizacijska oblika": "Dru\u017eba z omejeno odgovornostjo d.o.o.",
    "Registrski organ": "Okro\u017eno sodi\u0161\u010de v Ljubljani",
    "Ulica": "Testna cesta",
    "Hi\u0161na \u0161t": "12",
    "Hi\u0161na \u0161t  dodatek": "A",
    "Po\u0161tna \u0161t": "1000",
    "Po\u0161ta": "Ljubljana",
    "Dr\u017eava": "SLOVENIJA"
  };
  const draft = ajpesRecordToClientDraft(sourceRecord);
  assert.deepEqual(draft, {
    registryNumber: "5000152000",
    name: "PRIMER PODJETJE d.o.o.",
    search: "PRIMER PODJETJE d.o.o.",
    address: "Testna cesta 12 A",
    postal: "1000",
    city: "Ljubljana",
    country: "Slovenija",
    legalForm: "Dru\u017eba z omejeno odgovornostjo d.o.o.",
    registryOffice: "Okro\u017eno sodi\u0161\u010de v Ljubljani"
  });

  let requestedUrl = null;
  const result = await searchAjpesPublicRegister("Primer", {
    fetchImpl: async (url) => {
      requestedUrl = new URL(url);
      return { ok: true, json: async () => ({ success: true, result: { records: [sourceRecord] } }) };
    }
  });
  assert.equal(requestedUrl.origin, "https://podatki.gov.si");
  assert.equal(requestedUrl.pathname, "/api/3/action/datastore_search");
  assert.equal(requestedUrl.searchParams.get("resource_id"), "beb70929-3d0d-41c6-9af2-25d525d906d3");
  assert.equal(requestedUrl.searchParams.get("q"), "Primer");
  assert.deepEqual(result, [draft]);
});

test("posodobitev stranke brez ID-jev kontaktov ohrani izbrane osebe", () => {
  const clientId = createClientId();
  const existing = normalizeStoredClient({
    clientId,
    name: "ABC",
    contacts: [{ name: "Ana", phone: "+386 40 111 222" }, { name: "Bine", phone: "+386 40 222 333" }]
  });
  const updateWithoutIds = cleanClient({
    clientId,
    name: "ABC",
    contacts: existing.contacts.map(({ name, phone }) => ({ name, phone }))
  }, { existingClient: existing });
  assert.deepEqual(updateWithoutIds.contacts.map((contact) => contact.id), existing.contacts.map((contact) => contact.id));

  const correctedName = cleanClient({
    clientId,
    name: "ABC",
    contacts: [{ name: "Ana Novak", phone: existing.contacts[0].phone }, { name: "Bine", phone: existing.contacts[1].phone }]
  }, { existingClient: existing });
  assert.equal(correctedName.contacts[0].id, existing.contacts[0].id);
  const selected = applyTodoClientContactSelection(
    { clients: [correctedName] },
    { clientId, client: "ABC", clientContactIds: [existing.contacts[0].id] },
    { strict: true }
  );
  assert.equal(selected.error, "");
  assert.deepEqual(selected.todo.clientContactIds, [existing.contacts[0].id]);
});
test("opravilo shrani samo ID-je kontaktov iz izbrane stranke", () => {
  const clientId = createClientId();
  const client = normalizeStoredClient({
    clientId,
    name: "ABC",
    contacts: [{ name: "Ana", phone: "+386 40 111 222" }, { name: "Bine", phone: "+386 40 222 333" }]
  });
  const todo = { clientId, client: "ABC", clientContactIds: [client.contacts[1].id], clientContacts: [{ name: "Ponarejeno", phone: "000" }] };
  const selected = applyTodoClientContactSelection({ clients: [client] }, todo, { strict: true });
  assert.equal(selected.error, "");
  assert.deepEqual(selected.todo.clientContactIds, [client.contacts[1].id]);
  assert.deepEqual(selected.todo.clientContacts, [{ id: client.contacts[1].id, name: "Bine", phone: "+386 40 222 333" }]);

  const rejected = applyTodoClientContactSelection({ clients: [client] }, { ...todo, clientContactIds: [createClientId()] }, { strict: true });
  assert.match(rejected.error, /ne pripada/);
});

test("stranke z aktivnimi dogodki ni mogoče izbrisati", () => {
  const clientId = createClientId();
  const database = {
    clients: [normalizeStoredClient({ clientId, name: "ABC", search: "abc" })],
    todos: [{ id: "open", clientId, client: "ABC", status: "open" }],
    entries: []
  };
  const blocker = clientDeletionBlocker(database, clientId);
  assert.equal(blocker.status, 409);
  assert.deepEqual(blocker.activeTodoIds, ["open"]);
  assert.equal(deleteClientIfSafe(database, clientId).deleted, false);
  assert.equal(canDeleteClient({ role: "worker" }), false);
  assert.equal(canDeleteClient({ role: "boss" }), true);

  database.todos[0].archivedAt = "2026-07-20T12:00:00.000Z";
  const deleted = deleteClientIfSafe(database, clientId);
  assert.equal(deleted.deleted, true);
  assert.equal(database.clients.length, 0);
});

test("točna enkratna migracija Ane Kepic preusmeri reference na Tina Petrnel", () => {
  const sourceId = createClientId();
  const targetId = createClientId();
  const database = {
    users: {},
    entries: [{ id: "legacy-entry", clientId: sourceId, client: "GOSTINSTVO IN TURIZEM ANA KEPIC S.P.", date: "2026-07-20", start: "08:00", end: "09:00", status: "unbilled" }],
    todos: [{ id: "task-1", assignmentGroupId: "event-1", title: "Servis", clientId: sourceId, client: "GOSTINSTVO IN TURIZEM ANA KEPIC S.P.", status: "execution", syncUser: "ibro", date: "2026-07-20", start: "08:00", end: "09:00" }],
    debts: [],
    payrolls: [],
    clientBills: [{ id: "bill-1", clientId: sourceId, clientName: "GOSTINSTVO IN TURIZEM ANA KEPIC S.P.", eventIds: ["event-1"], lines: [{ eventId: "event-1", todoIds: ["task-1"], title: "Servis" }] }],
    clients: [
      normalizeStoredClient({ clientId: sourceId, name: "GOSTINSTVO IN TURIZEM ANA KEPIC S.P.", search: "Tilkova ani sobe kepic" }),
      // The migration target is deliberately stored only with `s.p.` here;
      // matching against `tina petrnel sp` must still find it.
      normalizeStoredClient({ clientId: targetId, name: "TINA PETRNEL s.p.", search: "Tina" })
    ]
  };
  normalizeDb(database);
  assert.deepEqual(database.clients.map((client) => client.clientId), [targetId]);
  assert.equal(database.todos[0].clientId, targetId);
  assert.equal(database.entries[0].clientId, targetId);
  assert.equal(database.clientBills[0].clientId, targetId);
  assert.equal(database.clientBills[0].clientName, "TINA PETRNEL s.p.");
  // The next normalization is intentionally a no-op: the source client no
  // longer exists, so a restored/updated database cannot be double-migrated.
  assert.equal(normalizeDb(database).changed, false);
});
test("migracija Ane Kepic preusmeri tudi stari davcni ID in kontakt", () => {
  const targetId = createClientId();
  const sourceTaxId = "SI12345678";
  const sourceContactId = createClientId();
  const database = {
    users: {},
    entries: [],
    debts: [],
    payrolls: [],
    clientBills: [],
    todos: [{
      id: "legacy-tax-reference",
      assignmentGroupId: "legacy-tax-reference",
      title: "Servis",
      clientId: sourceTaxId,
      client: "GOSTINSTVO IN TURIZEM ANA KEPIC S.P.",
      clientContactIds: [sourceContactId],
      clientContacts: [{ id: sourceContactId, name: "Ana", phone: "+386 40 111 222" }],
      status: "execution",
      syncUser: "ibro",
      date: "2026-07-20",
      start: "08:00",
      end: "09:00"
    }],
    clients: [
      {
        clientId: sourceTaxId,
        name: "GOSTINSTVO IN TURIZEM ANA KEPIC S.P.",
        search: "Ana Kepic",
        taxId: sourceTaxId,
        contacts: [{ id: sourceContactId, name: "Ana", phone: "+386 40 111 222" }]
      },
      normalizeStoredClient({ clientId: targetId, name: "TINA PETRNEL s.p.", search: "Tina" })
    ]
  };
  normalizeDb(database);
  assert.deepEqual(database.clients.map((client) => client.clientId), [targetId]);
  assert.equal(database.todos[0].clientId, targetId);
  assert.deepEqual(database.todos[0].clientContactIds, [sourceContactId]);
  assert.equal(database.clients[0].contacts.some((contact) => contact.id === sourceContactId), true);
  assert.equal(applyTodoClientContactSelection({ clients: database.clients }, database.todos[0], { strict: true }).error, "");
});
test("normalizacija obdrži reference opravil na lokalno stranko", () => {
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

test("opravilo zahteva prepoznano stranko šele po razrešitvi", () => {
  assert.equal(validateTodo({ title: "Servis", client: "Jerin", clientId: "" }, { requireClientId: true }), "Stranke ni bilo mogoče identificirati.");
  assert.equal(validateTodo({ title: "Interno", client: "", clientId: "" }, { requireClientId: true }), "");
});

test("stranke so v relacijski tabeli; Sheet API ni del strežnika", () => {
  const source = fs.readFileSync(serverPath, "utf8");
  const store = fs.readFileSync(storePath, "utf8");
  assert.match(store, /create table if not exists indus_clients/);
  assert.match(store, /client_id text primary key/);
  assert.doesNotMatch(source, /GOOGLE_SHEETS/);
  assert.doesNotMatch(source, /syncClientsWithSheets/);
  assert.doesNotMatch(source, /upsertClientInSheets/);
});
test("nevezana ad-hoc stranka se odstrani, povezana pa ostane", () => {
  const usedId = createClientId();
  const staleId = createClientId();
  const database = {
    todos: [{ id: "task-1", clientId: usedId, client: "Jerin" }],
    entries: [],
    clients: [
      normalizeStoredClient({ clientId: usedId, name: "ABC RENT", search: "Jerin", source: "ad-hoc" }),
      normalizeStoredClient({ clientId: staleId, name: "Začasna", search: "Začasna", source: "ad-hoc" })
    ]
  };
  assert.equal(pruneUnusedAdHocClients(database), true);
  assert.deepEqual(database.clients.map((client) => client.clientId), [usedId]);
});
