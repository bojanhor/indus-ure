const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  clientToSheetRow,
  findFirstEmptyClientRow,
  isStableClientId,
  isUsableTaxId,
  normalizeTaxId,
  parseSheetClients,
  rekeyClientReferences,
  sheetAppendRange,
  sheetRowRange
} = require("../outputs/client-sync");

test("davcna stevilka je locena od stabilnega internega ID stranke", () => {
  assert.equal(normalizeTaxId(" tax:si 123-45678 "), "SI12345678");
  assert.equal(isUsableTaxId("SI12345678"), true);
  assert.equal(isUsableTaxId("29433959"), true);
  assert.equal(isUsableTaxId("3956478d-92e9-425d-8a1e-3d58c7937ded"), false);
});

test("Google Sheet A-M prebere telefonsko stevilko iz stolpca M", () => {
  const rows = [
    ["Srch", "Naziv stranke", "Kontakt (e-mail)", "Naslov", "Kraj", "Posta", "Drzava", "ID za ddv", "DDV", "TRR", "BIC", "Referenca", "Telefon"],
    ["Novak", "NOVAK d.o.o.", "info@novak.si", "Cesta 1", "Kranj", "4000 Kranj", "Slovenija", "SI12345678", "DA", "SI56...", "BACXSI22", "SI00 123", "+38640111222"],
    ["Brez", "Brez davcne", "", "", "", "", "Slovenija", "", "NE"],
    ["Prvi", "Prvi naziv", "", "", "", "", "Slovenija", "SI87654321", "DA"],
    ["Drugi", "Drugi naziv", "", "", "", "", "Slovenija", "SI87654321", "DA"]
  ];
  const result = parseSheetClients(rows);
  assert.equal(result.total, 4);
  assert.equal(result.usable, 1);
  assert.equal(result.missingTax, 1);
  assert.equal(result.duplicateTax, 2);
  assert.equal(isStableClientId(result.clients[0].clientId), true);
  assert.equal(result.clients[0].search, "Novak");
  assert.equal(result.clients[0].email, "info@novak.si");
  assert.equal(result.clients[0].phone, "+38640111222");
  assert.equal(isStableClientId(result.clients[1].clientId), true);
});

test("stara referenca se migrira na stabilni ID", () => {
  const guid = "3956478d-92e9-425d-8a1e-3d58c7937ded";
  const db = {
    entries: [{ id: "e1", client: "Stari Novak", clientId: guid }],
    todos: [{ id: "t1", client: "NOVAK d.o.o.", clientId: "" }]
  };
  const previous = [{ id: guid, clientId: guid, name: "Stari Novak", search: "Novak" }];
  const stableId = "9e512d4c-0fc7-4fd3-a723-73e277bb65c1";
  const clients = [{ id: stableId, clientId: stableId, taxId: "SI12345678", name: "NOVAK d.o.o.", search: "Stari Novak" }];
  const result = rekeyClientReferences(db, previous, clients);
  assert.equal(result.updated, 2);
  assert.equal(result.unresolved.length, 0);
  assert.equal(db.entries[0].clientId, stableId);
  assert.equal(db.todos[0].clientId, stableId);
});

test("sprememba podatkov v isti Sheets vrstici ohrani stabilni ID", () => {
  const stableId = "b56af468-0b15-4af8-ae30-698105615319";
  const existing = [{
    id: stableId, clientId: stableId, name: "Stari naziv", search: "Stari vzdevek",
    taxId: "SI12345678", sheetRow: 2, source: "google-sheets"
  }];
  const result = parseSheetClients([
    ["Vzdevek", "Naziv", "", "", "", "", "", "Davcna", "DDV"],
    ["Nov vzdevek", "Nov naziv", "", "", "", "", "", "SI87654321", "NE"]
  ], existing);
  assert.equal(result.clients[0].clientId, stableId);
  assert.equal(result.clients[0].name, "Nov naziv");
  assert.equal(result.clients[0].taxId, "SI87654321");
});

