"use strict";

// report-service: explicit dependencies; factory creation has no I/O or UI effects.
function createReportService({
  buildPayrollSnapshot,
  canManageTodo,
  cleanUserId,
  clientBillableHoursForTodos,
  clientBillCandidates,
  clientForBilling,
  getPgStore,
  googleClient,
  googleDriveOwner,
  googleReady,
  googleWorkspaceTokenAvailable,
  isDateKey,
  isTrashedTodo,
  latestCorrection,
  normalizePayroll,
  payrollLineForTodo,
  payrollMinutesForTodo,
  payrollRange,
  payrollTotals,
  readBody,
  readRequestDb,
  requireUser,
  securityHeaders,
  sendJson,
  sessionTokenFromRequest,
  sessionTokenHash,
  signedNumber,
  todoAssignmentItems,
  todoBillingEventId,
  todoDurationHours,
  validEmailAddress,
  validTodoAttachmentId,
  withDailyCommuteInPayroll,
  xlsxDateSerial,
  xlsxSheetXml,
  xlsxTimeSerial,
  moduleValues
}) {
function workerPayrollXlsxReport(db, workerId, rangeInput) {
  const range = payrollRange(rangeInput);
  if (!range || !db.users?.[workerId]) return null;
  const stored = (db.payrolls || []).find((payroll) => payroll.workerId === workerId && payroll.from === range.from && payroll.to === range.to);
  const payroll = stored && ["archiving", "confirmed", "paid"].includes(stored.status)
    ? normalizePayroll(stored, db)
    : buildPayrollSnapshot(db, workerId, range);
  if (!payroll) return null;
  const byId = (items = []) => new Map(items.map((item) => [String(item.id || ""), item]));
  const debts = byId(db.debts || []);
  const advances = (payroll.advanceIds || []).map((id) => debts.get(String(id))).filter(Boolean);
  const receipts = (payroll.clientReceiptIds || []).map((id) => debts.get(String(id))).filter(Boolean);
  const purchases = (payroll.personalPurchaseIds || []).map((id) => debts.get(String(id))).filter(Boolean);
  return { payroll, worker: db.users[workerId], range, advances, receipts, purchases };
}

function workerPayrollXlsxEntries(report) {
  const detailRows = (report.payroll.lines || []).map((line) => ({
    date: xlsxDateSerial(line.date), start: xlsxTimeSerial(line.start), end: xlsxTimeSerial(line.end),
    hourlyRate: Number(line.hourlyRate || 0), workerKm: Number(line.workerKm || 0), kmRate: Number(line.kmRate || 0), commuteKm: Number(line.commuteKm || 0),
    client: line.client || "", title: line.title || "", status: line.status || ""
  }));
  const financialRows = [
    ...report.advances.map((item) => ({ date: item.date, type: "Založeno", reason: item.reason || "", amount: Number(item.amount || 0), impact: Number(item.amount || 0) })),
    ...report.receipts.map((item) => ({ date: item.date, type: "Prejeta sredstva", reason: item.reason || "", amount: Number(item.amount || 0), impact: Number(item.amount || 0) })),
    ...report.purchases.map((item) => ({ date: item.date, type: "Osebni nakup", reason: item.reason || "", amount: Number(item.amount || 0), impact: -Number(item.amount || 0) })),
    ...(report.payroll.payments || []).map((item) => ({ date: String(item.createdAt || "").slice(0, 10), type: "Že izplačano", reason: item.note || "", amount: Number(item.amount || 0), impact: -Number(item.amount || 0) }))
  ].sort((left, right) => String(left.date).localeCompare(String(right.date)) || left.type.localeCompare(right.type, "sl"));
  const entryLastRow = Math.max(2, detailRows.length + 1);
  const financialLastRow = Math.max(2, financialRows.length + 1);
  const summary = [
    [{ value: "OBRAČUN DELAVCA", style: 1 }, { value: "", style: 1 }, { value: "", style: 1 }],
    [{ value: "Delavec", style: 2 }, { value: report.worker.billing?.exportTitle || report.worker.name || report.worker.id, style: 3 }],
    [{ value: "Obdobje", style: 2 }, { value: `${report.range.from} – ${report.range.to}`, style: 3 }],
    [{ value: "Stanje", style: 2 }, { value: report.payroll.status === "paid" ? "Plačano" : report.payroll.status === "confirmed" ? "Potrjeno" : "V pripravi", style: 3 }],
    [{ value: "Ure", style: 4 }, { value: "", style: 6, formula: `SUM('Vnosi'!D2:D${entryLastRow})` }, { value: "Delo", style: 4 }, { value: "", style: 7, formula: `SUM('Vnosi'!F2:F${entryLastRow})` }],
    [{ value: "Kilometrina", style: 4 }, { value: "", style: 6, formula: `SUM('Vnosi'!G2:G${entryLastRow})+SUM('Vnosi'!J2:J${entryLastRow})` }, { value: "Kilometrina", style: 4 }, { value: "", style: 7, formula: `SUM('Vnosi'!K2:K${entryLastRow})` }],
    [{ value: "Znesek skupaj", style: 8 }, { value: "", style: 9, formula: "D5+D6" }],
    [{ value: "Založeno", style: 4 }, { value: "", style: 7, formula: `SUMIF('Finančni vnosi'!B2:B${financialLastRow},"Založeno",'Finančni vnosi'!D2:D${financialLastRow})` }],
    [{ value: "Prejeta sredstva", style: 4 }, { value: "", style: 7, formula: `SUMIF('Finančni vnosi'!B2:B${financialLastRow},"Prejeta sredstva",'Finančni vnosi'!D2:D${financialLastRow})` }],
    [{ value: "Osebni nakupi", style: 4 }, { value: "", style: 7, formula: `SUMIF('Finančni vnosi'!B2:B${financialLastRow},"Osebni nakup",'Finančni vnosi'!D2:D${financialLastRow})` }],
    [{ value: "Že izplačano", style: 4 }, { value: "", style: 7, formula: `SUMIF('Finančni vnosi'!B2:B${financialLastRow},"Že izplačano",'Finančni vnosi'!D2:D${financialLastRow})` }],
    [{ value: "Razlika", style: 8 }, { value: "", style: 9, formula: "B8+B9-B10-B11" }],
    [{ value: "Za izplačilo", style: 10 }, { value: "", style: 11, formula: "B7+B12" }]
  ];
  const details = [["Datum", "Od", "Do", "Ure", "EUR/h", "Delo", "Km delavca", "EUR/km", "Vožnja", "Pot v službo", "Kilometrina", "Skupaj", "Stranka", "Ime opravila", "Status"]]
    .concat(detailRows.map((line, index) => {
      const row = index + 2;
      return [line.date, line.start, line.end, { formula: `IF(OR(B${row}=\"\",C${row}=\"\"),0,(C${row}-B${row})*24)` }, line.hourlyRate, { formula: `D${row}*E${row}` }, line.workerKm, line.kmRate, { formula: `G${row}*H${row}` }, line.commuteKm, { formula: `(G${row}+J${row})*H${row}` }, { formula: `F${row}+K${row}` }, line.client, line.title, line.status];
    }));
  const finances = [["Datum", "Vrsta", "Opis", "Znesek", "Vpliv na izplačilo"]]
    .concat(financialRows.map((line) => [xlsxDateSerial(line.date), line.type, line.reason, line.amount, line.impact]));
  return { summary, details, finances };
}

async function sendWorkerPayrollXlsx(res, report) {
  const sheets = workerPayrollXlsxEntries(report);
  const rows = (matrix) => matrix.map((row) => row.map((value) => typeof value === "object" && value ? { value: value.value ?? "", formula: value.formula || "" } : { value }));
  const detailSheetRows = rows(sheets.details).map((row, rowIndex) => row.map((cell, columnIndex) => {
    const style = rowIndex === 0 ? 1
      : columnIndex === 0 ? 12
        : [1, 2].includes(columnIndex) ? 13
          : [3, 4, 6, 7, 9].includes(columnIndex) ? 14
            : [5, 8, 10, 11].includes(columnIndex) ? 15 : 3;
    return { ...cell, style };
  }));
  const financialSheetRows = rows(sheets.finances).map((row, rowIndex) => row.map((cell, columnIndex) => ({
    ...cell,
    style: rowIndex === 0 ? 1 : columnIndex === 0 ? 12 : [3, 4].includes(columnIndex) ? 15 : 3
  })));
  const xml = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
    "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="0"/><sheets><sheet name="Povzetek" sheetId="1" r:id="rId1"/><sheet name="Vnosi" sheetId="2" r:id="rId2"/><sheet name="Finančni vnosi" sheetId="3" r:id="rId3"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>`,
    "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="4"><numFmt numFmtId="164" formatCode="dd.mm.yyyy"/><numFmt numFmtId="165" formatCode="hh:mm"/><numFmt numFmtId="166" formatCode="0.00"/><numFmt numFmtId="167" formatCode="# ##0.00 &quot;EUR&quot;"/></numFmts><fonts count="3"><font><sz val="10"/><name val="Aptos"/></font><font><b/><sz val="10"/><name val="Aptos Display"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="10"/><name val="Aptos Display"/></font></fonts><fills count="5"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1E6172"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE6F2EF"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FF173F4C"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFD7E0DD"/></left><right style="thin"><color rgb="FFD7E0DD"/></right><top style="thin"><color rgb="FFD7E0DD"/></top><bottom style="thin"><color rgb="FFD7E0DD"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="16"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/><xf numFmtId="0" fontId="2" fillId="2" borderId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="1" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="0" borderId="1" applyFont="1" applyBorder="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="166" fontId="1" fillId="3" borderId="1" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="167" fontId="1" fillId="3" borderId="1" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="1" fillId="3" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="167" fontId="1" fillId="3" borderId="1" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="0" fontId="2" fillId="4" borderId="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="167" fontId="2" fillId="4" borderId="1" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="166" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/><xf numFmtId="167" fontId="0" fillId="0" borderId="1" applyNumberFormat="1" applyBorder="1"/></cellXfs></styleSheet>`,
    "xl/worksheets/sheet1.xml": xlsxSheetXml(rows(sheets.summary), [28, 26, 20, 22]),
    "xl/worksheets/sheet2.xml": xlsxSheetXml(detailSheetRows, [13, 9, 9, 10, 11, 14, 14, 11, 14, 14, 15, 15, 28, 45, 16]),
    "xl/worksheets/sheet3.xml": xlsxSheetXml(financialSheetRows, [13, 20, 50, 16, 22]),
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>INDUS URE</dc:creator><dc:title>Obračun delavca</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created></cp:coreProperties>`,
    "docProps/app.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>INDUS URE</Application><TitlesOfParts><vt:vector size="3" baseType="lpstr"><vt:lpstr>Povzetek</vt:lpstr><vt:lpstr>Vnosi</vt:lpstr><vt:lpstr>Finančni vnosi</vt:lpstr></vt:vector></TitlesOfParts></Properties>`
  };
  const safeWorker = String(report.worker.name || report.worker.id || "delavec").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase() || "delavec";
  res.writeHead(200, securityHeaders({
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": attachmentContentDisposition(`indus-ure-obracun-${safeWorker}-${report.range.from}-${report.range.to}.xlsx`),
    "Cache-Control": "no-store"
  }));
  await new Promise((resolve, reject) => {
    const archive = moduleValues.archiver("zip", { zlib: { level: 9 } });
    archive.on("error", reject);
    res.on("finish", resolve);
    archive.pipe(res);
    for (const [filename, content] of Object.entries(xml)) archive.append(content, { name: filename });
    archive.finalize().catch(reject);
  });
}

