const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");

const PORT = Number(process.env.PORT || 8123);
const HOST = process.env.HOST || "0.0.0.0";
const root = __dirname;
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, "data");
const dbFile = path.join(dataDir, "db.json");
const DATABASE_URL = process.env.DATABASE_URL || "";
const configuredBojanPassword = process.env.INITIAL_BOJAN_PASSWORD || "";
const configuredIbroPassword = process.env.INITIAL_IBRO_PASSWORD || "";
const initialBojanPassword = configuredBojanPassword || crypto.randomBytes(24).toString("hex");
const initialIbroPassword = configuredIbroPassword || crypto.randomBytes(24).toString("hex");
const resetUserPasswords = process.env.RESET_USER_PASSWORDS === "true";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || "";
let pgPool = null;
let pgReady = null;

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  if (!stored.includes(":")) return String(password) === String(stored);
  const [salt, hash] = stored.split(":");
  return hashPassword(password, salt) === `${salt}:${hash}`;
}

function configuredPasswordForUser(id) {
  if (id === "bojan") return configuredBojanPassword;
  if (id === "ibro") return configuredIbroPassword;
  return "";
}

function googleReady() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

const defaultUsers = {
  bojan: {
    id: "bojan",
    name: "Bojan",
    role: "boss",
    passwordHash: hashPassword(initialBojanPassword),
    avatar: ""
  },
  ibro: {
    id: "ibro",
    name: "Ibro",
    role: "worker",
    passwordHash: hashPassword(initialIbroPassword),
    avatar: ""
  }
};

const sessions = new Map();

function normalizeDb(db = {}) {
  let changed = false;

  if (!db.users) {
    db.users = defaultUsers;
    changed = true;
  }

  for (const [id, user] of Object.entries(defaultUsers)) {
    if (!db.users[id]) {
      db.users[id] = user;
      changed = true;
    } else if (!db.users[id].passwordHash && db.users[id].password) {
      db.users[id].passwordHash = hashPassword(db.users[id].password);
      delete db.users[id].password;
      changed = true;
    }
    if (!db.users[id].google) {
      db.users[id].google = { tokens: null, calendarId: "", calendarName: "", connectedAt: "" };
      changed = true;
    }
    if (resetUserPasswords) {
      const configuredPassword = id === "bojan" ? configuredBojanPassword : configuredIbroPassword;
      if (configuredPassword) {
        db.users[id].passwordHash = hashPassword(configuredPassword);
        delete db.users[id].password;
        changed = true;
      }
    }
  }

  for (const id of Object.keys(db.users)) {
    if (!defaultUsers[id]) {
      delete db.users[id];
      changed = true;
    }
  }

  if (!Array.isArray(db.entries)) {
    db.entries = [];
    changed = true;
  }

  if (!Array.isArray(db.todos)) {
    db.todos = [];
    changed = true;
  }

  if (!db.calendarToken || String(db.calendarToken).length < 24) {
    db.calendarToken = crypto.randomBytes(24).toString("hex");
    changed = true;
  }

  db.entries = db.entries.map((entry) => {
    const next = { ...entry };
    if (next.createdBy === "delavec") {
      next.createdBy = "ibro";
      next.createdByName = "Ibro";
      changed = true;
    }
    if (next.updatedBy === "delavec") {
      next.updatedBy = "ibro";
      next.updatedByName = "Ibro";
      changed = true;
    }
    if (next.createdBy === "sef") {
      next.createdBy = "bojan";
      next.createdByName = "Bojan";
      changed = true;
    }
    if (next.updatedBy === "sef") {
      next.updatedBy = "bojan";
      next.updatedByName = "Bojan";
      changed = true;
    }
    if (!Array.isArray(next.history)) {
      next.history = [];
      changed = true;
    }
    if (typeof next.people !== "string") {
      next.people = "";
      changed = true;
    }
    if (!next.syncUser) {
      next.syncUser = next.createdBy || "ibro";
      changed = true;
    }
    if (typeof next.googleEventId !== "string") {
      next.googleEventId = "";
      changed = true;
    }
    if (typeof next.googleUpdatedAt !== "string") {
      next.googleUpdatedAt = "";
      changed = true;
    }
    return next;
  });

  db.todos = db.todos.map((todo, index) => {
    const next = { ...todo };
    if (!["open", "in_progress"].includes(next.status)) {
      next.status = "open";
      changed = true;
    }
    if (typeof next.order !== "number") {
      next.order = index + 1;
      changed = true;
    }
    if (!next.syncUser) {
      next.syncUser = next.createdBy || "ibro";
      changed = true;
    }
    if (typeof next.googleEventId !== "string") {
      next.googleEventId = "";
      changed = true;
    }
    if (typeof next.googleUpdatedAt !== "string") {
      next.googleUpdatedAt = "";
      changed = true;
    }
    return next;
  });

  return { db, changed };
}

