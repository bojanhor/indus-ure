const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  clientToSheetRow,
  findFirstEmptyClientRow,
  isUsableTaxId,
  normalizeTaxId,
  parseSheetClients,
  rekeyClientReferences,
  sheetAppendRange,
  sheetRowRange
} = require("../outputs/client-sync");

test("davcna stevilka je kanonicni ID stranke", () => {
  assert.equal(normalizeTaxId(" tax:si 123-45678 "), "SI12345678");
  assert.equal(isUsableTaxId("SI12345678"), true);
  assert.equal(isUsableTaxId("29433959"), true);
  assert.equal(isUsableTaxId("3956478d-92e9-425d-8a1e-3d58c7937ded"), false);
});

test("Google Sheet A-I se prebere brez spreminjanja njegove strukture", () => {
  const rows = [
    ["Srch", "Naziv stranke", "Kontakt (e-mail)", "Naslov", "Kraj", "Posta", "Drzava", "ID za ddv", "DDV"],
    ["Novak", "NOVAK d.o.o.", "info@novak.si", "Cesta 1", "Kranj", "4000 Kranj", "Slovenija", "SI12345678", "DA"],
    ["Brez", "Brez davcne", "", "", "", "", "Slovenija", "", "NE"],
    ["Prvi", "Prvi naziv", "", "", "", "", "Slovenija", "SI87654321", "DA"],
    ["Drugi", "Drugi naziv", "", "", "", "", "Slovenija", "SI87654321", "DA"]
  ];
  const result = parseSheetClients(rows);
  assert.equal(result.total, 4);
  assert.equal(result.usable, 1);
  assert.equal(result.missingTax, 1);
  assert.equal(result.duplicateTax, 2);
  assert.equal(result.clients[0].clientId, "SI12345678");
  assert.equal(result.clients[0].search, "Novak");
  assert.equal(result.clients[0].email, "info@novak.si");
  assert.equal(result.clients[1].clientId, "");
});

test("GUID reference se migrira na davcno stevilko", () => {
  const guid = "3956478d-92e9-425d-8a1e-3d58c7937ded";
  const db = {
    entries: [{ id: "e1", client: "Stari Novak", clientId: guid }],
    todos: [{ id: "t1", client: "NOVAK d.o.o.", clientId: "" }]
  };
  const previous = [{ id: guid, clientId: guid, name: "Stari Novak", search: "Novak" }];
  const clients = [{ id: "SI12345678", clientId: "SI12345678", taxId: "SI12345678", name: "NOVAK d.o.o.", search: "Stari Novak" }];
  const result = rekeyClientReferences(db, previous, clients);
  assert.equal(result.updated, 2);
  assert.equal(result.unresolved.length, 0);
  assert.equal(db.entries[0].clientId, "SI12345678");
  assert.equal(db.todos[0].clientId, "SI12345678");
});

test("nova stranka se zapise v devet stolpcev baze strank", () => {
  const row = clientToSheetRow({
    name: "NOVAK d.o.o.", search: "Novak", email: "info@novak.si", address: "Cesta 1",
    city: "Kranj", postal: "4000 Kranj", country: "Slovenija", taxId: "SI12345678", vatPayer: true
  });
  assert.deepEqual(row, ["Novak", "NOVAK d.o.o.", "info@novak.si", "Cesta 1", "Kranj", "4000 Kranj", "Slovenija", "SI12345678", "DA"]);
  assert.equal(sheetRowRange("'Baza Strank'!A:I", 12), "'Baza Strank'!A12:I12");
  assert.equal(sheetAppendRange("'Baza Strank'!A:I"), "'Baza Strank'!A:I");
  assert.equal(findFirstEmptyClientRow([["glava"], ["_ROCNI_"], ["x", "Stranka"], [null, null, null, null, null, null, null, null, "NE"]]), 4);
  assert.equal(findFirstEmptyClientRow([["glava"], ["x", "Stranka"]]), 0);
});

test("novo opravilo ponuja aliase iz prvega stolpca Google Sheeta", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="pageTodoClient"[^>]+aria-controls="todoClientSuggestions"/);
  assert.match(html, /id="todoClientSuggestions"[^>]+role="listbox"/);
  assert.match(html, /function renderTodoClientSuggestions\(\)/);
  assert.match(html, /normalizeText\(client\.search\)\.includes\(query\)/);
  assert.match(html, /function findTodoClient\(value\)/);
  assert.match(html, /client\?\.search \|\| todo\.client/);
  assert.match(html, /minmax\(240px, 1\.2fr\)/);
  assert.match(html, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(html, /event\.key === "Enter" && state\.todoClientSuggestionIndex >= 0/);
  assert.match(html, /scrollIntoView\(\{ block: "nearest" \}\)/);
});

test("spletne povezave v naslovu opravila so varno klikljive", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /todo-title">\$\{linkifyText\(todo\.title\)\}/);
  assert.match(html, /function linkifyText\(value\)/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
});

test("dropdown statusov prikaze koledarske barve za vsako moznost", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /\.todo-status option\[value="execution"\] \{ background: #51b749; color: #fff; \}/);
  assert.match(html, /\.todo-status option\[value="return"\] \{ background: #dbadff; color: #202124; \}/);
  assert.match(html, /\.todo-status option\[value="order"\]/);
  assert.match(html, /class="todo-option-\$\{status\.id\}"/);
  assert.match(html, /<option value="execution">Zaklju&#269;eno<\/option>/);
  assert.match(html, /id: "execution", label: "Zaklju\\u010deno"/);
  assert.doesNotMatch(html, />Izvedba<\/option>/);
});

test("gumba za slike sta poimenovana kot prilogi", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, />Prikaz prilog<\/button>/);
  assert.match(html, />Dodaj prilogo<input/);
  assert.doesNotMatch(html, />Fotografije<\/button>/);
  assert.doesNotMatch(html, />Dodaj foto<input/);
});

test("novo opravilo je mogoce dodeliti sebi in vec drugim delavcem", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(html, /id="pageTodoAssigneePicker"/);
  assert.match(html, /id="pageTodoAssigneeOptions"/);
  assert.match(html, /input\.type = "checkbox"/);
  assert.match(html, /assigneeIds: selectedTodoAssigneeIds\(\)/);
  assert.match(html, /dodeljeno: \$\{escapeHtml\(userDisplayName/);
  assert.match(html, /const availableUsers = \(await api\("\/api\/users"\)\)\.users/);
  assert.doesNotMatch(server, /Seznam uporabnikov je na voljo samo sefu/);
  assert.match(server, /todoAssigneesForRequest\(user, body\.assigneeIds/);
  assert.match(server, /assigneeIds\.forEach\(\(assigneeId, index\) =>/);
});
test("sef ima tabelo privzetih postavk in obracun zakljucenih opravil", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(html, /id="workerBillingRows"/);
  assert.match(html, /api\("\/api\/workers\/billing"/);
  assert.match(html, /todo\.status === "execution"/);
  assert.match(html, /class="todo-billing"/);
  assert.match(html, /class="todo-billing-hourly"/);
  assert.match(html, /class="todo-billing-km"/);
  assert.match(server, /user\.role !== "boss"[\s\S]*Samo sef lahko spreminja urne postavke delavcev/);
  assert.match(server, /todo = todoForUserRole\(user, db, db\.todos\[index\], todo\)/);
});
