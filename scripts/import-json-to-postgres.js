"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const args = process.argv.slice(2);
const sourceArg = args.find((arg) => arg !== "--force");
const force = args.includes("--force");
const databaseUrl = process.env.DATABASE_URL || "";

if (!sourceArg || !databaseUrl) {
  console.error("Uporaba: DATABASE_URL=... npm run import:json -- /varna/pot/db.json [--force]");
  process.exit(2);
}

const source = path.resolve(sourceArg);
const raw = fs.readFileSync(source, "utf8").replace(/^\uFEFF/, "");
const data = JSON.parse(raw);
const recognized = ["users", "entries", "todos", "clients", "debts", "settings", "billingLocks"];

if (!data || Array.isArray(data) || typeof data !== "object" || !recognized.some((key) => key in data)) {
  throw new Error("Datoteka ni prepoznana kot celoten INDUS URE db.json.");
}

const localDatabase = /localhost|127\.0\.0\.1/.test(databaseUrl);
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: localDatabase ? false : { rejectUnauthorized: true }
});

async function main() {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(`
      create table if not exists app_state (
        id text primary key,
        data jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
    const existing = await client.query("select 1 from app_state where id = $1", ["main"]);
    if (existing.rowCount && !force) {
      throw new Error("Vrstica app_state/main ze obstaja. Najprej naredi backup; nato ponovi z --force.");
    }
    await client.query(
      `insert into app_state (id, data, updated_at)
       values ($1, $2::jsonb, now())
       on conflict (id) do update set data = excluded.data, updated_at = now()`,
      ["main", JSON.stringify(data)]
    );
    await client.query("commit");
    console.log("Uvoz koncan:", {
      entries: Array.isArray(data.entries) ? data.entries.length : 0,
      todos: Array.isArray(data.todos) ? data.todos.length : 0,
      clients: Array.isArray(data.clients) ? data.clients.length : 0,
      debts: Array.isArray(data.debts) ? data.debts.length : 0
    });
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
