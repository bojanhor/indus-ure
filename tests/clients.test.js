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
  assert.match(html, /grid-template-columns: 140px minmax\(260px, 1\.4fr\) 160px minmax\(210px, 1fr\)/);
  assert.match(html, /\.todo-title-field \{ grid-column: 1 \/ 4; \}/);
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
  assert.match(html, /class="todo-assignee-select"/);
  assert.match(html, /saveTodoToServer\(\{ \.\.\.todo, syncUser: select\.value \}\)/);
  assert.doesNotMatch(html, /Opravilo je dodeljeno:/);
  assert.match(html, /const availableUsers = \(await api\("\/api\/users"\)\)\.users/);
  assert.doesNotMatch(server, /Seznam uporabnikov je na voljo samo sefu/);
  assert.match(server, /todoAssigneesForRequest\(user, body\.assigneeIds/);
  assert.match(server, /assigneeIds\.forEach\(\(assigneeId, index\) =>/);
});
test("sef ima tabelo privzetih postavk in obracun zakljucenih opravil", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(html, /id="workerBillingRows"/);
  const workerBillingDialog = html.match(/<dialog id="workerBillingDialog"[\s\S]*?<\/dialog>/)?.[0] || "";
  assert.match(workerBillingDialog, /id="workerBillingRows"/);
  assert.match(html, /id="workerBillingBtn"/);
  assert.doesNotMatch(html, /id="bossPanel"/);
  assert.match(html, /api\("\/api\/workers\/billing"/);
  assert.match(html, /todo\.status === "execution"/);
  assert.match(html, /class="todo-billing"/);
  assert.match(html, /class="todo-billing-hourly"/);
  assert.match(html, /class="todo-billing-km"/);
  assert.match(server, /user\.role !== "boss"[\s\S]*Samo sef lahko spreminja urne postavke delavcev/);
  assert.match(server, /todo = todoForUserRole\(user, db, previousTodo, \{ \.\.\.todo, syncUser: nextAssignee \}\)/);
});
test("nov koledarski vnos je mogoc samo skozi opravilo", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(html, /id="newTodoFromSidebar"/);
  assert.match(html, /add\.addEventListener\("click", \(\) => startTodoForDate\(key\)\)/);
  assert.match(html, /if \(!existing && !entry\.todoId\)/);
  assert.match(html, /sourceTodoId: \$\("entryTodoId"\)\.value/);
  assert.match(html, /\$\("duplicateEntry"\)\.style\.display = "none"/);
  assert.match(server, /const sourceTodo = sourceTodoForNewEntry\(db, user, entry\)/);
  assert.match(server, /Nov koledarski vnos lahko ustvaris samo iz svojega opravila/);
  assert.match(server, /status: "execution",[\s\S]*done: true/);
});
test("nastavitve in tehnicna orodja so zbrana v enem meniju", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /<details class="tools-menu" id="toolsMenu">/);
  assert.match(html, /class="tools-menu-panel"/);
  for (const id of ["accountBtn", "googleCalendar", "syncClientsBtn", "workerBillingBtn", "exportCsv", "downloadBackup", "logoutBtn"]) {
    assert.equal((html.match(new RegExp(`id="${id}"`, "g")) || []).length, 1, `ID ${id} mora biti samo enkrat`);
  }
  const bossPanel = html.match(/<section class="panel boss-panel[\s\S]*?<\/section>/)?.[0] || "";
  assert.doesNotMatch(bossPanel, /downloadBackup/);
  assert.match(html, /id="downloadBackup"[^>]*class="[^"]*admin-only|class="[^"]*admin-only[^"]*" id="downloadBackup"/);
  assert.match(html, /querySelectorAll\("button"\)[\s\S]*closeToolsMenu/);
});
test("leva barvna legenda je odstranjena", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.doesNotMatch(html, /class="legend"/);
  assert.doesNotMatch(html, /class="legend-item"/);
});
test("razlagalni AI teksti niso prikazani v uporabniskem vmesniku", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  for (const copy of [
    "Ure, stranke, material in kilometrina",
    "Pri modrih opravkih se stranka ne shrani.",
    "Podatki se zdaj shranjujejo",
    "Postavka se zajame",
    "Google Sheet Baza Strank je osnovna baza.",
    "Prijava je vezana na tvoj Google",
    "Skupni pregled, obracuni in nastavitve.",
    "Vnosi se shranjujejo za uporabnika",
    "Odpre se varna Google povezava"
  ]) {
    assert.doesNotMatch(html, new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(html, /workContextHint/);
});
test("sefovski pogled ne prikazuje statistik zacetne strani", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /<section class="stats calendar-view worker-only">/);
  assert.match(html, /querySelectorAll\("\.worker-only"\)[\s\S]*toggle\("hidden", admin\)/);
});
test("sefovski seznam privzeto prikaze zakljucena opravila", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="reportTodoCompletionFilter"/);
  assert.match(html, /<option value="completed" selected>Zaklju&#269;ena<\/option>/);
  assert.match(html, /todo\.done \|\| todo\.status === "execution"/);
  assert.match(html, /function filterReportTodos\(todos\)/);
  assert.match(html, /const todos = filterReportTodos\(reportTodos\(\)\)/);
  assert.match(html, /reportTodoCompletionFilter"\)\.addEventListener\("change", renderReport\)/);
});
test("skupni podatki se osvezujejo samodejno in ne prek rocnega gumba", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.doesNotMatch(html, /id="refreshBtn"/);
  assert.match(html, /async function autoRefreshSharedData\(\)/);
  assert.match(html, /setInterval\(autoRefreshSharedData, 15_000\)/);
  assert.match(html, /window\.addEventListener\("focus", autoRefreshSharedData\)/);
  assert.match(html, /document\.visibilityState !== "visible"/);
  assert.match(html, /document\.querySelector\("dialog\[open\]"\)/);
  assert.match(html, /active\?\.matches\('input, textarea, select/);
  assert.match(html, /await loadAll\(\)/);
});

test("urejanje koledarskega vnosa uporablja strezniski zaklep", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(html, /acquireEntryEditLockForDialog/);
  assert.match(html, /setInterval\(renewEntryEditLock, 20_000\)/);
  assert.match(html, /await pauseEntryLockHeartbeat\(\)/);
  assert.match(html, /addEventListener\("close", releaseEntryEditLockForDialog\)/);
  assert.match(html, /editLockToken/);
  assert.match(server, /const entryLockMatch = url\.pathname\.match/);
  assert.match(server, /entryLockMatch && req\.method === "POST"/);
  assert.match(server, /entryEditLockConflict\(id, user, editLockToken\)/);
  assert.match(server, /sendJson\(res, 409, \{ error: `Vnos trenutno ureja/);
  assert.match(server, /if \(activeEntryEditLock\(entry\.id\)\) continue/);
  assert.match(server, /releaseEntryEditLock\(id, user, editLockToken\)/);
});
