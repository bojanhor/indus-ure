"use strict";
const crypto = require("node:crypto");

// Requests are transient, just like editor leases. Never transfer a lease before
// its owner has saved/released it; an unresponsive device follows normal expiry.
class EditHandover {
  constructor() { this.requests = new Map(); }
  prune(now) {
    for (const [id, request] of this.requests) {
      if (now - request.createdAt > 180_000) this.requests.delete(id);
    }
  }
  request(todoId, lock, user, requestId = "", now = Date.now()) {
    this.prune(now);
    if (requestId) {
      const existing = this.requests.get(requestId);
      if (!existing || existing.todoId !== todoId || existing.userId !== user.id) return { status: "expired" };
      if (existing.status === "waiting" && (!lock || lock.token !== existing.ownerToken)) existing.status = "ready";
      return this.public(existing);
    }
    if (!lock) return { status: "ready" };
    const waiting = [...this.requests.values()].find((r) => r.ownerToken === lock.token && r.status === "waiting");
    if (waiting) return waiting.userId === user.id && waiting.todoId === todoId
      ? this.public(waiting) : { status: "busy" };
    const request = { id: crypto.randomUUID(), todoId, ownerToken: lock.token,
      userId: user.id, userName: user.name || user.id, createdAt: now,
      deadline: now + 20_000, status: "waiting" };
    this.requests.set(request.id, request);
    return this.public(request);
  }
  owner(lock, user, token, action = "poll", requestId = "", now = Date.now()) {
    this.prune(now);
    if (!lock || lock.userId !== user.id || lock.token !== token) return { status: "not-owner" };
    const request = [...this.requests.values()].find((r) => r.ownerToken === token && r.status === "waiting");
    if (!request) return { status: "idle" };
    if (["deny", "failed"].includes(action) && requestId === request.id) request.status = action === "deny" ? "denied" : "failed";
    return this.public(request);
  }
  cancel(todoId, user, requestId) {
    const request = this.requests.get(requestId);
    if (!request || request.todoId !== todoId || request.userId !== user.id) return {status:"expired"};
    if (request.status === "waiting") request.status = "cancelled";
    return this.public(request);
  }
  public(r) { return { requestId: r.id, status: r.status, requesterName: r.userName, deadline: r.deadline }; }
}
module.exports = { EditHandover };
