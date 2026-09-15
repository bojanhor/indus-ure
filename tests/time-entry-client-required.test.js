const assert = require("node:assert/strict");
const test = require("node:test");
const { TEST_PASSWORD, startIsolatedTestApp } = require("./e2e/test-app.cjs");

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