function clientReportSelection(db, input = {}) {
  const selection = clientBillCandidates(db, input);
  if (!selection.client || !selection.groups.length) return null;
  if (selection.requestedEventIds && selection.groups.length !== selection.requestedEventIds.size) return null;
  const groups = selection.groups.map((group) => {
    const todos = [...group.todos].sort((left, right) => String(left.date || "").localeCompare(String(right.date || ""))
      || String(left.start || "").localeCompare(String(right.start || ""))
      || String(left.id || "").localeCompare(String(right.id || "")));
    const correction = latestCorrection(db, (item) => item?.type === "client" && item?.status === "pending" && String(item.eventId || "") === String(group.eventId));
    if (!correction || !todos.length) return { eventId: group.eventId, todos };
    const representative = todos[0];
    return { eventId: group.eventId, todos: [{ ...representative, title: "Popravek obračuna: " + String(correction.after?.title || representative.title || "storitev"), start: "", end: "", reportHours: signedNumber(correction.delta?.hours), clientKm: signedNumber(correction.delta?.clientKm), materialAmount: signedNumber(correction.delta?.materialAmount), externalDelivery: Boolean(correction.after?.externalDelivery), status: correction.after?.status || representative.status, clientVehicle: correction.after?.clientVehicle || representative.clientVehicle, notes: "Popravek že potrjene storitve. Poročilo vsebuje samo razliko glede na prvotni obračun.", material: correction.after?.material || "" }] };
  }).sort((left, right) => {
    const leftTodo = left.todos[0] || {};
    const rightTodo = right.todos[0] || {};
    return String(leftTodo.date || "").localeCompare(String(rightTodo.date || ""))
      || String(leftTodo.start || "").localeCompare(String(rightTodo.start || ""))
      || String(leftTodo.title || "").localeCompare(String(rightTodo.title || ""));
  });
  return {
    client: selection.client,
    from: isDateKey(input?.from) ? String(input.from) : "",
    to: isDateKey(input?.to) ? String(input.to) : "",
    groups
  };
}

function clientReportRequestIsValid(input) {
  return Boolean(input && typeof input === "object" && !Array.isArray(input))
    && (input.eventIds === undefined || Array.isArray(input.eventIds));
}

function clientReportDownloadPayload(input = {}) {
  const cleanList = (value, max = 1_000) => Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim().slice(0, 240)).filter(Boolean))].slice(0, max)
    : undefined;
  return {
    clientId: String(input.clientId || "").trim().slice(0, 160),
    clientName: String(input.clientName || "").trim().slice(0, 240),
    from: isDateKey(input.from) ? String(input.from) : "",
    to: isDateKey(input.to) ? String(input.to) : "",
    eventIds: cleanList(input.eventIds),
    attachmentIds: cleanList(input.attachmentIds),
    exportOptions: clientReportExportOptions(input.exportOptions)
  };
}

function pruneClientReportDownloadTickets(now = Date.now()) {
  for (const [token, ticket] of moduleValues.clientReportDownloadTickets) {
    if (Number(ticket?.expiresAt || 0) <= now) moduleValues.clientReportDownloadTickets.delete(token);
  }
  while (moduleValues.clientReportDownloadTickets.size > moduleValues.MAX_CLIENT_REPORT_DOWNLOAD_TICKETS) {
    const oldest = moduleValues.clientReportDownloadTickets.keys().next().value;
    if (!oldest) break;
    moduleValues.clientReportDownloadTickets.delete(oldest);
  }
}

function createClientReportDownloadTicket(req, user, payload) {
  pruneClientReportDownloadTickets();
  const token = moduleValues.crypto.randomBytes(32).toString("base64url");
  moduleValues.clientReportDownloadTickets.set(token, {
    userId: String(user?.id || ""),
    sessionHash: sessionTokenHash(sessionTokenFromRequest(req)),
    payload: clientReportDownloadPayload(payload),
    expiresAt: Date.now() + moduleValues.CLIENT_REPORT_DOWNLOAD_TICKET_TTL_MS
  });
  return token;
}

function clientReportDownloadTicketForRequest(req, user, token) {
  pruneClientReportDownloadTickets();
  const ticket = moduleValues.clientReportDownloadTickets.get(String(token || ""));
  if (!ticket) return null;
  const sameUser = ticket.userId && ticket.userId === String(user?.id || "");
  const sameSession = ticket.sessionHash && ticket.sessionHash === sessionTokenHash(sessionTokenFromRequest(req));
  return sameUser && sameSession ? ticket : null;
}