test("nova stranka se zapise v A-M brez poseganja v financne stolpce", () => {
  const existing = ["", "", "", "", "", "", "", "", "", "SI56...", "BACXSI22", "SI00 123", ""];
  const row = clientToSheetRow({
    name: "NOVAK d.o.o.", search: "Novak", email: "info@novak.si", address: "Cesta 1",
    city: "Kranj", postal: "4000 Kranj", country: "Slovenija", taxId: "SI12345678", vatPayer: true, phone: "+38640111222"
  }, existing);
  assert.deepEqual(row, ["Novak", "NOVAK d.o.o.", "info@novak.si", "Cesta 1", "Kranj", "4000 Kranj", "Slovenija", "SI12345678", "DA", "SI56...", "BACXSI22", "SI00 123", "+38640111222"]);
  assert.equal(sheetRowRange("'Baza Strank'!A:M", 12), "'Baza Strank'!A12:M12");
  assert.equal(sheetAppendRange("'Baza Strank'!A:M"), "'Baza Strank'!A:M");
  assert.equal(findFirstEmptyClientRow([["glava"], ["_ROCNI_"], ["x", "Stranka"], [null, null, null, null, null, null, null, null, "NE"]]), 4);
  assert.equal(findFirstEmptyClientRow([["glava"], ["x", "Stranka"]]), 0);
});

test("filter opravil je locen po prijavljenem uporabniku in delovnem pogledu", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /function todoSortStorageKey\(\)/);
  assert.ok(html.includes('return `${todoSortModeKey}:${userId}:${context}`;'));
  assert.match(html, /function loadTodoSortMode\(\)/);
  assert.match(html, /state\.workContext = state\.user\.role[\s\S]*?loadTodoSortMode\(\)/);
  assert.match(html, /state\.workContext = context;[\s\S]*?loadTodoSortMode\(\)/);
  assert.match(html, /localStorage\.setItem\(todoSortStorageKey\(\), state\.todoSortMode\)/);
  assert.doesNotMatch(html, /localStorage\.setItem\(todoSortModeKey, state\.todoSortMode\)/);
});

test("iskalnik ima praznjenje in vrnitev na prejsnji pogled", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="clearClientSearch"/);
  assert.match(html, /function rememberSearchReturnState\(\)/);
  assert.match(html, /view: state\.view,[\s\S]*?selectedClient: state\.selectedClient/);
  assert.match(html, /function clearClientSearchAndRestoreView\(\)/);
  assert.match(html, /\$\("clientSearch"\)\.value = "";[\s\S]*?setView\(previous\.view\)/);
  assert.match(html, /\$\("clientSearch"\)\.addEventListener\("input", handleClientSearchInput\)/);
  assert.match(html, /\$\("clearClientSearch"\)\.addEventListener\("click", clearClientSearchAndRestoreView\)/);
});

