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
  assert.match(html, /id="todoFormClient" list="clientList"/);
  assert.match(html, /<datalist id="clientList"><\/datalist>/);
  assert.match(html, /client\.search !== client\.name/);
  assert.match(html, /<option value="\$\{escapeHtml\(client\.search\)\}" label="\$\{escapeHtml\(client\.name\)\}"><\/option>/);
  assert.match(html, /function findTodoClient\(value\)/);
  assert.match(html, /client\?\.search \|\| todo\.client/);
  assert.doesNotMatch(html, /pageTodoClient|todoClientSuggestions/);
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
  assert.match(html, /id: "execution", label: "Zaklju\\u010deno"/);
  assert.doesNotMatch(html, />Izvedba<\/option>/);
});

test("osnovni pogled priloge samo prikazuje, dodajanje pa ostane v obrazcu", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /<details class="todo-description-details todo-attachments-details">[\s\S]*?<summary>Priloge <span class="todo-details-count">/);
  assert.doesNotMatch(html, /class="secondary show-photos"/);
  assert.match(html, /id="todoFormPhotoInput"[^>]*type="file"/);
  assert.doesNotMatch(html, /class="hidden-file todo-photo-input"/);
  assert.doesNotMatch(html, />Fotografije<\/button>/);
  assert.doesNotMatch(html, />Dodaj foto<input/);
  assert.doesNotMatch(html, /Pri tem opravilu se ni fotografij/);
});

test("brisanje opravila je majhna dostopna ikona kosa", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /class="todo-delete-icon delete-todo"[^>]*aria-label="Izbri&#353;i opravilo"/);
  assert.match(html, /<svg viewBox="0 0 20 20"[^>]*aria-hidden="true">/);
  assert.doesNotMatch(html, /class="secondary delete-todo"/);
  assert.match(html, /if \(!confirm\("Izbrisem to opravilo\?"\)\) return;/);
});