function pruneTodoSharePdfDownloadTickets(now = Date.now()) {
  for (const [token, ticket] of moduleValues.todoSharePdfDownloadTickets) {
    if (Number(ticket?.expiresAt || 0) <= now) moduleValues.todoSharePdfDownloadTickets.delete(token);
  }
  while (moduleValues.todoSharePdfDownloadTickets.size > moduleValues.MAX_CLIENT_REPORT_DOWNLOAD_TICKETS) {
    const oldest = moduleValues.todoSharePdfDownloadTickets.keys().next().value;
    if (!oldest) break;
    moduleValues.todoSharePdfDownloadTickets.delete(oldest);
  }
}

function createTodoSharePdfDownloadTicket(req, user, todoId) {
  pruneTodoSharePdfDownloadTickets();
  const token = moduleValues.crypto.randomBytes(32).toString("base64url");
  moduleValues.todoSharePdfDownloadTickets.set(token, {
    userId: String(user?.id || ""),
    sessionHash: sessionTokenHash(sessionTokenFromRequest(req)),
    todoId: String(todoId || ""),
    expiresAt: Date.now() + moduleValues.CLIENT_REPORT_DOWNLOAD_TICKET_TTL_MS
  });
  return token;
}

function todoSharePdfDownloadTicketForRequest(req, user, token) {
  pruneTodoSharePdfDownloadTickets();
  const ticket = moduleValues.todoSharePdfDownloadTickets.get(String(token || ""));
  if (!ticket) return null;
  const sameUser = ticket.userId && ticket.userId === String(user?.id || "");
  const sameSession = ticket.sessionHash && ticket.sessionHash === sessionTokenHash(sessionTokenFromRequest(req));
  return sameUser && sameSession ? ticket : null;
}

function safeReportFileName(value, fallback = "priloga") {
  const cleaned = String(value || "").trim()
    .replace(/[\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120);
  return cleaned || fallback;
}

function attachmentMimeExtension(mimeType) {
  const type = String(mimeType || "").toLowerCase();
  if (type === "application/pdf") return ".pdf";
  if (type === "image/jpeg") return ".jpg";
  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "text/plain") return ".txt";
  return "";
}

function clientReportAttachmentSelection(report, attachmentIds) {
  const available = new Map();
  for (const group of report.groups || []) {
    for (const todo of group.todos || []) {
      for (const photo of todo.photos || []) {
        const attachmentId = String(photo?.attachmentId || "");
        if (!validTodoAttachmentId(attachmentId) || available.has(attachmentId)) continue;
        available.set(attachmentId, {
          id: attachmentId,
          name: safeReportFileName(photo.name || "priloga"),
          eventId: group.eventId
        });
      }
    }
  }
  const requested = Array.isArray(attachmentIds)
    ? [...new Set(attachmentIds.map((id) => String(id || "").trim()).filter(Boolean))]
    : [...available.keys()];
  if (requested.length > 1_000) throw new Error("Za en izvoz lahko izbereš največ 1000 prilog.");
  if (requested.some((id) => !validTodoAttachmentId(id) || !available.has(id))) {
    throw new Error("Izbrana priloga ne pripada oznacenim vpisom poročila.");
  }
  return requested.map((id) => available.get(id));
}

function dataUrlAttachmentBytes(value) {
  const match = String(value || "").match(/^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/);
  return match ? { mimeType: match[1], bytes: Buffer.from(match[2], "base64") } : null;
}