function ensureDb() {
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify({ users: defaultUsers, entries: [], todos: [] }, null, 2), "utf8");
    return;
  }

  const { db, changed } = normalizeDb(JSON.parse(fs.readFileSync(dbFile, "utf8")));
  if (changed) writeDb(db);
}

function readDb() {
  ensureDb();
  return JSON.parse(fs.readFileSync(dbFile, "utf8"));
}

function writeDb(db) {
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2), "utf8");
}

function getPgPool() {
  if (pgPool) return pgPool;
  const { Pool } = require("pg");
  const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    ssl: isLocal ? false : { rejectUnauthorized: false }
  });
  return pgPool;
}

async function ensurePostgresDb() {
  if (!DATABASE_URL) return;
  if (pgReady) return pgReady;
  pgReady = (async () => {
    const pool = getPgPool();
    await pool.query(`
      create table if not exists app_state (
        id text primary key,
        data jsonb not null,
        updated_at timestamptz not null default now()
      )
    `);
    const existing = await pool.query("select data from app_state where id = $1", ["main"]);
    if (existing.rowCount === 0) {
      await pool.query(
        "insert into app_state (id, data) values ($1, $2::jsonb)",
        ["main", JSON.stringify({ users: defaultUsers, entries: [], todos: [], calendarToken: crypto.randomBytes(24).toString("hex") })]
      );
      return;
    }
    const { db, changed } = normalizeDb(existing.rows[0].data);
    if (changed) {
      await pool.query(
        "update app_state set data = $1::jsonb, updated_at = now() where id = $2",
        [JSON.stringify(db), "main"]
      );
    }
  })();
  return pgReady;
}

async function readDbAsync() {
  if (!DATABASE_URL) return readDb();
  await ensurePostgresDb();
  const result = await getPgPool().query("select data from app_state where id = $1", ["main"]);
  const { db, changed } = normalizeDb(result.rows[0]?.data || {});
  if (changed) await writeDbAsync(db);
  return db;
}

async function writeDbAsync(db) {
  if (!DATABASE_URL) {
    writeDb(db);
    return;
  }
  await ensurePostgresDb();
  await getPgPool().query(
    "update app_state set data = $1::jsonb, updated_at = now() where id = $2",
    [JSON.stringify(db), "main"]
  );
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data));
}

function absoluteBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || (req.socket.encrypted ? "https" : "http");
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function sendText(res, status, text, type) {
  res.writeHead(status, {
    "Content-Type": `${type}; charset=utf-8`,
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 2_500_000) {
        reject(new Error("Zahteva je prevelika."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Neveljaven JSON."));
      }
    });
  });
}

function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    avatar: user.avatar || ""
  };
}

async function getSessionUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const userId = sessions.get(token);
  if (!userId) return null;
  const db = await readDbAsync();
  return db.users[userId] || null;
}

async function requireUser(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: "Prijava je potekla. Prijavi se se enkrat." });
    return null;
  }
  return user;
}

function audit(user, action) {
  return {
    action,
    by: user.id,
    byName: user.name,
    at: new Date().toISOString()
  };
}

