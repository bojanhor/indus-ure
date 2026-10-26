"use strict";

// Shared by live preview, immutable payroll snapshots and exports.
const PayrollTravel = (() => {
  const round = value => Number(Number(value || 0).toFixed(2));
  function priced({ workerKm = 0, commuteKm = 0, kmRate = 0, commuteKmRate = kmRate }) {
    const workerKmAmount = round(workerKm * kmRate);
    const commuteKmAmount = round(commuteKm * commuteKmRate);
    return { workerKm, commuteKm, kmRate, commuteKmRate, workerKmAmount, commuteKmAmount,
      km: round(workerKm + commuteKm), kmAmount: round(workerKmAmount + commuteKmAmount) };
  }
  function parts(line = {}) {
    const commuteKm = Number(line.commuteKm || 0);
    const workerKm = Number(line.workerKm ?? (Number(line.km || 0) - commuteKm));
    const kmRate = Number(line.kmRate || 0);
    const commuteKmRate = Number(line.commuteKmRate ?? kmRate);
    const commuteKmAmount = round(line.commuteKmAmount ?? (commuteKm * commuteKmRate));
    // Older snapshots rounded both journeys together. Allocate their rounding
    // remainder to business travel; never change a historical total by a cent.
    const workerKmAmount = round(line.workerKmAmount ?? (line.kmAmount == null
      ? workerKm * kmRate : Number(line.kmAmount) - commuteKmAmount));
    return { workerKm, commuteKm, kmRate, commuteKmRate, workerKmAmount, commuteKmAmount };
  }
  function totals(lines = []) {
    const sum = { workerKm: 0, commuteKm: 0, workerKmAmount: 0, commuteKmAmount: 0 };
    for (const line of lines) { const p = parts(line); for (const key of Object.keys(sum)) sum[key] += p[key]; }
    for (const key of Object.keys(sum)) sum[key] = round(sum[key]);
    return sum;
  }
  return { priced, parts, totals };
})();
if (typeof module !== "undefined" && module.exports) module.exports = PayrollTravel;