test("nova stranka sprejme e-posto in telefon ter ju pripravi za Google Sheet", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(html, /id="newClientEmail" type="email"/);
  assert.match(html, /id="newClientPhone" type="tel"/);
  assert.match(html, /email: \$\("newClientEmail"\)\.value\.trim\(\),[\s\S]*?phone: \$\("newClientPhone"\)\.value\.trim\(\)/);
  assert.match(server, /const GOOGLE_SHEETS_RANGE =[\s\S]*?replace\(\/\:\[I-L\]\$\/i, ":M"\)/);
  assert.match(server, /email: String\(input\.email \|\| ""\)\.trim\(\),[\s\S]*?phone: String\(input\.phone \|\| ""\)\.trim\(\)/);
});
test("novo opravilo ponuja aliase iz prvega stolpca Google Sheeta", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="todoFormClient"[^>]*role="combobox"/);
  assert.match(html, /id="todoFormClientSuggestions" role="listbox"/);
  assert.match(html, /<datalist id="clientList"><\/datalist>/);
  assert.match(html, /function clientSuggestionValues\(\)/);
  assert.match(html, /const alias = String\(client\?\.search \|\| client\?\.name \|\| ""\)\.trim\(\)/);
  assert.match(html, /const key = stableId \? `id:\$\{stableId\}` : normalizeText\(`\$\{alias\}\|\$\{name\}`\)/);
  assert.match(html, /state\.clients\.forEach\(add\)/);
  assert.match(html, /todoFormClient"\)\.addEventListener\("input", renderTodoClientSuggestions\)/);
  assert.match(html, /todoFormClientSuggestions"\)\.addEventListener\("pointerdown"/);
  assert.match(html, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(html, /function findTodoClient\(value\)/);
  assert.match(html, /client\?\.search \|\| todo\.client/);
});

test("spletne povezave v naslovu opravila so varno klikljive", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /todo-title">[\s\S]*?\$\{linkifyText\(todo\.title\)\}/);
  assert.match(html, /function linkifyText\(value\)/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
});

test("neposredna izbira statusov prikaze koledarske barve za vsako moznost", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /\.todo-status-execution \{ --todo-bg: #51b749; --todo-fg: #fff; \}/);
  assert.match(html, /\.todo-status-return \{ --todo-bg: #dbadff; --todo-fg: #202124;/);
  assert.match(html, /\.todo-status-meal,[\s\S]*?\.todo-status-internal \{ --todo-bg: #fbd75b; --todo-fg: #202124;/);
  assert.match(html, /class="todo-status-choice todo-status-color \$\{todoStatusClass\(status\.id\)\}"/);
  assert.doesNotMatch(html, /class="todo-option-\$\{status\.id\}"/);
  assert.match(html, /id: "execution", label: "Zaklju\\u010deno"/);
  assert.doesNotMatch(html, />Izvedba<\/option>/);
});

test("osnovni pogled priloge samo prikazuje, dodajanje pa ostane v obrazcu", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /<details class="todo-description-details todo-attachments-details">[\s\S]*?<summary>Priloge <span class="todo-details-count">/);
  assert.doesNotMatch(html, /class="secondary show-photos"/);
  assert.match(html, /id="todoFormPhotoInput"[^>]*type="file"[^>]*accept="image\/\*"[^>]*multiple/);
  assert.match(html, /id="todoFormCameraInput"[^>]*accept="image\/\*"[^>]*capture="environment"/);
  assert.match(html, /id="todoFormPdfInput"[^>]*accept="application\/pdf,\.pdf"[^>]*multiple/);
  assert.match(html, /function handleTodoAttachmentsFromInput\(event\)/);
  assert.match(html, /\["todoFormPhotoInput", "todoFormCameraInput", "todoFormPdfInput"\]\.forEach/);
  assert.match(html, /async function todoAttachmentFromFile\(file\)/);
  assert.match(html, /file\.size > 1_500_000/);
  assert.match(html, /todoAttachmentsDataLength\(state\.todoDialogPhotos\) \+ attachment\.data\.length > 4_800_000/);
  assert.match(html, /class="todo-pdf-preview"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/);
  assert.match(html, /class="todo-form-attachment-thumb"[\s\S]*?isPdfAttachment\(photo\) \? pdfThumbnailMarkup\(photo\) : `<img/);
  assert.match(html, /<dialog id="attachmentPreviewDialog">[\s\S]*?id="attachmentPreviewImage"/);
  assert.match(html, /class="todo-image-preview"[^>]*data-photo-id=/);
  assert.match(html, /class="todo-form-attachment-preview"[^>]*data-photo-id=/);
  assert.match(html, /function openAttachmentPreview\(photo, context = \{\}\)/);
  assert.match(html, /event\.target\.closest\("\.todo-image-preview"\)/);
  assert.match(html, /const image = \$\("attachmentPreviewImage"\);[\s\S]*?image\.removeAttribute\("src"\)/);
  assert.doesNotMatch(html, /class="hidden-file todo-photo-input"/);
  assert.doesNotMatch(html, />Fotografije<\/button>/);
  assert.doesNotMatch(html, />Dodaj foto<input/);
  assert.doesNotMatch(html, /Pri tem opravilu se ni fotografij/);
});

test("slikovne priloge je mogoce risarsko urediti tudi pri spremembi opravila", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /<dialog id="photoEditorDialog">[\s\S]*?id="photoEditorColor"[\s\S]*?id="photoEditorSize"[^>]*min="1"[^>]*value="1"[\s\S]*?id="photoEditorCanvas"/);
  assert.match(html, /id="photoEditorText"[\s\S]*?id="photoEditorAddText"[\s\S]*?id="photoEditorTextSize"[\s\S]*?id="photoEditorTextRotation"/);
  assert.match(html, /id="photoEditorPan"/);
  assert.match(html, /function queuePhotoEditorPinch\(metrics\)/);
  assert.match(html, /size: Number\(\$\("photoEditorSize"\)\.value\),/);
  assert.match(html, /isPdfAttachment\(photo\) \? "" : `<button class="secondary edit-todo-form-photo"/);
  assert.match(html, /function openPhotoEditor\(photo\)/);
  assert.match(html, /function drawPhotoEditorText\(context, text, selected = false\)/);
  assert.match(html, /function photoEditorTextHitTest\(point\)/);
  assert.match(html, /action: "rotate"/);
  assert.match(html, /photoEditorCanvas"\)\.addEventListener\("pointerdown"/);
  assert.match(html, /photoEditorCanvas"\)\.addEventListener\("pointermove"/);
  assert.match(html, /#photoEditorCanvas \{[\s\S]*?touch-action: none;/);
  assert.match(html, /function undoPhotoEditorAction\(\)[\s\S]*?strokes\.pop\(\)/);
  assert.match(html, /function canvasAsLimitedJpegDataUrl\(canvas, maxLength = 680_000\)/);
  assert.match(html, /state\.todoDialogPhotos = nextPhotos;[\s\S]*?renderTodoFormPhotos\(\)/);
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
  assert.match(html, /const ordered = contextTodos\(\)\.filter\(\(todo\) => !todo\.done && !todo\.urgent\)\.sort\(todoSort\)/);
  assert.match(server, /order: isOpenedTodo \? todo\.order : existing\.order/);
  assert.doesNotMatch(html, /todoReorderGroup|todoNativeDragSourceId|addEventListener\("dragstart"|draggable="\$\{reorderable/);
});

test("mobilna kartica zdruzi kontrole v dve kompaktni vrstici", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const card = html.match(/item\.innerHTML = `([\s\S]*?)`;\s*const openTodoEditor/)?.[1] || "";
  assert.ok(card);
  assert.match(card, /todo-control-stack[\s\S]*?class="drag-handle"[\s\S]*?class="todo-summary"/);
  assert.doesNotMatch(card, /aria-label="Opravljeno"/);
  assert.equal((card.match(/class="drag-handle"/g) || []).length, 1);
  assert.match(card, /todo-compact-actions[\s\S]*?todo-description-details[\s\S]*?todo-attachments-details[\s\S]*?todo-tools[\s\S]*?edit-todo[\s\S]*?delete-todo/);
  assert.match(html, /\.todo-compact-actions \{[\s\S]*?display: flex;[\s\S]*?flex-wrap: wrap;/);
  assert.match(html, /\.todo-edit-icon,\s*\.todo-delete-icon \{\s*width: 32px;\s*height: 32px;/);
});

test("kartica opravila poravna status datum in udelezence v stalne stolpce", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const card = html.match(/item\.innerHTML = `([\s\S]*?)`;\s*const openTodoEditor/)?.[1] || "";
  assert.match(html, /\.todo-primary-meta \{[\s\S]*?display: grid;[\s\S]*?grid-template-columns: 150px 170px minmax\(180px, 1fr\);/);
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
  assert.match(html, /const selectedAssignees = editing \? todoAssigneeIds\(todo\) : \[activeWorkerId\(\)\]/);
  assert.match(html, /renderTodoFormAssignees\(selectedAssignees,/);
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
test("sef ureja postavke in kilometrino samo v obrazcu opravila", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(html, /id="workerBillingRows"/);
  const workerBillingDialog = html.match(/<dialog id="workerBillingDialog"[\s\S]*?<\/dialog>/)?.[0] || "";
  assert.match(workerBillingDialog, /id="workerBillingRows"/);
  assert.match(html, /id="workerBillingBtn"/);
  assert.doesNotMatch(html, /id="bossPanel"/);
  assert.match(html, /api\("\/api\/workers\/billing"/);
  assert.match(html, /id="todoFormHourlyRate"/);
  assert.match(html, /id="todoFormBillingKm"/);
  assert.match(html, /id="todoFormClientKm"/);
  assert.match(html, /id="todoFormClientVehicle"/);
  assert.match(html, /const showClientMileage = !meal && \(isAdminView\(\) \|\| Boolean\(state\.todoHoursSourceId\) \|\| state\.todoStandaloneHours\)/);
  assert.match(html, /clientKm: 0,[\s\S]*?clientVehicle: "personal"/);
  assert.match(html, /<option value="personal">Osebni<\/option>/);
  assert.match(html, /<option value="van">Kombi<\/option>/);
  assert.doesNotMatch(html, /class="todo-billing"/);
  assert.match(server, /user\.role !== "boss"[\s\S]*Samo sef lahko spreminja urne postavke delavcev/);
  assert.match(server, /const adjusted = todoForUserRole\(user, db, existing/);
  assert.match(server, /billingHourlyRate: isOpenedTodo \? todo\.billingHourlyRate : existing\.billingHourlyRate/);
});
test("koledar ustvarja in prikazuje samo kanonicna opravila", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(html, /id="newTodoButton"[^>]*>Dodaj opravilo<\/button>/);
  assert.match(html, /function startTodoForDate\(date = ""\)[\s\S]*?openTodoDialog\(\{ date \}\)/);
  assert.match(html, /newTodoButton"\)\.addEventListener\("click", \(\) => startTodoForDate\(\)\)/);
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
test("obracun ur podpira delavski in sefovski pogled", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.doesNotMatch(html, /id="statHoursIbro"|id="statKm"|id="statUnbilled"/);
  assert.doesNotMatch(html, /function renderStats\(\)/);
  assert.match(html, /id="billingViewBtn"[^>]*>Obra&#269;uni/);
  assert.match(html, /class="panel billing-screen view-hidden"/);
  assert.match(html, /id="billingWorker"/);
  assert.match(html, /id="billingSaveDraft"/);
  assert.match(html, /id="billingConfirm"/);
  assert.match(html, /id="billingMarkPaid"/);
  assert.match(html, /function billingLiveLines\(workerId, month\)/);
  assert.match(html, /const payrollPaidTodoStatuses = new Set\(\["execution", "meal"\]\)/);
  assert.match(html, /payrollPaidTodoStatuses\.has\(todo\.status\)/);
  assert.match(html, /function billingDisplayActivities\(workerId, month, billedLines\)/);
  assert.match(html, /workAmount: billed \? Number\(billed\.workAmount \|\| 0\) : 0,/);
  assert.match(html, /const day = billingLineTotals\(payableRows\)/);
  assert.match(html, /class="billing-gap billing-open-day"/);
  assert.match(html, /function openBillingDayTimeline\(workerId, date\)[\s\S]*?openDayTimeline\(date\)/);
  assert.match(html, /class="billing-task-row \$\{todoExists \? "billing-open-task"/);
  assert.match(html, /openTodoDialog\(todo\)\.catch/);
  assert.match(html, /function changePayroll\(action\)/);
  assert.match(html, /api\("\/api\/payrolls"\)/);
  assert.doesNotMatch(html, /if \(isAdminView\(\) && view === "billing"\) view = "todos"/);
  assert.match(html, /billingViewBtn"\)\.addEventListener\("click", \(\) => setView\("billing"\)\)/);
});test("sefovski seznam privzeto prikaze zakljucena opravila", () => {
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
    "todoFormAssignees", "todoFormTask", "todoFormNotes", "todoFormUrgent", "todoFormHourlyRate",
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
  assert.match(html, /\.topbar \{\s*align-items: stretch;\s*grid-template-columns: minmax\(0, 1fr\);\s*position: static;\s*top: auto;\s*z-index: auto;/);
  assert.doesNotMatch(html, /\.main \{\s*order: 1;\s*padding-bottom: 86px;/);
});

test("opravilo ima loceno ime in dolg vecvrsticni opis", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /<label>Ime opravila\s*<input id="todoFormTask" type="text"/);
  assert.match(html, /<label>Opis del\s*<textarea id="todoFormNotes" placeholder="Opi&#353;i, kaj se bo delalo"/);
  assert.match(html, /<label>Material\s*<textarea id="todoFormMaterial"/);
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
  const settingsIndex = topbar.indexOf('class="tools-menu"');
  const monthIndex = topbar.indexOf('class="month-title calendar-view"');
  const toolsIndex = topbar.indexOf('class="tools"');
  assert.ok(switchIndex >= 0 && switchIndex < settingsIndex && settingsIndex < monthIndex && monthIndex < toolsIndex);
  assert.match(topbar, /<summary class="account-btn settings-menu-button"[^>]*aria-label="Nastavitve in orodja">[\s\S]*?<svg class="settings-icon"/);
  assert.doesNotMatch(topbar, /<span>Nastavitve<\/span>/);
  assert.match(topbar, /<div class="month-title calendar-view">[\s\S]*?class="today-calendar-btn" id="todayBtn"[\s\S]*?id="todayDayNumber"/);
  assert.match(html, /\$\("todayDayNumber"\)\.textContent = todayDate\.getDate\(\)/);
  assert.match(html, /document\.querySelectorAll\("\.calendar-view"\)[\s\S]*?view !== "calendar"/);
  assert.match(html, /\.month-title \{\s*grid-template-columns: 44px minmax\(0, 1fr\) 44px 44px;\s*gap: 8px;/);
  assert.match(html, /\.topbar-view-row \{\s*display: grid;[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 44px;/);
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

test("filtriranje po strankah je samostojen prikaz brez gumba Vse stranke", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="todoSortMode"[\s\S]*?value="client">PO STRANKAH/);
  assert.match(html, /id="todoLayout"/);
  assert.doesNotMatch(html, /id="clearClientFilter"/);
  assert.match(html, /const active = state\.todoSortMode === "client"/);
  assert.match(html, /\$\("todoLayout"\)\.classList\.toggle\("client-filter-active", active\)/);
  assert.match(html, /list\.classList\.toggle\("hidden", !active\)/);
  assert.match(html, /if \(!active\) \{[\s\S]*?state\.selectedClient = "";[\s\S]*?return;/);
  assert.match(html, /state\.selectedClient = state\.selectedClient === client \? "" : client/);
});
test("opravila imajo rocno in datumsko razvrscanje ter neobvezni uri", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="todoSortMode"[\s\S]*?value="manual">RO&#268;NO[\s\S]*?value="date">DATUMSKO/);
  assert.match(html, /value="order">NARO&#268;I/);
  assert.match(html, /value="completed">ZAKLJU&#268;ENO/);
  assert.match(html, /value="open">&#268;AKA/);
  assert.match(html, /value="in_progress">V TEKU/);
  assert.match(html, /if \(state\.todoSortMode === "date"\) return list\.filter\(\(todo\) => todo\.date\)\.sort\(todoDateSort\)/);
  assert.match(html, /function todoNeedsOrdering\(todo\)/);
  assert.match(html, /orderStatuses = new Set\(\["order", "order_car", "order_warehouse", "add_to_car"\]\)/);
  assert.match(html, /naro\u010di\(\?=\$\|\[\^\\p\{L\}\\p\{N\}_\]\)/);
  assert.match(html, /state\.todoSortMode === "order"\) return list\.filter\(\(todo\) => todoNeedsOrdering\(todo\)\)\.sort\(todoSort\)/);
  assert.match(html, /state\.todoSortMode === "open"[\s\S]*?todo\.status === "open"/);
  assert.match(html, /state\.todoSortMode === "in_progress"[\s\S]*?todo\.status === "in_progress"/);
  assert.match(html, /state\.todoSortMode === "manual"[\s\S]*?todo\.status !== "meal"/);
  assert.match(html, /state\.todoSortMode === "completed"[\s\S]*?counts\.get\(bKey\)/);
  assert.match(html, /const reorderable = state\.todoSortMode === "manual" && !todo\.done/);
  assert.match(html, /id="todoFormStart" type="time"/);
  assert.match(html, /id="todoFormEnd" type="time"/);
  assert.match(html, /start: \$\("todoFormStart"\)\.value/);
  assert.match(html, /end: \$\("todoFormEnd"\)\.value/);
  assert.match(html, /Za opravilo z uro vnesi tudi datum/);
  assert.match(html, /\$\("todoFormStart"\)\.value = ""/);
  assert.match(html, /localStorage\.setItem\(todoSortStorageKey\(\), state\.todoSortMode\)/);
  assert.match(html, /return \(orders\.length \? Math\.min\(\.\.\.orders\) : 0\) - 1/);
  assert.doesNotMatch(html, /id: "billing", label: "Obra/);
});

test("opravila so privzeti levi pogled in status se izbira neposredno brez dropdowna", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /view: "todos"/);
  const switchMarkup = html.match(/<div class="view-switch"[\s\S]*?<\/div>/)?.[0] || "";
  assert.ok(switchMarkup.indexOf('id="todosViewBtn"') < switchMarkup.indexOf('id="calendarViewBtn"'));
  assert.match(html, /id="todoFormStatusChoices"/);
  assert.match(html, /id="todoFormStatus" type="hidden"/);
  assert.doesNotMatch(html, /<select id="todoFormStatus"/);
  assert.match(html, /\.todo-status-mobile-options \{[\s\S]*?display: grid;/);
  assert.doesNotMatch(html, /id="todoFormDone"/);
  assert.match(html, /done: \$\("todoFormStatus"\)\.value === "execution"/);
});

test("nujno opravilo je na vrhu in ga ni mogoce rocno prestavljati", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="todoFormUrgent"/);
  assert.match(html, /Number\(b\.urgent\) - Number\(a\.urgent\)/);
  assert.match(html, /const reorderable = state\.todoSortMode === "manual" && !todo\.done && !todo\.urgent/);
  assert.match(html, /!source\.urgent && !target\.urgent/);
  assert.match(html, /Odstranil si sebe iz opravila[\s\S]*?ne bos vec videl ali mogel odpreti/);
});

test("sefovski pogled prikaze skupno opravilo samo enkrat po skritem ID", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /function todoEventId\(todo = \{\}\)/);
  assert.match(html, /return String\(todo\.assignmentGroupId \|\| todo\.id \|\| ""\)/);
  assert.match(html, /function uniqueTodosByEventId\(todos = \[\]\)/);
  assert.match(html, /if \(isAdminView\(\)\) return uniqueTodosByEventId\(state\.todos\)/);
  assert.match(html, /function reportTodos\(\)[\s\S]*?return contextTodos\(\)/);
  assert.match(html, /existing\.assigneeIds = \[\.\.\.new Set/);
});
test("sefovski koledar zdruzi skupna opravila in ponudi locena feeda", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /function calendarTodos\(\)/);
  assert.match(html, /const key = todo\.assignmentGroupId \|\| todo\.id/);
  assert.match(html, /return \[\.\.\.groups\.values\(\)\]/);
  assert.match(html, /id="copyWorkerCalendar"/);
  assert.match(html, /id="copyCombinedCalendar"/);
});

test("mobilni tagi in gumbi ne lomijo kartice opravila", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /@media \(max-width: 760px\)[\s\S]*?\.todo-primary-meta \{[\s\S]*?display: flex;[\s\S]*?flex-wrap: wrap;/);
  assert.match(html, /\.todo-primary-meta > \.todo-assignees-chip \{[\s\S]*?width: 100%;[\s\S]*?flex: 1 1 100%;[\s\S]*?white-space: normal;/);
  assert.match(html, /\.todo-primary-meta > \.todo-chip \{[\s\S]*?white-space: nowrap;[\s\S]*?word-break: normal;/);
  assert.match(html, /\.todo-secondary-meta > \.todo-chip \{[\s\S]*?max-width: 100%;[\s\S]*?word-break: normal;/);
  assert.match(html, /\.todo-tools \{[\s\S]*?flex-wrap: nowrap;[\s\S]*?flex: 0 0 auto;/);
});

test("klik na datum odpre dnevno casovnico z gestami in urejanjem casa", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="dayTimelineDialog"/);
  assert.match(html, /head\.addEventListener\("click", \(\) => openDayTimeline\(key\)\)/);
  assert.match(html, /for \(let minute = 0; minute <= 1440; minute \+= 30\)/);
  assert.match(html, /function dayTimelineLayouts\(todos\)/);
  assert.match(html, /data-mode = "resize-start"|dataset\.mode = "resize-start"/);
  assert.match(html, /dataset\.mode = "resize-end"/);
  assert.match(html, /function updateDayTimelineEventPointer\(event\)/);
  assert.match(html, /const delta = Math\.round\(rawDelta \/ 15\) \* 15;/);
  assert.match(html, /setDayTimelineZoom\(state\.dayTimelineMinuteHeight \* ratio/);
  assert.match(html, /Ctrl \+ kole&#353;&#269;ek/);
  assert.match(html, /await saveTodoToServer\(\{[\s\S]*?start: dayTimelineTime\(interaction\.startMinute\),[\s\S]*?end: dayTimelineTime\(interaction\.endMinute\)/);
});

test("vlecenje dogodka na dotik zahteva kratek pridrzan dotik", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /const touchHoldRequired = event\.pointerType === "touch" && mode === "move"/);
  assert.match(html, /touchReady: !touchHoldRequired/);
  assert.match(html, /setTimeout\(\(\) => \{[\s\S]*?interaction\.touchReady = true;[\s\S]*?\}, 350\)/);
});

test("stranko iz zavihka Stranke sef odpre v obrazcu za urejanje", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /<dialog id="clientEditDialog">/);
  assert.match(html, /id="clientEditId"/);
  assert.match(html, /id="clientEditName"/);
  assert.match(html, /id="clientEditTax"/);
  assert.match(html, /id="clientEditPhone"/);
  assert.match(html, /id="clientEditVatPayer"/);
  assert.match(html, /function openClientEditDialog\(clientId\)/);
  assert.match(html, /function saveClientFromDialog\(\)/);
  assert.match(html, /if \(isAdminView\(\)\) openClientEditDialog\(button\.dataset\.clientId\)/);
  assert.match(html, /\$\("clientEditForm"\)\.addEventListener\("submit"/);
});
test("globalni iskalnik vrne samo dogodke stranke pa imajo svoj zavihek", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="clientSearch" placeholder="I&#353;&#269;i opravilo ali opis"/);
  assert.match(html, /id="clientsViewBtn" type="button">Stranke<\/button>/);
  assert.doesNotMatch(html, /id="clientsViewBtn"[^>]*admin-only/);
  assert.match(html, /id="clientsSearch" placeholder="I&#353;&#269;i po bazi strank"/);
  assert.match(html, /const visibleRecords = query \? records\.filter\(\(client\) => clientMatches\(client, query\)\) : records;/);
  assert.match(html, /function renderSearch\(\)[\s\S]*?const results = contextTodos\(\)/);
  assert.doesNotMatch(html, /function renderSearch\(\)[\s\S]*?const clientResults/);
});
test("dnevna casovnica zdruzi neprekinjene delovne bloke", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /function dayWorkBlocks\(todos\)/);
  assert.match(html, /interval\.start <= previous\.end/);
  assert.match(html, /className = "day-work-blocks"/);
  assert.match(html, /\(duration \/ 60\)\.toLocaleString\("sl-SI"/);
});
test("offline vrsta opravil ostane na napravi in preprecuje tihi prepis", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(html, /indexedDB\.open\(offlineTodoDbName, 1\)/);
  assert.match(html, /function flushOfflineTodoQueue\(\)/);
  assert.match(html, /window\.addEventListener\("online", \(\) => flushOfflineTodoQueue/);
  assert.match(server, /baseUpdatedAt && baseUpdatedAt !== String\(db\.todos\[index\]\.updatedAt \|\| ""\)/);
});
test("klik na prazno dnevno casovnico pripravi enourno opravilo", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /async function openNewTodoFromDayTimeline\(clientY\)/);
  assert.match(html, /Math\.floor\(clickedMinute \/ 15\) \* 15/);
  assert.match(html, /const endMinute = startMinute \+ 60/);
  assert.match(html, /date: state\.dayTimelineDate,/);
  assert.match(html, /openNewTodoFromDayTimeline\(event\.clientY\)/);
});
test("vpis ur ne zakljuci izvornega opravila pred potrditvijo", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.doesNotMatch(server, /zakljuceno z vnosom v koledar/);
  assert.match(html, /todoHoursSourceOriginal: null/);
  assert.match(html, /const originalStatus = sourceOriginal\?\.status \|\| \(source\.status === "execution" \? "open" : source\.status\)/);
});
test("brisanje skupnega opravila odstrani vse dodelitve", () => {
  const server = fs.readFileSync(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(server, /const assignmentItems = todoAssignmentItems\(db, todo\);/);
  assert.match(server, /for \(const item of assignmentItems\) \{/);
  assert.match(server, /const removedIds = new Set\(assignmentItems\.map\(\(item\) => item\.id\)\);/);
  assert.match(server, /db\.todos = db\.todos\.filter\(\(item\) => !removedIds\.has\(item\.id\)\);/);
});
test("po vpisu ur uporabnik potrdi zakljucek projekta", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="projectCompletionDialog"/);
  assert.match(html, /id="projectCompletionTask"[\s\S]*?id="projectCompletionClient"/);
  assert.match(html, /function openProjectCompletionDialog\(sourceId\)[\s\S]*?projectCompletionTask[\s\S]*?projectCompletionClient/);
  assert.match(html, /Ali je projekt v celoti zaklju&#269;en \(tudi najmanj&#353;e podrobnosti\)\?/);
  assert.match(html, /id="deleteCompletedProject">Da, izbri&#353;i opravilo/);
  assert.match(html, /id="rescheduleProject">Ne, prestavi opravilo na drug dan/);
  assert.match(html, /if \(state\.todoHoursSourceId\) state\.todoHoursSavedSourceId = state\.todoHoursSourceId/);
  assert.match(html, /async function handleHoursProjectCompletion\(deleteProject\)/);
  assert.match(html, /await deleteTodoFromServer\(sourceId\)/);
  assert.match(html, /await openTodoDialog\(\{ \.\.\.source, status: originalStatus, done: false \}\)/);
});
