const assert = require("node:assert/strict");
const test = require("node:test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./e2e/test-app.cjs");

test("customer PDF always uses billable hours; event sharing retains actual time and business values stay unchanged", { timeout: 40_000 }, async () => {
  const app = await startIsolatedTestApp();
  try {
    const login = await fetch(`${app.baseUrl}/api/test-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "bojan", password: TEST_PASSWORD }) });
    const session = await login.json();
    const headers = { "Content-Type": "application/json", Cookie: login.headers.get("set-cookie").split(";", 1)[0], "X-CSRF-Token": session.csrfToken };
    const call = (path, method = "GET", body) => fetch(app.baseUrl + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const created = await call("/api/todos", "POST", { title: "PDF hour comparison", client: "PDF hours QA", status: "execution", date: "2032-06-02", start: "08:00", end: "11:00", syncUser: "ibro", assigneeIds: ["ibro"], clientBillableMinutes: 240 });
    assert.equal(created.status, 200);
    const todo = (await created.json()).todos.find(item => item.title === "PDF hour comparison");
    assert.equal(todo.clientBillableMinutes, 240);
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const pdfText = async response => {
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /application\/pdf/);
      const document = await getDocument({ data: new Uint8Array(await response.arrayBuffer()), verbosity: 0, useSystemFonts: true }).promise;
      try {
        const pages = [];
        for (let page = 1; page <= document.numPages; page++) pages.push((await (await document.getPage(page)).getTextContent()).items.map(item => item.str).join(" "));
        return pages.join(" ");
      } finally { await document.destroy(); }
    };
    const payload = { clientId: todo.clientId, eventIds: [todo.assignmentGroupId || todo.id], attachmentIds: [], exportOptions: { hoursMode: "worker_time" } };
    const direct = await pdfText(await call("/api/client-report/pdf", "POST", payload));
    assert.match(direct, /Za obračun\s*:?\s*4 h/);
    assert.match(direct, /Skupaj\s*:?\s*4 h/);
    assert.doesNotMatch(direct, /Čas izvajalcev|3 h/);
    payload.exportOptions.hoursMode = "worker_total";
    const ticketResponse = await call("/api/client-report/pdf-ticket", "POST", payload);
    assert.equal(ticketResponse.status, 201);
    const download = await pdfText(await call((await ticketResponse.json()).downloadUrl));
    assert.match(download, /Za obračun\s*:?\s*4 h/);
    assert.doesNotMatch(download, /Čas izvajalcev|3 h/);
    const shareTicket = await call(`/api/todos/${todo.id}/share-pdf-ticket`, "POST", {});
    assert.equal(shareTicket.status, 201);
    const shared = await pdfText(await call((await shareTicket.json()).downloadUrl));
    assert.match(shared, /08:00-11:00/);
    assert.match(shared, /3 h/);
    const stored = (await (await call(`/api/todos/${todo.id}`)).json()).todo;
    assert.equal(stored.start, "08:00"); assert.equal(stored.end, "11:00"); assert.equal(stored.clientBillableMinutes, 240);
  } finally { await app.stop(); }
});

test("selected bulk client transfer merges safely, creates adhoc clients, and Undo restores only that batch; midnight survives API", { timeout: 40_000 }, async () => {
  const app = await startIsolatedTestApp();
  try {
    const login = await fetch(`${app.baseUrl}/api/test-login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ userId: "bojan", password: TEST_PASSWORD }) });
    const session = await login.json();
    const headers = { "Content-Type": "application/json", Cookie: login.headers.get("set-cookie").split(";", 1)[0], "X-CSRF-Token": session.csrfToken };
    const api = async (path, method = "GET", body) => {
      const response = await fetch(app.baseUrl + path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      return { status: response.status, data: await response.json() };
    };
    const create = async (title, client, start, end) => {
      const result = await api("/api/todos", "POST", { title, client, status: "execution", date: "2032-03-18", start, end, assigneeIds: ["ibro"], syncUser: "ibro" });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return result.data.todos.find(t => t.title === title);
    };
    const first = await create("Bulk selected", "Source", "08:00", "09:00");
    const unselected = await create("Bulk unselected", "Source", "09:00", "10:00");
    let target = await create("Target existing", "Target", "23:00", "24:00");
    assert.equal(target.end, "24:00");
    const overlap = await api("/api/todos", "POST", { title: "Overlap", client: "Target", status: "execution", date: "2032-03-18", start: "23:30", end: "24:00", assigneeIds: ["ibro"], syncUser: "ibro" });
    assert.equal(overlap.status, 409);
    target = (await api(`/api/todos/${target.id}`)).data.todo;
    const move = await api("/api/todos/bulk-client", "POST", { eventIds: [first.assignmentGroupId || first.id], clientId: target.clientId, sourceClientId: first.clientId });
    assert.equal(move.status, 200, JSON.stringify(move.data));
    assert.equal(move.data.todos.find(t => t.id === first.id).clientId, target.clientId);
    assert.equal(move.data.todos.find(t => t.id === unselected.id).clientId, unselected.clientId);
    assert.deepEqual(move.data.todos.find(t => t.id === target.id), target);
    const undo = async () => {
      const journal = await api("/api/undo-journal");
      const action = journal.data.actions.find(a => a.canUndo);
      assert.match(action.action, /paketno/);
      const result = await api(`/api/undo-journal/${action.id}`, "POST", { confirm: true });
      assert.equal(result.status, 200, JSON.stringify(result.data));
    };
    await undo();
    assert.equal((await api(`/api/todos/${first.id}`)).data.todo.clientId, first.clientId);
    assert.deepEqual((await api(`/api/todos/${target.id}`)).data.todo, target);
    const adhoc = await api("/api/todos/bulk-client", "POST", { eventIds: [first.assignmentGroupId || first.id], clientName: "New adhoc target", sourceClientId: first.clientId });
    assert.equal(adhoc.status, 200, JSON.stringify(adhoc.data));
    assert.equal(adhoc.data.client.name, "New adhoc target");
    assert.ok(adhoc.data.client.clientId);
    await undo();
    assert.equal((await api(`/api/todos/${first.id}`)).data.todo.clientId, first.clientId);
    const stale = await api("/api/todos/bulk-client", "POST", { eventIds: [first.assignmentGroupId || first.id], clientName: "Must not exist", sourceClientId: target.clientId });
    assert.equal(stale.status, 409);
    const clients = await api("/api/clients");
    assert.ok(!clients.data.clients.some(c => ["Must not exist", "New adhoc target"].includes(c.name)));
    const billed = await api("/api/client-bills", "POST", { clientId: first.clientId, eventIds: [first.assignmentGroupId || first.id] });
    assert.equal(billed.status, 201, JSON.stringify(billed.data));
    const locked = await api("/api/todos/bulk-client", "POST", { eventIds: [first.assignmentGroupId || first.id], clientName: "Locked target" });
    assert.equal(locked.status, 409);
  } finally { await app.stop(); }
});

