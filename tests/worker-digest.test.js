const assert = require("node:assert/strict");
const test = require("node:test");

const {
  buildWorkerDailyReportPdf,
  canReadWorkerDailyReport,
  gmailWorkerDigestDraftRaw,
  gmailWorkerDigestMessageRaw,
  normalizeWorkerDigestRuns,
  recordWorkerDigestRun,
  workerDailyDigestSnapshot,
  workerDailyReportHtml,
  workerDailyReportText,
  workerDailyReportFilename,
  workerDigestPortalUrl,
  workerDigestRunFor,
  workerDigestRunKey
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
test("daily digest keeps archived and confirmed worker entries", () => {
  const historical = JSON.parse(JSON.stringify(database));
  historical.todos[0].archivedAt = "2026-07-22T12:00:00.000Z";
  historical.payrolls = [{ id: "confirmed", status: "confirmed", lines: [{ todoId: "first" }] }];
  const report = workerDailyDigestSnapshot(historical, "ibro", "2026-07-22");
  assert.equal(report.lines.length, 2);
  assert.equal(report.lines[0].title, "Servis");

  const empty = workerDailyDigestSnapshot(historical, "bojan", "2026-07-22");
  assert.ok(empty);
  assert.equal(empty.lines.length, 0);
});
test("dnevni portalni URL in HTML sta varna", () => {
  const report = workerDailyDigestSnapshot(database, "ibro", "2026-07-22");
  const portal = new URL(workerDigestPortalUrl("ibro", "2026-07-22"));
  assert.equal(portal.searchParams.get("worker-digest-worker"), "ibro");
  assert.equal(portal.searchParams.get("worker-digest-date"), "2026-07-22");
  assert.equal(report.portalUrl, portal.toString());

  const html = workerDailyReportHtml({ ...report, workerName: "Ibro <preveri>" });
  assert.match(html, /Ibro &lt;preveri&gt;/);
  assert.doesNotMatch(html, /Ibro <preveri>/);
  assert.match(html, /worker-digest-worker=ibro&amp;worker-digest-date=2026-07-22/);
  assert.match(html, /Servis/);
  assert.match(html, /Potrebno je preveriti ure/);
});

test("dnevni povzetek je dejanski HTML e-mail Bojanu brez PDF priponke", () => {
  const report = workerDailyDigestSnapshot(database, "ibro", "2026-07-22");
  const html = workerDailyReportHtml(report);
  const text = workerDailyReportText(report);
  const raw = Buffer.from(gmailWorkerDigestMessageRaw({
    to: "bojan@example.test",
    workerName: report.workerName,
    date: report.date,
    html,
    text
  }), "base64url").toString("utf8");

  assert.match(raw, /To: bojan@example\.test/);
  assert.match(raw, /multipart\/alternative/);
  assert.match(raw, /Content-Type: text\/plain; charset=utf-8/);
  assert.match(raw, /Content-Type: text\/html; charset=utf-8/);
  assert.doesNotMatch(raw, /application\/pdf/);
  assert.ok(raw.includes(Buffer.from(html, "utf8").toString("base64").slice(0, 32)));
});

test("dnevni povzetek se deduplicira po delavcu in datumu", () => {
  const db = { workerDigestRuns: [] };
  const report = { workerId: "ibro", date: "2026-07-22", lines: [{ id: "one" }], warnings: [] };
  assert.equal(workerDigestRunKey("ibro", "2026-07-22"), "ibro:2026-07-22");
  recordWorkerDigestRun(db, report, { recipientEmail: "bojan@example.test", messageId: "first", sentAt: "2026-07-22T08:00:00.000Z" });
  recordWorkerDigestRun(db, report, { recipientEmail: "bojan@example.test", messageId: "second", sentAt: "2026-07-22T08:01:00.000Z" });
  assert.equal(db.workerDigestRuns.length, 1);
  assert.equal(workerDigestRunFor(db, "ibro", "2026-07-22").messageId, "second");

  recordWorkerDigestRun(db, { ...report, workerId: "bojan" }, { recipientEmail: "bojan@example.test", messageId: "boss", sentAt: "2026-07-22T08:02:00.000Z" });
  assert.equal(db.workerDigestRuns.length, 2);
  const normalized = normalizeWorkerDigestRuns([
    ...db.workerDigestRuns,
    { key: "old:2024-01-01", workerId: "old", date: "2024-01-01", recipientEmail: "bojan@example.test", sentAt: "2024-01-01T00:00:00.000Z" }
  ], Date.parse("2026-07-22T12:00:00.000Z"));
  assert.equal(normalized.length, 2);
});

test("dnevni report lahko bere sef ali delavec sam", () => {
  assert.equal(canReadWorkerDailyReport({ id: "bojan", role: "boss" }, "ibro"), true);
  assert.equal(canReadWorkerDailyReport({ id: "ibro", role: "worker" }, "ibro"), true);
  assert.equal(canReadWorkerDailyReport({ id: "ibro", role: "worker" }, "bojan"), false);
  assert.equal(canReadWorkerDailyReport(null, "ibro"), false);
});