test("urejanje opravila uporablja svincnik in klik na podatke kartice", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const card = html.match(/item\.innerHTML = `([\s\S]*?)`;\s*const openTodoEditor/)?.[1] || "";
  assert.match(card, /class="todo-edit-icon edit-todo"[^>]*aria-label="Uredi opravilo"/);
  assert.match(card, /todo-edit-icon edit-todo[\s\S]*?todo-delete-icon delete-todo/);
  assert.doesNotMatch(card, /<button class="primary edit-todo"[^>]*>Uredi opravilo<\/button>/);
  assert.doesNotMatch(card, /class="todo-status todo-status-color|class="todo-date"|edit-todo-assignees/);
  assert.match(html, /const todoSummary = item\.querySelector\("\.todo-summary"\);[\s\S]*?todoSummary\.addEventListener\("click"/);
  assert.match(html, /if \(event\.target\.closest\("a, summary, button, \.todo-attachments-details"\)\) return;/);
});

test("razvrscanje opravil deluje z rocajem, misjo in dotikom", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(html, /dragHandle\.addEventListener\("pointerdown"/);
  assert.match(html, /beginTodoPointerDrag\(event, item, todo\.id\)/);
  assert.match(html, /document\.elementFromPoint\(event\.clientX, event\.clientY\)/);
  assert.match(html, /function todosCanReorderTogether\(sourceId, targetId\)/);
  assert.match(html, /async function reorderTodos\(sourceId, targetId\)/);
  assert.match(html, /const orderDifference = Number\(a\.order \|\| 0\) - Number\(b\.order \|\| 0\)/);
  assert.match(html, /const ordered = contextTodos\(\)\.filter\(\(todo\) => !todo\.done\)\.sort\(todoSort\)/);
  assert.match(server, /order: isOpenedTodo \? todo\.order : existing\.order/);
  assert.doesNotMatch(html, /todoReorderGroup|todoNativeDragSourceId|addEventListener\("dragstart"|draggable="\$\{reorderable/);
});

test("kartica opravila poravna status datum in udelezence v stalne stolpce", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const card = html.match(/item\.innerHTML = `([\s\S]*?)`;\s*const openTodoEditor/)?.[1] || "";
  assert.match(html, /\.todo-primary-meta \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: 150px 110px minmax\(180px, 1fr\);/);
  assert.match(card, /todo-status-color[\s\S]*?todo-date-chip[\s\S]*?Za:/);
  assert.match(card, /todo-date-chip \$\{todo\.date \? "" : "is-empty"\}/);
  assert.match(html, /\.todo-date-chip\.is-empty \{\s*visibility: hidden;/);
  assert.doesNotMatch(card, /dodal:/i);
  assert.match(html, /Dodal: <strong>\$\{escapeHtml\(todo\.createdByName \|\| "-"\)\}/);
});

test("novo opravilo je mogoce dodeliti sebi in vec drugim delavcem", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(html, /id="todoFormAssignees"/);
  assert.match(html, /<input type="checkbox" value="\$\{escapeHtml\(user\.id\)\}"/);
  assert.match(html, /renderTodoFormAssignees\(editing \? todoAssigneeIds\(todo\) : \[activeWorkerId\(\)\]\)/);
  assert.match(html, /const assigneeIds = selectedTodoFormAssignees\(\)/);
  assert.match(html, /Za: \$\{escapeHtml\(todoAssigneeNames\(todo\)\)\}/);
  assert.doesNotMatch(html, /class="todo-assignee-select"/);
  assert.doesNotMatch(html, /Opravilo je dodeljeno:/);
  assert.match(html, /const availableUsers = \(await api\("\/api\/users"\)\)\.users/);
  assert.doesNotMatch(server, /Seznam uporabnikov je na voljo samo sefu/);
  assert.match(server, /todoAssigneesForRequest\(user, body\.assigneeIds/);
  assert.match(server, /assigneeIds\.forEach\(\(assigneeId, index\) =>/);
  assert.match(server, /const assignmentItems = todoAssignmentItems\(db, previousTodo\)/);
  assert.match(server, /const updatedGroup = \[\]/);
  assert.match(server, /db\.todos\.push\(\.\.\.updatedGroup\)/);
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
  assert.match(server, /const adjusted = todoForUserRole\(user, db, existing/);
  assert.match(server, /billingHourlyRate: isOpenedTodo \? todo\.billingHourlyRate : existing\.billingHourlyRate/);
});
test("koledar ustvarja in prikazuje samo kanonicna opravila", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(html, /id="newTodoButton"[^>]*>Dodaj opravilo<\/button>/);
  assert.match(html, /openTodoDialog\(\{ date: date \|\| dateKey\(new Date\(\)\) \}\)/);
  assert.match(html, /add\.addEventListener\("click", \(\) => startTodoForDate\(key\)\)/);
  assert.match(html, /item\.addEventListener\("click", \(\) => openTodoDialog\(todo\)\)/);
  assert.doesNotMatch(html, /<dialog id="entryDialog">/);
  assert.doesNotMatch(html, /id="saveQuick"|id="quickStart"|id="quickEnd"/);
  assert.doesNotMatch(html, /openEventForm|openCalendarTodoForm|eventDraftFromTodo/);
  assert.match(server, /const sourceTodo = sourceTodoForNewEntry\(db, user, entry\)/);
  assert.match(server, /Nov koledarski vnos lahko ustvaris samo iz svojega opravila/);
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
test("sefovski seznam omogoca grupiranje po strankah", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="reportClientGrouping"/);
  assert.match(html, /<option value="client">Po strankah<\/option>/);
  assert.match(html, /function renderReportDetailRows\(rows\)/);
  assert.match(html, /const client = String\(row\.client \|\| ""\)\.trim\(\) \|\| "Brez stranke"/);
  assert.match(html, /a\.localeCompare\(b, "sl"\)/);
  assert.match(html, /class="client-work-group-title"/);
  assert.match(html, /reportClientGrouping"\)\.addEventListener\("change", renderReport\)/);
});
test("vsi pogledi uporabljajo en sam obrazec opravila", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /<dialog id="todoDialog">/);
  assert.equal((html.match(/<dialog id="todoDialog">/g) || []).length, 1);
  for (const id of [
    "todoFormId", "todoFormDate", "todoFormClient", "todoFormStatus", "todoFormAssigneeField",
    "todoFormAssignees", "todoFormTask", "todoFormNotes", "todoFormDone", "todoFormHourlyRate",
    "todoFormBillingKm", "todoFormPhotoInput", "todoFormAudit"
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /id="newReportTodo"/);
  assert.match(html, /async function openTodoDialog\(todo = \{\}\)/);
  assert.match(html, /async function saveTodoFromDialog\(\)/);
  assert.match(html, /openTodoDialog\(todo\)/);
  assert.match(html, /class="todo-edit-icon edit-todo"/);
  assert.match(html, /item\.querySelector\("\.edit-todo"\)\.addEventListener\("click", openTodoEditor\)/);
  assert.match(html, /class="report-state-chip"/);
  assert.doesNotMatch(html, /class="invoice-flag"/);
  assert.doesNotMatch(html, /function updateInvoiceFlag/);
  assert.doesNotMatch(html, /entryDialog|entryForm|dialogTitle/);
  assert.doesNotMatch(html, /entryStart|entryEnd|entryWork|entryMaterial/);
  assert.doesNotMatch(html, /saveDialogEntry|deleteDialogEntry|duplicateDialogEntry/);
});

test("potekla seja samodejno sprozi varno ponovno Google prijavo", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");

  assert.match(html, /function recoverExpiredSession\(\)/);
  assert.match(html, /response\.status === 401 && hadSession && recoverSession/);
  assert.match(html, /requestGoogleLoginUrl\(true\)/);
  assert.match(html, /sessionStorage\.setItem\(automaticLoginAttemptKey/);
  assert.match(html, /location\.replace\(data\.url\)/);
  assert.match(server, /db\.sessions\[sessionTokenHash\(token\)\]/);
  assert.match(server, /await writeDbAsync\(db\);[\s\S]*localStorage\.setItem\("indus-ure-token"/);
  assert.doesNotMatch(server, /const sessions = new Map\(\)/);
});

test("tipka nazaj med prijavo ne odpre stare Google prijave", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");

  assert.match(html, /const loggedInHistoryStateKey = "indusUreLoggedIn"/);
  assert.match(html, /function protectLoggedInHistory\(\)/);
  assert.match(html, /history\.replaceState\(loggedInHistoryState\("base"\)/);
  assert.match(html, /history\.pushState\(loggedInHistoryState\("active"\)/);
  assert.match(html, /function showApp\(\) \{\s*protectLoggedInHistory\(\)/);
  assert.match(html, /window\.addEventListener\("popstate"/);
  assert.match(html, /event\.state\?\.\[loggedInHistoryStateKey\] !== "base"/);
});

test("mobilni preklopnik je na vrhu in ne prekriva konca strani", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");

  assert.match(html, /\.main \{\s*order: 1;\s*padding-bottom: 16px;/);
  assert.match(html, /\.sidebar \{\s*order: 2;\s*gap: 12px;\s*padding-bottom: 16px;/);
  assert.match(html, /\.view-switch \{\s*display: flex;\s*width: 100%;\s*position: static;/);
  assert.doesNotMatch(html, /\.main \{\s*order: 1;\s*padding-bottom: 86px;/);
});

test("opravilo ima loceno ime in dolg vecvrsticni opis", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /<label>Ime opravila\s*<input id="todoFormTask" type="text"/);
  assert.match(html, /<label>Opis\s*<textarea id="todoFormNotes"/);
  assert.match(html, /<details class="todo-description-details">\s*<summary>Opis<\/summary>/);
  assert.match(html, /<div class="todo-description todo-meta">\$\{linkifyText\(todo\.notes\)\}<\/div>/);
  assert.doesNotMatch(html, /<details class="todo-description-details" open>/);
  assert.match(html, /white-space: pre-wrap/);
  assert.match(html, /\.todo-description-details summary \{[\s\S]*?min-height: 42px;[\s\S]*?padding: 9px 12px;/);
  assert.match(html, /\.todo-description-details \{[\s\S]*?border: 1px solid var\(--line\);[\s\S]*?background: #f6f9f6;/);
  assert.match(html, /\.todo-description-details\[open\] summary::after \{ content: "\\2212"; \}/);
  assert.doesNotMatch(html, /pageTodoTitle|pageTodoNotes/);
  assert.doesNotMatch(html, /Kaj je treba narediti/);
});

test("pogled opravil uporablja samo gumb in skupni obrazec ima Preklici", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /class="todo-actions-bar">\s*<button class="primary" id="newTodoButton"[^>]*>Dodaj opravilo<\/button>/);
  assert.match(html, /id="cancelTodoDialog">Prekli&#269;i<\/button>/);
  assert.match(html, /\$\("cancelTodoDialog"\)\.addEventListener\("click", \(\) => \$\("todoDialog"\)\.close\(\)\)/);
  assert.doesNotMatch(html, /id="todoCreatePanel"|id="savePageTodo"|class="todo-create"/);
  assert.doesNotMatch(html, /todoFromPage|async function addTodo/);
});

test("glavni preklop pogleda je na vrhu in na telefonu ne prekriva vsebine", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const topbar = html.match(/<section class="topbar">([\s\S]*?)<\/section>/)?.[1] || "";
  assert.ok(topbar);
  assert.equal((html.match(/class="view-switch"/g) || []).length, 1);
  const switchIndex = topbar.indexOf('class="view-switch"');
  const monthIndex = topbar.indexOf('class="month-title"');
  const toolsIndex = topbar.indexOf('class="tools"');
  assert.ok(switchIndex >= 0 && switchIndex < monthIndex && monthIndex < toolsIndex);
  assert.match(html, /\.view-switch \{\s*display: flex;\s*width: 100%;\s*position: static;/);
  assert.doesNotMatch(html, /\.view-switch\s*\{[^}]*position:\s*fixed/);
  assert.doesNotMatch(html, /padding-bottom:\s*calc\(104px/);
});

test("iskanje odpira isti obrazec opravila kot koledar", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /const results = contextTodos\(\)/);
  assert.match(html, /normalizeText\(\[todo\.client, todo\.title, todo\.notes, todo\.createdByName\]/);
  assert.match(html, /results\.forEach\(\(todo\) =>/);
  assert.match(html, /item\.addEventListener\("click", \(\) => openTodoDialog\(todo\)\)/);
  assert.doesNotMatch(html, /const results = contextEntries\(\)/);
});

test("koledar in porocilo odpirata isto instanco obrazca opravila", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const directOpeners = html.match(/openTodoDialog\(todo\)/g) || [];
  assert.ok(directOpeners.length >= 3);
  assert.match(html, /item\.addEventListener\("click", \(\) => openTodoDialog\(todo\)\)/);
  assert.match(html, /class="secondary open-report-todo"/);
  assert.match(html, /const todo = state\.todos\.find/);
  assert.match(html, /openTodoDialog\(todo\)/);
  assert.doesNotMatch(html, /class="event /);
  assert.doesNotMatch(html, /open-report-entry/);
  assert.doesNotMatch(html, /function openEventForm|function openDialog/);
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

test("skupni obrazec opravila uporablja strezniski zaklep", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(html, /acquireTodoEditLockForDialog/);
  assert.match(html, /setInterval\(renewTodoEditLock, 20_000\)/);
  assert.match(html, /await pauseTodoLockHeartbeat\(\)/);
  assert.match(html, /addEventListener\("close", releaseTodoEditLockForDialog\)/);
  assert.match(html, /editLockToken/);
  assert.match(server, /const todoLockMatch = url\.pathname\.match/);
  assert.match(server, /todoLockMatch && req\.method === "POST"/);
  assert.match(server, /todoAssignmentEditLockConflict\(db, previousTodo, user, editLockToken\)/);
  assert.match(server, /sendJson\(res, 409, \{ error: `Opravilo trenutno ureja/);
  assert.match(server, /locked: Boolean\(activeTodoEditLock\(item\.id\)\)/);
  assert.match(server, /releaseTodoAssignmentEditLock\(db, previousTodo, user, editLockToken\)/);
});