function cleanEntry(input) {
  return {
    date: String(input.date || ""),
    start: String(input.start || ""),
    end: String(input.end || ""),
    client: String(input.client || "").trim(),
    status: ["billed", "warranty", "unbilled", "errand"].includes(input.status) ? input.status : "unbilled",
    work: String(input.work || "").trim(),
    material: String(input.material || "").trim(),
    people: String(input.people || "").trim(),
    syncUser: ["bojan", "ibro"].includes(input.syncUser) ? input.syncUser : "",
    km: Number(input.km || 0),
    materialCost: Number(input.materialCost || 0),
    notes: String(input.notes || "").trim()
  };
}

function validateEntry(entry) {
  if (!entry.date || !entry.start || !entry.end || !entry.client) return "Manjka datum, cas ali stranka.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) return "Datum ni pravilen.";
  if (!/^\d{2}:\d{2}$/.test(entry.start) || !/^\d{2}:\d{2}$/.test(entry.end)) return "Cas ni pravilen.";
  if (entry.end <= entry.start) return "Ura do mora biti kasneje kot ura od.";
  return "";
}

function cleanTodo(input) {
  return {
    title: String(input.title || "").trim(),
    date: String(input.date || ""),
    client: String(input.client || "").trim(),
    notes: String(input.notes || "").trim(),
    status: ["open", "in_progress"].includes(input.status) ? input.status : "open",
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : 0,
    syncUser: ["bojan", "ibro"].includes(input.syncUser) ? input.syncUser : "",
    done: Boolean(input.done)
  };
}

function validateTodo(todo) {
  if (!todo.title) return "Manjka opis opravila.";
  if (todo.date && !/^\d{4}-\d{2}-\d{2}$/.test(todo.date)) return "Datum opravila ni pravilen.";
  return "";
}

function icsEscape(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,")
    .replaceAll("\r", "")
    .replaceAll("\n", "\\n");
}

function icsDateTime(date, time) {
  return `${date.replaceAll("-", "")}T${time.replace(":", "")}00`;
}

function icsDate(date) {
  return String(date || "").replaceAll("-", "");
}

function addDays(date, days) {
  const parsed = new Date(`${date}T00:00:00`);
  parsed.setDate(parsed.getDate() + days);
  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, "0"),
    String(parsed.getDate()).padStart(2, "0")
  ].join("");
}

function foldIcsLine(line) {
  const chunks = [];
  let rest = line;
  while (rest.length > 72) {
    chunks.push(rest.slice(0, 72));
    rest = ` ${rest.slice(72)}`;
  }
  chunks.push(rest);
  return chunks.join("\r\n");
}