async function loadClientReportAttachments(db, selected = [], { maxAttachmentBytes = moduleValues.REPORT_PDF_MAX_TOTAL_BYTES, maxTotalBytes = moduleValues.REPORT_PDF_MAX_TOTAL_BYTES, destination = "PDF" } = {}) {
  const attachments = [];
  let totalBytes = 0;
  for (const selectedAttachment of selected) {
    let mimeType = "application/octet-stream";
    let bytes = null;
    if (moduleValues.DATABASE_URL) {
      const stored = await getPgStore().getAttachment(selectedAttachment.id, false);
      if (stored) {
        mimeType = String(stored.mimeType || mimeType);
        bytes = await moduleValues.fsp.readFile(stored.filePath);
      }
    } else {
      const parsed = dataUrlAttachmentBytes(db.attachments?.[selectedAttachment.id]?.data);
      if (parsed) {
        mimeType = parsed.mimeType || mimeType;
        bytes = parsed.bytes;
      }
    }
    if (!bytes?.length) throw new Error(`Priloge \"${selectedAttachment.name}\" ni mogoče prebrati.`);
    if (bytes.length > maxAttachmentBytes) {
      throw new Error(`Priloga \"${selectedAttachment.name}\" je prevelika za ${destination} izvoz.`);
    }
    totalBytes += bytes.length;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Izbrane priloge so skupaj prevelike za ${destination} izvoz. Izberi manj prilog.`);
    }
    const extension = attachmentMimeExtension(mimeType);
    const baseName = safeReportFileName(selectedAttachment.name || "priloga");
    const filename = extension && !baseName.toLowerCase().endsWith(extension) ? `${baseName}${extension}` : baseName;
    const storedMetadata = db.attachments?.[selectedAttachment.id] || {};
    attachments.push({
      ...selectedAttachment,
      mimeType,
      bytes,
      filename,
      driveFileId: String(storedMetadata.driveFileId || ""),
      driveUrl: String(storedMetadata.driveUrl || "")
    });
  }
  return attachments;
}

function reportPdfFontPath(weight = "regular") {
  return moduleValues.path.resolve(moduleValues.root, "..", "node_modules", "pdfjs-dist", "standard_fonts", weight === "bold" ? "LiberationSans-Bold.ttf" : "LiberationSans-Regular.ttf");
}

function reportPdfDate(date) {
  if (!isDateKey(date)) return "Brez datuma";
  const [year, month, day] = String(date).split("-");
  return `${day}. ${month}. ${year}`;
}

function clientReportExportOptions(input = {}) {
  const hoursMode = ["client_billable", "worker_total", "worker_time"].includes(String(input?.hoursMode || ""))
    ? String(input.hoursMode)
    : "client_billable";
  const heading = String(input?.heading || "").trim().slice(0, 120);
  return { hoursMode, heading };
}

function reportPdfAssigneeTitle(db, todo) {
  const worker = db.users?.[todo?.syncUser || todo?.createdBy] || {};
  const title = String(worker.billing?.exportTitle || "").trim() || "Izvajalec";
  const name = String(worker.name || todo?.updatedByName || todo?.createdByName || "").trim();
  return name ? `${title} (${name})` : title;
}

function reportPdfAssignees(db, todos) {
  return [...new Set((todos || []).map((todo) => reportPdfAssigneeTitle(db, todo)))].join(", ");
}

function reportPdfVehicleLabel(vehicle) {
  return vehicle === "van" ? "kombi" : "osebni avto";
}

function reportPdfDriveFileLink(doc, file) {
  const url = String(file?.url || "").trim();
  if (!url) return;
  const label = file?.kind === "video" ? "Video" : "Dokument";
  doc.font(reportPdfFontPath("bold")).fillColor("#1e3430").text(`${label}: `, { continued: true });
  doc.font(reportPdfFontPath()).fillColor("#0d6d95").text(String(file?.name || "Priloga"), { link: url, underline: true });
  doc.fillColor("#263634");
}

function reportPdfAttachmentSummary(attachments = []) {
  const counts = attachments.reduce((summary, attachment) => {
    const type = String(attachment?.mimeType || "").toLowerCase();
    if (type.startsWith("image/")) summary.photos += 1;
    else if (type === "application/pdf") summary.pdfs += 1;
    else summary.files += 1;
    return summary;
  }, { photos: 0, pdfs: 0, files: 0 });
  const plural = (count, one, two, few, many) => count === 1 ? one : count === 2 ? two : count < 5 ? few : many;
  return [
    counts.photos && `${counts.photos} ${plural(counts.photos, "fotografija", "fotografiji", "fotografije", "fotografij")}`,
    counts.pdfs && `${counts.pdfs} ${plural(counts.pdfs, "PDF dokument", "PDF dokumenta", "PDF dokumenti", "PDF dokumentov")}`,
    counts.files && `${counts.files} ${plural(counts.files, "datoteka", "datoteki", "datoteke", "datotek")}`
  ].filter(Boolean).join(", ");
}

function reportPdfAttachmentTitle(attachment, index) {
  const type = String(attachment?.mimeType || "").toLowerCase();
  if (type.startsWith("image/")) return `Fotografija ${index}`;
  if (type === "application/pdf") return `PDF dokument ${index}`;
  return `Priloga ${index}`;
}

function reportPdfAttachmentLinks(doc, attachments = []) {
  if (!attachments.length) return;
  const shared = attachments.filter((attachment) => String(attachment?.driveUrl || "").trim());
  if (!shared.length) {
    reportPdfLine(doc, "Vključene priloge", reportPdfAttachmentSummary(attachments));
    return;
  }
  doc.font(reportPdfFontPath("bold")).fillColor("#1e3430").text("Vključene priloge: ", { continued: true });
  if (shared.length === 1) {
    doc.font(reportPdfFontPath()).fillColor("#0d6d95").text(reportPdfAttachmentSummary(shared), {
      link: shared[0].driveUrl,
      underline: true
    });
  } else {
    shared.forEach((attachment, index) => {
      doc.font(reportPdfFontPath()).fillColor("#0d6d95").text(reportPdfAttachmentTitle(attachment, index + 1), {
        link: attachment.driveUrl,
        underline: true,
        continued: index < shared.length - 1
      });
      if (index < shared.length - 1) doc.text(" · ", { continued: true });
    });
  }
  doc.fillColor("#263634");
}

function reportPdfLine(doc, label, value) {
  if (!value) return;
  doc.font(reportPdfFontPath("bold")).fillColor("#1e3430").text(`${label}: `, { continued: true });
  doc.font(reportPdfFontPath()).fillColor("#263634").text(String(value));
}

function reportPdfEnsureSpace(doc, height = 0) {
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y + height > bottom) doc.addPage();
}

function reportPdfAttachmentPreviews(doc, attachments = []) {
  const images = attachments.filter((attachment) => /^image\/(jpeg|png)$/i.test(String(attachment?.mimeType || '')));
  for (const [index, attachment] of images.entries()) {
    reportPdfEnsureSpace(doc, 218);
    const label = reportPdfAttachmentTitle(attachment, index + 1);
    doc.font(reportPdfFontPath('bold')).fontSize(10).fillColor('#1e3430').text(label);
    const x = doc.page.margins.left;
    const y = doc.y + 5;
    try {
      // Half of the printable A4 width keeps reports readable while retaining
      // enough detail for photos from the field.
      doc.image(attachment.bytes, x, y, { fit: [250, 180], align: 'left', valign: 'top' });
      if (String(attachment.driveUrl || '').trim()) doc.link(x, y, 250, 180, attachment.driveUrl);
      doc.y = y + 188;
    } catch {
      reportPdfLine(doc, 'Priloga', 'Slike ni bilo mogo\u010de vgraditi; v PDF je prilo\u017een izvirnik.');
    }
  }
}

function buildClientReportPdf(db, report, attachments = [], exportOptions = {}) {
  const options = clientReportExportOptions(exportOptions);
  const heading = options.heading || 'Obra\u010dun opravljenih storitev';
  const title = `${heading} - ${safeReportFileName(report.client?.name || 'stranka')}`;
  return new Promise((resolve, reject) => {
    const doc = new moduleValues.PDFDocument({
      size: 'A4',
      margin: 46,
      info: { Title: title, Author: 'INDUS URE', Subject: heading }
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.once('error', reject);
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    try {
      doc.font(reportPdfFontPath('bold')).fontSize(21).fillColor('#0d536b').text(heading);
      doc.moveDown(0.3);
      doc.font(reportPdfFontPath()).fontSize(11).fillColor('#263634');
      reportPdfLine(doc, 'Stranka', report.client?.name || '');
      if (report.client?.email) reportPdfLine(doc, 'E-po\u0161ta', report.client.email);
      if (report.from || report.to) reportPdfLine(doc, 'Obdobje', `${report.from ? reportPdfDate(report.from) : '-'} - ${report.to ? reportPdfDate(report.to) : '-'}`);
      doc.moveDown(0.8);

      for (const group of report.groups || []) {
        const todo = group.todos?.[0] || {};
        const warranty = Boolean(todo.warranty);
        const materialEntry = todo.status === "material";
        const noteEntry = todo.status === "note";
        const clientBillableHours = warranty || materialEntry || noteEntry ? 0 : clientBillableHoursForTodos(group.todos);
        const workerHours = warranty || materialEntry || noteEntry ? 0 : Number((group.todos || []).reduce((sum, item) => sum + todoDurationHours(item), 0).toFixed(2));
        const hours = options.hoursMode === "client_billable" ? clientBillableHours : workerHours;
        const clientKm = warranty || materialEntry || noteEntry ? 0 : Math.max(0, Number(todo.clientKm || 0));
        doc.font(reportPdfFontPath('bold')).fontSize(13).fillColor('#143b34').text(reportPdfDate(todo.date));
        doc.font(reportPdfFontPath('bold')).fontSize(12).fillColor('#161f20').text(String(todo.title || 'Brez naziva'));
        doc.font(reportPdfFontPath()).fontSize(10).fillColor('#263634');
        if (!materialEntry && !noteEntry) reportPdfLine(doc, 'Izvajalec', reportPdfAssignees(db, group.todos));
        if (options.hoursMode === "worker_time" && !materialEntry && !noteEntry) {
          const workerTimes = (group.todos || []).filter((item) => item.start && item.end)
            .map((item) => reportPdfAssigneeTitle(db, item) + ': ' + item.start + '-' + item.end).join(', ');
          if (workerTimes) reportPdfLine(doc, '\u010cas izvajalcev', workerTimes);
        }
        if (materialEntry) reportPdfLine(doc, todo.externalDelivery ? 'Dostava' : 'Vrsta vpisa', todo.externalDelivery ? 'Material je neposredno dostavil zunanji dobavitelj.' : 'Material brez izvajalca.');
        if (noteEntry) reportPdfLine(doc, 'Vrsta vpisa', 'Zapisek brez obračuna ur in kilometrine.');
        if (warranty) reportPdfLine(doc, 'Garancija', 'Storitev se ne obra\u010dunava stranki.');
        if (hours) reportPdfLine(doc, options.hoursMode === "client_billable" ? 'Za obra\u010dun' : 'Ure izvajalcev', hours.toLocaleString('sl-SI', { maximumFractionDigits: 2 }) + ' h');
        if (clientKm) reportPdfLine(doc, 'Stro\u0161ki prevoza (obe smeri)', `${reportPdfVehicleLabel(todo.clientVehicle)} - ${clientKm.toLocaleString('sl-SI', { maximumFractionDigits: 1 })} km`);
        if (todo.notes) reportPdfLine(doc, 'Opis del', todo.notes);
        if (todo.material) reportPdfLine(doc, 'Material', todo.material);
        const driveFiles = [...new Map(group.todos.flatMap((item) => item.driveFiles || []).filter((file) => file?.url).map((file) => [file.url, file])).values()];
        for (const file of driveFiles) reportPdfDriveFileLink(doc, file);
        const groupAttachments = attachments.filter((attachment) => attachment.eventId === group.eventId);
        if (groupAttachments.length) reportPdfAttachmentLinks(doc, groupAttachments);
        reportPdfAttachmentPreviews(doc, groupAttachments);
        doc.moveDown(0.75);
        reportPdfEnsureSpace(doc, 20);
        doc.strokeColor('#a9c5bd').lineWidth(1.4).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
        doc.moveDown(0.75);
      }

      const workerHoursByWorker = new Map();
      const travel = { personal: 0, van: 0 };
      const totalHours = (report.groups || []).reduce((sum, group) => {
        const representative = group.todos?.[0] || {};
        if (['material', 'note'].includes(representative.status)) return sum;
        if (representative.warranty) return sum;
        const vehicle = representative.clientVehicle === 'van' ? 'van' : 'personal';
        travel[vehicle] += Math.max(0, Number(representative.clientKm || 0));
        const clientBillableHours = clientBillableHoursForTodos(group.todos || []);
        const workerHours = (group.todos || []).reduce((hours, item) => hours + todoDurationHours(item), 0);
        if (options.hoursMode !== "client_billable") {
          for (const item of group.todos || []) {
            const workerHoursForItem = todoDurationHours(item);
            if (!workerHoursForItem) continue;
            const label = reportPdfAssigneeTitle(db, item);
            workerHoursByWorker.set(label, (workerHoursByWorker.get(label) || 0) + workerHoursForItem);
          }
        }
        return sum + (options.hoursMode === "client_billable" ? clientBillableHours : workerHours);
      }, 0);
      reportPdfEnsureSpace(doc, 105);
      doc.moveDown(0.4);
      doc.font(reportPdfFontPath('bold')).fontSize(13).fillColor('#0d536b').text(options.hoursMode === "client_billable" ? 'Ure za obra\u010dun' : 'Ure izvajalcev');
      if (options.hoursMode !== "client_billable" && workerHoursByWorker.size) {
        [...workerHoursByWorker.entries()].sort(([left], [right]) => left.localeCompare(right, 'sl')).forEach(([label, hours]) => {
          reportPdfLine(doc, label, hours.toLocaleString('sl-SI', { maximumFractionDigits: 2 }) + ' h');
        });
      }
      reportPdfLine(doc, 'Skupaj', totalHours.toLocaleString('sl-SI', { maximumFractionDigits: 2 }) + ' h');
      if (travel.personal || travel.van) {
        doc.moveDown(0.35);
        doc.font(reportPdfFontPath('bold')).fontSize(13).fillColor('#0d536b').text('Skupaj prevoza');
        if (travel.personal) reportPdfLine(doc, 'Osebni avto', `${travel.personal.toLocaleString('sl-SI', { maximumFractionDigits: 1 })} km`);
        if (travel.van) reportPdfLine(doc, 'Kombi', `${travel.van.toLocaleString('sl-SI', { maximumFractionDigits: 1 })} km`);
        reportPdfLine(doc, 'Skupaj', `${(travel.personal + travel.van).toLocaleString('sl-SI', { maximumFractionDigits: 1 })} km`);
      }

      for (const attachment of attachments) {
        doc.file(attachment.bytes, {
          name: attachment.filename,
          type: attachment.mimeType,
          description: `Priloga: ${attachment.name}`,
          relationship: 'Supplement'
        });
      }
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

async function sendClientReportPdf(res, db, body) {
  const report = clientReportSelection(db, body);
  if (!report) {
    sendJson(res, 409, { error: "Izbrani vpisi niso več na voljo za poročilo. Osveži pogled in preveri izbor." });
    return false;
  }
  let attachments;
  try {
    const requestedAttachments = clientReportAttachmentSelection(report, body.attachmentIds);
    attachments = await loadClientReportAttachments(db, requestedAttachments, { destination: "PDF" });
  } catch (error) {
    console.error("Prilog za PDF poročilo ni bilo mogoče pripraviti:", error?.message || error);
    sendJson(res, 400, { error: "Izbrane priloge za PDF poročilo niso na voljo. Osveži pogled in poskusi znova." });
    return false;
  }
  let pdf;
  try {
    pdf = await buildClientReportPdf(db, report, attachments, body.exportOptions);
  } catch (error) {
    console.error("PDF poročila ni bilo mogoče ustvariti:", error?.message || error);
    sendJson(res, 500, { error: "PDF poročila ni bilo mogoče pripraviti. Poskusi znova." });
    return false;
  }
  const filename = clientReportFilename(report.client);
  res.writeHead(200, securityHeaders({
    "Content-Type": "application/pdf",
    "Content-Length": pdf.length,
    "Content-Disposition": attachmentContentDisposition(filename),
    "Cache-Control": "no-store"
  }));
  res.end(pdf);
  return true;
}

function todoShareReport(db, todo) {
  const todos = todoAssignmentItems(db, todo).filter((item) => !isTrashedTodo(item));
  if (!todos.length) return null;
  const first = todos[0];
  const client = clientForBilling(db, { clientId: first.clientId, clientName: first.client }) || {
    clientId: String(first.clientId || ""),
    name: String(first.client || "Brez stranke"),
    email: ""
  };
  return {
    client,
    from: String(first.date || ""),
    to: String(first.endDate || first.date || ""),
    groups: [{ eventId: todoBillingEventId(first), todos }]
  };
}

function todoSharePdfFilename(todo) {
  const date = isDateKey(todo?.date) ? String(todo.date) : "brez-datuma";
  const title = safeReportFileName(todo?.title || "dogodek").replace(/\s+/g, "-");
  return `dogodek-${date}-${title || "brez-naslova"}.pdf`;
}

async function sendTodoSharePdf(res, db, todo) {
  const report = todoShareReport(db, todo);
  if (!report) {
    sendJson(res, 404, { error: "Dogodek ni več na voljo." });
    return false;
  }
  try {
    const attachments = await loadClientReportAttachments(db, clientReportAttachmentSelection(report), { destination: "PDF" });
    const pdf = await buildClientReportPdf(db, report, attachments, { hoursMode: "worker_time", heading: "Dogodek" });
    res.writeHead(200, securityHeaders({
      "Content-Type": "application/pdf",
      "Content-Length": pdf.length,
      "Content-Disposition": attachmentContentDisposition(todoSharePdfFilename(todo)),
      "Cache-Control": "no-store"
    }));
    res.end(pdf);
    return true;
  } catch (error) {
    console.error("PDF dogodka ni bilo mogoče ustvariti:", error?.message || error);
    sendJson(res, 500, { error: "PDF dogodka ni bilo mogoče pripraviti. Poskusi znova." });
    return false;
  }
}

function workerDigestBaseUrl() {
  return moduleValues.PUBLIC_BASE_URL || `http://127.0.0.1:${moduleValues.PORT}`;
}

function workerDigestTodoUrl(todoId) {
  return `${workerDigestBaseUrl()}/?todo=${encodeURIComponent(String(todoId || ""))}`;
}

function workerDigestPortalUrl(workerId, date) {
  const id = cleanUserId(workerId);
  const reportDate = isDateKey(date) ? String(date) : "";
  if (!id || !reportDate) return `${workerDigestBaseUrl()}/`;
  return `${workerDigestBaseUrl()}/?worker-digest-worker=${encodeURIComponent(id)}&worker-digest-date=${encodeURIComponent(reportDate)}`;
}

function workerDigestMinutes(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function workerDigestGapLabel(value) {
  const minutes = Math.max(0, Math.round(Number(value) || 0));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours} h ${remainder} min` : `${hours} h`;
}

function workerDailyDigestSnapshot(db, workerId, date) {
  const worker = db.users?.[workerId] || null;
  if (!worker || !isDateKey(date)) return null;
  // This is a historical daily journal, not a live payroll draft: archived or
  // already confirmed entries must stay visible in the morning digest.
  const lines = withDailyCommuteInPayroll(db, workerId, (db.todos || [])
    .filter((todo) => !todo.imported && !isTrashedTodo(todo) && (todo.syncUser || todo.createdBy) === workerId && todo.date === date)
    .map((todo) => payrollLineForTodo(db, todo, workerId))
    .filter(Boolean)
    .sort((left, right) => String(left.date || "").localeCompare(String(right.date || "")) || String(left.start || "").localeCompare(String(right.start || "")) || String(left.title || "").localeCompare(String(right.title || ""), "sl")));
  const totals = payrollTotals(lines);
  const warnings = (db.todos || [])
    .filter((todo) => !todo.imported && !isTrashedTodo(todo) && (todo.syncUser || todo.createdBy) === workerId && todo.date === date && moduleValues.PAYROLL_PAID_TODO_STATUSES.has(todo.status))
    .filter((todo) => Boolean(todo.hoursNeedsReview) || !payrollMinutesForTodo(db, todo))
    .sort((left, right) => String(left.start || "").localeCompare(String(right.start || "")) || String(left.title || "").localeCompare(String(right.title || "")))
    .map((todo) => ({ id: String(todo.id || ""), title: String(todo.title || "Brez naziva"), start: String(todo.start || ""), end: String(todo.end || "") }));
  return {
    workerId,
    workerName: String(worker.name || workerId),
    email: String(worker.email || "").trim().toLowerCase(),
    date,
    portalUrl: workerDigestPortalUrl(workerId, date),
    lines,
    warnings,
    totals
  };
}

function canReadWorkerDailyReport(user, workerId) {
  const id = cleanUserId(workerId);
  return Boolean(user && id && (user.role === "boss" || cleanUserId(user.id) === id));
}

function workerDailyReportFilename(report) {
  const worker = safeReportFileName(report?.workerName || "delavec").replace(/\s+/g, "-");
  return `dnevni-povzetek-${worker || "delavec"}-${report?.date || "dan"}.pdf`;
}

function workerDigestHtmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  }[character]));
}

function workerDigestAmount(value, digits = 2) {
  return Number(value || 0).toLocaleString("sl-SI", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function workerDailyReportText(report = {}) {
  const readableDate = reportPdfDate(report.date);
  const lines = [...(report.lines || [])].sort((left, right) => String(left.start || "").localeCompare(String(right.start || "")) || String(left.end || "").localeCompare(String(right.end || "")) || String(left.title || "").localeCompare(String(right.title || "")));
  const text = [
    "Dnevni povzetek ur",
    `Delavec: ${report.workerName || ""}`,
    `Datum: ${readableDate}`,
    ""
  ];
  if (lines.length) {
    text.push("Vpisane ure:");
    for (const line of lines) {
      const time = line.start && line.end ? `${line.start}-${line.end}` : "Brez ure";
      const client = line.client ? ` | ${line.client}` : "";
      text.push(`- ${time} | ${line.title || "Brez naziva"}${client} | ${workerDigestAmount(line.hours || 0)} h | ${workerDigestAmount(line.hourlyRate || 0)} EUR/h`);
    }
  } else {
    text.push("Za ta dan ni vpisanih obra\u010dunskih ur.");
  }
  if ((report.warnings || []).length) {
    text.push("", "Potrebno je preveriti ure:");
    for (const warning of report.warnings) text.push(`- ${warning.title || "Brez naziva"}`);
  }
  const totals = report.totals || payrollTotals(lines);
  text.push("", `Skupaj: ${workerDigestAmount(totals.hours || 0)} h | ${workerDigestAmount(totals.totalAmount || 0)} EUR`);
  if (report.portalUrl) text.push("", `Odpri dnevni povzetek v INDUS URE: ${report.portalUrl}`);
  return text.join("\n");
}

function workerDailyReportHtml(report = {}) {
  const readableDate = reportPdfDate(report.date);
  const lines = [...(report.lines || [])].sort((left, right) => String(left.start || "").localeCompare(String(right.start || "")) || String(left.end || "").localeCompare(String(right.end || "")) || String(left.title || "").localeCompare(String(right.title || "")));
  const rows = lines.map((line) => {
    const time = line.start && line.end ? `${line.start}&ndash;${line.end}` : "Brez ure";
    const title = workerDigestHtmlEscape(line.title || "Brez naziva");
    const client = workerDigestHtmlEscape(line.client || "");
    const href = workerDigestTodoUrl(line.todoId);
    return `<tr><td style="padding:10px 8px;border-bottom:1px solid #d7e4df;white-space:nowrap">${time}</td><td style="padding:10px 8px;border-bottom:1px solid #d7e4df"><a href="${href}" style="color:#0d536b;font-weight:700;text-decoration:none">${title}</a>${client ? `<br><span style="color:#60706c">${client}</span>` : ""}</td><td style="padding:10px 8px;border-bottom:1px solid #d7e4df;text-align:right;white-space:nowrap">${workerDigestAmount(line.hours || 0)} h</td></tr>`;
  }).join("") || '<tr><td colspan="3" style="padding:12px 8px;color:#60706c">Za ta dan ni vpisanih obra\u010dunskih ur.</td></tr>';
  const warnings = (report.warnings || []).map((warning) => `<li style="margin:4px 0"><a href="${workerDigestTodoUrl(warning.id)}" style="color:#a12b22">${workerDigestHtmlEscape(warning.title || "Brez naziva")}</a></li>`).join("");
  const totals = report.totals || payrollTotals(lines);
  const portalUrl = String(report.portalUrl || workerDigestPortalUrl(report.workerId, report.date));
  return `<!doctype html><html lang="sl"><body style="margin:0;background:#f3f7f5;color:#1e3430;font:15px Arial,sans-serif"><main style="max-width:680px;margin:0 auto;padding:24px"><section style="background:#fff;border:1px solid #d7e4df;border-radius:14px;overflow:hidden"><header style="padding:22px 24px;background:#0d536b;color:#fff"><h1 style="margin:0;font-size:22px">Dnevni povzetek ur</h1><p style="margin:7px 0 0">${workerDigestHtmlEscape(report.workerName || "Delavec")} &middot; ${workerDigestHtmlEscape(readableDate)}</p></header><div style="padding:18px 24px"><table role="presentation" style="width:100%;border-collapse:collapse"><tbody>${rows}</tbody></table>${warnings ? `<section style="margin-top:18px;padding:12px 14px;background:#fff5f3;border-left:4px solid #b3261e"><strong>Potrebno je preveriti ure</strong><ul style="margin:8px 0 0;padding-left:20px">${warnings}</ul></section>` : ""}<section style="margin-top:18px;padding:14px;background:#eaf4f1;border-radius:9px"><strong>Skupaj: ${workerDigestAmount(totals.hours || 0)} h</strong><span style="float:right">${workerDigestAmount(totals.totalAmount || 0)} EUR</span></section><p style="margin:22px 0 4px"><a href="${workerDigestHtmlEscape(portalUrl)}" style="display:inline-block;padding:11px 16px;border-radius:8px;background:#0d536b;color:#fff;font-weight:700;text-decoration:none">Odpri dnevni povzetek</a></p></div></section></main></body></html>`;
}

function buildWorkerDailyReportPdf(db, report) {
  const snapshot = report || {};
  const title = `Dnevni povzetek ur - ${safeReportFileName(snapshot.workerName || "delavec")}`;
  return new Promise((resolve, reject) => {
    const doc = new moduleValues.PDFDocument({
      size: "A4",
      margin: 46,
      info: { Title: title, Author: "INDUS URE", Subject: "Dnevni povzetek ur" }
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.once("error", reject);
    doc.once("end", () => resolve(Buffer.concat(chunks)));
    try {
      doc.font(reportPdfFontPath("bold")).fontSize(21).fillColor("#0d536b").text("Dnevni povzetek ur");
      doc.moveDown(0.3);
      doc.font(reportPdfFontPath()).fontSize(11).fillColor("#263634");
      reportPdfLine(doc, "Delavec", snapshot.workerName || "");
      reportPdfLine(doc, "Datum", reportPdfDate(snapshot.date));
      doc.moveDown(0.75);

      const lines = [...(snapshot.lines || [])].sort((left, right) => String(left.start || "").localeCompare(String(right.start || "")) || String(left.end || "").localeCompare(String(right.end || "")) || String(left.title || "").localeCompare(String(right.title || "")));
      let previous = null;
      for (const line of lines) {
        const startMinutes = workerDigestMinutes(line.start);
        const previousEnd = workerDigestMinutes(previous?.end);
        if (previous && startMinutes !== null && previousEnd !== null && startMinutes > previousEnd) {
          reportPdfEnsureSpace(doc, 28);
          doc.font(reportPdfFontPath("bold")).fontSize(10).fillColor("#0d536b").text(`\u2195 Razmak med vnosi: ${workerDigestGapLabel(startMinutes - previousEnd)}`);
          doc.moveDown(0.25);
        }
        reportPdfEnsureSpace(doc, 88);
        const url = workerDigestTodoUrl(line.todoId);
        doc.font(reportPdfFontPath("bold")).fontSize(13).fillColor("#143b34").text(`${line.start}-${line.end}`, { continued: true });
        doc.font(reportPdfFontPath("bold")).fontSize(12).fillColor("#161f20").text(`  ${line.title || "Brez naziva"}`, { link: url, underline: true });
        doc.font(reportPdfFontPath()).fontSize(10).fillColor("#263634");
        if (line.client) reportPdfLine(doc, "Stranka", line.client);
        reportPdfLine(doc, "Vpisane ure", `${Number(line.hours || 0).toLocaleString("sl-SI", { maximumFractionDigits: 2 })} h`);
        reportPdfLine(doc, "Urna postavka", `${Number(line.hourlyRate || 0).toLocaleString("sl-SI", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR/h`);
        if (Number(line.km || 0)) reportPdfLine(doc, "Kilometrina", `${Number(line.km || 0).toLocaleString("sl-SI", { maximumFractionDigits: 1 })} km`);
        doc.moveDown(0.4);
        doc.strokeColor("#a9c5bd").lineWidth(1.2).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
        doc.moveDown(0.5);
        previous = line;
      }

      for (const warning of snapshot.warnings || []) {
        reportPdfEnsureSpace(doc, 45);
        const url = workerDigestTodoUrl(warning.id);
        doc.font(reportPdfFontPath("bold")).fontSize(11).fillColor("#b3261e").text(`\u26a0 Popravi delovne ure: ${warning.title}`, { link: url, underline: true });
        doc.font(reportPdfFontPath()).fontSize(10).fillColor("#263634").text("Za ta vpis manjka ali je ozna\u010dena kot potrebna preveritev ura prihoda oziroma odhoda.");
        doc.moveDown(0.35);
      }

      const totals = payrollTotals(lines);
      reportPdfEnsureSpace(doc, 90);
      doc.moveDown(0.35);
      doc.font(reportPdfFontPath("bold")).fontSize(13).fillColor("#0d536b").text("Povzetek dneva");
      reportPdfLine(doc, "Ure", `${Number(totals.hours || 0).toLocaleString("sl-SI", { maximumFractionDigits: 2 })} h`);
      reportPdfLine(doc, "Delo", `${Number(totals.workAmount || 0).toLocaleString("sl-SI", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`);
      reportPdfLine(doc, "Kilometrina", `${Number(totals.km || 0).toLocaleString("sl-SI", { maximumFractionDigits: 1 })} km - ${Number(totals.kmAmount || 0).toLocaleString("sl-SI", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`);
      reportPdfLine(doc, "Skupaj", `${Number(totals.totalAmount || 0).toLocaleString("sl-SI", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} EUR`);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

function mimeBase64(value) {
  return Buffer.from(value).toString("base64").replace(/.{1,76}/g, "$&\r\n");
}

function gmailPdfDraftRaw({ to, subject, text, pdf, pdfFilename, attachments = [] }) {
  const boundary = `indus-ure-${moduleValues.crypto.randomBytes(18).toString("hex")}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(String(subject || ""), "utf8").toString("base64")}?=`;
  const parts = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    mimeBase64(String(text || "")),
    `--${boundary}`,
    `Content-Type: application/pdf; name=\"${pdfFilename}\"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename=\"${pdfFilename}\"`,
    "",
    mimeBase64(pdf)
  ];
  for (const attachment of attachments) {
    parts.push(
      `--${boundary}`,
      `Content-Type: ${attachment.mimeType}; name=\"${attachment.filename}\"`,
      "Content-Transfer-Encoding: base64",
      `Content-Disposition: attachment; filename=\"${attachment.filename}\"`,
      "",
      mimeBase64(attachment.bytes)
    );
  }
  parts.push(`--${boundary}--`, "");
  return Buffer.from(parts.join("\r\n")).toString("base64url");
}

function gmailDraftRaw({ to, pdf, pdfFilename, attachments = [] }) {
  return gmailPdfDraftRaw({
    to,
    pdf,
    pdfFilename,
    attachments,
    subject: "Obra\u010dun",
    text: "Pozdravljeni, v prilogi vam po\u0161iljam obra\u010dun opravljenih storitev in porabljenega materiala.\n\nZa pojasnila sem seveda na voljo."
  });
}

function gmailWorkerDigestDraftRaw({ to, workerName, date, pdf, pdfFilename }) {
  const readableDate = reportPdfDate(date);
  return gmailPdfDraftRaw({
    to,
    pdf,
    pdfFilename,
    subject: `Dnevni povzetek ur - ${workerName} - ${readableDate}`,
    text: `Pozdravljeni,\n\nv prilogi je dnevni povzetek vpisanih ur za ${readableDate}. Povezave v PDF-ju odprejo isto opravilo v INDUS URE.\n\nLep pozdrav.`
  });
}

function gmailWorkerDigestMessageRaw({ to, workerName, date, html, text }) {
  const recipient = String(to || "").trim().toLowerCase();
  if (!validEmailAddress(recipient)) throw new Error("Dnevnega povzetka ni mogo\u010de poslati brez veljavnega Bojanovega e-naslova.");
  const boundary = `indus-ure-digest-${moduleValues.crypto.randomBytes(18).toString("hex")}`;
  const subject = `Dnevni povzetek ur - ${String(workerName || "delavec")} - ${reportPdfDate(date)}`;
  const encodedSubject = `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
  const parts = [
    `To: ${recipient}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary=\"${boundary}\"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    mimeBase64(String(text || "")),
    `--${boundary}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    mimeBase64(String(html || "")),
    `--${boundary}--`,
    ""
  ];
  return Buffer.from(parts.join("\r\n")).toString("base64url");
}

function gmailCompletionRequestRaw({ to, subject, text }) {
  const encodedSubject = `=?UTF-8?B?${Buffer.from(String(subject || ""), "utf8").toString("base64")}?=`;
  const parts = [
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    mimeBase64(String(text || ""))
  ];
  return Buffer.from(parts.join("\r\n")).toString("base64url");
}

function clientReportFilename(client) {
  const suffix = safeReportFileName(client?.name || "stranka").replace(/\s+/g, "-");
  return `obračun-${suffix || "stranka"}.pdf`;
}

function attachmentContentDisposition(filename) {
  const original = safeReportFileName(filename, "priloga");
  const asciiFallback = original.normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._ -]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[-. ]+|[-. ]+$/g, "")
    .slice(0, 120) || "priloga";
  const utf8Filename = encodeURIComponent(original).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${utf8Filename}`;
}

async function handleWorkerReports(req, res, url) {
    if (url.pathname === "/api/worker-daily-report" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return true;
      const requestedWorkerId = url.searchParams.get("workerId");
      const workerId = requestedWorkerId === null || requestedWorkerId === ""
        ? cleanUserId(user.id)
        : cleanUserId(requestedWorkerId);
      const date = String(url.searchParams.get("date") || "");
      if (!workerId || !isDateKey(date)) {
        sendJson(res, 400, { error: "Izberi veljavnega delavca in datum dnevnega povzetka." });
        return true;
      }
      if (!canReadWorkerDailyReport(user, workerId)) {
        sendJson(res, 403, { error: "Dnevni povzetek drugega delavca vidi samo \u0161ef." });
        return true;
      }
      const db = await readRequestDb(req);
      if (!db.users?.[workerId]) {
        sendJson(res, 404, { error: "Delavec ne obstaja." });
        return true;
      }
      const report = workerDailyDigestSnapshot(db, workerId, date);
      if (!report) {
        sendJson(res, 404, { error: "Dnevni povzetek ni na voljo." });
        return true;
      }
      sendJson(res, 200, { report });
      return true;
    }
    if (url.pathname === "/api/payroll-export.xlsx" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return true;
      const requestedWorkerId = cleanUserId(url.searchParams.get("workerId") || user.id);
      const workerId = user.role === "boss" ? requestedWorkerId : user.id;
      if (!workerId || (user.role !== "boss" && requestedWorkerId !== user.id)) {
        sendJson(res, 403, { error: "Izvoz obračuna drugega delavca lahko pripravi samo šef." });
        return true;
      }
      const range = payrollRange({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
      if (!range) {
        sendJson(res, 400, { error: "Za izvoz izberi veljavno obračunsko obdobje." });
        return true;
      }
      const db = await readRequestDb(req);
      const report = workerPayrollXlsxReport(db, workerId, range);
      if (!report) {
        sendJson(res, 404, { error: "Obračun za izbranega delavca ni na voljo." });
        return true;
      }
      try {
        await sendWorkerPayrollXlsx(res, report);
      } catch (error) {
        console.error("Worker payroll XLSX export failed", error);
        if (!res.headersSent) sendJson(res, 500, { error: "Izvoz XLSX ni uspel." });
        else res.destroy(error);
      }
      return true;
    }
    return false;
}

async function handleReportDownloads(req, res, url) {
    const todoSharePdfTicketMatch = url.pathname.match(/^\/api\/todos\/([^/]+)\/share-pdf-ticket$/);
    if (todoSharePdfTicketMatch && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return true;
      const id = decodeURIComponent(todoSharePdfTicketMatch[1]);
      const db = await readRequestDb(req);
      const todo = (db.todos || []).find((item) => item.id === id);
      if (!todo || isTrashedTodo(todo) || !canManageTodo(user, todo) || !todoShareReport(db, todo)) {
        sendJson(res, 404, { error: "Dogodek ni več na voljo." });
        return true;
      }
      const token = createTodoSharePdfDownloadTicket(req, user, id);
      sendJson(res, 201, { downloadUrl: `/api/todos/share-pdf-download?ticket=${encodeURIComponent(token)}` });
      return true;
    }

    if (url.pathname === "/api/todos/share-pdf-download" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return true;
      const ticket = todoSharePdfDownloadTicketForRequest(req, user, url.searchParams.get("ticket"));
      if (!ticket) {
        sendJson(res, 410, { error: "Povezava za prenos PDF-ja je potekla. Ponovno odpri deljenje dogodka." });
        return true;
      }
      const db = await readRequestDb(req);
      const todo = (db.todos || []).find((item) => item.id === ticket.todoId);
      if (!todo || isTrashedTodo(todo) || !canManageTodo(user, todo)) {
        sendJson(res, 404, { error: "Dogodek ni več na voljo." });
        return true;
      }
      await sendTodoSharePdf(res, db, todo);
      return true;
    }

    if (url.pathname === "/api/client-report/pdf-ticket" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "PDF poročilo za stranko lahko pripravi samo šef." });
        return true;
      }
      const body = await readBody(req);
      if (!clientReportRequestIsValid(body)) {
        sendJson(res, 400, { error: "Izbrani vpisi za poročilo niso pravilni." });
        return true;
      }
      const db = await readRequestDb(req);
      const report = clientReportSelection(db, body);
      if (!report) {
        sendJson(res, 409, { error: "Izbrani vpisi niso več na voljo za poročilo. Osveži pogled in preveri izbor." });
        return true;
      }
      try {
        clientReportAttachmentSelection(report, body.attachmentIds);
      } catch {
        sendJson(res, 400, { error: "Izbrane priloge za PDF poročilo niso pravilne." });
        return true;
      }
      const token = createClientReportDownloadTicket(req, user, body);
      sendJson(res, 201, { downloadUrl: `/api/client-report/pdf-download?ticket=${encodeURIComponent(token)}` });
      return true;
    }

    if (url.pathname === "/api/client-report/pdf-download" && req.method === "GET") {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "PDF poročilo za stranko lahko pripravi samo šef." });
        return true;
      }
      const ticket = clientReportDownloadTicketForRequest(req, user, url.searchParams.get("ticket"));
      if (!ticket) {
        sendJson(res, 410, { error: "Povezava za prenos PDF-ja je potekla. Ponovno klikni Prenesi PDF." });
        return true;
      }
      const db = await readRequestDb(req);
      await sendClientReportPdf(res, db, ticket.payload);
      return true;
    }

    if (url.pathname === "/api/client-report/pdf" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (user.role !== "boss") {
        sendJson(res, 403, { error: "PDF poročilo za stranko lahko pripravi samo šef." });
        return true;
      }
      const body = await readBody(req);
      if (body.eventIds !== undefined && !Array.isArray(body.eventIds)) {
        sendJson(res, 400, { error: "Izbrani vpisi za poročilo niso pravilni." });
        return true;
      }
      const db = await readRequestDb(req);
      const report = clientReportSelection(db, body);
      if (!report) {
        sendJson(res, 409, { error: "Izbrani vpisi niso več na voljo za poročilo. Osvezi pogled in preveri izbor." });
        return true;
      }
      const requestedAttachments = clientReportAttachmentSelection(report, body.attachmentIds);
      const attachments = await loadClientReportAttachments(db, requestedAttachments, { destination: "PDF" });
      const pdf = await buildClientReportPdf(db, report, attachments, body.exportOptions);
      const filename = clientReportFilename(report.client);
      res.writeHead(200, securityHeaders({
        "Content-Type": "application/pdf",
        "Content-Length": pdf.length,
        "Content-Disposition": attachmentContentDisposition(filename),
        "Cache-Control": "no-store"
      }));
      res.end(pdf);
      return true;
    }

    if (url.pathname === "/api/client-report/gmail-draft" && req.method === "POST") {
      const user = await requireUser(req, res);
      if (!user) return true;
      if (user.role !== "boss" || String(user.email || "").toLowerCase() !== moduleValues.GOOGLE_DRIVE_OWNER_EMAIL) {
        sendJson(res, 403, { error: "Gmail osnutek lahko ustvari samo Bojanov račun." });
        return true;
      }
      const body = await readBody(req);
      if (body.eventIds !== undefined && !Array.isArray(body.eventIds)) {
        sendJson(res, 400, { error: "Izbrani vpisi za poročilo niso pravilni." });
        return true;
      }
      const db = await readRequestDb(req);
      const owner = googleDriveOwner(db);
      if (!googleReady() || !googleWorkspaceTokenAvailable(owner)) {
        sendJson(res, 409, { error: "V Nastavitvah kot Bojan najprej ponovno poveži Google Dokumente, preglednice in Gmail." });
        return true;
      }
      const report = clientReportSelection(db, body);
      if (!report) {
        sendJson(res, 409, { error: "Izbrani vpisi niso več na voljo za poročilo. Osvezi pogled in preveri izbor." });
        return true;
      }
      const email = String(report.client?.email || "").trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        sendJson(res, 409, { error: "V bazi za izbrano stranko ni veljavnega e-postnega naslova." });
        return true;
      }
      const requestedAttachments = clientReportAttachmentSelection(report, body.attachmentIds);
      const attachments = await loadClientReportAttachments(db, requestedAttachments, {
        maxAttachmentBytes: moduleValues.REPORT_GMAIL_MAX_ATTACHMENT_BYTES,
        maxTotalBytes: moduleValues.REPORT_GMAIL_MAX_TOTAL_BYTES,
        destination: "Gmail"
      });
      const pdf = await buildClientReportPdf(db, report, attachments, body.exportOptions);
      const filename = clientReportFilename(report.client);
      try {
        const { google } = require("googleapis");
        const gmail = google.gmail({ version: "v1", auth: googleClient(req, owner.google.tokens) });
        const draft = await gmail.users.drafts.create({
          userId: "me",
          requestBody: { message: { raw: gmailDraftRaw({ to: email, pdf, pdfFilename: filename, attachments }) } }
        });
        sendJson(res, 201, { ok: true, draftId: String(draft.data?.id || ""), email });
      } catch (error) {
        console.error("Gmail osnutka ni bilo mogoče ustvariti:", error.message || error);
        sendJson(res, 502, { error: "Gmail osnutka ni bilo mogoče ustvariti. V Nastavitvah ponovno poveži Google račun in poskusi znova." });
      }
      return true;
    }
    return false;
}

  return {
    workerPayrollXlsxReport,
    workerPayrollXlsxEntries,
    sendWorkerPayrollXlsx,
    clientReportSelection,
    clientReportAttachmentSelection,
    reportPdfDate,
    buildClientReportPdf,
    workerDigestPortalUrl,
    workerDailyDigestSnapshot,
    canReadWorkerDailyReport,
    workerDailyReportFilename,
    workerDailyReportText,
    workerDailyReportHtml,
    buildWorkerDailyReportPdf,
    mimeBase64,
    gmailDraftRaw,
    gmailWorkerDigestDraftRaw,
    gmailWorkerDigestMessageRaw,
    gmailCompletionRequestRaw,
    attachmentContentDisposition,
    handleWorkerReports,
    handleReportDownloads
  };
}

module.exports = { createReportService };
