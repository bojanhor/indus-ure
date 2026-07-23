#!/usr/bin/env node
"use strict";

const { runDailyWorkerDigest } = require("../outputs/server");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const dateFlag = args.find((item) => item.startsWith("--date="));
const date = dateFlag ? dateFlag.slice("--date=".length) : "";

runDailyWorkerDigest({ date, dryRun }).then((result) => {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}).catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});