const assert = require("node:assert/strict");
const http = require("node:http");
const { spawn } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("Postgres store singleton is initialized before database startup", async () => {
  const serverSource = await fs.readFile(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(serverSource, /let pgStore = null;/);
});

test("nepooblaščena Google prijava ima splošno zavrnitev in trajni zapis", async () => {
  const [server, store] = await Promise.all([
    fs.readFile(path.join(__dirname, "..", "outputs", "server.js"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "outputs", "postgres-store.js"), "utf8")
  ]);
  assert.match(server, /async function recordDeniedGoogleLogin\(email(?:,\s*req\s*=\s*null)?\)/);
  assert.match(server, /sendText\(res, 403, "Dostop je zavrnjen\.", "text\/plain"\)/);
  assert.match(server, /insert into indus_access_attempts/);
  assert.match(store, /create table if not exists indus_access_attempts/);
});

test("front-end naročila in foto urejevalnik ohranita dogovorjeni mobilni prikaz", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /function todoOrderingSort\(a, b\) \{[\s\S]*?orderedDifference/);
  assert.match(html, /ordered-confirmed/);
  assert.match(html, /photo-editor-main-tools/);
  assert.match(html, /#photoEditorDialog \{ inset: 0; width: 100vw;/);
  assert.match(html, /function attachmentLabel\(photo\) \{[\s\S]*?return "Fotografija";/);
  assert.match(html, /\$\("photoEditorTitle"\)\.textContent = "Uredi fotografijo";/);
  assert.doesNotMatch(html, /\$\("photoEditorTitle"\)\.textContent = `Uredi:/);
  assert.match(html, /photoEditorPendingActions/);
  assert.match(html, /function confirmPhotoEditorPendingOperation\(\)/);
  assert.match(html, /function cancelPhotoEditorPendingOperation\(\)/);
  assert.match(html, /function beginPhotoEditorPinch\(editor, shell\)/);
  assert.match(html, /function queuePhotoEditorPan\(editor, next\)/);
  assert.match(html, /function queueAttachmentPreviewGesture\(preview, next\)/);
  assert.match(html, /setAttachmentPreviewZoom\(preview\.zoom \* ratio, gesture\.lastCenter\)/);
  assert.match(html, /setPhotoEditorZoom\(editor\.zoom \* ratio, previous\.lastCenter\)/);
  assert.match(html, /lostpointercapture/);
  assert.doesNotMatch(html, /photoEditorCropActions|photoEditorApplyCrop|photoEditorCancelCrop/);
  assert.match(html, /todoFormFooterActions/);
  assert.match(html, /id="todoFormAttachmentMenu"/);
  assert.match(html, /id="todoFormAttachmentInput"/);
  assert.match(html, /id="todoFormCameraInput"[^>]*capture="environment"/);
  assert.match(html, /id="todoFormVideoInput"[^>]*accept="video\/\*"/);
  assert.match(html, /id="showTodoDriveLink"/);
  assert.match(html, /\.modal-head \{[\s\S]*?position: sticky;/);
  assert.match(html, /todo-form-activity-history/);
  assert.match(html, /function autosizeTodoNarrativeFields\(\)/);
  assert.match(html, /function dayTimelineDragAutoScrollVelocity\(clientY\)/);
  assert.match(html, /todoTextOrderMarker/);
  assert.match(html, /<details class="work-context-menu hidden" id="workContextControl"/);
  assert.match(html, /id="activeWorkContext"/);
  assert.match(html, /id="activeWorkContextIcon"/);
  assert.match(html, /id="workContextOptions"/);
  assert.match(html, /function renderWorkContextOptions\(contexts\)/);
  assert.match(html, /work-context-option/);
  assert.match(html, /\\u265B/);
  assert.doesNotMatch(html, /<select class="work-context-select"/);
  assert.match(html, /overscroll-behavior-y: none/);
  assert.match(html, /function panMonthTodoPointerGesture\(drag, event\)/);
  assert.match(html, /id="toolsMenuNotificationsCount"/);
  assert.match(html, /todoSortModes = \["manual", "client", "date", "order", "completed", "open", "in_progress", "imported"\]/);
  assert.match(html, /function isImportedTodo\(todo\)/);
  assert.match(html, /state\.todoSortMode === "imported" \? isImportedTodo\(todo\) : !isImportedTodo\(todo\)/);
  assert.match(html, /!isImportedTodo\(todo\) && \(includeArchived \|\| !todo\.archivedAt\)/);
  assert.match(html, /@media \(min-width: 1600px\)[\s\S]*?width: min\(100%, 1540px\)/);
  assert.match(html, /function closeWorkContextMenu\(\)/);
  assert.match(html, /closeWorkContextMenu\(\);/);
  assert.match(html, /todoSectionCollapseStorageKey/);
  assert.match(html, /todo-order-section-toggle/);
  assert.match(html, /#todoFormNotes,[\s\S]*?#todoFormMaterial \{[\s\S]*?overflow-y: hidden;/);
  assert.match(html, /function autosizeTodoNarrativeFields\(\) \{[\s\S]*?field\.style\.height = "0px";[\s\S]*?field\.scrollHeight/);
  assert.match(html, /autosizeTodoNarrativeFieldsAfterLayout\(\);/);
  assert.match(html, /id="serverStatusBtn"/);
  assert.match(html, /id="serverStatusDialog"/);
  assert.match(html, /todo-card-badges/);
  assert.match(html, /todo-card-header/);
  assert.match(html, /todo-ordering-chip/);
  assert.match(html, /\.todo-card-badges \.todo-chip \{\s*min-height: 38px;/);
  assert.match(html, /\.todo-title-row \.todo-tools \{[\s\S]*?flex-direction: column;/);
  assert.match(html, /\.main,\s*\.sidebar \{ padding: 8px; \}/);
  assert.match(html, /\.todo-title-row \.todo-client-name \{[\s\S]*?flex: 1 1 0;/);
  assert.doesNotMatch(html, /serverStatusPanel/);
});
test("ročni filter loči in omogoča razvrščanje nujnih opravil", async () => {
  const [html, server] = await Promise.all([
    fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "outputs", "server.js"), "utf8")
  ]);
  assert.match(html, /function todoManualCategory\(todo\) \{\s*if \(todo\?\.urgent\) return "urgent";/);
  assert.match(html, /const positions = \{ urgent: 0, ordering: 1, unsorted: 2, sorted: 3 \}/);
  assert.match(html, /if \(state\.todoSortMode === "manual"\) \{\s*return list\.filter\(\(todo\) => !todo\.done && !timeEntryStatusIds\.has\(todo\.status\)\)\.sort\(todoManualCategorySort\);/);
  assert.match(html, /urgent: \["Nujno", "Nujna opravila"\]/);
  assert.match(html, /const collapsible = bucket === "ordering";/);
  assert.match(html, /function appendTodoOrderSection\(items, bucket, itemCount = 0\)/);
  assert.match(html, /hiddenCountSuffix/);
  assert.match(html, /manualCategoryCounts/);
  assert.match(html, /function todoManualOrderDomain\(todo\) \{/);
  assert.match(html, /return Boolean\(todoManualOrderDomain\(todo\)\);/);
  assert.match(html, /todoManualOrderDomain\(source\) === todoManualOrderDomain\(target\)/);
  assert.match(server, /function applySharedManualTodoOrder\(db, user, input = \{\}\)/);
  assert.match(server, /sharedManualBucket/);
});

test("zahtevek za dopolnitev uporabnika jasno vodi od pošiljanja do potrditve", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="completionRequestSubmit"/);
  assert.match(html, /function setCompletionRequestSending\(sending\)/);
  assert.match(html, /Pošiljam zahtevek po e-pošti\. Počakaj na potrditev/);
  assert.match(html, /E-pošta je uspešno predana Gmailu/);
  assert.match(html, /completion-request-status\.pending/);
});

test("večdnevno opravilo ima ločen datum do in se prikaže skozi cel razpon", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="todoFormEndDate"/);
  assert.match(html, /function todoEndDate\(todo\)/);
  assert.match(html, /function todoOccursOnDate\(todo, date\)/);
  assert.match(html, /todoOccursOnDate\(todo, key\)/);
  assert.match(html, /endDate: \$\("todoFormEndDate"\)\.value/);
  assert.match(html, /function syncTodoFormEndDate/);
});

test("obračunsko obdobje samodejno sledi novemu dnevu, ročna izbira pa ostane ločena po delavcu", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /billingRangeSelections: \{\}/);
  assert.match(html, /function billingRangeSelectionForWorker\(workerId\)/);
  assert.match(html, /function billingTodayKey\(now = new Date\(\)\)/);
  assert.match(html, /function billingDateBefore\(key\)/);
  assert.match(html, /function billingMaximumSelectableDate\(now = new Date\(\)\)/);
  assert.match(html, /data-billing-range-preset="current-month"/);
  assert.match(html, /data-billing-range-preset="previous-month"/);
  assert.match(html, /data-billing-range-preset="today"/);
  assert.match(html, /data-billing-range-preset="yesterday"/);
  assert.match(html, /function billingAvailableEntryDates\(workerId, now = new Date\(\)\)/);
  assert.match(html, /function billingFallbackEntryDate\(workerId, targetDate, now = new Date\(\)\)/);
  assert.match(html, /function applyBillingQuickRange\(preset, now = new Date\(\)\)/);
  assert.match(html, /document\.querySelectorAll\("\[data-billing-range-preset\]"\)/);
  assert.match(html, /openCoversNewestRange/);
  assert.match(html, /function staleOpenBillingPayroll\(workerId\)/);
  assert.match(html, /billingStaleDraftNotice/);
  assert.match(html, /function lockedBillingFinancialIds\(workerId, field\)/);
  assert.match(html, /const from = previous \? billingDateAfter\(previous\.to\)/);
  assert.match(html, /saveBillingRangeSelection\(billingWorkerId\(\), \{ from: \$\("billingFrom"\)\.value, to: \$\("billingTo"\)\.value \}\);/);
  assert.match(html, /saveBillingRangeSelection\(state\.billingWorkerId, \{ from: button\.dataset\.from, to: button\.dataset\.to \}\);/);
});
test("obnovitev seje ohrani pogled, preverjanje v ozadju pa ne preusmeri uporabnika", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /const sessionRecoveryUiStateKey = "indus-ure-session-return"/);
  assert.match(html, /function rememberSessionRecoveryUiState\(\)/);
  assert.match(html, /function restoreSessionRecoveryUiState\(\)/);
  assert.match(html, /rememberSessionRecoveryUiState\(\);[\s\S]*?location\.replace\(data\.url\)/);
  assert.match(html, /function recoverBackgroundSession\(\)/);
  assert.match(html, /await refreshSessionSecurityContext\(\);/);
  assert.match(html, /state\.backgroundSessionLoginRequired = true/);
  assert.match(html, /if \(response\.status === 401\) \{\s*await recoverBackgroundSession\(\);/);
  assert.match(html, /state\.backgroundSessionLoginRequired \|\| document\.visibilityState/);
  assert.match(html, /const restoredSessionUi = restoreSessionRecoveryUiState\(\);/);
});
test("poročilo stranke odpre isti vpis s klikom na naslov ali zeleni povzetek", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /client-billing-title-trigger/);
  assert.match(html, /client-billing-charges-trigger/);
  assert.match(html, /open-report-todo/);
  assert.match(html, /closest\("\.open-report-todo"\)[\s\S]*?openTodoDialog\(todo\)/);
  assert.doesNotMatch(html, />Odpri vpis</);
});
test("dnevni pregled varno vleče enodnevno opravilo brez ure v 15-minutno časovnico", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /function beginDayAllDayPointerDrag\(event, todo\)/);
  assert.match(html, /touchHoldRequired = event\.pointerType === "touch"/);
  assert.match(html, /setTimeout\(\(\) => \{[\s\S]*?\}, 400\)/);
  assert.match(html, /function dayAllDayDropTarget\(clientY\)/);
  assert.match(html, /Math\.floor\([^\n]*\/ 15\) \* 15/);
  assert.match(html, /Spusti: \$\{dayTimelineTime\(target\.startMinute\)\}/);
  assert.match(html, /saveDayTimelineDraft\(interaction\.todo, dayTimelineTime\(target\.startMinute\), dayTimelineTime\(target\.endMinute\), state\.dayTimelineDate\)/);
  assert.match(html, /const movableToTimeline = !todoIsMultiDayCalendarSpan\(todo\)/);
  assert.match(html, /\.day-timeline-event\.is-drop-preview/);
});
test("večdnevno opravilo dobi povezani mesečni trak in varne kontrole vnosa", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /function todoIsMultiDayCalendarSpan\(todo\)/);
  assert.match(html, /function monthMultiDayLayout\(todos, gridStart, dayCount = 42\)/);
  assert.match(html, /function appendMonthMultiDayLanes\(day, key, weekIndex, layout\)/);
  assert.match(html, /day-multiday-event-title/);
  assert.match(html, /is-span-continuation/);
  assert.match(html, /!multiDayLayout\.todoIds\.has\(todo\.id\)/);
  assert.match(html, /function syncTodoFormDateRangeControls\(\)/);
  assert.match(html, /field\.disabled = multiDay;/);
  assert.match(html, /endDate\.disabled = Boolean\(isTimeEntry && date\)/);
  assert.match(html, /function todoPointerDragScrollBounds\(\)/);
  assert.match(html, /hasDropTarget: false/);
  assert.match(html, /if \(!active \|\| !hasDropTarget\) return;/);
});
test("imenik strank podpira več stabilnih kontaktov in varno brisanje", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /id="clientEditContacts"/);
  assert.match(html, /id="addClientEditContact"/);
  assert.match(html, /function clientEditContactDrafts\(/);
  assert.match(html, /contacts\.length > 1 && contacts\.some\(\(contact\) => !contact\.name\)/);
  assert.match(html, /function clientContactRecords\(/);
  assert.match(html, /function clientSearchFields\(/);
  assert.match(html, /function deleteClientFromDialog\(\)/);
  assert.match(html, /\/api\/clients\/\$\{encodeURIComponent\(clientId\)\}/);
  assert.match(html, /function canDeleteClient\(\)[\s\S]*?state\.user\?\.role === "boss"/);
});
function request(port, pathname, { method = "GET", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method, headers }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { responseBody += chunk; });
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: responseBody }));
    });
    request.on("error", reject);
    if (body) request.write(body);
    request.end();
  });
}

test("HTML shell has a strict nonce CSP and PWA endpoints", { timeout: 15_000 }, async () => {
  const port = 18200 + Math.floor(Math.random() * 700);
  const dataDir = path.join(os.tmpdir(), `indus-ure-http-test-${process.pid}-${Date.now()}`);
  const child = spawn(process.execPath, ["outputs/server.js"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, NODE_ENV: "development" },
    stdio: ["ignore", "ignore", "ignore"]
  });
  try {
    let health = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        health = await request(port, "/api/health");
        if (health.status === 200) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(health?.status, 200);
    const page = await request(port, "/");
    assert.equal(page.status, 200);
    assert.match(page.headers["content-security-policy"] || "", /script-src 'self' 'nonce-/);
    assert.doesNotMatch(page.headers["content-security-policy"] || "", /unsafe-inline/);
    const nonce = /<script nonce="([^"]+)"/.exec(page.body)?.[1];
    assert.ok(nonce);
    const escapedNonce = nonce.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    assert.match(page.body, new RegExp(`<style nonce="${escapedNonce}"`));
    const worker = await request(port, "/service-worker.js");
    assert.equal(worker.status, 200);
    assert.equal(worker.headers["cache-control"], "no-cache");
  } finally {
    child.kill("SIGTERM");
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});
test("lokalna testna instanca omogoča ločeno prijavo samo v testnem načinu", { timeout: 15_000 }, async () => {
  const port = 18900 + Math.floor(Math.random() * 700);
  const dataDir = path.join(os.tmpdir(), `indus-ure-test-login-${process.pid}-${Date.now()}`);
  const password = "test-only-local-password-123";
  const child = spawn(process.execPath, ["outputs/server.js"], {
    cwd: path.join(__dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      NODE_ENV: "test",
      INDUS_URE_TEST_MODE: "true",
      TEST_LOCAL_LOGIN_PASSWORD: password
    },
    stdio: ["ignore", "ignore", "ignore"]
  });
  try {
    let health = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try {
        health = await request(port, "/api/health");
        if (health.status === 200) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(health?.status, 200);
    const mode = await request(port, "/api/test-mode");
    assert.deepEqual(JSON.parse(mode.body), { enabled: true, localNetwork: "192.168.50.0/24" });
    const denied = await request(port, "/api/test-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "bojan", password: "wrong-password" })
    });
    assert.equal(denied.status, 401);
    const login = await request(port, "/api/test-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "bojan", password })
    });
    assert.equal(login.status, 200);
    const cookie = login.headers["set-cookie"]?.[0];
    assert.match(cookie || "", /indus-ure-session=/);
    const me = await request(port, "/api/me", { headers: { Cookie: cookie } });
    assert.equal(me.status, 200);
    assert.equal(JSON.parse(me.body).user.id, "bojan");
    const users = await request(port, "/api/users", { headers: { Cookie: cookie } });
    assert.equal(users.status, 200);
    assert.ok(JSON.parse(users.body).users.some((user) => user.id === "bojan"));
    assert.ok(JSON.parse(users.body).users.some((user) => user.id === "ibro"));

    const missingTodoLock = await request(port, "/api/todos/missing-id/lock", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
        "X-CSRF-Token": JSON.parse(login.body).csrfToken
      },
      body: JSON.stringify({ lockToken: "" })
    });
    assert.equal(missingTodoLock.status, 404, missingTodoLock.body);
    assert.equal(JSON.parse(missingTodoLock.body).code, "todo_not_found");
    const bossTodoHeaders = {
      "Content-Type": "application/json",
      Cookie: cookie,
      "X-CSRF-Token": JSON.parse(login.body).csrfToken
    };
    const assigned = await request(port, "/api/todos", {
      method: "POST",
      headers: bossTodoHeaders,
      body: JSON.stringify({
        date: "2026-07-27",
        client: "Test client",
        title: "Boss assigned task",
        status: "open",
        assigneeIds: ["ibro"]
      })
    });
    assert.equal(assigned.status, 200, assigned.body);
    const assignedData = JSON.parse(assigned.body);
    assert.deepEqual(assignedData.assignedTo.map((user) => user.id), ["ibro"]);
    const createdTodo = assignedData.todos.find((todo) => todo.title === "Boss assigned task");
    assert.ok(createdTodo);
    assert.equal(createdTodo.syncUser, "ibro");
    assert.equal(createdTodo.createdBy, "bojan");

    const focused = await request(port, `/api/todos/${encodeURIComponent(createdTodo.id)}`, { headers: { Cookie: cookie } });
    assert.equal(focused.status, 200, focused.body);
    const focusedData = JSON.parse(focused.body);
    assert.deepEqual(Object.keys(focusedData), ["todo"]);
    assert.equal(focusedData.todo.id, createdTodo.id);
    assert.equal(focusedData.todo.title, "Boss assigned task");

    const focusedLock = await request(port, `/api/todos/${encodeURIComponent(createdTodo.id)}/lock`, {
      method: "POST",
      headers: bossTodoHeaders,
      body: JSON.stringify({})
    });
    assert.equal(focusedLock.status, 200, focusedLock.body);
    assert.match(JSON.parse(focusedLock.body).lockToken || "", /^[a-f0-9]+$/);

    const noAssignee = await request(port, "/api/todos", {
      method: "POST",
      headers: bossTodoHeaders,
      body: JSON.stringify({
        date: "2026-07-27",
        client: "Test client",
        title: "Task without assignee",
        status: "open",
        assigneeIds: []
      })
    });
    assert.equal(noAssignee.status, 400, noAssignee.body);
    assert.match(JSON.parse(noAssignee.body).error, /vsaj enega/);

    const ibroLogin = await request(port, "/api/test-login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "ibro", password })
    });
    assert.equal(ibroLogin.status, 200, ibroLogin.body);
    const ibroCookie = ibroLogin.headers["set-cookie"]?.[0];
    const ibroTodoHeaders = {
      "Content-Type": "application/json",
      Cookie: ibroCookie,
      "X-CSRF-Token": JSON.parse(ibroLogin.body).csrfToken
    };
    const crossAssigned = await request(port, "/api/todos", {
      method: "POST",
      headers: ibroTodoHeaders,
      body: JSON.stringify({
        date: "2026-07-27",
        client: "Test client",
        title: "Worker assigned task to Bojan",
        status: "open",
        assigneeIds: ["bojan"]
      })
    });
    assert.equal(crossAssigned.status, 200, crossAssigned.body);
    const crossAssignedData = JSON.parse(crossAssigned.body);
    assert.deepEqual(crossAssignedData.assignedTo.map((user) => user.id), ["bojan"]);
    const workerCreatedForeignTask = crossAssignedData.todos.find((todo) => todo.title === "Worker assigned task to Bojan");
    assert.ok(workerCreatedForeignTask);
    const foreignHours = await request(port, "/api/todos", {
      method: "POST",
      headers: ibroTodoHeaders,
      body: JSON.stringify({
        date: "2026-07-27",
        start: "08:00",
        end: "09:00",
        client: "Test client",
        title: "Worker must not enter Bojan hours",
        status: "execution",
        assigneeIds: ["bojan"]
      })
    });
    assert.equal(foreignHours.status, 403, foreignHours.body);
    const foreignHoursUpdate = await request(port, `/api/todos/${encodeURIComponent(workerCreatedForeignTask.id)}`, {
      method: "PUT",
      headers: ibroTodoHeaders,
      body: JSON.stringify({
        ...workerCreatedForeignTask,
        date: "2026-07-27",
        start: "08:00",
        end: "09:00",
        status: "execution",
        assigneeIds: ["bojan"],
        baseUpdatedAt: workerCreatedForeignTask.updatedAt
      })
    });
    assert.equal(foreignHoursUpdate.status, 403, foreignHoursUpdate.body);
    assert.equal(JSON.parse(foreignHoursUpdate.body).error, JSON.parse(foreignHours.body).error);
    assert.match(JSON.parse(foreignHours.body).error, /ure vpiše samo sebi/);
    const ibroTodos = await request(port, "/api/todos", { headers: { Cookie: ibroCookie } });
    assert.equal(ibroTodos.status, 200, ibroTodos.body);
    assert.ok(JSON.parse(ibroTodos.body).todos.some((todo) => todo.title === "Boss assigned task"));
  } finally {
    child.kill("SIGTERM");
    await fs.rm(dataDir, { recursive: true, force: true });
  }
});

test("lastnik vidi začasno video prilogo pred shranjevanjem, drugi uporabniki ne", async () => {
  const server = await fs.readFile(path.join(__dirname, "..", "outputs", "server.js"), "utf8");
  assert.match(server, /const pendingVisible = pendingAttachmentMap\(db\)\[attachmentId\]\?\.userId === user\.id;/);
  assert.match(server, /return pendingVisible \|\| todoVisible \|\| advanceVisible;/);
});

test("completion request UI and authenticated link flow are present", async () => {
  const [server, html] = await Promise.all([
    fs.readFile(path.join(__dirname, "..", "outputs", "server.js"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8")
  ]);
  assert.match(server, /TODO_COMPLETION_REQUEST_TTL_MS/);
  assert.match(server, /\/completion-request\$/);
  assert.match(server, /gmailCompletionRequestRaw/);
  assert.match(html, /id="completionRequestDialog"/);
  assert.match(html, /id="completionRequestTodoSelect"/);
  assert.match(html, /id="completionRequestRecipients"/);
  assert.match(html, /id="requestCompletionMenuBtn"/);
  assert.match(html, /recipientUserIds/);
  assert.match(html, /function openCompletionRequestFromLink\(\)/);
  assert.match(html, /requestTodoCompletion/);
  assert.match(html, /params\.set\("return_to", returnTo\)/);
  assert.match(html, /async function openTodoFromLink\(\{ render = true \} = \{\}\) \{[\s\S]*?if \(render\) \{[\s\S]*?renderTodos\(\);[\s\S]*?renderMonth\(\);[\s\S]*?\}[\s\S]*?await openTodoDialog\(todo\);/);
  assert.doesNotMatch(html, /renderCalendar\(\)/);
  assert.match(server, /\/api\/worker-daily-report/);
  assert.match(server, /workerDigestPortalUrl/);
  assert.match(html, /id="workerDailyDigestDialog"/);
  assert.match(html, /function openWorkerDailyDigestFromLink\(\)/);
  assert.match(html, /worker-digest-worker/);
  assert.match(html, /await openWorkerDailyDigestFromLink\(\);/);
});
test("e-poštna povezava odpre ciljno opravilo pred celotnim nalaganjem", async () => {
  const [server, html, store] = await Promise.all([
    fs.readFile(path.join(__dirname, "..", "outputs", "server.js"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "outputs", "postgres-store.js"), "utf8")
  ]);
  assert.match(server, /function visibleTodoForUser\(db, user, id\) \{/);
  assert.match(server, /const todo = visibleTodoForUser\(db, user, id\);/);
  assert.match(server, /async function requireUserForFocusedTodo\(req, res\) \{/);
  assert.match(server, /const focused = await getPgStore\(\)\.focusedTodo\(id\);/);
  assert.match(server, /completionRequestGroup\(id, tokenHash\)/);
  assert.match(server, /function acquireTodoEditLockGroup\(todoId, assignmentIds, user, lockToken = "", now = Date\.now\(\)\) \{/);
  assert.match(store, /async focusedTodo\(id\) \{/);
  assert.match(store, /async completionRequestGroup\(requestedAssignmentId, tokenHash\) \{/);
  assert.match(html, /function hasTodoLink\(\) \{/);
  assert.match(html, /async function openTodoFromLink\(\{ render = true \} = \{\}\)/);
  assert.match(html, /if \(hasTodoLink\(\)\) \{[\s\S]*?await openTodoFromLink\(\{ render: false \}\);[\s\S]*?await loadAll\(\);/);
  assert.match(html, /if \(render\) \{\s*renderTodos\(\);\s*renderMonth\(\);\s*\}/);
});
test("zagonska identiteta in imenik v PostgreSQL ostaneta ozka", async () => {
  const [server, store] = await Promise.all([
    fs.readFile(path.join(__dirname, "..", "outputs", "server.js"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "outputs", "postgres-store.js"), "utf8")
  ]);
  assert.match(server, /async function requireUserForLightweightSession\(req, res\) \{/);
  assert.match(server, /if \(url\.pathname === "\/api\/me"\) \{[\s\S]*?await requireUserForLightweightSession\(req, res\)/);
  assert.match(server, /if \(url\.pathname === "\/api\/users" && req\.method === "GET"\) \{[\s\S]*?await requireUserForLightweightSession\(req, res\);[\s\S]*?getPgStore\(\)\.publicUserDirectory\(\)/);
  assert.match(store, /async sessionWithRevision\(tokenHash\) \{[\s\S]*?jsonb_build_object\(/);
  assert.match(store, /async publicUserDirectory\(\) \{/);
  assert.doesNotMatch(store, /async publicUserDirectory\(\) \{[\s\S]{0,900}this\.load\(\)/);
});

test("boss can create a task for workers directly from admin view", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /\$\("newTodoButton"\)\.classList\.remove\("hidden"\);/);
  assert.match(html, /function startTodoForDate\(date = ""\) \{\s*openTodoDialog\(\{ date, _adminCreate: isAdminView\(\) \}\);/);
  assert.match(html, /todo\._adminCreate\s*\? \[\]/);
  assert.match(html, /id="todoFormAssigneeLabel"/);
  assert.match(html, /Izberi vsaj enega izvajalca\./);
  assert.match(html, /function setTodoDialogSaving\(saving\)/);
  assert.match(html, /save\.classList\.toggle\("is-saving", Boolean\(saving\)\)/);
  assert.match(html, /todoDialogSaveInFlight\) event\.preventDefault\(\)/);
  assert.match(html, /\$\("todoDialog"\)\.addEventListener\("click", \(event\) => \{\s*if \(event\.target !== event\.currentTarget\) return;\s*event\.preventDefault\(\);\s*\}\);/);
  assert.match(html, /\$\("newTodoButton"\)\.textContent = "Dodaj opravilo";/);
  assert.match(html, /add\.title = isAdminView\(\) \? 'Dodaj opravilo'/);
  assert.doesNotMatch(html, /Dodaj opravilo za delavca/);
  assert.match(html, /function openStandaloneHoursDialog\(date = dateKey\(new Date\(\)\), \{ adminCreate = false \} = \{\}\)/);
  assert.match(html, /openStandaloneHoursDialog\(date, \{ adminCreate: isAdminView\(\) \}\)/);
});
test("calendar-only task controls are date-bound, unavailable for time entries, and excluded only from task lists", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  const materialIndex = html.indexOf('id="todoFormMaterialField"');
  const dateTimeIndex = html.indexOf('id="todoFormDateTimeSection"');
  const attachmentsIndex = html.indexOf('id="todoFormAttachments"');
  assert.ok(materialIndex >= 0 && dateTimeIndex > materialIndex && attachmentsIndex > dateTimeIndex);
  assert.match(html, /<details class="todo-form-date-time" id="todoFormDateTimeSection">/);
  assert.match(html, /placeholder="Vpi&#353;i predvideni material"/);
  assert.match(html, /<details class="todo-status-direct-field" id="todoFormStatusField">/);
  assert.match(html, /id="todoFormStatusSummary"/);
  assert.match(html, /function closeOtherTodoFormFoldouts\(opened\)/);
  assert.match(html, /\$\("todoFormStatusField"\)\.open = false;\s*\$\("todoFormDateTimeSection"\)\.open = false;/);
  assert.match(html, /#todoDialog \.todo-form-date-time-grid \{\s*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(html, /id="todoFormWarrantyField"/);
  assert.match(html, /class="todo-form-warranty" id="todoFormWarrantyField"/);
  assert.match(html, /Zahtevaj dopolnitev vnosa ur/);
  assert.match(html, /id="todoFormCalendarOnly"/);
  assert.match(html, /id="todoFormCalendarOnlyField"/);
  assert.match(html, /const isTimeEntry = timeEntryStatusIds\.has\(\$\('todoFormStatus'\)\.value\);[\s\S]*?const canShowOnlyInCalendar = Boolean\(date && !isTimeEntry\);/);
  assert.match(html, /if \(!canShowOnlyInCalendar\) calendarOnly\.checked = false;/);
  assert.match(html, /calendarOnly: Boolean\(!timeEntryStatusIds\.has\(selectedStatus\) && \$\("todoFormDate"\)\.value && \$\("todoFormCalendarOnly"\)\.checked\)/);
  assert.match(html, /!todo\.calendarOnly && \(state\.todoSortMode === "imported" \? isImportedTodo\(todo\) : !isImportedTodo\(todo\)\)/);
  assert.match(html, /function calendarTodos\(\{ includeArchived = false \} = \{\}\) \{[\s\S]*?!isImportedTodo\(todo\)/);
});

test("izvorno opravilo se prikaže samo pri res povezanem vpisu ur", async () => {
  const [html, server] = await Promise.all([
    fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "outputs", "server.js"), "utf8")
  ]);
  assert.match(html, /function sourceProjectDetailsForTodo\(todo = \{\}\)/);
  assert.match(html, /linkedToProject: Boolean\(isTimeEntry && sourceId && \(source \|\| sourceTitle\)\)/);
  assert.match(html, /sourceLookupPending: Boolean\(isTimeEntry && sourceId && !source && !state\.todoSnapshotLoaded\)/);
  assert.match(html, /box\.classList\.toggle\("hidden", !linkedToProject \|\| sourceLookupPending\);/);
  assert.match(html, /function refreshOpenTodoSourceProject\(\) \{/);
  assert.match(html, /sourceProjectTitle: source\.title \|\| ""/);
  assert.match(server, /const sourceProjectTodoId = status === "execution"/);
  assert.match(server, /sourceProjectTitle,/);
});

test("blocked form saves keep an accessible error inside the active form", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /\.form-validation-error \{[\s\S]*?position: sticky;/);
  assert.match(html, /function showFormValidationError\(formOrField, message, field = null\)/);
  assert.match(html, /node\.setAttribute\("role", "alert"\)/);
  assert.match(html, /const details = target\?\.closest\("details"\);[\s\S]*?details\.open = true;/);
  assert.match(html, /focusTarget\.scrollIntoView\?\.\(\{ block: "center"/);
  assert.match(html, /document\.addEventListener\("invalid", \(event\) => \{[\s\S]*?showFormValidationError\(form, validationMessageForField\(field\), field\)/);
  assert.match(html, /function invalidTodoForm\(message, fieldOrId = ""\)/);
  assert.match(html, /showFormValidationError\(\$\("paymentForm"\), "Vpiši znesek za izplačilo\./);
  assert.match(html, /showFormValidationError\(\$\("advanceForm"\), "Vpiši komentar za ta vnos\./);
  assert.match(html, /showFormValidationError\(\$\("quickClientForm"\), "Vpiši vsaj vzdevek stranke\./);
});

test("date sort is ascending and client view hides only order status chips", async () => {
  const html = await fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8");
  assert.match(html, /function todoDateSort\(a, b\) \{[\s\S]*?String\(a\.date\)\.localeCompare\(String\(b\.date\)\)[\s\S]*?String\(a\.start \|\| "00:00"\)\.localeCompare\(String\(b\.start \|\| "00:00"\)\)[\s\S]*?String\(a\.end \|\| "00:00"\)\.localeCompare\(String\(b\.end \|\| "00:00"\)\)/);
  assert.match(html, /const showStatusChip = !todoOrderStatusIds\.has\(todo\.status\);/);
  assert.match(html, /showStatusChip \? `<span class="todo-chip todo-status-chip todo-status-color \$\{todoStatusClass\(todo\.status\)\}">/);
});

test("logistična statusa sta ločena, Vrni nima več stare oznake in ročni filter nima odvečnega opisa", async () => {
  const [html, server] = await Promise.all([
    fs.readFile(path.join(__dirname, "..", "outputs", "index.html"), "utf8"),
    fs.readFile(path.join(__dirname, "..", "outputs", "server.js"), "utf8")
  ]);
  assert.ok(html.includes('{ id: "return_and_bill", label: "Vrne naj" }'));
  assert.ok(html.includes('{ id: "bill", label: "Pora\\u010dunaj" }'));
  assert.ok(html.includes('{ id: "return", label: "Vrni" }'));
  assert.match(html, /\.todo-status-bill \{ --todo-bg: #d96b25;/);
  assert.match(html, /"return_and_bill", "bill", "return"/);
  assert.doesNotMatch(html, /Ustaljeni vrstni red/);
  assert.match(server, /return_and_bill: \{ label: "Vrne naj", googleColorId: "4" \}/);
  assert.match(server, /bill: \{ label: "Poračunaj", googleColorId: "6" \}/);
  assert.match(server, /return: \{ label: "Vrni", googleColorId: "3" \}/);
});
