"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

test("recovery guide makes dump readable and restores with the application role", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "scripts", "backup-indus-ure.js"), "utf8");
  assert.match(source, /chmod 0644 restore\/database\.dump restore\/sanitized-state\.sql/);
  assert.match(source, /pg_restore --no-owner --no-acl --role=indus_ure -d indus_ure restore\/database\.dump/);
});