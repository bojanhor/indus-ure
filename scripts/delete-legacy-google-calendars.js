#!/usr/bin/env node
"use strict";

// Deletes only legacy Google Calendars that are explicitly marked in the old
// INDUS URE app_state as created by this app. Dry-run is the default.

const { Pool } = require("pg");
const { google } = require("googleapis");

const confirmed = process.argv.includes("--confirm");
const DATABASE_URL = process.env.DATABASE_URL || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";
const APP_ID = "indus-ure-v1";

function requireConfig() {
  if (!DATABASE_URL || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error("Manjkajo DATABASE_URL ali Google OAuth podatki.");
  }
}

function expectedCalendar(user, kind) {
  if (kind === "archive") return {
    id: user.google?.archiveCalendarId,
    created: user.google?.archiveCalendarCreatedByApp === true,
    summary: `INDUS URE - arhiv - ${user.name || user.id}`,
    descriptionPart: "Arhiv potrjenih obračunov iz aplikacije INDUS URE"
  };
  return {
    id: user.google?.calendarId,
    created: user.google?.calendarCreatedByApp === true,
    summary: `INDUS URE - ${user.name || user.id}`,
    descriptionPart: "Namenski koledar aplikacije INDUS URE"
  };
}

async function main() {
  requireConfig();
  const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false } });
  try {
    const legacy = await pool.query("select data from app_state where id = $1", ["main"]);
    const state = legacy.rows[0]?.data;
    if (!state?.users || typeof state.users !== "object") throw new Error("Stare app_state baze ni bilo mogoče najti.");
    const result = [];
    for (const user of Object.values(state.users)) {
      if (!user?.google?.tokens) continue;
      const oauth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
      oauth.setCredentials(user.google.tokens);
      const calendar = google.calendar({ version: "v3", auth: oauth });
      for (const kind of ["worker", "archive"]) {
        const expected = expectedCalendar(user, kind);
        if (!expected.created || !expected.id) continue;
        let remote;
        try {
          remote = (await calendar.calendars.get({ calendarId: expected.id })).data;
        } catch (error) {
          result.push({ user: user.email || user.id, kind, calendarId: expected.id, action: "skip", reason: `ni dosegljiv (${error.code || error.message || error})` });
          continue;
        }
        const verified = remote.summary === expected.summary && String(remote.description || "").includes(expected.descriptionPart);
        if (!verified) {
          result.push({ user: user.email || user.id, kind, calendarId: expected.id, action: "skip", reason: "ime ali opis se ne ujema z aplikacijskim koledarjem" });
          continue;
        }
        if (confirmed) {
          await calendar.calendars.delete({ calendarId: expected.id });
          result.push({ user: user.email || user.id, kind, calendarId: expected.id, action: "deleted", summary: remote.summary });
        } else {
          result.push({ user: user.email || user.id, kind, calendarId: expected.id, action: "would-delete", summary: remote.summary });
        }
      }
    }
    process.stdout.write(`${JSON.stringify({ app: APP_ID, dryRun: !confirmed, calendars: result }, null, 2)}\n`);
    if (!confirmed) process.stdout.write("Dry-run only. For deletion run again with --confirm after checking this list.\n");
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`Legacy calendar cleanup failed: ${error.message || error}\n`);
  process.exit(1);
});