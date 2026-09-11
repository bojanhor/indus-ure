"use strict";
// Test-only instrumentation, never loaded by the production entrypoint.
if (process.env.NODE_ENV !== "test" || !/^indus_ure_qa_[a-z0-9_]+$/.test(process.env.PG_QA_DATABASE || "")) {
  throw new Error("PG QA instrumentation requires an isolated test database.");
}
const { PostgresStore } = require("../outputs/postgres-store");
const original = PostgresStore.prototype.load;
PostgresStore.prototype.load = async function (...args) {
  const result = await original.apply(this, args);
  process.stdout.write("PG_QA_FULL_LOAD\n");
  return result;
};
