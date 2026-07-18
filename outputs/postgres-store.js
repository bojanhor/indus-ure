"use strict";

// Transitional relational store for INDUS URE.  The HTTP layer can still use
// the established in-memory shape while PostgreSQL stores every business
// entity in its own row.  This keeps the production migration reversible and
// lets individual endpoints move to direct queries later without another data
// conversion.

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");

const STATE_TABLES = [
  ["indus_users", "id", "users", true],
  ["indus_clients", "client_id", "clients", false],
  ["indus_entries", "id", "entries", false],
  ["indus_debts", "id", "debts", false],
  ["indus_payrolls", "id", "payrolls", false],
  ["indus_billing_locks", "id", "billingLocks", false]
];

const META_EXCLUDED_KEYS = new Set([
  "users", "sessions", "clients", "entries", "todos", "attachments",
  "debts", "payrolls", "billingLocks"
]);

function json(value) {
  return JSON.stringify(value ?? {});
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function objectFromRows(rows, key) {
  return Object.fromEntries(rows.map((row) => [String(row[key]), row.data]));
}

function dataUrlInfo(value) {
  const match = String(value || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const buffer = Buffer.from(match[2], "base64");
  if (!buffer.length) return null;
  return { mimeType: match[1].toLowerCase(), buffer };
}

function extensionForMime(mimeType) {
  return ({
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "application/pdf": ".pdf"
  })[String(mimeType || "").toLowerCase()] || ".bin";
}

function splitTodo(todo) {
  const source = clone(todo);
  const assignmentId = String(source.id || "");
  const taskId = String(source.assignmentGroupId || assignmentId);
  const assignment = {
    id: assignmentId,
    taskId,
    syncUser: source.syncUser || source.createdBy || "",
    order: Number.isFinite(Number(source.order)) ? Number(source.order) : 0,
    billingHourlyRate: source.billingHourlyRate ?? null,
    billingKm: source.billingKm ?? null,
    billingClientKm: source.billingClientKm ?? null,
    billingVehicle: source.billingVehicle || "",
    billingWorkerKm: source.billingWorkerKm ?? null,
    createdAt: source.createdAt || "",
    updatedAt: source.updatedAt || "",
    updatedBy: source.updatedBy || "",
    updatedByName: source.updatedByName || ""
  };
  for (const key of Object.keys(assignment)) {
    if (key !== "taskId") delete source[key];
  }
  source.assignmentGroupId = taskId;
  return { taskId, task: source, assignment };
}

function joinTodo(task, assignment) {
  return {
    ...task,
    id: assignment.id,
    assignmentGroupId: assignment.taskId,
    syncUser: assignment.syncUser,
    order: assignment.order,
    billingHourlyRate: assignment.billingHourlyRate,
    billingKm: assignment.billingKm,
    billingClientKm: assignment.billingClientKm,
    billingVehicle: assignment.billingVehicle,
    createdAt: assignment.createdAt || task.createdAt || "",
    updatedAt: assignment.updatedAt || task.updatedAt || "",
    updatedBy: assignment.updatedBy || task.updatedBy || "",
    updatedByName: assignment.updatedByName || task.updatedByName || ""
  };
}

class PostgresStore {
  constructor(pool, mediaDir) {
    this.pool = pool;
    this.mediaDir = mediaDir;
    this.objectsDir = path.join(mediaDir, "objects");
    this.thumbnailsDir = path.join(mediaDir, "thumbnails");
    this.ready = null;
  }

  async ensure(initialState, normalize = null) {
    if (this.ready) return this.ready;
    this.ready = this.#ensure(initialState, normalize);
    return this.ready;
  }

  async #ensure(initialState, normalize) {
    await this.pool.query(`
      create table if not exists indus_meta (
        key text primary key,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create table if not exists indus_users (
        id text primary key,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create table if not exists indus_sessions (
        token_hash text primary key,
        user_id text not null,
        expires_at timestamptz not null,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create index if not exists indus_sessions_expires_at_idx on indus_sessions (expires_at);
      create table if not exists indus_clients (
        client_id text primary key,
        alias text not null default '',
        name text not null default '',
        tax_id text not null default '',
        needs_review boolean not null default false,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create index if not exists indus_clients_alias_idx on indus_clients (lower(alias));
      create index if not exists indus_clients_tax_id_idx on indus_clients (tax_id) where tax_id <> '';
      create table if not exists indus_tasks (
        id text primary key,
        client_id text not null default '',
        status text not null default '',
        scheduled_date date,
        archived_at timestamptz,
        revision bigint not null default 1,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create index if not exists indus_tasks_client_idx on indus_tasks (client_id);
      create index if not exists indus_tasks_scheduled_date_idx on indus_tasks (scheduled_date);
      create table if not exists indus_task_assignments (
        id text primary key,
        task_id text not null references indus_tasks(id) on delete cascade,
        worker_id text not null default '',
        manual_order numeric not null default 0,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create index if not exists indus_task_assignments_task_idx on indus_task_assignments (task_id);
      create index if not exists indus_task_assignments_worker_idx on indus_task_assignments (worker_id);
      create table if not exists indus_entries (
        id text primary key,
        client_id text not null default '',
        worker_id text not null default '',
        entry_date date,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create index if not exists indus_entries_date_idx on indus_entries (entry_date);
      create table if not exists indus_attachments (
        id text primary key,
        mime_type text not null default 'application/octet-stream',
        byte_size bigint not null default 0,
        storage_key text not null default '',
        thumbnail_key text not null default '',
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create table if not exists indus_debts (
        id text primary key,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create table if not exists indus_payrolls (
        id text primary key,
        worker_id text not null default '',
        month text not null default '',
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create index if not exists indus_payrolls_worker_month_idx on indus_payrolls (worker_id, month);
      create table if not exists indus_billing_locks (
        id text primary key,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create table if not exists indus_notifications (
        id text primary key,
        user_id text not null default '',
        severity text not null default 'info',
        read_at timestamptz,
        data jsonb not null,
        created_at timestamptz not null default now()
      );
      create index if not exists indus_notifications_user_idx on indus_notifications (user_id, read_at, created_at desc);
      create table if not exists indus_backup_runs (
        id text primary key,
        status text not null,
        finished_at timestamptz,
        data jsonb not null,
        created_at timestamptz not null default now()
      );
    `);
    await fsp.mkdir(this.objectsDir, { recursive: true, mode: 0o700 });
    await fsp.mkdir(this.thumbnailsDir, { recursive: true, mode: 0o700 });

    const marker = await this.pool.query("select data from indus_meta where key = $1", ["storage_version"]);
    if (marker.rowCount) return;

    let source = initialState;
    try {
      const legacy = await this.pool.query("select data from app_state where id = $1", ["main"]);
      if (legacy.rowCount && legacy.rows[0].data) source = legacy.rows[0].data;
    } catch {
      // Fresh installations have no legacy app_state table.
    }
    const normalizedSource = clone(source || {});
    if (typeof normalize === "function") normalize(normalizedSource);
    await this.save(normalizedSource);
    await this.pool.query(
      "insert into indus_meta (key, data) values ($1, $2::jsonb) on conflict (key) do update set data = excluded.data, updated_at = now()",
      ["storage_version", json({ version: 1, migratedAt: new Date().toISOString(), legacyAppStateRetained: true })]
    );
  }

  async load() {
    const [meta, users, sessions, clients, tasks, assignments, entries, attachments, debts, payrolls, locks] = await Promise.all([
      this.pool.query("select data from indus_meta where key = $1", ["application"]),
      this.pool.query("select id, data from indus_users"),
      this.pool.query("select token_hash, data from indus_sessions where expires_at > now()"),
      this.pool.query("select client_id, data from indus_clients order by lower(alias), lower(name)"),
      this.pool.query("select id, data from indus_tasks"),
      this.pool.query("select id, task_id, data from indus_task_assignments"),
      this.pool.query("select id, data from indus_entries"),
      this.pool.query("select id, mime_type, byte_size, storage_key, thumbnail_key, data from indus_attachments"),
      this.pool.query("select id, data from indus_debts"),
      this.pool.query("select id, data from indus_payrolls"),
      this.pool.query("select id, data from indus_billing_locks")
    ]);

    const base = meta.rows[0]?.data || {};
    const taskById = new Map(tasks.rows.map((row) => [String(row.id), row.data]));
    const todos = assignments.rows
      .map((row) => {
        const task = taskById.get(String(row.task_id));
        return task ? joinTodo(task, { ...row.data, id: row.id, taskId: row.task_id }) : null;
      })
      .filter(Boolean);
    const attachmentMap = {};
    for (const row of attachments.rows) {
      attachmentMap[row.id] = {
        ...row.data,
        id: row.id,
        mimeType: row.mime_type,
        byteSize: Number(row.byte_size || 0),
        storageKey: row.storage_key,
        thumbnailKey: row.thumbnail_key
      };
    }
    return {
      ...base,
      users: objectFromRows(users.rows, "id"),
      sessions: objectFromRows(sessions.rows, "token_hash"),
      clients: clients.rows.map((row) => row.data),
      todos,
      entries: entries.rows.map((row) => row.data),
      attachments: attachmentMap,
      debts: debts.rows.map((row) => row.data),
      payrolls: payrolls.rows.map((row) => row.data),
      billingLocks: locks.rows.map((row) => row.data)
    };
  }

  async sessionWithRevision(tokenHash) {
    const result = await this.pool.query(
      `select s.data as session, u.data as user, coalesce(m.data, '{}'::jsonb) as application
       from indus_sessions s
       join indus_users u on u.id = s.user_id
       left join indus_meta m on m.key = 'application'
       where s.token_hash = $1 and s.expires_at > now()`,
      [tokenHash]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    if (!row.session || !row.user || row.session.userId !== row.user.id) return null;
    return {
      session: row.session,
      user: row.user,
      revision: Math.max(0, Number(row.application?.syncRevision || 0))
    };
  }

  async save(db) {
    const client = await this.pool.connect();
    const filesToDelete = [];
    try {
      await client.query("begin");
      const meta = Object.fromEntries(Object.entries(db).filter(([key]) => !META_EXCLUDED_KEYS.has(key)));
      await client.query(
        "insert into indus_meta (key, data) values ($1, $2::jsonb) on conflict (key) do update set data = excluded.data, updated_at = now()",
        ["application", json(meta)]
      );

      await this.#replaceRows(client, "indus_users", "id", Object.values(db.users || {}).map((item) => [String(item.id), item]));
      await this.#replaceSessions(client, db.sessions || {});
      await this.#replaceClients(client, db.clients || []);
      await this.#replaceTodos(client, db.todos || []);
      await this.#replaceRows(client, "indus_entries", "id", (db.entries || []).map((item) => [String(item.id), item]));
      await this.#replaceRows(client, "indus_debts", "id", (db.debts || []).map((item) => [String(item.id), item]));
      await this.#replacePayrolls(client, db.payrolls || []);
      await this.#replaceRows(client, "indus_billing_locks", "id", (db.billingLocks || []).map((item, index) => [String(item.id || `${item.workerId || "worker"}:${item.month || index}`), item]));
      filesToDelete.push(...await this.#replaceAttachments(client, db.attachments || {}));
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
    await Promise.all(filesToDelete.map((file) => fsp.rm(file, { force: true }).catch(() => {})));
  }

  async getAttachment(id, thumbnail = false) {
    const result = await this.pool.query(
      "select id, mime_type, byte_size, storage_key, thumbnail_key, data from indus_attachments where id = $1",
      [id]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    const storageKey = thumbnail ? row.thumbnail_key : row.storage_key;
    if (!storageKey) return null;
    const filePath = this.#safeMediaPath(storageKey);
    if (!filePath || !fs.existsSync(filePath)) return null;
    return {
      id: row.id,
      mimeType: thumbnail ? String(row.data?.thumbnailMimeType || "image/jpeg") : row.mime_type,
      byteSize: Number(row.byte_size || 0),
      filePath
    };
  }

  #safeMediaPath(storageKey) {
    const candidate = path.resolve(this.mediaDir, String(storageKey || ""));
    return candidate.startsWith(`${this.mediaDir}${path.sep}`) ? candidate : null;
  }

  async #replaceRows(client, table, keyColumn, rows) {
    const seen = [];
    for (const [id, data] of rows.filter(([id]) => id)) {
      seen.push(id);
      await client.query(
        `insert into ${table} (${keyColumn}, data) values ($1, $2::jsonb)
         on conflict (${keyColumn}) do update set data = excluded.data, updated_at = now()`,
        [id, json(data)]
      );
    }
    if (seen.length) {
      await client.query(`delete from ${table} where not (${keyColumn} = any($1::text[]))`, [seen]);
    } else {
      await client.query(`delete from ${table}`);
    }
  }

  async #replaceSessions(client, sessions) {
    const entries = Object.entries(sessions).filter(([tokenHash, value]) => tokenHash && value && Number(value.expiresAt) > Date.now());
    const ids = [];
    for (const [tokenHash, data] of entries) {
      ids.push(tokenHash);
      await client.query(
        `insert into indus_sessions (token_hash, user_id, expires_at, data) values ($1, $2, $3, $4::jsonb)
         on conflict (token_hash) do update set user_id = excluded.user_id, expires_at = excluded.expires_at, data = excluded.data, updated_at = now()`,
        [tokenHash, String(data.userId || ""), new Date(Number(data.expiresAt)), json(data)]
      );
    }
    if (ids.length) await client.query("delete from indus_sessions where token_hash <> all($1::text[])", [ids]);
    else await client.query("delete from indus_sessions");
  }

  async #replaceClients(client, clients) {
    const ids = [];
    for (const value of clients) {
      const id = String(value.clientId || "");
      if (!id) continue;
      ids.push(id);
      await client.query(
        `insert into indus_clients (client_id, alias, name, tax_id, needs_review, data)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (client_id) do update set alias = excluded.alias, name = excluded.name, tax_id = excluded.tax_id,
         needs_review = excluded.needs_review, data = excluded.data, updated_at = now()`,
        [id, String(value.alias || value.search || ""), String(value.name || ""), String(value.taxId || ""), Boolean(value.needsReview), json(value)]
      );
    }
    if (ids.length) await client.query("delete from indus_clients where client_id <> all($1::text[])", [ids]);
    else await client.query("delete from indus_clients");
  }

  async #replaceTodos(client, todos) {
    const taskMap = new Map();
    const assignments = [];
    for (const todo of todos) {
      if (!todo?.id) continue;
      const split = splitTodo(todo);
      if (!taskMap.has(split.taskId)) taskMap.set(split.taskId, split.task);
      assignments.push(split.assignment);
    }
    const taskIds = [];
    for (const [id, task] of taskMap) {
      taskIds.push(id);
      await client.query(
        `insert into indus_tasks (id, client_id, status, scheduled_date, archived_at, revision, data)
         values ($1, $2, $3, nullif($4, '')::date, nullif($5, '')::timestamptz, $6, $7::jsonb)
         on conflict (id) do update set client_id = excluded.client_id, status = excluded.status,
         scheduled_date = excluded.scheduled_date, archived_at = excluded.archived_at, revision = excluded.revision,
         data = excluded.data, updated_at = now()`,
        [id, String(task.clientId || ""), String(task.status || ""), String(task.date || ""), String(task.archivedAt || ""), Number(task.revision || 1), json(task)]
      );
    }
    if (taskIds.length) await client.query("delete from indus_tasks where id <> all($1::text[])", [taskIds]);
    else await client.query("delete from indus_tasks");

    const assignmentIds = [];
    for (const assignment of assignments) {
      assignmentIds.push(assignment.id);
      await client.query(
        `insert into indus_task_assignments (id, task_id, worker_id, manual_order, data)
         values ($1, $2, $3, $4, $5::jsonb)
         on conflict (id) do update set task_id = excluded.task_id, worker_id = excluded.worker_id,
         manual_order = excluded.manual_order, data = excluded.data, updated_at = now()`,
        [assignment.id, assignment.taskId, String(assignment.syncUser || ""), Number(assignment.order || 0), json(assignment)]
      );
    }
    if (assignmentIds.length) await client.query("delete from indus_task_assignments where id <> all($1::text[])", [assignmentIds]);
    else await client.query("delete from indus_task_assignments");
  }

  async #replacePayrolls(client, payrolls) {
    const ids = [];
    for (const item of payrolls) {
      const id = String(item.id || "");
      if (!id) continue;
      ids.push(id);
      await client.query(
        `insert into indus_payrolls (id, worker_id, month, data) values ($1, $2, $3, $4::jsonb)
         on conflict (id) do update set worker_id = excluded.worker_id, month = excluded.month, data = excluded.data, updated_at = now()`,
        [id, String(item.workerId || ""), String(item.month || ""), json(item)]
      );
    }
    if (ids.length) await client.query("delete from indus_payrolls where id <> all($1::text[])", [ids]);
    else await client.query("delete from indus_payrolls");
  }

  async #replaceAttachments(client, attachments) {
    const existing = await client.query("select id, storage_key, thumbnail_key, data from indus_attachments");
    const existingById = new Map(existing.rows.map((row) => [String(row.id), row]));
    const ids = [];
    for (const [id, raw] of Object.entries(attachments)) {
      if (!/^[a-f0-9]{64}$/.test(id) || !raw) continue;
      ids.push(id);
      const previous = existingById.get(id);
      const attachment = { ...raw, id };
      const file = dataUrlInfo(attachment.data);
      const thumbnail = dataUrlInfo(attachment.thumbnailData);
      const storageKey = file
        ? path.posix.join("objects", `${id}${extensionForMime(file.mimeType)}`)
        : String(attachment.storageKey || previous?.storage_key || "");
      const thumbnailKey = thumbnail
        ? path.posix.join("thumbnails", `${id}${extensionForMime(thumbnail.mimeType)}`)
        : String(attachment.thumbnailKey || previous?.thumbnail_key || "");
      if (file) await this.#writeMedia(storageKey, file.buffer);
      if (thumbnail) await this.#writeMedia(thumbnailKey, thumbnail.buffer);
      delete attachment.data;
      delete attachment.thumbnailData;
      attachment.mimeType = file?.mimeType || attachment.mimeType || previous?.data?.mimeType || "application/octet-stream";
      attachment.byteSize = file?.buffer.length || Number(attachment.byteSize || previous?.byte_size || 0);
      attachment.storageKey = storageKey;
      attachment.thumbnailKey = thumbnailKey;
      if (thumbnail) attachment.thumbnailMimeType = thumbnail.mimeType;
      await client.query(
        `insert into indus_attachments (id, mime_type, byte_size, storage_key, thumbnail_key, data)
         values ($1, $2, $3, $4, $5, $6::jsonb)
         on conflict (id) do update set mime_type = excluded.mime_type, byte_size = excluded.byte_size,
         storage_key = excluded.storage_key, thumbnail_key = excluded.thumbnail_key, data = excluded.data, updated_at = now()`,
        [id, attachment.mimeType, attachment.byteSize, storageKey, thumbnailKey, json(attachment)]
      );
      attachments[id] = attachment;
    }
    const stale = existing.rows.filter((row) => !ids.includes(String(row.id)));
    if (ids.length) await client.query("delete from indus_attachments where id <> all($1::text[])", [ids]);
    else await client.query("delete from indus_attachments");
    return stale.flatMap((row) => [row.storage_key, row.thumbnail_key]).filter(Boolean).map((key) => this.#safeMediaPath(key)).filter(Boolean);
  }

  async #writeMedia(storageKey, buffer) {
    const target = this.#safeMediaPath(storageKey);
    if (!target) throw new Error("Neveljaven kljuc priloge.");
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temp, buffer, { mode: 0o600 });
    await fsp.rename(temp, target);
  }
}

module.exports = { PostgresStore };