function buildCalendarIcs(db) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//INDUS URE//Delovni koledar//SL",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:INDUS URE",
    "X-WR-TIMEZONE:Europe/Ljubljana"
  ];

  for (const entry of db.entries || []) {
    if (!entry.date || !entry.start || !entry.end) continue;
    const description = [
      entry.work ? `Delo: ${entry.work}` : "",
      entry.material ? `Material: ${entry.material}` : "",
      entry.people ? `Sodelavci: ${entry.people}` : "",
      entry.km ? `Km: ${entry.km}` : "",
      entry.materialCost ? `Material EUR: ${entry.materialCost}` : "",
      entry.notes ? `Opombe: ${entry.notes}` : "",
      entry.createdByName ? `Dodal: ${entry.createdByName}` : "",
      entry.updatedByName ? `Spremenil: ${entry.updatedByName}` : ""
    ].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:entry-${entry.id}@indus-ure`,
      `DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/Ljubljana:${icsDateTime(entry.date, entry.start)}`,
      `DTEND;TZID=Europe/Ljubljana:${icsDateTime(entry.date, entry.end)}`,
      `SUMMARY:${icsEscape(`${entry.client || "Stranka"} - ${entry.work || entry.material || "Delo"}`)}`,
      `DESCRIPTION:${icsEscape(description)}`,
      "END:VEVENT"
    );
  }

  for (const todo of db.todos || []) {
    if (!todo.date || todo.done) continue;
    const description = [
      todo.client ? `Stranka: ${todo.client}` : "",
      todo.status === "in_progress" ? "Status: v teku" : "",
      todo.notes ? `Opombe: ${todo.notes}` : "",
      todo.createdByName ? `Dodal: ${todo.createdByName}` : ""
    ].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:todo-${todo.id}@indus-ure`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${icsDate(todo.date)}`,
      `DTEND;VALUE=DATE:${addDays(todo.date, 1)}`,
      `SUMMARY:${icsEscape(`TODO: ${todo.title}`)}`,
      `DESCRIPTION:${icsEscape(description)}`,
      "END:VEVENT"
    );
  }

  lines.push("END:VCALENDAR");
  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

function googleRedirectUri(req) {
  return GOOGLE_REDIRECT_URI || `${absoluteBaseUrl(req)}/api/google/callback`;
}

function googleClient(req, tokens) {
  const { google } = require("googleapis");
  const client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, googleRedirectUri(req));
  if (tokens) client.setCredentials(tokens);
  return client;
}

function googleEventDescription(lines) {
  return ["INDUS URE", ...lines.filter(Boolean)].join("\n");
}

function entryToGoogleEvent(entry) {
  return {
    summary: `${entry.client || "Stranka"} - ${entry.work || entry.material || "Delo"}`,
    description: googleEventDescription([
      entry.work ? `Delo: ${entry.work}` : "",
      entry.material ? `Material: ${entry.material}` : "",
      entry.people ? `Sodelavci: ${entry.people}` : "",
      entry.km ? `Km: ${entry.km}` : "",
      entry.materialCost ? `Material EUR: ${entry.materialCost}` : "",
      entry.notes ? `Opombe: ${entry.notes}` : ""
    ]),
    start: { dateTime: `${entry.date}T${entry.start}:00`, timeZone: "Europe/Ljubljana" },
    end: { dateTime: `${entry.date}T${entry.end}:00`, timeZone: "Europe/Ljubljana" },
    extendedProperties: { private: { indusId: entry.id, indusType: "entry", indusUser: entry.syncUser || entry.createdBy || "" } }
  };
}

function todoToGoogleEvent(todo) {
  return {
    summary: `TODO: ${todo.title}`,
    description: googleEventDescription([
      todo.client ? `Stranka: ${todo.client}` : "",
      todo.status === "in_progress" ? "Status: v teku" : "",
      todo.notes ? `Opombe: ${todo.notes}` : ""
    ]),
    start: { date: todo.date },
    end: { date: addDaysDashed(todo.date, 1) },
    extendedProperties: { private: { indusId: todo.id, indusType: "todo", indusUser: todo.syncUser || todo.createdBy || "" } }
  };
}

function addDaysDashed(date, days) {
  const parsed = new Date(`${date}T00:00:00`);
  parsed.setDate(parsed.getDate() + days);
  return [
    parsed.getFullYear(),
    String(parsed.getMonth() + 1).padStart(2, "0"),
    String(parsed.getDate()).padStart(2, "0")
  ].join("-");
}

function googleEventUpdatedLater(event, item) {
  if (!event.updated) return false;
  if (!item.googleUpdatedAt) return true;
  return new Date(event.updated).getTime() > new Date(item.googleUpdatedAt).getTime();
}

async function ensureGoogleCalendar(calendar, user) {
  const name = `INDUS URE - ${user.name || user.id}`;
  if (user.google?.calendarId) return user.google.calendarId;
  const existing = await calendar.calendarList.list({ maxResults: 250 });
  const found = (existing.data.items || []).find((item) => item.summary === name);
  if (found) {
    user.google.calendarId = found.id;
    user.google.calendarName = found.summary;
    return found.id;
  }
  const created = await calendar.calendars.insert({
    requestBody: { summary: name, timeZone: "Europe/Ljubljana" }
  });
  user.google.calendarId = created.data.id;
  user.google.calendarName = created.data.summary || name;
  return user.google.calendarId;
}

function entryFromGoogleEvent(event, user) {
  const start = event.start?.dateTime ? new Date(event.start.dateTime) : null;
  const end = event.end?.dateTime ? new Date(event.end.dateTime) : null;
  if (!start || !end) return null;
  const date = [
    start.getFullYear(),
    String(start.getMonth() + 1).padStart(2, "0"),
    String(start.getDate()).padStart(2, "0")
  ].join("-");
  const time = (value) => `${String(value.getHours()).padStart(2, "0")}:${String(value.getMinutes()).padStart(2, "0")}`;
  return {
    id: crypto.randomUUID(),
    date,
    start: time(start),
    end: time(end),
    client: event.summary || "Google dogodek",
    status: "unbilled",
    work: event.summary || "",
    material: "",
    people: "",
    km: 0,
    materialCost: 0,
    notes: event.description || "",
    syncUser: user.id,
    googleEventId: event.id || "",
    googleUpdatedAt: event.updated || "",
    createdBy: user.id,
    createdByName: user.name,
    createdAt: new Date().toISOString(),
    updatedBy: user.id,
    updatedByName: user.name,
    updatedAt: new Date().toISOString(),
    history: [audit(user, "uvozeno iz Google")]
  };
}

function todoFromGoogleEvent(event, user) {
  if (!event.start?.date) return null;
  return {
    id: crypto.randomUUID(),
    title: String(event.summary || "Google opravilo").replace(/^TODO:\s*/i, ""),
    date: event.start.date,
    client: "",
    notes: event.description || "",
    status: "open",
    order: 0,
    done: false,
    syncUser: user.id,
    googleEventId: event.id || "",
    googleUpdatedAt: event.updated || "",
    createdBy: user.id,
    createdByName: user.name,
    createdAt: new Date().toISOString(),
    updatedBy: user.id,
    updatedByName: user.name,
    updatedAt: new Date().toISOString(),
    history: [audit(user, "uvozeno iz Google")]
  };
}

async function syncGoogleForUser(req, db, user) {
  if (!googleReady()) throw new Error("Google OAuth se ni nastavljen.");
  if (!user.google?.tokens) throw new Error("Najprej povezi svoj Google racun.");
  const { google } = require("googleapis");
  const auth = googleClient(req, user.google.tokens);
  const calendar = google.calendar({ version: "v3", auth });
  const calendarId = await ensureGoogleCalendar(calendar, user);
  const now = new Date().toISOString();
  let pushed = 0;
  let pulled = 0;

  const timeMin = new Date();
  timeMin.setDate(timeMin.getDate() - 30);
  const remote = await calendar.events.list({
    calendarId,
    timeMin: timeMin.toISOString(),
    maxResults: 2500,
    singleEvents: false,
    showDeleted: false
  });

  for (const event of remote.data.items || []) {
    const privateProps = event.extendedProperties?.private || {};
    if (privateProps.indusId && privateProps.indusType === "entry") {
      const entry = db.entries.find((item) => item.id === privateProps.indusId && item.syncUser === user.id);
      if (entry && googleEventUpdatedLater(event, entry)) {
        const imported = entryFromGoogleEvent(event, user);
        if (imported) {
          Object.assign(entry, { ...entry, date: imported.date, start: imported.start, end: imported.end, work: imported.work, notes: imported.notes, googleUpdatedAt: event.updated || "", updatedAt: now, updatedBy: user.id, updatedByName: user.name });
          pulled++;
        }
      }
      continue;
    }
    if (privateProps.indusId && privateProps.indusType === "todo") {
      const todo = db.todos.find((item) => item.id === privateProps.indusId && item.syncUser === user.id);
      if (todo && googleEventUpdatedLater(event, todo)) {
        todo.title = String(event.summary || todo.title).replace(/^TODO:\s*/i, "");
        todo.date = event.start?.date || todo.date;
        todo.notes = event.description || todo.notes;
        todo.googleUpdatedAt = event.updated || "";
        todo.updatedAt = now;
        todo.updatedBy = user.id;
        todo.updatedByName = user.name;
        pulled++;
      }
      continue;
    }
    if (event.id && !db.entries.some((item) => item.googleEventId === event.id) && !db.todos.some((item) => item.googleEventId === event.id)) {
      const imported = event.start?.dateTime ? entryFromGoogleEvent(event, user) : todoFromGoogleEvent(event, user);
      if (imported) {
        if (event.start?.dateTime) db.entries.push(imported);
        else db.todos.push(imported);
        pulled++;
      }
    }
  }

  for (const entry of db.entries.filter((item) => item.syncUser === user.id && item.date && item.start && item.end)) {
    const requestBody = entryToGoogleEvent(entry);
    if (entry.googleEventId) {
      const updated = await calendar.events.update({ calendarId, eventId: entry.googleEventId, requestBody });
      entry.googleUpdatedAt = updated.data.updated || now;
    } else {
      const created = await calendar.events.insert({ calendarId, requestBody });
      entry.googleEventId = created.data.id || "";
      entry.googleUpdatedAt = created.data.updated || now;
    }
    pushed++;
  }

  for (const todo of db.todos.filter((item) => item.syncUser === user.id && item.date && !item.done)) {
    const requestBody = todoToGoogleEvent(todo);
    if (todo.googleEventId) {
      const updated = await calendar.events.update({ calendarId, eventId: todo.googleEventId, requestBody });
      todo.googleUpdatedAt = updated.data.updated || now;
    } else {
      const created = await calendar.events.insert({ calendarId, requestBody });
      todo.googleEventId = created.data.id || "";
      todo.googleUpdatedAt = created.data.updated || now;
    }
    pushed++;
  }

  user.google.calendarId = calendarId;
  user.google.lastSyncAt = now;
  return { pushed, pulled, calendarName: user.google.calendarName || `INDUS URE - ${user.name}` };
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(root, pathname));
  if (!filePath.startsWith(root)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(root, "index.html"), (indexErr, indexData) => {
        if (indexErr) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(indexData);
      });
      return;
    }
    const type = filePath.endsWith(".html")
      ? "text/html; charset=utf-8"
      : filePath.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : "text/plain; charset=utf-8";
    res.writeHead(200, { "Content-Type": type });
    res.end(data);
  });
}

async function handleApi(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (url.pathname === "/api/google/status" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, {
        configured: googleReady(),
        connected: Boolean(user.google?.tokens),
        calendarName: user.google?.calendarName || "",
        lastSyncAt: user.google?.lastSyncAt || ""
      });
      return;
    }

    if (url.pathname === "/api/google/auth-url" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      if (!googleReady()) {
        sendJson(res, 400, { error: "Google OAuth se ni nastavljen v Render Environment." });
        return;
      }
      const auth = googleClient(req);
      const authUrl = auth.generateAuthUrl({
        access_type: "offline",
        prompt: "consent",
        state: (req.headers.authorization || "").replace(/^Bearer\s+/i, ""),
        scope: [
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/calendar.events"
        ]
      });
      sendJson(res, 200, { url: authUrl });
      return;
    }

    if (url.pathname === "/api/google/callback" && req.method === "GET") {
      if (!googleReady()) {
        sendText(res, 400, "Google OAuth ni nastavljen.", "text/plain");
        return;
      }
      const token = url.searchParams.get("state") || "";
      const userId = sessions.get(token);
      if (!userId) {
        sendText(res, 401, "Prijava je potekla. Zapri to okno, prijavi se v INDUS URE in poskusi znova.", "text/plain");
        return;
      }
      const code = url.searchParams.get("code") || "";
      const auth = googleClient(req);
      const result = await auth.getToken(code);
      const db = await readDbAsync();
      const user = db.users[userId];
      user.google = user.google || {};
      user.google.tokens = result.tokens;
      user.google.connectedAt = new Date().toISOString();
      user.google.calendarId = user.google.calendarId || "";
      user.google.calendarName = user.google.calendarName || "";
      await writeDbAsync(db);
      sendText(res, 200, "Google racun je povezan. Lahko zapres to okno in v INDUS URE kliknes Google sync.", "text/plain");
      return;
    }

    if (url.pathname === "/api/google/sync" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      const current = db.users[user.id];
      const result = await syncGoogleForUser(req, db, current);
      await writeDbAsync(db);
      sendJson(res, 200, { ok: true, ...result, entries: db.entries, todos: db.todos });
      return;
    }

    if (url.pathname === "/api/calendar-url" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, {
        url: `${absoluteBaseUrl(req)}/calendar.ics?token=${encodeURIComponent(db.calendarToken)}`
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/login") {
      const body = await readBody(req);
      const db = await readDbAsync();
      const username = String(body.username || "").toLowerCase();
      const password = String(body.password || "");
      const user = db.users[username];
      const envPassword = configuredPasswordForUser(username);
      if (user && envPassword && password === envPassword && !verifyPassword(password, user.passwordHash || user.password)) {
        user.passwordHash = hashPassword(password);
        delete user.password;
        await writeDbAsync(db);
      }
      if (!user || !verifyPassword(password, user.passwordHash || user.password)) {
        sendJson(res, 401, { error: "Napacno uporabnisko ime ali geslo." });
        return;
      }
      const token = crypto.randomBytes(24).toString("hex");
      sessions.set(token, user.id);
      sendJson(res, 200, { token, user: publicUser(user) });
      return;
    }

    if (url.pathname === "/api/me") {
      const user = await requireUser(req, res);
      if (!user) return;
      sendJson(res, 200, { user: publicUser(user) });
      return;
    }

    if (url.pathname === "/api/profile" && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const db = await readDbAsync();
      const current = db.users[user.id];
      const name = String(body.name || "").trim();
      const avatar = String(body.avatar || "");
      if (name.length < 2) {
        sendJson(res, 400, { error: "Ime mora imeti vsaj 2 znaka." });
        return;
      }
      if (avatar && !avatar.startsWith("data:image/")) {
        sendJson(res, 400, { error: "Slika mora biti slikovna datoteka." });
        return;
      }
      current.name = name;
      current.avatar = avatar.slice(0, 1_500_000);
      await writeDbAsync(db);
      sendJson(res, 200, { user: publicUser(current) });
      return;
    }

    if (url.pathname === "/api/password" && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      const body = await readBody(req);
      const db = await readDbAsync();
      const current = db.users[user.id];
      if (!verifyPassword(body.currentPassword || "", current.passwordHash || current.password)) {
        sendJson(res, 400, { error: "Trenutno geslo ni pravilno." });
        return;
      }
      const next = String(body.newPassword || "");
      if (next.length < 6) {
        sendJson(res, 400, { error: "Novo geslo mora imeti vsaj 6 znakov." });
        return;
      }
      current.passwordHash = hashPassword(next);
      delete current.password;
      await writeDbAsync(db);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/entries" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, { entries: db.entries });
      return;
    }

    if (url.pathname === "/api/todos" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return;
      const db = await readDbAsync();
      sendJson(res, 200, { todos: db.todos });
      return;
    }

    if (url.pathname === "/api/todos" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const todo = cleanTodo(await readBody(req));
      const validation = validateTodo(todo);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const now = new Date().toISOString();
      const db = await readDbAsync();
      const maxOrder = db.todos.reduce((max, item) => Math.max(max, Number(item.order || 0)), 0);
      db.todos.push({
        id: crypto.randomUUID(),
        ...todo,
        syncUser: todo.syncUser || user.id,
        order: todo.order || maxOrder + 1,
        createdBy: user.id,
        createdByName: user.name,
        createdAt: now,
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: now,
        history: [audit(user, "dodano opravilo")]
      });
      await writeDbAsync(db);
      sendJson(res, 200, { todos: db.todos });
      return;
    }

    if (url.pathname === "/api/entries" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return;
      const entry = cleanEntry(await readBody(req));
      const validation = validateEntry(entry);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const now = new Date().toISOString();
      const db = await readDbAsync();
      db.entries.push({
        id: crypto.randomUUID(),
        ...entry,
        syncUser: entry.syncUser || user.id,
        createdBy: user.id,
        createdByName: user.name,
        createdAt: now,
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: now,
        history: [audit(user, "dodano")]
      });
      await writeDbAsync(db);
      sendJson(res, 200, { entries: db.entries });
      return;
    }

    const match = url.pathname.match(/^\/api\/entries\/([^/]+)$/);
    if (match && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(match[1]);
      const entry = cleanEntry(await readBody(req));
      const validation = validateEntry(entry);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const db = await readDbAsync();
      const index = db.entries.findIndex((item) => item.id === id);
      if (index < 0) {
        sendJson(res, 404, { error: "Vnos ne obstaja." });
        return;
      }
      db.entries[index] = {
        ...db.entries[index],
        ...entry,
        syncUser: entry.syncUser || db.entries[index].syncUser || user.id,
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: new Date().toISOString(),
        history: [...(db.entries[index].history || []), audit(user, "spremenjeno")]
      };
      await writeDbAsync(db);
      sendJson(res, 200, { entries: db.entries });
      return;
    }

    if (match && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(match[1]);
      const db = await readDbAsync();
      db.entries = db.entries.filter((item) => item.id !== id);
      await writeDbAsync(db);
      sendJson(res, 200, { entries: db.entries });
      return;
    }

    const todoMatch = url.pathname.match(/^\/api\/todos\/([^/]+)$/);
    if (todoMatch && req.method === "PUT") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(todoMatch[1]);
      const todo = cleanTodo(await readBody(req));
      const validation = validateTodo(todo);
      if (validation) {
        sendJson(res, 400, { error: validation });
        return;
      }
      const db = await readDbAsync();
      const index = db.todos.findIndex((item) => item.id === id);
      if (index < 0) {
        sendJson(res, 404, { error: "Opravilo ne obstaja." });
        return;
      }
      db.todos[index] = {
        ...db.todos[index],
        ...todo,
        syncUser: todo.syncUser || db.todos[index].syncUser || user.id,
        updatedBy: user.id,
        updatedByName: user.name,
        updatedAt: new Date().toISOString(),
        history: [...(db.todos[index].history || []), audit(user, todo.done ? "oznaceno opravljeno" : "spremenjeno opravilo")]
      };
      await writeDbAsync(db);
      sendJson(res, 200, { todos: db.todos });
      return;
    }

    if (todoMatch && req.method === "DELETE") {
      const user = await requireUser(req, res);
      if (!user) return;
      const id = decodeURIComponent(todoMatch[1]);
      const db = await readDbAsync();
      db.todos = db.todos.filter((item) => item.id !== id);
      await writeDbAsync(db);
      sendJson(res, 200, { todos: db.todos });
      return;
    }

    sendJson(res, 404, { error: "API pot ne obstaja." });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Napaka na strezniku." });
  }
}

async function handleCalendarFeed(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const db = await readDbAsync();
    if (url.searchParams.get("token") !== db.calendarToken) {
      sendText(res, 403, "Forbidden", "text/plain");
      return;
    }
    sendText(res, 200, buildCalendarIcs(db), "text/calendar");
  } catch (error) {
    sendText(res, 500, error.message || "Napaka na strezniku.", "text/plain");
  }
}

function networkUrls() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((item) => item && item.family === "IPv4" && !item.internal)
    .map((item) => `http://${item.address}:${PORT}`);
}

async function start() {
  if (DATABASE_URL) {
    await ensurePostgresDb();
    console.log("Shranjevanje: Postgres baza prek DATABASE_URL");
  } else {
    ensureDb();
    console.log(`Shranjevanje: lokalna datoteka ${dbFile}`);
  }

  http.createServer((req, res) => {
    if (req.url.startsWith("/api/")) {
      handleApi(req, res);
      return;
    }
    if (req.url.startsWith("/calendar.ics")) {
      handleCalendarFeed(req, res);
      return;
    }
    serveStatic(req, res);
  }).listen(PORT, HOST, () => {
    console.log(`INDUS URE lokalno: http://127.0.0.1:${PORT}`);
    for (const url of networkUrls()) console.log(`Na istem omrezju: ${url}`);
    console.log("Uporabnika: bojan in ibro");
  });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
