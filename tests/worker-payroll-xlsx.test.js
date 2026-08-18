const assert = require("node:assert/strict");
const test = require("node:test");
const { Writable } = require("node:stream");
const unzipper = require("unzipper");
const { workerPayrollXlsxEntries, sendWorkerPayrollXlsx } = require("../outputs/server");

function sampleReport() {
  return {
    worker: { id: "ibro", name: "Ibro", billing: { exportTitle: "Ibrahim Etemaj" } },
    range: { from: "2026-08-01", to: "2026-08-15" },
    payroll: {
      status: "draft",
      lines: [{ date: "2026-08-04", start: "07:00", end: "10:30", title: "Montaža", client: "Primer d.o.o.", status: "completed", hourlyRate: 15, workerKm: 12, kmRate: 0.22, commuteKm: 4 }],
      payments: [{ createdAt: "2026-08-10T09:00:00.000Z", amount: 20, note: "Delno plačilo" }]
    },
    advances: [{ date: "2026-08-05", amount: 30, reason: "Material" }],
    receipts: [],
    purchases: [{ date: "2026-08-06", amount: 5, reason: "Zasebni nakup" }]
  };
}

test("XLSX obračun delavca vsebuje urejevalne formule in finančne postavke", () => {
  const workbook = workerPayrollXlsxEntries(sampleReport());
  assert.equal(workbook.summary[0][0].value, "OBRAČUN DELAVCA");
  assert.equal(workbook.details[1][3].formula, "IF(OR(B2=\"\",C2=\"\"),0,(C2-B2)*24)");
  assert.equal(workbook.details[1][5].formula, "D2*E2");
  assert.equal(workbook.details[1][11].formula, "F2+K2");
  assert.match(workbook.summary[7][1].formula, /Založeno/);
  assert.deepEqual(workbook.finances.slice(1).map((row) => row[1]), ["Založeno", "Osebni nakup", "Že izplačano"]);
});

test("XLSX obračun je veljaven ZIP s tremi berljivimi listi", async () => {
  const chunks = [];
  const response = new Writable({ write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
  response.writeHead = (status, headers) => { response.statusCode = status; response.headers = headers; };
  await sendWorkerPayrollXlsx(response, sampleReport());
  assert.equal(response.statusCode, 200);
  assert.match(response.headers["Content-Type"], /spreadsheetml/);
  const archive = await unzipper.Open.buffer(Buffer.concat(chunks));
  const files = archive.files.map((file) => file.path);
  assert.deepEqual(files.sort(), ["[Content_Types].xml", "_rels/.rels", "docProps/app.xml", "docProps/core.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml", "xl/worksheets/sheet2.xml", "xl/worksheets/sheet3.xml"].sort());
  const detailXml = (await archive.files.find((file) => file.path === "xl/worksheets/sheet2.xml").buffer()).toString("utf8");
  assert.match(detailXml, /<f>IF\(OR\(B2=&quot;&quot;,C2=&quot;&quot;\),0,\(C2-B2\)\*24\)<\/f>/);
});
