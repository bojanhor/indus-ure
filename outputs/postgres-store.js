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
  ["indus_client_bills", "id", "clientBills", false],
  ["indus_billing_locks", "id", "billingLocks", false]
];

const META_EXCLUDED_KEYS = new Set([
  "users", "sessions", "clients", "entries", "todos", "attachments",
  "debts", "payrolls", "clientBills", "billingLocks"
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
    archivedAt: source.archivedAt || "",
    archivedPayrollId: source.archivedPayrollId || "",
    archivedClientBillId: source.archivedClientBillId || "",
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
    archivedAt: assignment.archivedAt || "",
    archivedPayrollId: assignment.archivedPayrollId || "",
    archivedClientBillId: assignment.archivedClientBillId || "",
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
      create index if not exists indus_tasks_active_schedule_idx on indus_tasks (scheduled_date desc, updated_at desc) where archived_at is null;
      create index if not exists indus_tasks_archived_schedule_idx on indus_tasks (archived_at desc, scheduled_date desc) where archived_at is not null;
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
      create index if not exists indus_task_assignments_worker_order_idx on indus_task_assignments (worker_id, manual_order, updated_at desc);
      create table if not exists indus_entries (
        id text primary key,
        client_id text not null default '',
        worker_id text not null default '',
        entry_date date,
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create index if not exists indus_entries_date_idx on indus_entries (entry_date);
      create index if not exists indus_entries_worker_date_idx on indus_entries (worker_id, entry_date desc);
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
      create table if not exists indus_client_bills (
        id text primary key,
        client_id text not null default '',
        status text not null default 'confirmed',
        data jsonb not null,
        updated_at timestamptz not null default now()
      );
      create index if not exists indus_client_bills_client_idx on indus_client_bills (client_id, updated_at desc);
      create index if not exists indus_client_bills_status_updated_idx on indus_client_bills (status, updated_at desc);
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
      create table if not exists indus_access_attempts (
        id text primary key,
        email text not null,
        outcome text not null default 'denied',
        created_at timestamptz not null default now()
      );
      create index if not exists indus_access_attempts_created_idx on indus_access_attempts (created_at desc);
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
    const [meta, users, sessions, clients, tasks, assignments, entries, attachments, debts, payrolls, clientBills, locks] = await Promise.all([
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
      this.pool.query("select id, data from indus_client_bills"),
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
      clientBills: clientBills.rows.map((row) => row.data),
      billingLocks: locks.rows.map((row) => row.data)
    };
  }

  async sessionWithRevision(tokenHash) {
    const result = await this.pool.query(
      // Deliberately project only the identity fields used by the lightweight
      // bootstrap routes. A user row can also contain OAuth credentials, so
      // carrying the whole JSON document through an ordinary /api/me request
      // is unnecessary (and makes it too easy to use it accidentally).
      `select s.data as session,
              jsonb_build_object(
                'id', u.id,
                'email', coalesce(u.data ->> 'email', ''),
                'name', coalesce(u.data ->> 'name', ''),
                'role', coalesce(u.data ->> 'role', ''),
                'avatar', coalesce(u.data ->> 'avatar', ''),
                'active', coalesce(u.data -> 'active', 'true'::jsonb),
                'employmentType', coalesce(u.data ->> 'employmentType', 'contractor'),
                'timeEntryForIds', coalesce(u.data -> 'timeEntryForIds', '[]'::jsonb)
              ) as user,
              coalesce(m.data ->> 'syncRevision', '0') as revision
       from indus_sessions s
       join indus_users u on u.id = s.user_id
       left join indus_meta m on m.key = 'application'
       where s.token_hash = $1 and s.expires_at > now()
         and coalesce(u.data ->> 'active', 'true') <> 'false'`,
      [tokenHash]
    );
    if (!result.rowCount) return null;
    const row = result.rows[0];
    if (!row.session || !row.user || row.session.userId !== row.user.id) return null;
    return {
      session: row.session,
      user: row.user,
      revision: Math.max(0, Number(row.revision || 0))
    };
  }

  // The initial page only needs a small public worker directory to populate
  // assignment controls. Do not use load() here: that would also fetch every
  // task, attachment, entry and billing row before an e-mail deep link opens.
  async publicUserDirectory() {
    const result = await this.pool.query(
      `select id,
              coalesce(data ->> 'name', '') as name,
              data ->> 'role' as role,
              coalesce(data #>> '{billing,exportTitle}', '') as export_title
       from indus_users
       where coalesce(data ->> 'active', 'true') <> 'false'
       order by lower(coalesce(data ->> 'name', '')), id`
    );
    return result.rows.map((row) => {
      const user = {
        id: String(row.id || ''),
        name: String(row.name || ''),
        exportTitle: String(row.export_title || '')
      };
      if (row.role) user.role = String(row.role);
      return user;
    });
  }

  // A link from e-mail opens one assignment, not the whole task list.  Keep
  // this query deliberately narrow so it stays quick even when the calendar
  // history and attachment table have grown large.
  async focusedTodo(id) {
    const todoId = String(id || "");
    if (!todoId) return null;
    const target = await this.pool.query(
      `select a.id as assignment_id, a.task_id, a.worker_id, a.data as assignment_data, t.data as task_data
       from indus_task_assignments a
       join indus_tasks t on t.id = a.task_id
       where a.id = $1`,
      [todoId]
    );
    if (!target.rowCount) return null;
    const row = target.rows[0];
    const assignments = await this.pool.query(
      "select id, worker_id, data from indus_task_assignments where task_id = $1",
      [row.task_id]
    );
    const todo = joinTodo(row.task_data || {}, {
      ...(row.assignment_data || {}),
      id: row.assignment_id,
      taskId: row.task_id,
      syncUser: row.assignment_data?.syncUser || row.worker_id || ""
    });
    const attachmentIds = [...new Set((todo.photos || [])
      .map((photo) => String(photo?.attachmentId || "").trim())
      .filter((attachmentId) => /^[a-f0-9]{64}$/i.test(attachmentId)))];
    const attachmentRows = attachmentIds.length
      ? await this.pool.query(
        "select id, mime_type, byte_size, storage_key, thumbnail_key, data from indus_attachments where id = any($1::text[])",
        [attachmentIds]
      )
      : { rows: [] };
    const attachments = {};
    for (const attachment of attachmentRows.rows) {
      attachments[attachment.id] = {
        ...(attachment.data || {}),
        id: attachment.id,
        mimeType: attachment.mime_type,
        byteSize: Number(attachment.byte_size || 0),
        storageKey: attachment.storage_key,
        thumbnailKey: attachment.thumbnail_key
      };
    }
    const assigneeIds = [...new Set(assignments.rows
      .map((assignment) => String(assignment.data?.syncUser || assignment.worker_id || "").trim())
      .filter(Boolean))];
    const assignmentIds = assignments.rows.map((assignment) => String(assignment.id || "")).filter(Boolean);
    return { todo, assigneeIds, assignmentIds, attachments };
  }

  // Completion-request links are sent by e-mail and must work even if their
  // original assignment was subsequently replaced.  Find the logical task by
  // the opaque token hash, then let the HTTP layer select the recipient's
  // current assignment.  This is intentionally a narrow lookup: loading the
  // full application state here would make the link feel broken on a large
  // calendar history.
  async completionRequestGroup(requestedAssignmentId, tokenHash) {
    const assignmentId = String(requestedAssignmentId || "");
    const hash = String(tokenHash || "").toLowerCase();
    if (!assignmentId || !/^[a-f0-9]{64}$/.test(hash)) return null;
    const tokenMatch = (parameter) => `exists (
      select 1
      from jsonb_array_elements(coalesce(a.data -> 'completionRequests', '[]'::jsonb)) as request(value)
      where lower(coalesce(request.value ->> 'tokenHash', '')) = $${parameter}
    )`;
    // Most links still point at their original assignment; avoid even a
    // group-wide lookup in that common case.  The fallback retains the older
    // promise that a link survives a later assignment-copy change.
    const direct = await this.pool.query(
      `select a.task_id from indus_task_assignments a where a.id = $1 and ${tokenMatch(2)}`,
      [assignmentId, hash]
    );
    const relocated = direct.rowCount ? null : await this.pool.query(
      `select a.task_id from indus_task_assignments a where ${tokenMatch(1)} limit 1`,
      [hash]
    );
    const taskId = direct.rows[0]?.task_id || relocated?.rows[0]?.task_id;
    if (!taskId) return null;
    const assignments = await this.pool.query(
      "select id, worker_id, data from indus_task_assignments where task_id = $1",
      [taskId]
    );
    return {
      taskId: String(taskId || ""),
      assignments: assignments.rows.map((row) => ({
        id: String(row.id || ""),
        workerId: String(row.worker_id || ""),
        data: row.data || {}
      })),
      completionRequests: assignments.rows.flatMap((row) => Array.isArray(row.data?.completionRequests)
        ? row.data.completionRequests
        : [])
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
      await this.#replaceClientBills(client, db.clientBills || []);
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
      const existing = taskMap.get(split.taskId);
      if (!existing) {
        taskMap.set(split.taskId, {
          task: split.task,
          allArchived: Boolean(split.assignment.archivedAt),
          archivedAt: String(split.assignment.archivedAt || "")
        });
      } else {
        existing.allArchived = existing.allArchived && Boolean(split.assignment.archivedAt);
        if (!existing.archivedAt && split.assignment.archivedAt) existing.archivedAt = String(split.assignment.archivedAt);
      }
      assignments.push(split.assignment);
    }
    const taskIds = [];
    for (const [id, record] of taskMap) {
      const { task } = record;
      taskIds.push(id);
      await client.query(
        `insert into indus_tasks (id, client_id, status, scheduled_date, archived_at, revision, data)
         values ($1, $2, $3, nullif($4, '')::date, nullif($5, '')::timestamptz, $6, $7::jsonb)
         on conflict (id) do update set client_id = excluded.client_id, status = excluded.status,
         scheduled_date = excluded.scheduled_date, archived_at = excluded.archived_at, revision = excluded.revision,
         data = excluded.data, updated_at = now()`,
        [id, String(task.clientId || ""), String(task.status || ""), String(task.date || ""), record.allArchived ? record.archivedAt : "", Number(task.revision || 1), json(task)]
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

  async #replaceClientBills(client, clientBills) {
    const ids = [];
    for (const item of clientBills) {
      const id = String(item.id || "");
      if (!id) continue;
      ids.push(id);
      await client.query(
        `insert into indus_client_bills (id, client_id, status, data) values ($1, $2, $3, $4::jsonb)
         on conflict (id) do update set client_id = excluded.client_id, status = excluded.status, data = excluded.data, updated_at = now()`,
        [id, String(item.clientId || ""), String(item.status || "confirmed"), json(item)]
      );
    }
    if (ids.length) await client.query("delete from indus_client_bills where id <> all($1::text[])", [ids]);
    else await client.query("delete from indus_client_bills");
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
    if (!target) throw new Error("Neveljaven ključ priloge.");
    await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(temp, buffer, { mode: 0o600 });
    await fsp.rename(temp, target);
  }
}

module.exports = { PostgresStore };
