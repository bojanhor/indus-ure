"use strict";

// All application media publishers share this lock. GC only tries the exclusive
// lock, never queues it: nested save() leases cannot deadlock behind a collector.
const MEDIA_LOCK = "indus-ure-media-lifecycle-v1";
const pools = new WeakMap();
function referencedMediaIds(values) {
  const ids = new Set();
  const visit = value => {
    if (typeof value === "string") for (const match of value.matchAll(/[a-f0-9]{64}/g)) ids.add(match[0]);
    else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) { visit(key); visit(child); }
  };
  visit(values); return ids;
}
async function withMediaLease(pool, work) {
  let leases = pools.get(pool);
  if (!leases) {
    const { Pool } = require("pg");
    leases = new Pool({ ...pool.options, max: 4, idleTimeoutMillis: 1000, allowExitOnIdle: true,
      application_name: "indus-ure-media-lease" });
    pools.set(pool, leases);
  }
  const client = await leases.connect();
  let locked = false;
  try {
    await client.query("select pg_advisory_lock_shared(hashtext($1))", [MEDIA_LOCK]);
    locked = true;
    return await work();
  } finally {
    try { if (locked) await client.query("select pg_advisory_unlock_shared(hashtext($1))", [MEDIA_LOCK]); }
    finally { client.release(); }
  }
}
module.exports = { MEDIA_LOCK, withMediaLease, referencedMediaIds };
