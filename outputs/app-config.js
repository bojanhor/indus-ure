"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const defaults = require("./app-config.defaults.json");

// Only deliberately supported, non-secret operational settings. No paths,
// URLs, permissions, executable names or billing rules may be added via JSON.
const rules = {
  uploads: { maxAttachments: [1, 200], pdfMaxMb: [1, 100], imageMaxMb: [5, 50], videoMaxMb: [20, 200], imageDisplayMaxSide: [640, 4096], imageThumbnailMaxSide: [120, 800], imageProcessTimeoutSeconds: [15, 180], pendingHours: [1, 72] },
  history: { trashDays: [7, 365], auditDays: [7, 365], auditMaxEvents: [1000, 100000], undoActions: [5, 100], eventVersions: [5, 100] },
  reports: { pdfTotalMb: [50, 200], gmailAttachmentMb: [1, 10], gmailTotalMb: [1, 20], downloadTicketMinutes: [1, 15] },
  network: { requestTimeoutSeconds: [5, 120], uploadTimeoutSeconds: [30, 900], refreshSeconds: [15, 600] },
  editor: { defaultStart: "time", defaultDurationMinutes: [15, 480, 15], clientSuggestions: [3, 50], noticeSeconds: [2, 30], photoBrushPixels: [2, 10], photoTextPixels: [16, 48], photoTouchPixels: [18, 44], jpegMaxSide: [640, 2560], jpegQuality: [50, 95], dragHoldMs: [100, 800], calendarDragHoldMs: [100, 800], groupDragHoldMs: [100, 800] },
  locks: { leaseSeconds: [60, 300], heartbeatSeconds: [10, 60] },
  calendar: { pollSeconds: [15, 300], reconcileSeconds: [60, 3600], debounceMs: [500, 10000], retryMaxSeconds: [60, 3600] },
  monitor: { intervalSeconds: [60, 1800], maxRssMb: [256, 4000], diskWarningPercent: [70, 95], backupStaleHours: [24, 168], alertCooldownHours: [1, 48] }
};
const clone = value => JSON.parse(JSON.stringify(value));
function invalid(message, status = 400) { return Object.assign(new Error(message), { status }); }
function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Konfiguracija mora biti JSON objekt.");
  for (const key of Object.keys(input)) if (!Object.hasOwn(rules, key)) throw invalid(`Neznan sklop nastavitev: ${key}`);
  const result = {};
  for (const [section, fields] of Object.entries(rules)) {
    const data = input[section];
    if (!data || typeof data !== "object" || Array.isArray(data)) throw invalid(`Manjka sklop: ${section}`);
    for (const key of Object.keys(data)) if (!Object.hasOwn(fields, key)) throw invalid(`Neznana nastavitev: ${section}.${key}`);
    result[section] = {};
    for (const [key, rule] of Object.entries(fields)) {
      const value = data[key];
      const valid = rule === "time" ? /^([01]\d|2[0-3]):(00|15|30|45)$/.test(String(value))
        : Number.isInteger(value) && value >= rule[0] && value <= rule[1] && (!rule[2] || value % rule[2] === 0);
      if (!valid) throw invalid(`${section}.${key}: ${rule === "time" ? "uporabi HH:MM s korakom 15 minut" : `dovoljeno celo število ${rule[0]}–${rule[1]}${rule[2] ? `, korak ${rule[2]}` : ""}`}.`);
      result[section][key] = value;
    }
  }
  if (result.locks.leaseSeconds < result.locks.heartbeatSeconds * 3) throw invalid("Zaklep mora trajati vsaj trikrat toliko kot interval njegovega obnavljanja.");
  if (result.reports.pdfTotalMb < result.uploads.pdfMaxMb + 1) throw invalid("Skupna velikost PDF poročila mora biti vsaj 1 MB večja od največje PDF priloge.");
  if (result.reports.gmailTotalMb < result.reports.gmailAttachmentMb) throw invalid("Skupna omejitev Gmaila mora biti vsaj tolikšna kot omejitev ene priloge.");
  if (result.network.uploadTimeoutSeconds < result.network.requestTimeoutSeconds) throw invalid("Čas za nalaganje ne sme biti krajši od časa za običajno zahtevo.");
  if (result.calendar.reconcileSeconds < result.calendar.pollSeconds) throw invalid("Interval uskladitve koledarja ne sme biti krajši od preverjanja.");
  return result;
}
function createAppConfig({ file, environment = process.env }) {
  const initial = clone(defaults);
  // Migrate existing environment-based limits only when no config file exists.
  const envKeys = [["uploads", "imageMaxMb", "MAX_TODO_IMAGE_BYTES", 1048576], ["uploads", "videoMaxMb", "MAX_VIDEO_BYTES", 1048576], ["monitor", "intervalSeconds", "MONITOR_INTERVAL_MS", 1000], ["monitor", "maxRssMb", "MONITOR_MAX_RSS_MB", 1], ["monitor", "diskWarningPercent", "MONITOR_DISK_WARNING_PERCENT", 1]];
  for (const [section, key, envKey, divisor] of envKeys) {
    const raw = environment[envKey] || (envKey === "MAX_VIDEO_BYTES" ? environment.MAX_DRIVE_VIDEO_BYTES : "");
    if (raw) { const value = Math.round(Number(raw) / divisor), rule = rules[section][key]; if (Number.isFinite(value)) initial[section][key] = Math.max(rule[0], Math.min(rule[1], value)); }
  }
  const encode = value => JSON.stringify(value, null, 2) + "\n";
  const revision = raw => crypto.createHash("sha256").update(raw).digest("hex");
  const read = () => {
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32768) throw invalid("Neveljavna konfiguracijska datoteka.");
      const raw = fs.readFileSync(file, "utf8");
      return { config: validateConfig(JSON.parse(raw)), revision: revision(raw) };
    } catch (error) { if (error.code === "ENOENT") return { config: clone(initial), revision: revision(encode(initial)) }; throw error; }
  };
  let current = read();
  let writes = Promise.resolve();
  async function atomicWrite(target, raw) {
    await fs.promises.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${crypto.randomUUID()}.tmp`;
    try {
      const handle = await fs.promises.open(temp, "wx", 0o600);
      try { await handle.writeFile(raw); await handle.sync(); } finally { await handle.close(); }
      await fs.promises.rename(temp, target);
    } finally { await fs.promises.rm(temp, { force: true }).catch(() => {}); }
  }
  return {
    get: () => current.config,
    snapshot: () => ({ ...clone(current), file: path.basename(file), rules, defaults: clone(defaults) }),
    async ensure() { if (!fs.existsSync(file)) await atomicWrite(file, encode(current.config)); current = read(); },
    reload() { current = read(); return this.snapshot(); },
    previous() { try { return validateConfig(JSON.parse(fs.readFileSync(file + ".previous", "utf8"))); } catch { return null; } },
    async save(input, expectedRevision) {
      const config = validateConfig(input);
      const execute = async () => {
        const latest = read();
        if (!expectedRevision || latest.revision !== expectedRevision) throw invalid("Nastavitve je medtem spremenil drug uporabnik. Ponovno jih naloži; svoj osnutek lahko prej kopiraš.", 409);
        await atomicWrite(file + ".previous", encode(latest.config));
        await atomicWrite(file, encode(config));
        current = { config, revision: revision(encode(config)) };
        return this.snapshot();
      };
      const result = writes.then(execute);
      writes = result.catch(() => {});
      return result;
    }
  };
}
module.exports = { defaults, rules, validateConfig, createAppConfig };
