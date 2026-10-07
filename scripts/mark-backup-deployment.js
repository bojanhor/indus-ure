#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const { markDeploymentBackup } = require("./backup-retention");

function backupDirectoryFromEnvironmentFile(file) {
  // Read only the one setting we need; never source/evaluate the env file or
  // print its credentials. Match the simple systemd EnvironmentFile value.
  const matches = fs.readFileSync(file, "utf8").split(/\r?\n/).filter(line => /^BACKUP_DIR=/.test(line));
  if (matches.length !== 1) throw new Error("BACKUP_DIR mora biti enolično nastavljen.");
  return matches[0].slice("BACKUP_DIR=".length).trim().replace(/^(["'])(.*)\1$/, "$2");
}
async function main(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!["--directory", "--env-file", "--release", "--archive", "--since"].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error("Neveljavni argumenti označevanja kopije.");
    options[args[i]] = args[i + 1];
  }
  if (Boolean(options["--directory"]) === Boolean(options["--env-file"])) throw new Error("Določi mapo kopij ali okoljsko datoteko.");
  const directory = options["--directory"] || backupDirectoryFromEnvironmentFile(options["--env-file"]);
  const marker = await markDeploymentBackup(directory, { release: options["--release"], archive: options["--archive"], notBefore: Number(options["--since"] || 0) * 1000 });
  // Publication must also persist checkpoint protection off-site. Load only
  // the explicitly supplied, trusted systemd file; never log its contents.
  if (options["--env-file"]) {
    process.loadEnvFile(options["--env-file"]);
    await require("./backup-indus-ure").inspectOrMarkDriveRetention({ markOnly: true });
  }
  process.stdout.write(`Zaščitena kopija pred objavo ${marker.release}: ${marker.archive}\n`);
}
if (require.main === module) main(process.argv.slice(2)).catch(error => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
module.exports = { backupDirectoryFromEnvironmentFile };
