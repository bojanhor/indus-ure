"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const KEY = "planning_calendar_sync_v1";

// Operational state is intentionally outside application snapshots, Undo and
// the sanitized recovery export. It cannot overwrite a concurrent work entry.
// A separate pool never holds the business mutation queue. One connection
// holds the advisory lock; the other serves quick read-only status requests.
function createCalendarSyncStore({ databaseUrl = "", file }) {
  let pool;
  let queue = Promise.resolve();
  function getPool() {
    if (!pool) {
      const { Pool } = require("pg");
      pool = new Pool({ connectionString: databaseUrl, max: 2,
        ssl: /localhost|127\.0\.0\.1/.test(databaseUrl) ? false : { rejectUnauthorized: false },
        idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000, application_name: "indus-planning-calendar" });
    }
    return pool;
  }
  async function load(client) {
    if (databaseUrl) return (await (client || getPool()).query("select data from indus_meta where key = $1", [KEY])).rows[0]?.data || {};
    try { return JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
  }
  async function save(value, client) {
    if (databaseUrl) {
      await client.query("insert into indus_meta (key, data) values ($1, $2::jsonb) on conflict (key) do update set data = excluded.data, updated_at = now()", [KEY, JSON.stringify(value)]);
    } else {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(temporary, file);
    }
  }
  function locked(work) {
    const operation = queue.then(async () => {
      let client;
      if (databaseUrl) {
        client = await getPool().connect();
        let lock;
        try { lock = await client.query("select pg_try_advisory_lock(8123, 91601) as locked"); }
        catch (error) { client.release(error); throw error; }
        if (!lock.rows[0].locked) { client.release(); return; }
      }
      try { return await work({ load: () => load(client), save: value => save(value, client) }); }
      finally {
        if (client) { try { await client.query("select pg_advisory_unlock(8123, 91601)"); } finally { client.release(); } }
      }
    });
    queue = operation.catch(() => {});
    return operation;
  }
  return { load: () => load(), locked, close: async () => { await queue; if (pool) await pool.end(); } };
}

module.exports = { createCalendarSyncStore, KEY };
