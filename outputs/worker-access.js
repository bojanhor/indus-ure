"use strict";

const WorkerAccess = (() => {
  // Migrate the existing shared external-worker profile once; subsequent
  // renaming does not change its meaning. Never infer this from payroll type.
  const kind = user => user?.workerKind || (String(user?.name || "").trim().toLocaleLowerCase("sl-SI") === "zunanji izvajalci" ? "external" : "person");
  const targets = (users, actor) => (users || []).filter(user => user.active !== false
    && (actor?.role === "boss" || user.id === actor?.id || kind(user) === "external"));
  return { kind, targets };
})();
if (typeof module !== "undefined" && module.exports) module.exports = WorkerAccess;
