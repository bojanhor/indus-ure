"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

test("deployment requires content-bound PostgreSQL QA and a successful backup before switching", () => {
  const root = path.join(__dirname, "..");
  const deploy = fs.readFileSync(path.join(root, "scripts/server/deploy-indus-ure"), "utf8");
  const qa = fs.readFileSync(path.join(root, "scripts/server/run-indus-ure-postgres-qa"), "utf8");
  const windows = fs.readFileSync(path.join(root, "scripts/deploy.ps1"), "utf8");
  assert.match(deploy, /sha256sum/);
  assert.ok(deploy.indexOf("sha256sum") < deploy.indexOf("systemctl restart"));
  assert.ok(deploy.indexOf("systemctl start indus-ure-backup.service") < deploy.indexOf("systemctl restart"));
  assert.match(qa, /--verify-restore/);
  assert.match(qa, /--verify-recovery/);
  assert.match(qa, /--upgrade/);
  assert.match(qa, /trap cleanup EXIT/);
  assert.match(windows, /Invoke-Native npm.cmd run test:e2e/);
  assert.match(windows, /run-indus-ure-postgres-qa \$release && sudo \/usr\/local\/sbin\/deploy-indus-ure/);
});

test("successful deployments remove their temporary release staging", () => {
  const production = fs.readFileSync(path.join(__dirname, "..", "scripts", "deploy.ps1"), "utf8");
  const isolated = fs.readFileSync(path.join(__dirname, "..", "scripts", "deploy-test.ps1"), "utf8");
  assert.match(production, /rm -rf \/tmp\/indus-ure-\$release-deploy/);
  assert.match(isolated, /rm -rf \/tmp\/indus-ure-\$release-deploy/);
});
