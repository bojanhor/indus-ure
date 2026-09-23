"use strict";

const crypto = require("node:crypto");
const planning = require("./planning-calendar");
const APP = "indus-planning-v1";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.app.created",
  "https://www.googleapis.com/auth/calendar.acls",
  "https://www.googleapis.com/auth/calendar.calendarlist.readonly"
];
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const statusCode = error => Number(error?.response?.status || error?.code || 0);
const missing = error => [404, 410].includes(statusCode(error));

function eventBody(todo, db, baseUrl, definitions) {
  const link = new URL("/", baseUrl);
  link.searchParams.set("todo", todo.id);
  const status = definitions[todo.status] || { label: todo.status, googleColorId: "8" };
  const people = (todo.assigneeIds || []).map(id => db.users?.[id]?.name || id).join(", ");
  const endDate = todo.endDate && todo.endDate >= todo.date ? todo.endDate : todo.date;
  const timed = /^\d{2}:\d{2}$/.test(todo.start || "") && /^\d{2}:\d{2}$/.test(todo.end || "");
  return {
    summary: `${todo.urgent ? "NUJNO: " : ""}${todo.title || "Opravilo"}${todo.client ? ` — ${todo.client}` : ""}`,
    description: [todo.client ? `Stranka: ${todo.client}` : "", people ? `Za: ${people}` : "",
      `Status: ${status.label}`, todo.notes || "", `Odpri v INDUS Ure: ${link}`,
      "Samo prikaz. Urejanje poteka v INDUS Ure."].filter(Boolean).join("\n\n"),
    start: timed ? { dateTime: `${todo.date}T${todo.start}:00`, timeZone: "Europe/Ljubljana" } : { date: todo.date },
    end: timed ? { dateTime: todo.end === "24:00" ? `${planning.nextDay(endDate)}T00:00:00` : `${endDate}T${todo.end}:00`, timeZone: "Europe/Ljubljana" } : { date: planning.nextDay(endDate) },
    colorId: status.googleColorId, visibility: "default", transparency: "opaque",
    guestsCanModify: false, guestsCanInviteOthers: false, guestsCanSeeOtherGuests: false,
    reminders: { useDefault: false },
    source: { title: "INDUS Ure", url: link.toString() },
    extendedProperties: { private: { indusApp: APP, indusKey: hash(todo.assignmentGroupId || todo.id) } }
  };
}

function calendarPlans(db, baseUrl, definitions) {
  const active = Object.values(db.users || {}).filter(user => user.active !== false);
  const bosses = active.filter(user => user.role === "boss" && user.email).map(user => user.email.toLowerCase());
  const plans = [{ key: "combined", title: "INDUS — Planiranje — Vsi delavci", readers: bosses,
    todos: planning.select(db.todos, { combined: true }) }];
  for (const user of active) {
    if (!user.email) continue;
    plans.push({ key: `worker:${user.id}`, title: `INDUS — Planiranje — ${user.name || user.id}`,
      readers: [user.email.toLowerCase()], todos: planning.select(db.todos, { userId: user.id }) });
  }
  return plans.map(plan => ({ ...plan, events: Object.fromEntries(plan.todos.map(todo => {
    const body = eventBody(todo, db, baseUrl, definitions);
    return [body.extendedProperties.private.indusKey, body];
  })) }));
}

