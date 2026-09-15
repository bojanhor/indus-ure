"use strict";
const fs = require("node:fs/promises");
const path = require("node:path");
const manifest = require("../outputs/module-manifest.json");

// Source-contract tests inspect the actual entry point and its explicitly
// composed modules. Runtime/API tests continue to launch the real server.
async function readServerSource() {
  const files = ["server", ...manifest.filter(item => item.source === "server").map(item => item.name)];
  return (await Promise.all(files.map(file => fs.readFile(path.join(__dirname, "../outputs", `${file}.js`), "utf8")))).join("\n");
}

module.exports = { readServerSource };