test("API zavrne vpis ur brez stranke tudi pri urejanju in spremembi opravila v ure", { timeout: 30_000 }, async () => {
  const app = await startIsolatedTestApp();
  try {
    for (const userId of ["bojan", "ibro"]) {
      const login = await fetch(`${app.baseUrl}/api/test-login`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, password: TEST_PASSWORD })
      });
      assert.equal(login.status, 200);
      const session = await login.json();
      const headers = {
        "Content-Type": "application/json",
        Cookie: login.headers.get("set-cookie").split(";", 1)[0],
        "X-CSRF-Token": session.csrfToken
      };
      const api = async (pathname, method, body) => {
        const response = await fetch(`${app.baseUrl}${pathname}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
        return { status: response.status, data: await response.json() };
      };
      const base = { title: `Delo ${userId}`, date: "2032-02-12", endDate: "2032-02-12", start: "08:00", end: "09:00", syncUser: userId, assigneeIds: [userId] };
      for (const status of ["execution", "drive", "purchase"]) {
        for (const client of ["", "   "]) {
          const rejected = await api("/api/todos", "POST", { ...base, status, client, clientId: "" });
          assert.equal(rejected.status, 400, JSON.stringify(rejected.data));
          assert.equal(rejected.data.error, "Za vpis ur izberi stranko.");
        }
        const fake = await api("/api/todos", "POST", { ...base, status, clientId: "neobstojeca-stranka" });
        assert.equal(fake.status, 400, JSON.stringify(fake.data));
      }
      const valid = await api("/api/todos", "POST", { ...base, status: "execution", client: `Ad hoc ${userId}` });
      assert.equal(valid.status, 200, JSON.stringify(valid.data));
      const saved = valid.data.todos.find((todo) => todo.title === base.title);
      assert.ok(saved.clientId, "Ad hoc stranka se mora še vedno razrešiti in shraniti.");
      const before = await api(`/api/todos/${saved.id}`, "GET");
      const cleared = await api(`/api/todos/${saved.id}`, "PUT", { ...saved, assigneeIds: [userId], client: " ", clientId: "" });
      assert.equal(cleared.status, 400);
      assert.equal(cleared.data.error, "Za vpis ur izberi stranko.");
      const after = await api(`/api/todos/${saved.id}`, "GET");
      assert.deepEqual(after.data.todo, before.data.todo, "Zavrnjeno urejanje ne sme spreminjati obstoječega vpisa.");

      const planned = await api("/api/todos", "POST", { ...base, title: `Plan ${userId}`, start: "", end: "", status: "open" });
      assert.equal(planned.status, 200, JSON.stringify(planned.data));
      const task = planned.data.todos.find((todo) => todo.title === `Plan ${userId}`);
      const converted = await api(`/api/todos/${task.id}`, "PUT", { ...task, assigneeIds: [userId], status: "execution", start: "09:00", end: "10:00" });
      assert.equal(converted.status, 400);
      assert.equal(converted.data.error, "Za vpis ur izberi stranko.");
      const unchanged = await api(`/api/todos/${task.id}`, "GET");
      assert.equal(unchanged.data.todo.status, "open");

      const meal = await api("/api/todos", "POST", { ...base, status: "meal", start: "12:00", end: "12:30" });
      assert.equal(meal.status, 200, JSON.stringify(meal.data));
      assert.equal(meal.data.todos.find((todo) => todo.status === "meal" && todo.syncUser === userId).clientId, "");
    }
  } finally {
    await app.stop();
  }
});
