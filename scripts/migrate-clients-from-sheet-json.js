"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { parseSheetClients, rekeyClientReferences } = require("../outputs/client-sync");

const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : "";
const databaseUrl = process.env.DATABASE_URL || "";

if (!inputPath || !fs.existsSync(inputPath)) {
  console.error("Uporaba: node scripts/migrate-clients-from-sheet-json.js /pot/sheet-rows.json");
  process.exit(1);
}
if (!databaseUrl) {
  console.error("Manjka DATABASE_URL.");
  process.exit(1);
}

async function main() {
  const rows = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  if (!Array.isArray(rows) || !Array.isArray(rows[0])) throw new Error("Vhod mora biti JSON polje vrstic Google Sheeta.");
  const local = /localhost|127\.0\.0\.1/.test(databaseUrl);
  const pool = new Pool({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await client.query("select data from app_state where id = $1 for update", ["main"]);
    if (result.rowCount !== 1) throw new Error("app_state/main ne obstaja.");
    const db = result.rows[0].data;
    const previousClients = Array.isArray(db.clients) ? db.clients : [];
    const parsed = parseSheetClients(rows, previousClients);
    const references = rekeyClientReferences(db, previousClients, parsed.clients);
    if (references.unresolved.length) {
      throw new Error(`Migracija ustavljena: ${references.unresolved.length} referenc ni bilo mogoce povezati z davcno stevilko.`);
    }
    db.clients = parsed.clients;
    await client.query("update app_state set data = $1::jsonb, updated_at = now() where id = $2", [JSON.stringify(db), "main"]);
    await client.query("commit");
    console.log(JSON.stringify({
      total: parsed.total,
      usable: parsed.usable,
      missingTax: parsed.missingTax,
      duplicateTax: parsed.duplicateTax,
      updatedReferences: references.updated,
      unresolvedReferences: references.unresolved.length
    }));
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
  process.exitCode = 1;
});
