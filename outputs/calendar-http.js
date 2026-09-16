"use strict";

const crypto = require("node:crypto");
const { SCOPES } = require("./google-planning-calendar");

function createCalendarHttp({ service, requireUser, sendJson, sendText, readBody, googleClient, googleReady, googleProfile, ownerEmail, baseUrl }) {
  const pending = new Map();
  const canConnect = user => user.role === "boss" && String(user.email || "").toLowerCase() === ownerEmail;
  async function handle(req, res, url) {
    const callback = url.pathname === "/api/google/callback" && String(url.searchParams.get("state") || "").startsWith("planning:");
    if (!callback && !url.pathname.startsWith("/api/planning-calendar/")) return false;
    const user = await requireUser(req, res);
    if (!user) return true;
    if (url.pathname === "/api/planning-calendar/status" && req.method === "GET") {
      sendJson(res, 200, { ...await service.status(user, canConnect(user)), configured: googleReady() && Boolean(baseUrl) });
      return true;
    }
    if (callback) {
      const state = url.searchParams.get("state");
      const intent = pending.get(state);
      pending.delete(state);
      if (!intent || intent.userId !== user.id || intent.sessionToken !== String(req.indusSession?.tokenHash || req.indusSession?.csrfToken || "")
        || Date.now() - intent.at > 10 * 60000 || !canConnect(user)) {
        sendText(res, 401, "Povezava je potekla ali pripada drugi seji. V profilu ponovno izberi Poveži Google Koledar.", "text/plain");
        return true;
      }
      if (url.searchParams.get("error") || !url.searchParams.get("code")) {
        sendText(res, 400, "Povezava z Google Koledarjem ni bila potrjena. Podatki v Urah niso spremenjeni.", "text/plain");
        return true;
      }
      try {
        const auth = googleClient(req);
        const { tokens } = await auth.getToken(url.searchParams.get("code"));
        auth.setCredentials(tokens);
        const profile = await googleProfile(auth);
        const email = String(profile.email || "").toLowerCase();
        if (email !== ownerEmail || profile.verified_email === false) throw new Error("Napačen Google račun.");
        const granted = new Set(String(tokens.scope || "").split(/\s+/));
        if (!SCOPES.every(scope => granted.has(scope))) {
          sendText(res, 400, "Potrdi vsa zahtevana dovoljenja za namenski koledar in njegovo deljenje. Drive povezava ostaja nespremenjena.", "text/plain");
          return true;
        }
        await service.connect({ tokens, ownerEmail: email, userId: user.id });
        res.writeHead(303, { Location: `${baseUrl}/?planning_calendar=connected`, "Cache-Control": "no-store" });
        res.end();
      } catch (error) {
        sendText(res, 400, error.safeMessage || "Google Koledarja ni bilo mogoče povezati. Izberi pravilen službeni račun in poskusi ponovno.", "text/plain");
      }
      return true;
    }
    if (user.role !== "boss") { sendJson(res, 403, { error: "Povezavo koledarja upravlja šef." }); return true; }
    if (url.pathname === "/api/planning-calendar/auth" && req.method === "POST") {
      if (!canConnect(user)) { sendJson(res, 403, { error: "Google Koledar lahko poveže samo določeni službeni lastnik." }); return true; }
      if (!googleReady() || !baseUrl) { sendJson(res, 400, { error: "Google OAuth ali javni naslov aplikacije ni nastavljen." }); return true; }
      for (const [key, value] of pending) if (Date.now() - value.at > 10 * 60000) pending.delete(key);
      const state = `planning:${crypto.randomBytes(24).toString("hex")}`;
      pending.set(state, { userId: user.id, sessionToken: String(req.indusSession?.tokenHash || req.indusSession?.csrfToken || ""), at: Date.now() });
      const auth = googleClient(req);
      sendJson(res, 200, { url: auth.generateAuthUrl({ access_type: "offline", prompt: "consent", state,
        scope: ["openid", "email", ...SCOPES], include_granted_scopes: false, login_hint: ownerEmail }) });
      return true;
    }
    if (url.pathname === "/api/planning-calendar/sync" && req.method === "POST") {
      service.schedule(true);
      sendJson(res, 202, { queued: true });
      return true;
    }
    if (url.pathname === "/api/planning-calendar/enabled" && req.method === "PUT") {
      const body = await readBody(req);
      if (typeof body.enabled !== "boolean") { sendJson(res, 400, { error: "Manjka izbira vklopa." }); return true; }
      await service.setEnabled(body.enabled);
      sendJson(res, 200, await service.status(user, canConnect(user)));
      return true;
    }
    sendJson(res, 404, { error: "Pot koledarja ne obstaja." });
    return true;
  }
  return { handle };
}

module.exports = { createCalendarHttp };
