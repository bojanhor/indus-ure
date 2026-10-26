"use strict";

// Missing personal rates inherit the existing company setting. In particular,
// zero is a deliberate personal rate, not a request to use the fallback.
function workerKmRateForUser(db, userId) {
  const values = [db.users?.[userId]?.billing?.workerOwnVehicleKmRate,
    db.settings?.billing?.workerOwnVehicleKmRate, db.settings?.billing?.kmRate];
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0 && number <= 1000) return number;
  }
  return 0;
}

function workerCommuteKmRateForUser(db, userId) {
  const value = db.users?.[userId]?.billing?.commuteKmRate;
  if (value !== null && value !== undefined && value !== "") {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0 && number <= 1000) return number;
  }
  return workerKmRateForUser(db, userId);
}

module.exports = { workerKmRateForUser, workerCommuteKmRateForUser };
