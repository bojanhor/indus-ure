"use strict";

const WorkerAccess = (() => {
  // Migrate the existing shared external-worker profile once; subsequent
  // renaming does not change its meaning. Never infer this from payroll type.
  const kind = user => user?.workerKind || (String(user?.name || "").trim().toLocaleLowerCase("sl-SI") === "zunanji izvajalci" ? "external" : "person");
  const targets = (users, actor) => {
    if (!actor?.id || actor.active === false) return [];
    // Legacy timeEntryForIds were deliberately ignored by the previous release.
    // Only an explicit boss save activates the new allowlist, including [].
    const configured = actor.timeEntryPermissionsConfigured === true;
    const allowed = new Set(configured && Array.isArray(actor.timeEntryForIds) ? actor.timeEntryForIds : []);
    return (users || []).filter(user => user.active !== false && (actor.role === "boss"
      || (configured ? allowed.has(user.id) : user.id === actor.id || kind(user) === "external")));
  };
  return { kind, targets };
})();
if (typeof module !== "undefined" && module.exports) module.exports = WorkerAccess;
