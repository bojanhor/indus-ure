"use strict";

const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const test = require("node:test");

test("successful deployments remove their temporary release staging", () => {
  const production = fs.readFileSync(path.join(__dirname, "..", "scripts", "deploy.ps1"), "utf8");
  const isolated = fs.readFileSync(path.join(__dirname, "..", "scripts", "deploy-test.ps1"), "utf8");
  assert.match(production, /rm -rf \/tmp\/indus-ure-\$release-deploy/);
  assert.match(isolated, /rm -rf \/tmp\/indus-ure-\$release-deploy/);
});