async function pages(method, args) {
  const items = [];
  let pageToken;
  do {
    const { data } = await method({ ...args, ...(pageToken ? { pageToken } : {}) });
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

// Compare wall-clock values: Google returns explicit UTC offsets for timed
// events, whereas requests supply Europe/Ljubljana and the local time.
function controlledEvent(event) {
  const result = { summary: event.summary || "", description: event.description || "", colorId: event.colorId || "",
    visibility: event.visibility || "default", transparency: event.transparency || "opaque",
    guestsCanModify: Boolean(event.guestsCanModify), guestsCanInviteOthers: event.guestsCanInviteOthers !== false,
    guestsCanSeeOtherGuests: event.guestsCanSeeOtherGuests !== false,
    reminders: { useDefault: Boolean(event.reminders?.useDefault), overrides: event.reminders?.overrides || [] },
    source: { title: event.source?.title || "", url: event.source?.url || "" },
    extendedProperties: { private: { indusApp: event.extendedProperties?.private?.indusApp, indusKey: event.extendedProperties?.private?.indusKey } } };
  for (const key of ["start", "end"]) {
    const value = event[key] || {};
    // Google canonicalizes the IANA Ljubljana link to Europe/Belgrade.
    // Keep sending Ljubljana, but do not rewrite identical events forever.
    // Do not collapse arbitrary zones just because today's offset matches.
    const zone = value.timeZone || "Europe/Ljubljana";
    const timeZone = zone === "Europe/Belgrade" ? "Europe/Ljubljana" : zone;
    result[key] = value.date ? { date: value.date } : { dateTime: String(value.dateTime || "").slice(0, 19), timeZone };
  }
  return result;
}

function safeError(error) {
  const code = statusCode(error);
  if (code === 401 || /invalid_grant/.test(String(error?.message || ""))) return "Google dovoljenje je poteklo. Šef naj ponovno poveže koledar.";
  if (code === 403) return "Google je zavrnil dostop. Preveri dovoljenja, vklop Calendar API in pravila deljenja koledarjev.";
  if (code === 429) return "Google trenutno omejuje zahteve. Prenos bo ponovljen samodejno.";
  if (error.safeMessage) return error.safeMessage;
  return "Sinhronizacija ni uspela. Samodejno jo bomo ponovno poskusili; podatki v Urah so shranjeni.";
}
function fail(message) { const error = new Error(message); error.safeMessage = message; return error; }

function createGooglePlanningCalendar({ store, readDb, createApi, baseUrl, definitions, deploymentKey = "", runtimeEnabled = true, config = () => require("./app-config.defaults.json").calendar, now = () => Date.now() }) {
  let timer = null, interval = null, running = false, rerun = false, forceNext = false;
  const instance = hash(baseUrl).slice(0, 24);
  const marker = key => `${APP}:${instance}:${hash(key).slice(0, 24)}`;

  async function ensureCalendar(api, state, plan, save) {
    const description = `${marker(plan.key)}\nNamenski koledar INDUS Ure. Samo dogodki za planiranje; urejanje v aplikaciji.`;
    let record = state.calendars[plan.key];
    if (record?.id) {
      try {
        const { data } = await api.calendars.get({ calendarId: record.id });
        if (!String(data.description || "").startsWith(marker(plan.key))) throw fail("Oznaka namenskega koledarja se ne ujema. Zaradi varnosti sinhronizacija ni nadaljevana.");
        if (data.summary !== plan.title) await api.calendars.patch({ calendarId: record.id, requestBody: { summary: plan.title } });
        return record;
      } catch (error) {
        if (!missing(error)) throw error;
        delete state.calendars[plan.key];
        record = null;
        await save(state);
      }
    }
    const listed = await pages(args => api.calendarList.list(args), { minAccessRole: "owner", showHidden: true, maxResults: 250 });
    const found = listed.filter(item => String(item.description || "").startsWith(marker(plan.key)));
    if (found.length > 1) throw fail("Najdena sta podvojena namenska koledarja. Potreben je pregled pred nadaljevanjem.");
    if (found.length) {
      record = { id: found[0].id, events: {} };
    } else {
      // Persist intent BEFORE the external call. A timeout must not create a
      // second calendar on retry. Discovery can recover a successful response.
      if (record?.creating) throw fail("Ustvarjanje koledarja ima nejasen izid. Samodejno preverjamo, ali je bil ustvarjen; novega ne podvajamo.");
      state.calendars[plan.key] = { creating: true };
      await save(state);
      let data;
      try { ({ data } = await api.calendars.insert({ requestBody: { summary: plan.title, description, timeZone: "Europe/Ljubljana" } })); }
      catch (error) {
        if ([400, 401, 403, 429].includes(statusCode(error))) { delete state.calendars[plan.key]; await save(state); }
        throw error;
      }
      record = { id: data.id, events: {} };
    }
    state.calendars[plan.key] = record;
    await save(state);
    return record;
  }

  async function reconcileAccess(api, record, readers, ownerEmail) {
    const owner = String(ownerEmail || "").trim().toLowerCase();
    const desired = new Set(readers.map(email => String(email).trim().toLowerCase()).filter(email => email && email !== owner));
    const rules = await pages(args => api.acl.list(args), { calendarId: record.id, maxResults: 250 });
    const isConnectedOwner = rule => rule.role === "owner" && rule.scope?.type === "user"
      && String(rule.scope.value || "").toLowerCase() === owner;
    // Google's secondary calendars also carry a built-in owner ACL whose user
    // is the calendar itself. Accept only this exact calendar identity, and
    // only alongside the explicitly authenticated human owner. Never exempt
    // another calendar, a group/domain grant, or arbitrary owner identities.
    const isCalendarSelfOwner = rule => rule.role === "owner" && rule.scope?.type === "user"
      && typeof record.id === "string" && /^[^@\s]+@group\.calendar\.google\.com$/.test(record.id)
      && rule.scope.value === record.id;
    if (!owner || !rules.some(isConnectedOwner)) {
      throw fail("Pravica povezanega lastnika koledarja ni potrjena. Preveri pravice v Googlu.");
    }
    // Validate the complete (paginated) owner set before changing any ACL.
    if (rules.some(rule => rule.role === "owner" && !isConnectedOwner(rule) && !isCalendarSelfOwner(rule))) {
      throw fail("Namenski koledar ima dodatnega lastnika. Preveri pravice v Googlu.");
    }
    for (const rule of rules) {
      if (rule.role === "owner") continue;
      const email = String(rule.scope?.value || "").toLowerCase();
      if (rule.scope?.type === "user" && desired.has(email)) {
        if (rule.role !== "reader") await api.acl.patch({ calendarId: record.id, ruleId: rule.id, sendNotifications: false, requestBody: { role: "reader" } });
        desired.delete(email);
      } else {
        await api.acl.delete({ calendarId: record.id, ruleId: rule.id });
      }
    }
    for (const email of desired) await api.acl.insert({ calendarId: record.id, sendNotifications: false, requestBody: { role: "reader", scope: { type: "user", value: email } } });
  }

  async function putEvent(api, record, key, body, remote, saveState) {
    let persistedMapping = JSON.stringify(record.events[key]);
    let mapping = record.events[key] || { id: remote?.id || `1${hash([key, 0])}`, generation: 0 };
    if (remote) mapping = { ...mapping, id: remote.id, deleted: false };
    record.events[key] = mapping;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!remote && !mapping.deleted) {
        try { remote = (await api.events.get({ calendarId: record.id, eventId: mapping.id })).data; }
        catch (error) { if (!missing(error)) throw error; if (statusCode(error) === 410) mapping.deleted = true; }
      }
      if (mapping.deleted || remote?.status === "cancelled") {
        mapping = { id: `1${hash([key, (mapping.generation || 0) + 1])}`, generation: (mapping.generation || 0) + 1 };
        record.events[key] = mapping;
        remote = null;
      }
      if (JSON.stringify(mapping) !== persistedMapping) {
        await saveState(); // Preserve identity across a crash after Google accepts.
        persistedMapping = JSON.stringify(mapping);
      }
      if (remote) {
        if (remote.extendedProperties?.private?.indusApp !== APP || remote.extendedProperties?.private?.indusKey !== key) throw fail("Identiteta dogodka v Googlu se ne ujema. Tujega dogodka ne spreminjamo.");
        if (JSON.stringify(controlledEvent(remote)) !== JSON.stringify(controlledEvent(body))) {
          await api.events.update({ calendarId: record.id, eventId: mapping.id, sendUpdates: "none", requestBody: body }, { headers: remote.etag ? { "If-Match": remote.etag } : {} });
        }
        return;
      }
      try {
        await api.events.insert({ calendarId: record.id, sendUpdates: "none", requestBody: { id: mapping.id, ...body } });
        return;
      } catch (error) {
        if (statusCode(error) !== 409) throw error;
        try { remote = (await api.events.get({ calendarId: record.id, eventId: mapping.id })).data; }
        catch (lookup) { if (!missing(lookup)) throw lookup; mapping.deleted = true; }
      }
    }
    throw fail("Dogodka v Googlu še ni mogoče varno uskladiti. Prenos bo ponovljen.");
  }

  async function run({ force = false } = {}) {
    if (!runtimeEnabled) return;
    if (running) { rerun = true; return; }
    running = true;
    try {
      await store.locked(async ({ load, save }) => {
        const state = await load();
        if (!state.enabled || !state.tokens?.refresh_token || state.baseUrl !== baseUrl || (state.deploymentKey || "") !== deploymentKey) return;
        if (!force && Number(state.retryAt || 0) > now()) return;
        try {
          const db = await readDb();
          const plans = calendarPlans(db, baseUrl, definitions);
          const signature = hash(plans.map(({ key, title, readers, events }) => ({ key, title, readers, events })));
          if (!force && signature === state.signature && now() - Number(state.checkedAt || 0) < config().reconcileSeconds * 1000) return;
          const api = createApi(state.tokens);
          state.calendars ||= {};
          // Disabled/deleted workers lose access before their managed events
          // are removed. Keep the empty calendar for safe later reactivation.
          for (const key of Object.keys(state.calendars)) {
            if (!plans.some(plan => plan.key === key)) plans.push({ key, title: "INDUS — Planiranje — Neaktiven delavec", readers: [], events: {} });
          }
          const errors = [];
          for (const plan of plans) {
            try {
            const record = await ensureCalendar(api, state, plan, save);
            await reconcileAccess(api, record, plan.readers, state.ownerEmail);
            const remote = await pages(args => api.events.list(args), { calendarId: record.id, maxResults: 2500,
              privateExtendedProperty: `indusApp=${APP}`, showDeleted: false });
            const byKey = new Map(remote.map(event => [event.extendedProperties?.private?.indusKey, event]));
            record.events ||= {};
            for (const [key, body] of Object.entries(plan.events)) await putEvent(api, record, key, body, byKey.get(key), () => save(state));
            for (const event of remote) {
              const key = event.extendedProperties?.private?.indusKey;
              if (event.extendedProperties?.private?.indusApp !== APP || !key || plan.events[key]) continue;
              try { await api.events.delete({ calendarId: record.id, eventId: event.id, sendUpdates: "none" }); }
              catch (error) { if (!missing(error)) throw error; }
              record.events[key] = { ...(record.events[key] || { id: event.id, generation: 0 }), deleted: true };
              await save(state);
            }
            record.title = plan.title;
            record.count = Object.keys(plan.events).length;
            } catch (error) {
              errors.push(error);
              // An individual calendar failure must not prevent revoking a
              // departed worker's access on another managed calendar.
              if ([401, 429].includes(statusCode(error))) break;
            }
          }
          if (errors.length) throw errors[0];
          state.signature = signature;
          state.checkedAt = now();
          state.lastSuccessAt = new Date(now()).toISOString();
          state.lastError = ""; state.failures = 0; state.retryAt = 0;
          await save(state);
        } catch (error) {
          state.lastError = safeError(error);
          state.failures = (state.failures || 0) + 1;
          state.retryAt = now() + Math.min(config().retryMaxSeconds * 1000, 15000 * 2 ** Math.min(state.failures - 1, 6));
          await save(state);
        }
      });
    } finally {
      running = false;
      if (rerun) { rerun = false; schedule(); }
    }
  }
  function schedule(force = false) {
    if (!runtimeEnabled) return;
    forceNext ||= force;
    if (timer) return;
    timer = setTimeout(() => { timer = null; const forced = forceNext; forceNext = false; run({ force: forced }).catch(() => {}); }, config().debounceMs);
    timer.unref?.();
  }
  function start() {
    if (interval) return;
    schedule();
    interval = setInterval(() => schedule(), config().pollSeconds * 1000);
    interval.unref?.();
  }
  function stop() { if (timer) clearTimeout(timer); if (interval) clearInterval(interval); timer = interval = null; }
  async function connect({ tokens, ownerEmail, userId }) {
    await store.locked(async ({ load, save }) => {
      const state = await load();
      if (state.ownerEmail && state.ownerEmail !== ownerEmail) throw fail("Koledar je povezan z drugim lastnikom. Samodejna zamenjava ni dovoljena.");
      const refreshToken = tokens.refresh_token || state.tokens?.refresh_token;
      if (!refreshToken) throw fail("Google ni vrnil trajnega dovoljenja. Ponovno potrdi povezavo koledarja.");
      await save({ ...state, tokens: { ...tokens, refresh_token: refreshToken }, ownerEmail, userId, baseUrl, deploymentKey,
        enabled: true, retryAt: 0, signature: "", lastError: "", connectedAt: new Date(now()).toISOString() });
    });
    schedule(true);
  }
  async function status(user, canConnect) {
    const state = await store.load();
    const local = state.baseUrl === baseUrl && (state.deploymentKey || "") === deploymentKey;
    const ownKeys = new Set([`worker:${user.id}`, ...(user.role === "boss" ? Object.keys(state.calendars || {}) : [])]);
    const calendars = Object.entries(local ? (state.calendars || {}) : {}).filter(([key, value]) => ownKeys.has(key) && value.id).map(([key, value]) => ({
      key, title: value.title || "INDUS — Planiranje", count: value.count || 0,
      url: `https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(Buffer.from(value.id).toString("base64"))}`
    }));
    return { connected: Boolean(local && state.tokens?.refresh_token), enabled: Boolean(local && state.enabled), canConnect,
      lastSuccessAt: state.lastSuccessAt || "", lastError: state.lastError || "", running,
      needsEmail: !user.email, calendars, ...(user.role === "boss" ? { ownerEmail: state.ownerEmail || "" } : {}) };
  }
  async function setEnabled(enabled) {
    await store.locked(async ({ load, save }) => { const state = await load(); state.enabled = enabled; state.signature = ""; state.retryAt = 0; await save(state); });
    if (enabled) schedule(true);
  }
  return { run, schedule, start, stop, connect, status, setEnabled };
}

module.exports = { APP, SCOPES, eventBody, calendarPlans, controlledEvent, createGooglePlanningCalendar };
