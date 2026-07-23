const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildWorkerDailyReportPdf,
  gmailWorkerDigestDraftRaw,
  workerDailyDigestSnapshot,
  workerDailyReportFilename
} = require("../outputs/server");

const database = {
  users: {
    bojan: { id: "bojan", name: "Bojan", email: "bojan@example.test", role: "boss", billing: { hourlyRate: 20, commuteKmOneWay: 0 } },
    ibro: { id: "ibro", name: "Ibro", email: "ibro@example.test", role: "worker", billing: { hourlyRate: 15, commuteKmOneWay: 0 } }
  },
  settings: { billing: { hourlyRate: 15, workerOwnVehicleKmRate: 0.22, kmRate: 0.22, mealPaidMinutes: 45 } },
  payrolls: [],
  debts: [],
  todos: [
    { id: "first", assignmentGroupId: "first", syncUser: "ibro", createdBy: "ibro", status: "execution", date: "2026-07-22", start: "08:00", end: "09:00", title: "Servis", client: "Stranka", billingHourlyRate: 15, billingKm: 5 },
    { id: "second", assignmentGroupId: "second", syncUser: "ibro", createdBy: "ibro", status: "execution", date: "2026-07-22", start: "10:00", end: "11:30", title: "Popravilo", client: "Stranka", billingHourlyRate: 15, billingKm: 0, hoursNeedsReview: true }
  ]
};

test("dnevni povzetek uporablja obračunske vrstice, klicaj in PDF", async () => {
  const report = workerDailyDigestSnapshot(database, "ibro", "2026-07-22");
  assert.equal(report.lines.length, 2);
  assert.equal(report.warnings.length, 1);
  assert.equal(report.lines[0].workAmount, 15);
  assert.equal(workerDailyReportFilename(report), "dnevni-povzetek-Ibro-2026-07-22.pdf");
  const pdf = await buildWorkerDailyReportPdf(database, report);
  assert.ok(pdf.length > 1000);
  const raw = Buffer.from(gmailWorkerDigestDraftRaw({ to: report.email, workerName: report.workerName, date: report.date, pdf, pdfFilename: workerDailyReportFilename(report) }), "base64url").toString("utf8");
  assert.match(raw, /To: ibro@example\.test/);
  assert.match(raw, /application\/pdf/);
});