// editor/client-billing: explicit dependencies; factory creation has no I/O or UI effects.
function createClientBilling({
  $,
  state,
  activeWorkerId,
  api,
  attachmentDisplayName,
  attachmentLabel,
  attachmentSource,
  attachmentSymbolMarkup,
  attachmentThumbnailSource,
  dateKey,
  duration,
  editBillingSetting,
  escapeHtml,
  findClient,
  formatDate,
  formatDateTime,
  isImportedTodo,
  isPdfAttachment,
  isVideoAttachment,
  linkifyText,
  loadAll,
  manualClientBillableMinutes,
  money,
  navigateReportTodo,
  normalizeText,
  openAttachmentPreview,
  openTodoDialog,
  refreshClientList,
  refreshSessionSecurityContext,
  renderTodoDriveFilesHtml,
  reportClientHistoryState,
  reportOverviewHistoryState,
  reportOverviewSnapshot,
  restoreReportOverviewSnapshot,
  saveClientBillingFilter,
  setView,
  showAppConfirm,
  showFormValidationError,
  showNotice,
  todoAssigneeIds,
  todoClientBillableHours,
  todoEventId,
  uniqueTodosByEventId,
  withClientLookupSnapshot,
  moduleValues
}) {
async function saveClientBillingInlineField(input) {
      const field = String(input?.dataset?.clientBillingInlineField || "");
      const todoId = String(input?.dataset?.todoId || "");
      const todo = state.todos.find((item) => item.id === todoId);
      if (!todo || !["title", "notes", "clientBillableHours", "clientKm"].includes(field)) return;
      let value = input.value;
      if (field === "title") {
        value = String(value || "").trim();
        if (!value) throw new Error("Naslov dogodka ne sme biti prazen.");
        if (value === String(todo.title || "").trim()) return;
      } else if (field === "notes") {
        value = String(value || "").trim();
        if (value === String(todo.notes || "").trim()) return;
      } else {
        const raw = String(value || "").trim().replace(",", ".");
        if (!raw) throw new Error(field === "clientKm" ? "Vpiši kilometre ali izrecno 0." : "Vpiši ure za obračun ali izrecno 0.");
        value = Number(raw);
        if (!Number.isFinite(value) || value < 0) throw new Error(field === "clientKm" ? "Strošek prevoza mora biti nič ali več kilometrov." : "Ure za obračun morajo biti nič ali več.");
        const current = field === "clientKm"
          ? Number(todo.clientKm || 0)
          : Number(reportTodoLine(todo).clientBillableHours || 0);
        if (Math.abs(current - value) < 0.0001) return;
      }
      input.disabled = true;
      try {
        const data = await api(`/api/todos/${encodeURIComponent(todo.id)}/client-billing-fields`, {
          method: "POST",
          body: JSON.stringify({ [field]: value, baseUpdatedAt: todo.updatedAt || "" })
        });
        state.todos = data.todos;
        refreshClientList();
        renderReport();
      } finally {
        input.disabled = false;
      }
    }

function setDefaultReportRange() {
      // Prazen razpon pomeni celotno zgodovino zaključenih storitev.
      $("reportFrom").value = "";
      $("reportTo").value = "";
    }

function inDateRange(date, from, to) {
      if (!date) return false;
      if (from && date < from) return false;
      if (to && date > to) return false;
      return true;
    }

function reportTodoIsCompleted(todo) {
      return Boolean(todo.done || ["execution", "material", "note"].includes(todo.status));
    }

function reportClientSelection() {
      const stableId = String(state.reportClientId || "").trim();
      const client = findClient(stableId) || findClient(state.reportClient) || null;
      return {
        id: String(client?.clientId || client?.id || stableId || "").trim(),
        name: String(client?.name || state.reportClient || "").trim()
      };
    }

function reportClientBillSelectionKey(selection) {
      return [selection?.id || normalizeText(selection?.name || ""), $("reportFrom").value, $("reportTo").value, state.showClientPending, state.showClientBilled].join("|");
    }

function syncClientBillSelection(lines, selection) {
      const pending = lines.filter((line) => !line.clientBill);
      const availableEventIds = new Set(pending.map((line) => todoEventId(line.todo)).filter(Boolean));
      const key = reportClientBillSelectionKey(selection);
      if (state.clientBillSelectionKey !== key) {
        state.clientBillSelectionKey = key;
        state.clientBillSelectedEventIds = new Set(availableEventIds);
      } else {
        state.clientBillSelectedEventIds = new Set([...state.clientBillSelectedEventIds].filter((eventId) => availableEventIds.has(eventId)));
      }
      return pending.filter((line) => state.clientBillSelectedEventIds.has(todoEventId(line.todo)));
    }

function reportAttachmentSelectionKey(lines, selection) {
      return [reportClientBillSelectionKey(selection), ...lines.map((line) => todoEventId(line.todo)).filter(Boolean).sort()].join("|");
    }

function reportAttachmentItems(lines) {
      const attachments = new Map();
      lines.forEach((line) => {
        (line.todo.photos || []).forEach((photo) => {
          const id = String(photo?.attachmentId || "");
          if (!/^[a-f0-9]{64}$/.test(id) || attachments.has(id)) return;
          attachments.set(id, { id, eventId: todoEventId(line.todo), photo, todo: line.todo });
        });
      });
      return [...attachments.values()];
    }

function syncReportAttachmentSelection(lines, selection) {
      const items = reportAttachmentItems(lines);
      const availableIds = new Set(items.map((item) => item.id));
      const key = reportAttachmentSelectionKey(lines, selection);
      if (state.reportAttachmentSelectionKey !== key) {
        state.reportAttachmentSelectionKey = key;
        state.reportIncludedAttachmentIds = new Set();
      } else {
        state.reportIncludedAttachmentIds = new Set([...state.reportIncludedAttachmentIds].filter((id) => availableIds.has(id)));
      }
      return items;
    }

function reportHoursMode() {
      const mode = String($("reportHoursMode").value || "client_billable");
      return moduleValues.reportHoursModes.includes(mode) ? mode : "client_billable";
    }

function reportHoursModeLabel() {
      return {
        client_billable: "Ure za obra\u010dun stranki",
        worker_total: "Skupne ure izvajalcev",
        worker_time: "Ure izvajalcev (to\u010den \u010das)"
      }[reportHoursMode()];
    }

function reportHoursSummaryLabel() {
      return reportHoursMode() === "client_billable" ? "Za obra\u010dun" : "Ure izvajalcev";
    }

function reportWorkerTodos(todo) {
      const eventId = todoEventId(todo);
      const items = (state.todos || []).filter((item) => todoEventId(item) === eventId && !item.trashedAt);
      return items.length ? items : [todo];
    }

function reportWorkerName(todo) {
      const id = String(todo?.syncUser || todo?.createdBy || "");
      return String(state.workerBilling.find((worker) => worker.id === id)?.name || todo?.updatedByName || todo?.createdByName || "Izvajalec");
    }

function reportAssigneeLabel(todo) {
      const labels = todoAssigneeIds(todo).map((id) => {
        const worker = state.workerBilling.find((item) => item.id === id);
        const name = String(worker?.name || state.users.find((user) => user.id === id)?.name || id || "Izvajalec");
        const title = String(worker?.exportTitle || "").trim() || "Izvajalec";
        return `${title} (${name})`;
      });
      return labels.length ? labels.join(", ") : "Ni dodeljeno";
    }

function reportWorkerTimeSummary(todos) {
      return (todos || []).filter((todo) => todo.start && todo.end)
        .map((todo) => reportWorkerName(todo) + ": " + todo.start + "\u2013" + todo.end)
        .join(", ");
    }

function reportExportOptions() {
      return { hoursMode: reportHoursMode() };
    }

function reportExportPayload() {
      const selection = reportClientSelection();
      if (!selection.id && !selection.name) throw new Error("Najprej izberi stranko.");
      const pending = reportTodos().map(reportTodoLine).filter((line) => !line.clientBill);
      const selectedLines = syncClientBillSelection(pending, selection);
      const eventIds = [...new Set(selectedLines.map((line) => todoEventId(line.todo)).filter(Boolean))];
      if (!eventIds.length) throw new Error("Označi vsaj en vpis za poročilo.");
      const attachmentItems = syncReportAttachmentSelection(selectedLines, selection);
      const attachmentIds = attachmentItems
        .filter((item) => state.reportIncludedAttachmentIds.has(item.id))
        .map((item) => item.id);
      return {
        clientId: selection.id,
        clientName: selection.name,
        from: $("reportFrom").value,
        to: $("reportTo").value,
        eventIds,
        attachmentIds,
        exportOptions: reportExportOptions()
      };
    }

function reportClientBillHistoryCutoff() {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      return dateKey(cutoff);
    }

function reportTodoVisibleInClientBilling(todo) {
      const clientBill = reportClientBill(todo);
      if (!clientBill) return true;
      const source = String(clientBill.confirmedAt || todo.archivedAt || todo.date || "");
      const confirmedDate = (/^\d{4}-\d{2}-\d{2}/.exec(source) || [""])[0];
      return !confirmedDate || confirmedDate >= reportClientBillHistoryCutoff();
    }

function reportTodoMatchesClientBillingFilter(todo) {
      return reportClientBill(todo) ? state.showClientBilled : state.showClientPending;
    }

function reportTodoSort(left, right) {
      const leftKey = left.date ? `${left.date} ${left.start || "99:99"}` : "9999-99-99 99:99";
      const rightKey = right.date ? `${right.date} ${right.start || "99:99"}` : "9999-99-99 99:99";
      return leftKey.localeCompare(rightKey) || String(left.title || "").localeCompare(String(right.title || ""), "sl");
    }

function reportBaseTodos() {
      const from = $("reportFrom").value;
      const to = $("reportTo").value;
      return uniqueTodosByEventId(state.todos)
        .filter((todo) => !isImportedTodo(todo))
        .filter(reportTodoIsCompleted)
        .filter((todo) => Boolean(todo.clientId || todo.client))
        .filter(reportTodoVisibleInClientBilling)
        .filter(reportTodoMatchesClientBillingFilter)
        .filter((todo) => (!from && !to) ? true : inDateRange(todo.date, from, to))
        .sort(reportTodoSort);
    }

function todoMatchesReportClient(todo, selection) {
      if (!selection.id && !selection.name) return true;
      if (selection.id && String(todo.clientId || "") === selection.id) return true;
      return Boolean(selection.name) && normalizeText(todo.client) === normalizeText(selection.name);
    }

function reportTodos() {
      const selection = reportClientSelection();
      return reportBaseTodos().filter((todo) => todoMatchesReportClient(todo, selection));
    }

function reportVehicleId(todo) {
      return todo.clientVehicle === "van" ? "van" : "personal";
    }

function reportVehicleLabel(vehicle) {
      return vehicle === "van" ? "Kombi" : "Osebni avto";
    }

function reportClientBill(todo) {
      if (todo?.settlement?.client?.length) return null;
      const billId = String(todo?.clientBillId || "");
      const direct = (state.clientBills || []).find((bill) => bill.id === billId);
      if (direct && String(direct.status || "") === "confirmed") return direct;
      const eventId = todoEventId(todo);
      return (state.clientBills || []).find((bill) => String(bill.status || "") === "confirmed"
        && (bill.eventIds || []).map(String).includes(eventId))
        || null;
    }

function reportTodoLine(todo) {
      const materialEntry = todo.status === "material";
      const noteEntry = todo.status === "note";
      const warranty = Boolean(todo.warranty);
      const clientBill = reportClientBill(todo);
      // Old records can contain a pending client-correction marker.  Once the
      // event itself is confirmed, it remains a settled event rather than
      // becoming a second, misleading item in the customer-billing queue.
      const correction = clientBill ? null : (todo?.settlement?.client?.[0] || null);
      const workerTodos = correction ? [todo] : reportWorkerTodos(todo);
      const clientBillableHours = correction ? Number(correction.delta?.hours || 0) : todoClientBillableHours(todo);
      const workerHours = correction ? clientBillableHours : Number(workerTodos.reduce((sum, item) => sum + duration(item), 0).toFixed(2));
      const hours = warranty || materialEntry || noteEntry ? 0 : (reportHoursMode() === "client_billable" || correction ? clientBillableHours : workerHours);
      const clientKm = warranty || materialEntry || noteEntry ? 0 : correction ? Number(correction.delta?.clientKm || 0) : Math.max(0, Number(todo.clientKm || 0));
      const materialAmount = materialEntry ? (correction ? Number(correction.delta?.materialAmount || 0) : Math.max(0, Number(todo.materialAmount || 0))) : 0;
      return { todo, warranty, materialEntry, noteEntry, hours, clientBillableHours, workerHours, workerTimes: correction ? "" : reportWorkerTimeSummary(workerTodos), clientKm, materialAmount, correction, vehicle: reportVehicleId(todo), clientBill };
    }

function reportTotals(lines) {
      return lines.reduce((totals, line) => {
        const vehicle = line.vehicle === "van" ? "van" : "personal";
        totals.count += 1;
        totals.hours += line.hours;
        totals.clientKm += line.clientKm;
        totals[`${vehicle}Km`] += line.clientKm;
        totals.materialAmount += line.materialAmount || 0;
        return totals;
      }, {
        count: 0,
        hours: 0,
        clientKm: 0,
        personalKm: 0,
        vanKm: 0,
        materialAmount: 0
      });
    }

function reportClientDescriptor(todo) {
      const client = findClient(todo.clientId) || findClient(todo.client) || null;
      const id = String(client?.clientId || client?.id || todo.clientId || "").trim();
      const name = String(client?.name || todo.client || "Brez stranke").trim();
      return {
        id,
        name,
        search: String(client?.search || name).trim(),
        key: id ? `id:${id}` : `name:${normalizeText(name)}`
      };
    }

function reportClientSortMode(value = state.reportClientSort) {
      const normalized = String(value || "recent");
      return moduleValues.reportClientSortModes.includes(normalized) ? normalized : "recent";
    }

function reportClientSortLabel() {
      return {
        recent: "najnovej\u0161ih opravljenih storitvah",
        hours_desc: "najve\u010d opravljenih urah",
        oldest: "najstarej\u0161ih opravljenih storitvah",
        count_desc: "najve\u010d zaklju\u010denih dogodkih",
        name_asc: "imenu stranke A\u2013\u017d",
        name_desc: "imenu stranke \u017d\u2013A"
      }[reportClientSortMode()];
    }

function reportClientSummarySort(left, right) {
      const byName = left.name.localeCompare(right.name, "sl");
      const mode = reportClientSortMode();
      if (mode === "hours_desc") return Number(right.totals.hours || 0) - Number(left.totals.hours || 0) || byName;
      if (mode === "count_desc") return Number(right.totals.count || 0) - Number(left.totals.count || 0) || byName;
      if (mode === "oldest") return String(left.oldestDate || "9999-99-99").localeCompare(String(right.oldestDate || "9999-99-99")) || byName;
      if (mode === "name_asc") return byName;
      if (mode === "name_desc") return right.name.localeCompare(left.name, "sl");
      return String(right.lastDate || "").localeCompare(String(left.lastDate || "")) || byName;
    }

function reportClientSummaries() {
      const query = normalizeText($("reportClient").value);
      const groups = new Map();
      reportBaseTodos().forEach((todo) => {
        const client = reportClientDescriptor(todo);
        if (!groups.has(client.key)) groups.set(client.key, { ...client, lines: [], lastDate: "", oldestDate: "" });
        const group = groups.get(client.key);
        group.lines.push(reportTodoLine(todo));
        const todoDate = String(todo.date || "");
        if (todoDate && (!group.oldestDate || todoDate < group.oldestDate)) group.oldestDate = todoDate;
        if (todoDate && (!group.lastDate || todoDate > group.lastDate)) group.lastDate = todoDate;
      });
      return [...groups.values()]
        .map((group) => ({ ...group, totals: reportTotals(group.lines) }))
        .filter((group) => !query || normalizeText(`${group.name} ${group.search}`).includes(query))
        .sort(reportClientSummarySort);
    }

function reportOverviewLines() {
      return reportClientSummaries()
        .flatMap((summary) => summary.lines)
        .sort((left, right) => reportTodoSort(left.todo, right.todo));
    }

function reportRangeLabel() {
      const from = $("reportFrom").value;
      const to = $("reportTo").value;
      if (from && to) return `${formatDate(from)} – ${formatDate(to)}`;
      if (from) return `Od ${formatDate(from)}`;
      if (to) return `Do ${formatDate(to)}`;
      return "Celotna evidenca";
    }

function reportNumber(value, maximumFractionDigits = 2) {
      return Number(value || 0).toLocaleString("sl-SI", { maximumFractionDigits });
    }

function reportInputNumber(value, maximumFractionDigits = 2) {
      const number = Number(value || 0);
      return Number.isFinite(number) ? String(Number(number.toFixed(maximumFractionDigits))) : "0";
    }

function reportTransportText(km) {
      return `${reportNumber(km, 1)} km`;
    }

function renderReportAttachments(todo, { exportable = false } = {}) {
      const photos = todo.photos || [];
      const driveFiles = todo.driveFiles || [];
      if (!photos.length && !driveFiles.length) return "";
      const attachmentCards = photos.map((photo) => {
        const video = isVideoAttachment(photo);
        const title = escapeHtml(attachmentDisplayName(photo));
        const kind = escapeHtml(attachmentLabel(photo));
        const attachmentId = String(photo.attachmentId || "");
        const canChooseForExport = exportable && !video && /^[a-f0-9]{64}$/.test(attachmentId);
        const includeInExport = canChooseForExport && state.reportIncludedAttachmentIds.has(attachmentId);
        const exportToggle = canChooseForExport
          ? `<label class="client-billing-attachment-export"><input type="checkbox" data-report-export-attachment-id="${escapeHtml(attachmentId)}" ${includeInExport ? "checked" : ""}><span>Vključi v izvoz</span></label>`
          : "";
        const thumbnail = !isPdfAttachment(photo) && !video ? attachmentThumbnailSource(photo) : "";
        const media = `<button class="client-billing-attachment report-image-preview" type="button" data-report-todo-id="${escapeHtml(todo.id)}" data-photo-id="${escapeHtml(photo.id)}" aria-label="Odpri prilogo ${title}">${thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="" loading="lazy">` : attachmentSymbolMarkup(photo)}<span><strong>${title}</strong><small>${kind}${video ? " · povezava do videa" : ""}</small></span></button>`;
        return `<div class="client-billing-attachment-wrap">${media}${exportToggle}</div>`;
      }).join("");
      return `<section class="client-billing-section"><strong>Priloge in dokumenti</strong>${attachmentCards ? `<div class="client-billing-attachments">${attachmentCards}</div>` : ""}${driveFiles.length ? `<div class="todo-drive-files">${renderTodoDriveFilesHtml(driveFiles)}</div>` : ""}</section>`;
    }

function renderClientBillingRow(line) {
      const { todo, warranty, materialEntry, noteEntry, hours, clientBillableHours, clientKm, vehicle, clientBill, workerTimes, correction } = line;
      const time = materialEntry ? "Material brez vpisa ur" : noteEntry ? "Zapisek brez vpisa ur" : (reportHoursMode() === "worker_time" ? "To\u010den \u010das izvajalcev" : (todo.start && todo.end ? todo.start + "\u2013" + todo.end : "Brez vpisane ure"));
      const eventId = todoEventId(todo);
      const inlineEditable = state.user?.role === "boss" && !clientBill && !correction;
      const selectedForClientBill = !clientBill && state.clientBillSelectedEventIds.has(eventId);
      const billSelection = clientBill
        ? `<button class="client-billing-select is-billed" type="button" data-cancel-client-bill-id="${escapeHtml(clientBill.id)}" title="Prekliči obračun stranki" aria-label="Prekliči obračun stranki"><span class="client-billing-select-icon" aria-hidden="true">&#10003;</span></button>`
        : `<label class="client-billing-select ${selectedForClientBill ? "is-selected" : ""}" title="Označi za obračun"><input type="checkbox" data-client-bill-event-id="${escapeHtml(eventId)}" ${selectedForClientBill ? "checked" : ""} aria-label="Označi vpis za obračun stranki"><span class="client-billing-select-icon" aria-hidden="true">&#10003;</span></label>`;
      const description = inlineEditable
        ? `<section class="client-billing-section"><strong>Opis del</strong><textarea class="client-billing-inline-description" data-client-billing-inline-field="notes" data-todo-id="${escapeHtml(todo.id)}" placeholder="Dodaj opis del">${escapeHtml(todo.notes || "")}</textarea></section>`
        : todo.notes ? `<section class="client-billing-section"><strong>Opis del</strong><div class="report-todo-description">${linkifyText(todo.notes)}</div></section>` : "";
      const details = [
        description,
        todo.material ? `<section class="client-billing-section"><strong>Material</strong><div class="report-todo-description">${linkifyText(todo.material)}</div></section>` : "",
        renderReportAttachments(todo, { exportable: selectedForClientBill })
      ].filter(Boolean).join("");
      const hoursLabel = reportHoursMode() === "client_billable" || correction ? "Za obra\u010dun" : "Ure izvajalcev";
      const hasExplicitClientHours = !correction && manualClientBillableMinutes(todo.clientBillableMinutes) !== null;
      const billingFields = inlineEditable && !warranty && !materialEntry && !noteEntry
        ? `<div class="client-billing-charges client-billing-inline-fields"><label>Za obračun (h)<input type="number" min="0" max="16666.67" step="0.25" inputmode="decimal" data-client-billing-inline-field="clientBillableHours" data-todo-id="${escapeHtml(todo.id)}" value="${escapeHtml(reportInputNumber(clientBillableHours))}" aria-label="Za obračun ur"></label><label>Stroški prevoza – ${escapeHtml(reportVehicleLabel(vehicle))} (km)<input type="number" min="0" max="1000000" step="0.1" inputmode="decimal" data-client-billing-inline-field="clientKm" data-todo-id="${escapeHtml(todo.id)}" value="${escapeHtml(reportInputNumber(clientKm, 1))}" aria-label="Stroški prevoza v kilometrih"></label></div>`
        : "";
      const charges = warranty
        ? `<span class="client-billing-warranty">Garancija \u2013 storitev se ne obra\u010duna stranki.</span>`
        : materialEntry
          ? `<span>Material brez obra\u010duna zneska</span>`
          : noteEntry
            ? `<span>Zapisek brez obra\u010duna ur in kilometrine</span>`
          : [
            hours || hasExplicitClientHours ? `<span>${hoursLabel}: ${reportNumber(hours)} h</span>` : "<span>Ura ni vpisana</span>",
            reportHoursMode() === "worker_time" && workerTimes ? `<span>\u010cas izvajalcev: ${escapeHtml(workerTimes)}</span>` : "",
            clientKm ? `<span>Stro\u0161ki prevoza (obe smeri): ${reportVehicleLabel(vehicle)} &middot; ${reportNumber(clientKm, 1)} km</span>` : ""
          ].filter(Boolean).join("");
      const fullEditor = `<button class="client-billing-edit-button open-report-todo" type="button" data-todo-id="${escapeHtml(todo.id)}" title="Odpri celoten obrazec" aria-label="Odpri celoten obrazec za: ${escapeHtml(todo.title || "Brez naziva")}"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25Zm17.71-10.21a1 1 0 0 0 0-1.41l-2.55-2.55a1 1 0 0 0-1.41 0l-1.99 1.99 3.75 3.75 2.2-2.2Z"/></svg></button>`;
      const title = inlineEditable
        ? `<textarea class="client-billing-inline-title" rows="1" data-client-billing-inline-field="title" data-todo-id="${escapeHtml(todo.id)}" aria-label="Naslov dogodka">${escapeHtml(todo.title || "")}</textarea>`
        : `<button class="client-billing-title-trigger open-report-todo" type="button" data-todo-id="${escapeHtml(todo.id)}" aria-label="Odpri vpis: ${escapeHtml(todo.title || "Brez naziva")}">${escapeHtml(todo.title || "Brez naziva")}</button>`;
      return `<article class="client-billing-row${state.reportMovedEventIds?.has(eventId) ? " is-reassigned" : ""}">
        <div class="client-billing-selection-slot">${billSelection}</div>
        <div class="client-billing-when"><strong>${todo.date ? formatDate(todo.date) : "Brez datuma"}</strong><span>${escapeHtml(time)}</span></div>
        <div class="client-billing-main">
          <div class="client-billing-title-row">${fullEditor}<h3>${title}</h3></div>
          <div class="client-billing-meta">${materialEntry ? `<span>Dostava materiala</span>` : noteEntry ? `<span>Zapisek</span>` : `<span>${escapeHtml(reportAssigneeLabel(todo))}</span>`}${clientBill ? `<span>Obra\u010dun stranki potrjen ${escapeHtml(formatDateTime(clientBill.confirmedAt))}</span>` : ""}${clientBill?.directSettlement ? `<span>Prejeto: ${money(clientBill.receivedAmount || 0)} EUR${clientBill.creditedWorkerName ? ` &middot; v dobro ${escapeHtml(clientBill.creditedWorkerName)}` : ""}</span>` : ""}</div>
          ${billingFields || `<button class="client-billing-charges client-billing-charges-trigger open-report-todo" type="button" data-todo-id="${escapeHtml(todo.id)}" aria-label="Odpri vpis: ${escapeHtml(todo.title || "Brez naziva")}">${charges}</button>`}
          ${details}
        </div>
      </article>`;
    }

function renderReportClientCard(summary) {
      const { name, id, key, totals, lastDate } = summary;
      const pending = summary.lines.filter((line) => !line.clientBill).length;
      const returnTarget = key === state.reportOverviewFocusKey;
      return `<button class="client-billing-client-card open-client-report${returnTarget ? " is-return-target" : ""}" type="button" data-client-key="${escapeHtml(key)}" data-client-id="${escapeHtml(id)}" data-client-name="${escapeHtml(name)}"${returnTarget ? ' aria-current="true"' : ""}>
        <span class="client-billing-client-card-head"><strong>${escapeHtml(name)}</strong><span>${lastDate ? `Nazadnje: ${escapeHtml(formatDate(lastDate))}` : ""}</span></span>
        <span class="client-billing-client-card-meta"><span>${totals.count} ${totals.count === 1 ? "zaklju\u010dena storitev" : "zaklju\u010denih storitev"}</span><span>${reportHoursSummaryLabel()}: ${reportNumber(totals.hours)} h</span><span>${pending ? `${pending} za obra\u010dun` : "obra\u010dunano"}</span></span>
        <span class="client-billing-client-travel"><span>Osebni avto: ${escapeHtml(reportTransportText(totals.personalKm))}</span><span>Kombi: ${escapeHtml(reportTransportText(totals.vanKm))}</span></span>
        <span class="client-billing-client-open">Odpri poro\u010dilo &rsaquo;</span>
      </button>`;
    }

function renderReport() {
      return withClientLookupSnapshot(renderReportContent);
    }

function renderReportContent() {
      const selection = reportClientSelection();
      const detail = Boolean(selection.id || selection.name);
      $("reportBillingFilterControl").classList.toggle("hidden", detail);
      $("reportClientSortControl").classList.toggle("hidden", detail);
      $("reportClientControl").classList.toggle("hidden", detail);
      $("clearReportClient").classList.toggle("hidden", detail);
      $("reportClientSort").value = reportClientSortMode();
      const summaries = detail ? [] : reportClientSummaries();
      const lines = detail ? reportTodos().map(reportTodoLine) : summaries.flatMap((summary) => summary.lines);
      const pendingClientBillLines = detail ? lines.filter((line) => !line.clientBill) : [];
      const selectedClientBillLines = detail ? syncClientBillSelection(lines, selection) : [];
      if (detail) syncReportAttachmentSelection(selectedClientBillLines, selection);
      // In the client bill detail, the summary is the amount currently being confirmed.
      const totals = reportTotals(detail ? selectedClientBillLines : lines);
      $("clientDetailTitle").textContent = detail ? `Poročilo: ${selection.name}` : "Povzetek po strankah";
      $("reportClientTransfer").classList.toggle("hidden", !detail || state.user?.role !== "boss");
      const transferKey = selection.id || selection.name;
      if ($("bulkClientTarget").dataset.clientKey !== transferKey) {
        $("bulkClientTarget").value = selection.name || "";
        $("bulkClientTarget").dataset.clientKey = transferKey;
      }
      $("clientDetailRange").textContent = $("reportFrom").value || $("reportTo").value ? reportRangeLabel() : "";
      $("reportLineCount").textContent = detail
        ? `${selectedClientBillLines.length} / ${pendingClientBillLines.length} označenih za obračun`
        : `${summaries.length} ${summaries.length === 1 ? "stranka" : "strank"}`;
      const reportNotice = detail ? "" : `Izberi stranko za njen podroben kronolo\u0161ki pregled izvedenih storitev. Seznam je razvr\u0161\u010den po ${reportClientSortLabel()}.`;
      $("reportBillingNotice").textContent = reportNotice;
      $("reportBillingNotice").classList.toggle("hidden", !reportNotice);
      $("reportBackToClients").classList.toggle("hidden", !detail);
      $("reportNewEntry").classList.toggle("hidden", !detail);
      const hasPendingClientBillLines = detail && pendingClientBillLines.length > 0;
      const selectedClientBillCount = selectedClientBillLines.length;
      $("confirmClientBill").classList.toggle("hidden", !hasPendingClientBillLines);
      $("confirmClientBill").disabled = !selectedClientBillCount;
      $("confirmClientBill").title = selectedClientBillCount ? "" : "Označi vsaj en vpis za obračun stranki.";
      $("confirmClientBill").textContent = `Potrdi izbrane vpise (${selectedClientBillCount})`;
      $("selectAllClientBill").classList.toggle("hidden", !hasPendingClientBillLines);
      $("clearClientBillSelection").classList.toggle("hidden", !hasPendingClientBillLines);
      $("bulkChangeReportClient").classList.toggle("hidden", !hasPendingClientBillLines);
      $("selectAllClientBill").disabled = selectedClientBillCount === pendingClientBillLines.length;
      $("clearClientBillSelection").disabled = !selectedClientBillCount;
      $("bulkChangeReportClient").disabled = !selectedClientBillCount;
      $("bulkChangeReportClient").textContent = `Prestavi označene (${selectedClientBillCount})`;
      $("bulkChangeReportClient").title = selectedClientBillCount ? "" : "Označi vsaj en še neobračunan vpis.";
      $("exportReportPdf").classList.toggle("hidden", !detail);      $("reportHoursModeOption").classList.toggle("hidden", !detail);
      $("createReportGmailDraft").classList.toggle("hidden", !detail);
      $("exportReportPdf").disabled = !selectedClientBillLines.length;
      const reportClient = findClient(selection.id) || findClient(selection.name);
      const hasClientEmail = Boolean(String(reportClient?.email || "").trim());
      $("createReportGmailDraft").disabled = !selectedClientBillLines.length || !hasClientEmail;
      $("createReportGmailDraft").title = !selectedClientBillLines.length ? "Označi vsaj en vpis za poročilo." : (hasClientEmail ? "Ustvari Gmail osnutek brez pošiljanja." : "Za stranko v bazi ni e-poštnega naslova.");
      $("clearReportClient").textContent = detail ? "Počisti izbor" : "Počisti iskanje";
      const summaryRows = detail ? [
        ["Zaklju\u010dene storitve", `${totals.count}`],
        [reportHoursModeLabel(), `${reportNumber(totals.hours)} h`],
        ["Stro\u0161ki prevoza (obe smeri) \u2013 osebni avto", reportTransportText(totals.personalKm)],
        ["Stro\u0161ki prevoza (obe smeri) \u2013 kombi", reportTransportText(totals.vanKm)],
        ["Stro\u0161ki prevoza skupaj", `${reportNumber(totals.clientKm, 1)} km`],
      ] : [
        ["Stranke", `${summaries.length}`],
        ["Zaklju\u010dene storitve", `${totals.count}`],
        [reportHoursModeLabel(), `${reportNumber(totals.hours)} h`],
        ["Stro\u0161ki prevoza skupaj", `${reportNumber(totals.clientKm, 1)} km`],
      ];
      $("reportSummary").innerHTML = `<dl class="client-billing-summary-list">${summaryRows.map(([label, value]) => `<div class="${label.endsWith("skupaj") ? "is-total" : ""}"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("")}</dl>`;
      $("clientDetailList").classList.toggle("client-billing-client-overview", !detail);
      if (detail) {
        const pendingLines = lines.filter((line) => !line.clientBill);
        const billedLines = lines.filter((line) => line.clientBill);
        const billedDivider = billedLines.length
          ? `<div class="client-billing-settled-divider"><span>Obračunano</span><small>Prikaz zadnjih 12 mesecev</small></div>`
          : "";
        $("clientDetailList").innerHTML = [...pendingLines.map(renderClientBillingRow), billedDivider, ...billedLines.map(renderClientBillingRow)].join("")
          || `<p class="todo-meta">Za ta izbor ni zaključenih storitev.</p>`;
        requestAnimationFrame(autosizeClientBillingFields);
      } else {
        const rows = summaries.map(renderReportClientCard);
        const keys = state.reportOverviewReturnKeys || [];
        const oldIndex = keys.indexOf(state.reportOverviewFocusKey);
        if (oldIndex >= 0 && !summaries.some((item) => item.key === state.reportOverviewFocusKey)) {
          let at = summaries.findIndex((item) => keys.indexOf(item.key) > oldIndex);
          if (at < 0) {
            const previous = [...keys.slice(0, oldIndex)].reverse().find((key) => summaries.some((item) => item.key === key));
            at = previous ? summaries.findIndex((item) => item.key === previous) + 1 : Math.min(oldIndex, rows.length);
          }
          rows.splice(at, 0, '<div class="client-billing-return-marker" role="separator" aria-label="Prejšnje mesto zaključene stranke"><span>Tukaj ste zaključili stranko</span></div>');
        }
        $("clientDetailList").innerHTML = rows.join("") || `<p class="todo-meta">Za ta izbor ni zaključenih storitev.</p>`;
      }
    }

function openClientReport(client, clientId = "", { fromHistory = false, returnSnapshot = null } = {}) {
      window.clearTimeout(moduleValues.reportSearchRenderTimer);
      const clientDescriptor = reportClientDescriptor({ client, clientId });
      const snapshot = returnSnapshot || { ...reportOverviewSnapshot(), focusKey: clientDescriptor.key, returnKeys: reportClientSummaries().map((item) => item.key) };
      if (!fromHistory) {
        state.reportMovedEventIds = null;
        state.reportOverviewFocusKey = clientDescriptor.key;
        state.reportReturnSnapshot = snapshot;
        const currentReportState = history.state?.[moduleValues.reportHistoryStateKey];
        if (state.token && state.user) {
          if (currentReportState?.kind === "overview") {
            // A previous detail view may have left its return target in this
            // history entry. Replace it before opening the next client so
            // Back always focuses the client that was most recently opened.
            history.replaceState(reportOverviewHistoryState(snapshot), "", location.href);
          } else {
            history.pushState(reportOverviewHistoryState(snapshot), "", location.href);
          }
        }
      }
      state.reportClient = client;
      state.reportClientId = clientId;
      $("reportClient").value = client;
      setView("report");
      renderReport();
      if (!fromHistory && state.token && state.user) {
        history.pushState(reportClientHistoryState(client, clientId, snapshot), "", location.href);
      }
    }

async function cancelClientBillFromReport(billId) {
      const bill = (state.clientBills || []).find((item) => item.id === billId && String(item.status || "") === "confirmed");
      if (!bill) return;
      if (!await showAppConfirm(`Prekličem obračun stranki ${bill.clientName}?\n\nPovezani zaključeni vnosi se vrnejo med neobračunane. Če so že v arhivu, jih sistem varno vrne iz arhiva; obračun delavca ostane nespremenjen.`)) return;
      const data = await api(`/api/client-bills/${encodeURIComponent(billId)}`, { method: "DELETE" });
      state.clientBills = data.clientBills || state.clientBills;
      state.todos = data.todos || state.todos;
      state.clientBillSelectionKey = "";
      state.clientBillSelectedEventIds = new Set();
      state.reportAttachmentSelectionKey = "";
      state.reportIncludedAttachmentIds = new Set();
      await loadAll();
      renderReport();
    }

function clearClientReportSelection({ fromHistory = false, snapshot = null } = {}) {
      window.clearTimeout(moduleValues.reportSearchRenderTimer);
      const hadDetail = Boolean(state.reportClient || state.reportClientId);
      const returnSnapshot = snapshot || state.reportReturnSnapshot || { ...reportOverviewSnapshot(), query: "" };
      if (!fromHistory && hadDetail && history.state?.[moduleValues.reportHistoryStateKey]?.kind === "detail") {
        history.back();
        return;
      }
      state.reportClient = "";
      state.reportClientId = "";
      state.reportReturnSnapshot = null;
      state.clientBillSelectionKey = "";
      state.clientBillSelectedEventIds = new Set();
      state.reportAttachmentSelectionKey = "";
      state.reportIncludedAttachmentIds = new Set();
      $("reportClient").value = "";
      restoreReportOverviewSnapshot(returnSnapshot);
      setView("report");
      renderReport();
      requestAnimationFrame(() => {
        const target = state.reportOverviewFocusKey
          ? document.querySelector(`.open-client-report[data-client-key="${CSS.escape(state.reportOverviewFocusKey)}"]`)
          : null;
        const marker = document.querySelector(".client-billing-return-marker");
        if (target || marker) (target || marker).scrollIntoView({ block: "center", behavior: "auto" });
        else window.scrollTo({ top: Number(returnSnapshot?.scrollY || 0), behavior: "auto" });
      });
    }

function setClientBillSelectionForCurrentReport(selectAll) {
      const selection = reportClientSelection();
      const lines = reportTodos().map(reportTodoLine).filter((line) => !line.clientBill);
      state.clientBillSelectionKey = reportClientBillSelectionKey(selection);
      state.clientBillSelectedEventIds = selectAll
        ? new Set(lines.map((line) => todoEventId(line.todo)).filter(Boolean))
        : new Set();
      renderReport();
    }

function openBulkClientDialog() {
      const selection = reportClientSelection();
      const lines = syncClientBillSelection(reportTodos().map(reportTodoLine), selection);
      if (!lines.length) { showNotice("Označi vsaj en še neobračunan vpis."); return; }
      saveBulkClientFromDialog().catch((error) => showNotice(error.message || "Stranke ni bilo mogoče zamenjati."));
    }

async function saveBulkClientFromDialog() {
      const selection = reportClientSelection();
      const lines = syncClientBillSelection(reportTodos().map(reportTodoLine), selection);
      const eventIds = [...new Set(lines.map((line) => todoEventId(line.todo)).filter(Boolean))];
      if (!eventIds.length) throw new Error("Označi vsaj en še neobračunan vpis.");
      const requestedClient = String($("bulkClientTarget").value || "").trim();
      const client = findClient(requestedClient);
      if (!requestedClient || requestedClient.length > 240) throw new Error("Vpiši naziv stranke (največ 240 znakov).");
      if (client && String(client.clientId || client.id) === String(selection.id)) throw new Error("Izbrana je že ista stranka.");
      const clientName = client?.name || requestedClient;
      if (!await showAppConfirm(`Samo ${eventIds.length} označenih vpisov premaknem na ${clientName}?${client ? "" : "\nUstvarjena bo nova adhoc stranka."}\nObstoječi vpisi ciljne stranke ostanejo nespremenjeni. Kontakti prejšnje stranke se odstranijo.`, { title: "Zamenjaj stranko" })) return;
      setClientBillProcessing(true);
      try {
      const data = await api("/api/todos/bulk-client", {
        method: "POST",
        body: JSON.stringify({ eventIds, clientId: client?.clientId || client?.id || "", clientName, sourceClientId: selection.id })
      });
      state.todos = data.todos || state.todos;
      state.clientBillSelectionKey = "";
      state.clientBillSelectedEventIds = new Set();
      state.reportAttachmentSelectionKey = "";
      state.reportIncludedAttachmentIds = new Set();
      await loadAll();
      state.reportMovedEventIds = new Set(eventIds);
      state.clientBillSelectionKey = reportClientBillSelectionKey({ id: data.client.clientId, name: data.client.name });
      state.clientBillSelectedEventIds = new Set(eventIds);
      const snapshot = state.reportReturnSnapshot;
      openClientReport(data.client.name, data.client.clientId, { fromHistory: true, returnSnapshot: snapshot });
      history.replaceState(reportClientHistoryState(data.client.name, data.client.clientId, snapshot), "", location.href);
      showNotice(`${eventIds.length} vpisov je prestavljenih in poudarjenih. Prikazani so tudi obstoječi vpisi ciljne stranke v izbranem obdobju.`);
      } finally { setClientBillProcessing(false); }
    }

async function confirmClientBillFromReport() {
      const selection = reportClientSelection();
      if (!selection.id && !selection.name) return;
      const pending = reportTodos().map(reportTodoLine).filter((line) => !line.clientBill);
      const selected = syncClientBillSelection(pending, selection);
      const eventIds = [...new Set(selected.map((line) => todoEventId(line.todo)).filter(Boolean))];
      if (!eventIds.length) {
        showNotice("Označi vsaj en vpis za obračun stranki.");
        return;
      }
      const range = reportRangeLabel();
      const label = `${eventIds.length} ${eventIds.length === 1 ? "izbran vpis" : "izbranih vpisov"}`;
      if (!await showAppConfirm(`Potrdim obračun stranki ${selection.name} za ${label} (${range})?\n\nPotrjeni vnosi bodo odstranjeni s seznama »Za obračun«. Ostanejo dosegljivi prek izbire »Prikaži obračunano« in jih lahko tam tudi prekličeš.`)) return;
      setClientBillProcessing(true);
      try {
        await api("/api/client-bills", {
          method: "POST",
          body: JSON.stringify({ clientId: selection.id, clientName: selection.name, from: $("reportFrom").value, to: $("reportTo").value, eventIds })
        });
        state.clientBillSelectionKey = "";
        state.clientBillSelectedEventIds = new Set();
        state.reportAttachmentSelectionKey = "";
        state.reportIncludedAttachmentIds = new Set();
        await loadAll();
        setView("report");
        renderReport();
      } finally {
        setClientBillProcessing(false);
      }
    }

function setClientBillProcessing(active) {
      const overlay = $("clientBillProcessing");
      if (!overlay) return;
      overlay.classList.toggle("hidden", !active);
      overlay.setAttribute("aria-hidden", active ? "false" : "true");
      $("confirmClientBill").disabled = Boolean(active) || !state.clientBillSelectedEventIds?.size;
    }

async function requestClientReportPdfDownload(payload, retried = false) {
      let response;
      try {
        response = await fetch("/api/client-report/pdf-ticket", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrfToken || "" },
          body: JSON.stringify(payload)
        });
      } catch (cause) {
        throw new Error("Povezava s strežnikom ni uspela.");
      }
      if (response.status === 403 && !retried) {
        const failure = await response.clone().json().catch(() => null);
        if (/varnostna potrditev seje manjka/i.test(String(failure?.error || ""))) {
          await refreshSessionSecurityContext();
          return requestClientReportPdfDownload(payload, true);
        }
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(failure?.error || "Prenosa PDF poročila ni bilo mogoče pripraviti.");
      }
      const result = await response.json().catch(() => null);
      const downloadUrl = String(result?.downloadUrl || "");
      if (!downloadUrl.startsWith("/api/client-report/pdf-download?ticket=")) {
        throw new Error("Varne povezave za prenos PDF-ja ni bilo mogoče pripraviti.");
      }
      return downloadUrl;
    }

function clientReportDownloadWindow() {
      // Firefox on Android can receive a fetched Blob but then suppress its
      // artificial download click. Reserve a browser tab while the original
      // button gesture is still active, then navigate that tab to a normal
      // Content-Disposition download response.
      if (!window.matchMedia?.("(pointer: coarse)").matches) return null;
      const target = window.open("about:blank", "_blank");
      if (!target) return null;
      try {
        target.opener = null;
        target.document.title = "INDUS URE – PDF poročilo";
        target.document.body.textContent = "Pripravljam PDF poročilo …";
      } catch {
        // The direct-link fallback below still works if a browser limits the
        // temporary window object.
      }
      return target;
    }

function startClientReportDownload(downloadUrl, targetWindow = null) {
      if (targetWindow && !targetWindow.closed) {
        targetWindow.location.replace(downloadUrl);
        return;
      }
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = "";
      link.style.display = "none";
      document.body.append(link);
      link.click();
      link.remove();
    }

function mobileNativeShareAvailable() {
      return Boolean(window.matchMedia?.("(pointer: coarse)").matches && typeof navigator.share === "function");
    }

function downloadSharedFile(downloadUrl, filename = "") {
      const link = document.createElement("a");
      link.href = downloadUrl;
      link.download = filename;
      link.style.display = "none";
      document.body.append(link);
      link.click();
      link.remove();
    }

function shareFileName(value, fallback = "priloga") {
      const name = String(value || "").trim().replace(/[\\/:*?\"<>|\u0000-\u001f]+/g, "-").slice(0, 120);
      return name || fallback;
    }

async function shareFileOnMobileOrDownload(downloadUrl, { title = "", filename = "priloga" } = {}) {
      if (!mobileNativeShareAvailable()) {
        downloadSharedFile(downloadUrl, filename);
        return;
      }
      let response;
      try {
        response = await fetch(downloadUrl, { credentials: "same-origin" });
      } catch {
        throw new Error("Datoteke za deljenje ni bilo mogoče prenesti.");
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(failure?.error || "Datoteke za deljenje ni bilo mogoče pripraviti.");
      }
      const blob = await response.blob();
      const file = new File([blob], shareFileName(filename), { type: blob.type || "application/octet-stream" });
      if (typeof navigator.canShare === "function" && !navigator.canShare({ files: [file] })) {
        downloadSharedFile(downloadUrl, filename);
        return;
      }
      try {
        await navigator.share({ title, files: [file] });
      } catch (error) {
        // Closing the native chooser is not an application failure.
        if (error?.name !== "AbortError") throw error;
      }
    }

async function requestTodoSharePdfDownload(todoId, retried = false) {
      let response;
      try {
        response = await fetch(`/api/todos/${encodeURIComponent(todoId)}/share-pdf-ticket`, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrfToken || "" },
          body: "{}"
        });
      } catch {
        throw new Error("Povezava s strežnikom ni uspela.");
      }
      if (response.status === 403 && !retried) {
        const failure = await response.clone().json().catch(() => null);
        if (/varnostna potrditev seje manjka/i.test(String(failure?.error || ""))) {
          await refreshSessionSecurityContext();
          return requestTodoSharePdfDownload(todoId, true);
        }
      }
      if (!response.ok) {
        const failure = await response.json().catch(() => null);
        throw new Error(failure?.error || "PDF-ja dogodka ni bilo mogoče pripraviti.");
      }
      const result = await response.json().catch(() => null);
      const downloadUrl = String(result?.downloadUrl || "");
      if (!downloadUrl.startsWith("/api/todos/share-pdf-download?ticket=")) {
        throw new Error("Varne povezave za PDF dogodka ni bilo mogoče pripraviti.");
      }
      return downloadUrl;
    }

async function shareTodoPdf() {
      const todo = state.todos.find((item) => item.id === $("todoFormId").value);
      if (!todo?.id) throw new Error("Dogodek ni več na voljo.");
      const button = $("shareTodoPdf");
      button.disabled = true;
      try {
        const downloadUrl = await requestTodoSharePdfDownload(todo.id);
        await shareFileOnMobileOrDownload(downloadUrl, {
          title: todo.title || "Dogodek",
          filename: `${shareFileName(todo.title, "dogodek")}.pdf`
        });
      } finally {
        button.disabled = false;
      }
    }

async function shareTodoAttachment(photo) {
      const source = attachmentSource(photo);
      if (!source) throw new Error("Priloga ni več na voljo.");
      await shareFileOnMobileOrDownload(source, {
        title: attachmentDisplayName(photo),
        filename: attachmentDisplayName(photo)
      });
    }

async function downloadClientReportPdf() {
      const payload = reportExportPayload();
      const targetWindow = clientReportDownloadWindow();
      try {
        const downloadUrl = await requestClientReportPdfDownload(payload);
        startClientReportDownload(downloadUrl, targetWindow);
      } catch (error) {
        if (targetWindow && !targetWindow.closed) targetWindow.close();
        throw error;
      }
    }

async function createClientReportGmailDraft() {
      const payload = reportExportPayload();
      const result = await api("/api/client-report/gmail-draft", { method: "POST", body: JSON.stringify(payload) });
      showNotice(`Gmail osnutek za ${result.email} je pripravljen. Sporočilo ni bilo poslano.`);
      window.open("https://mail.google.com/mail/u/0/#drafts", "_blank", "noopener");
    }

function autosizeClientBillingFields() {
      const fields = [...$("clientDetailList").querySelectorAll("textarea[data-client-billing-inline-field]")]
        .filter((field) => field.getClientRects().length);
      fields.forEach((field) => { field.style.height = "0px"; });
      const heights = fields.map((field) => field.scrollHeight + 2);
      fields.forEach((field, index) => { field.style.height = `${heights[index]}px`; });
    }

function installReportFilterBindings1() {
    $("reportViewBtn").addEventListener("click", () => setView("report"));
    $("reportFrom").addEventListener("change", renderReport);
    $("reportTo").addEventListener("change", renderReport);
    $("reportClientSort").addEventListener("change", () => {
      state.reportClientSort = reportClientSortMode($("reportClientSort").value);
      saveClientBillingFilter();
      renderReport();
    });
    $("reportHoursMode").addEventListener("change", () => renderReport());
    ["reportShowPending", "reportShowBilled"].forEach((id) => {
      $(id).addEventListener("change", () => {
        state.showClientPending = $("reportShowPending").checked;
        state.showClientBilled = $("reportShowBilled").checked;
        saveClientBillingFilter();
        state.clientBillSelectionKey = "";
        state.clientBillSelectedEventIds = new Set();
        renderReport();
      });
    });
}

function installClientBillingBindings1() {
    $("reportClient").addEventListener("input", () => {
      state.reportClient = "";
      state.reportClientId = "";
      window.clearTimeout(moduleValues.reportSearchRenderTimer);
      moduleValues.reportSearchRenderTimer = window.setTimeout(renderReport, 100);
    });
    $("reportClient").addEventListener("keydown", (event) => {
      if (event.key === "Escape") clearClientReportSelection();
      if (event.key === "Enter") {
        event.preventDefault();
        window.clearTimeout(moduleValues.reportSearchRenderTimer);
        renderReport();
        const cards = $("clientDetailList").querySelectorAll(".open-client-report");
        if (cards.length === 1) cards[0].click();
      }
    });
    $("clearReportClient").addEventListener("click", clearClientReportSelection);
    $("reportBackToClients").addEventListener("click", clearClientReportSelection);
    $("reportNewEntry").addEventListener("click", () => {
      const client = reportClientSelection();
      if (!client.id && !client.name) { showNotice("Najprej izberi stranko."); return; }
      openTodoDialog({ _standaloneHours: true, status: "execution", date: dateKey(new Date()), client: client.name, clientId: client.id, _hoursAssigneeIds: [activeWorkerId()] }).catch((error) => showNotice(error.message));
    });
    $("selectAllClientBill").addEventListener("click", () => setClientBillSelectionForCurrentReport(true));
    $("clearClientBillSelection").addEventListener("click", () => setClientBillSelectionForCurrentReport(false));
    $("bulkChangeReportClient").addEventListener("click", openBulkClientDialog);
    $("bulkClientTarget").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); openBulkClientDialog(); } });
    $("confirmClientBill").addEventListener("click", () => confirmClientBillFromReport().catch((error) => showNotice(error.message)));
    $("exportReportPdf").addEventListener("click", () => downloadClientReportPdf().catch((error) => showNotice(error.message)));
    $("createReportGmailDraft").addEventListener("click", () => createClientReportGmailDraft().catch((error) => showNotice(error.message)));
}

function installReportOptionsBindings1() {
    document.querySelectorAll(".report-setting").forEach((button) => {
      button.addEventListener("click", () => editBillingSetting(button.dataset.setting).catch((error) => showNotice(error.message)));
    });
}

function installClientReportBindings1() {
    $("previousReportTodo").addEventListener("click", () => navigateReportTodo(-1).catch((error) => showNotice(error.message)));
    $("nextReportTodo").addEventListener("click", () => navigateReportTodo(1).catch((error) => showNotice(error.message)));
    $("clientDetailList").addEventListener("click", (event) => {
      const cancelBill = event.target.closest("[data-cancel-client-bill-id]");
      if (cancelBill) {
        event.preventDefault();
        event.stopPropagation();
        cancelClientBillFromReport(cancelBill.dataset.cancelClientBillId).catch((error) => showNotice(error.message));
        return;
      }
      const clientButton = event.target.closest(".open-client-report");
      if (clientButton) {
        openClientReport(clientButton.dataset.clientName || "", clientButton.dataset.clientId || "");
        return;
      }
      const preview = event.target.closest(".report-image-preview");
      if (preview) {
        const todo = state.todos.find((item) => item.id === preview.dataset.reportTodoId);
        const photo = todo?.photos?.find((item) => item.id === preview.dataset.photoId);
        if (photo) openAttachmentPreview(photo, { todoId: todo.id, photos: todo.photos });
        return;
      }
      const todoButton = event.target.closest(".open-report-todo");
      if (todoButton) {
        event.preventDefault();
        const todo = state.todos.find((item) => item.id === todoButton.dataset.todoId);
        if (!todo) return;
        const navigationIds = reportTodos().map((item) => item.id).filter(Boolean);
        openTodoDialog(todo, { reportNavigationIds: navigationIds }).catch((error) => showNotice(error.message));
      }
    });
    $("clientDetailList").addEventListener("input", (event) => {
      if (event.target.matches("textarea[data-client-billing-inline-field]")) autosizeClientBillingFields();
    });
    new ResizeObserver(() => {
      if (state.view === "report") requestAnimationFrame(autosizeClientBillingFields);
    }).observe($("clientDetailList"));
    $("clientDetailList").addEventListener("change", (event) => {
      const inlineField = event.target.closest("[data-client-billing-inline-field]");
      if (inlineField && !inlineField.disabled) {
        saveClientBillingInlineField(inlineField).catch((error) => {
          renderReport();
          showNotice(error.message);
        });
        return;
      }
      const exportAttachment = event.target.closest("[data-report-export-attachment-id]");
      if (exportAttachment && !exportAttachment.disabled) {
        const attachmentId = String(exportAttachment.dataset.reportExportAttachmentId || "");
        if (attachmentId) {
          if (exportAttachment.checked) state.reportIncludedAttachmentIds.add(attachmentId);
          else state.reportIncludedAttachmentIds.delete(attachmentId);
        }
        return;
      }
      const checkbox = event.target.closest("[data-client-bill-event-id]");
      if (!checkbox || checkbox.disabled) return;
      const eventId = String(checkbox.dataset.clientBillEventId || "");
      if (!eventId) return;
      if (checkbox.checked) state.clientBillSelectedEventIds.add(eventId);
      else state.clientBillSelectedEventIds.delete(eventId);
      renderReport();
    });
    $("clientDetailList").addEventListener("keydown", (event) => {
      const inlineField = event.target.closest("[data-client-billing-inline-field]");
      if (!inlineField || event.key !== "Enter") return;
      if (inlineField.dataset.clientBillingInlineField === "notes" && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      inlineField.blur();
    });
}

  return {
    setDefaultReportRange,
    reportTodoIsCompleted,
    reportClientSortMode,
    reportNumber,
    renderReport,
    openClientReport,
    clearClientReportSelection,
    shareTodoPdf,
    shareTodoAttachment,
    installReportFilterBindings1,
    installClientBillingBindings1,
    installReportOptionsBindings1,
    installClientReportBindings1
  };
}
