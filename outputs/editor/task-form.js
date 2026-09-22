// editor/task-form: explicit dependencies; factory creation has no I/O or UI effects.
function createTaskForm({
  $,
  state,
  activeWorkerId,
  api,
  chooseTodoClientSuggestion,
  dateKey,
  dayTimelineMinutes,
  dayTimelineTime,
  escapeHtml,
  findTodoClient,
  formatClientBillableHours,
  formatDateTime,
  hideTodoClientSuggestions,
  internalCompanyClient,
  isAdminView,
  mealPaidMinutes,
  money,
  normalizeText,
  normalizeTodoFormTimes,
  openTodoDialog,
  parseBillingNumber,
  refreshClientList,
  rememberTodoStartTime,
  render,
  renderBillingView,
  renderClients,
  renderMonth,
  renderReport,
  renderTodoClientSuggestions,
  renderTodoFormDriveFiles,
  renderTodoFormPhotos,
  renderTodoFormQuickTimePicker,
  renderTodos,
  renderTodoStatusChoices,
  setTodoClientSuggestionIndex,
  setTodoFormQuickTime,
  shiftDateKey,
  showFormValidationError,
  suggestedNoteTimeRange,
  syncTodoFormClientBillableHours,
  todoChangeNotice,
  todoChangeNoticeCanBeAcknowledged,
  todoChangeNoticeRecipientId,
  todoChangeNoticeText,
  todoStatus,
  todoStatusUsesInternalCompanyClient,
  updateTodoStatusControl,
  workerDefaultHourlyRate,
  moduleValues
}) {
function applyTodoFormInternalCompanyClient() {
      const client = internalCompanyClient();
      $("todoFormClient").value = client?.name || moduleValues.internalCompanyClientName;
      state.todoDialogClientContactIds = [];
      state.todoDialogClientContactClientId = String(client?.clientId || client?.id || "");
      state.todoDialogClientContactPickerOpen = false;
      hideTodoClientSuggestions();
      renderTodoFormClientContacts();
    }

function closeOtherTodoFormFoldouts(opened) {
      [$("todoFormStatusField"), $("todoFormDateTimeSection")].forEach((section) => {
        if (section && section !== opened) section.open = false;
      });
    }

function todoFormClientContacts(client) {
      const contacts = Array.isArray(client?.contacts) ? client.contacts : [];
      return contacts.filter((contact) => String(contact?.id || "").trim() && String(contact?.phone || "").trim());
    }

function todoFormSelectedClient() {
      return findTodoClient($("todoFormClient").value);
    }

function renderTodoFormClientContacts() {
      const field = $("todoFormClientContactsField");
      const picker = $("todoFormClientContactPicker");
      const selected = $("todoFormClientContactSelected");
      const client = todoFormSelectedClient();
      const clientId = String(client?.clientId || client?.id || "");
      const contacts = todoFormClientContacts(client);
      if (clientId !== state.todoDialogClientContactClientId) {
        state.todoDialogClientContactClientId = clientId;
        state.todoDialogClientContactIds = [];
        state.todoDialogClientContactPickerOpen = false;
      }
      field.classList.toggle("hidden", !contacts.length);
      if (!contacts.length) {
        picker.classList.add("hidden");
        picker.innerHTML = "";
        selected.innerHTML = "";
        return;
      }
      const selectedIds = new Set(state.todoDialogClientContactIds);
      picker.classList.toggle("hidden", !state.todoDialogClientContactPickerOpen);
      picker.innerHTML = contacts.map((contact) => `
        <label class="todo-client-contact-picker-row">
          <input type="checkbox" data-todo-client-contact-id="${escapeHtml(contact.id)}" ${selectedIds.has(contact.id) ? "checked" : ""}>
          <span><strong>${escapeHtml(contact.name || "Kontakt")}</strong></span>
          <small>${escapeHtml(contact.phone)}</small>
        </label>
      `).join("");
      const selectedContacts = contacts.filter((contact) => selectedIds.has(contact.id));
      selected.innerHTML = selectedContacts.map((contact) => `
        <div class="todo-client-contact-row">
          <span><strong>${escapeHtml(contact.name || "Kontakt")}</strong> · ${escapeHtml(contact.phone)}</span>
          <span class="todo-client-contact-actions">
            <a class="secondary" href="tel:${escapeHtml(String(contact.phone).replace(/[^0-9+]/g, ""))}" title="Pokliči ${escapeHtml(contact.name || contact.phone)}" aria-label="Pokliči ${escapeHtml(contact.name || contact.phone)}">&#9742;</a>
            <button class="secondary" type="button" data-remove-todo-client-contact-id="${escapeHtml(contact.id)}" title="Odstrani kontakt" aria-label="Odstrani kontakt">&times;</button>
          </span>
        </div>
      `).join("");
    }

function syncTodoFormClientContacts({ preserve = false } = {}) {
      const client = todoFormSelectedClient();
      const clientId = String(client?.clientId || client?.id || "");
      if (!preserve && clientId !== state.todoDialogClientContactClientId) state.todoDialogClientContactIds = [];
      state.todoDialogClientContactClientId = clientId;
      renderTodoFormClientContacts();
    }

function invalidTodoForm(message, fieldOrId = "") {
      const field = typeof fieldOrId === "string" ? $(fieldOrId) : fieldOrId;
      return showFormValidationError($("todoForm"), message, field);
    }

function validateTodoHoursClient(todo) {
      if (moduleValues.timeEntryStatusIds.has(todo.status) && todo.status !== "meal"
          && !String(todo.client || "").trim() && !String(todo.clientId || "").trim()) {
        return invalidTodoForm("Za vpis ur izberi stranko.", "todoFormClient");
      }
      return true;
    }

function validateTodo(todo) {
      if (!validateTodoHoursClient(todo)) return false;
      const materialEntry = todo.status === "material";
      const noteEntry = todo.status === "note";
      if (!materialEntry && !noteEntry && (!todo.id || Array.isArray(todo.assigneeIds)) && (!Array.isArray(todo.assigneeIds) || todo.assigneeIds.length === 0)) {
        return invalidTodoForm("Izberi vsaj enega delavca.", $("todoFormAssignees").querySelector("input") || $("todoFormAssigneeLabel"));
      }
      if ((materialEntry || noteEntry) && !todo.clientId) {
        return invalidTodoForm(materialEntry ? "Za vpis materiala izberi stranko." : "Za zapisek izberi stranko.", "todoFormClient");
      }
      if (materialEntry && !todo.date) {
        return invalidTodoForm("Za vpis materiala vnesi datum.", "todoFormDate");
      }
      if (!todo.title) {
        return invalidTodoForm("Vpiši ime opravila.", "todoFormTask");
      }
      if (todo.endDate && !todo.date) {
        return invalidTodoForm("Za datum do vnesi tudi datum od.", "todoFormDate");
      }
      if (todo.date && todo.endDate && todo.endDate < todo.date) {
        return invalidTodoForm("Datum do ne more biti pred datumom od.", "todoFormEndDate");
      }
      if (Boolean(todo.start) !== Boolean(todo.end)) {
        return invalidTodoForm("Vnesi obe uri: od in do.", todo.start ? "todoFormEnd" : "todoFormStart");
      }
      if ((todo.start || todo.end) && !todo.date) {
        return invalidTodoForm("Za opravilo z uro vnesi tudi datum.", "todoFormDate");
      }
      if (todo.start && todo.end && todo.endDate && todo.endDate !== todo.date) {
        return invalidTodoForm("Opravilo z uro je lahko samo za en dan. Za večdnevno opravilo pusti uri prazni.", "todoFormEndDate");
      }
      if (["execution", "meal"].includes(todo.status) && (!todo.date || !todo.start || !todo.end)) {
        return invalidTodoForm(todo.status === "meal" ? "Za malico vnesi datum ter uro od in do." : "Za zaključeno opravilo vnesi datum ter uro od in do.", !todo.date ? "todoFormDate" : (!todo.start ? "todoFormStart" : "todoFormEnd"));
      }
      if (todo.start && todo.end <= todo.start) {
        return invalidTodoForm("Ura do mora biti kasneje kot ura od.", "todoFormEnd");
      }
      return true;
    }

function setView(view) {
      if (!isAdminView() && view === "report") view = "todos";
      state.view = view;
      document.querySelectorAll(".calendar-view").forEach((element) => {
        element.classList.toggle("view-hidden", view !== "calendar");
      });
      document.querySelectorAll(".todos-view").forEach((element) => {
        element.classList.toggle("view-hidden", view !== "todos");
      });
      document.querySelectorAll(".report-screen").forEach((element) => {
        element.classList.toggle("view-hidden", view !== "report");
      });
      document.querySelectorAll(".clients-screen").forEach((element) => {
        element.classList.toggle("view-hidden", view !== "clients");
      });
      document.querySelectorAll(".billing-screen").forEach((element) => {
        element.classList.toggle("view-hidden", view !== "billing");
      });
      $("calendarViewBtn").classList.toggle("active", view === "calendar");
      $("todosViewBtn").classList.toggle("active", view === "todos");
      $("billingMenuBtn").classList.toggle("active", view === "billing");
      $("clientBillingMenuBtn").classList.toggle("active", view === "report");
      $("billingTopViewBtn").classList.toggle("active", view === "billing");
      $("clientBillingTopViewBtn").classList.toggle("active", view === "report");
      $("clientsMenuBtn").classList.toggle("active", view === "clients");
      $("reportViewBtn").classList.toggle("active", view === "report");
      if (view === "calendar") renderMonth();
      if (view === "todos") renderTodos();
      if (view === "billing") renderBillingView();
      if (view === "clients") renderClients();
      if (view === "report") renderReport();
    }

function startTodoForDate(date = "") {
      openTodoDialog({ date, _adminCreate: isAdminView() });
    }

function todoOrderForCurrentUser(todo) {
      const sharedOrder = Number(todo?.sharedManualOrder);
      return Number.isFinite(sharedOrder) ? sharedOrder : Number(todo?.order || 0);
    }

function timeEntryTargetUsers() {
      const permitted = state.user?.role === "boss"
        ? new Set(state.users.map((user) => user.id))
        : new Set(state.user?.timeEntryForIds || [state.user?.id]);
      return state.users.filter((user) => permitted.has(user.id)).sort((left, right) => String(left.name || left.id).localeCompare(String(right.name || right.id), "sl"));
    }

function renderTodoFormAssignees(selectedIds = [], onlyIds = null, { disabled = false, single = false } = {}) {
      const selected = new Set(selectedIds);
      const allowed = onlyIds ? new Set(onlyIds) : null;
      const users = state.users.filter((user) => !allowed || allowed.has(user.id)).slice().sort((left, right) => String(left.name || left.id).localeCompare(String(right.name || right.id), "sl"));
      $("todoFormAssignees").innerHTML = users.map((user) => `
        <label>
          <input type="${single ? "radio" : "checkbox"}" ${single ? 'name="todo-time-entry-assignee"' : ""} value="${escapeHtml(user.id)}" ${selected.has(user.id) ? "checked" : ""} ${disabled ? "disabled" : ""}>
          ${escapeHtml(user.name || user.id)}
        </label>
      `).join("");
    }

function selectedTodoFormAssignees() {
      return [...$("todoFormAssignees").querySelectorAll('input:checked')]
        .map((input) => input.value);
    }

function renderTodoFormAudit(todo) {
      const audit = $("todoFormAudit");
      const dialog = $("todoDialog");
      if (!todo.id || state.user?.role !== "boss") {
        audit.classList.add("hidden");
        audit.textContent = "";
        dialog.classList.remove("is-history-preview");
        return;
      }
      const revisions = Array.isArray(todo.revisionHistory) ? todo.revisionHistory : [];
      const previewIndex = Number(state.todoHistoryPreviewIndex);
      const revision = previewIndex >= 0 ? revisions[previewIndex] : null;
      const previewing = Boolean(revision?.snapshot);
      state.todoHistoryPreviewActive = previewing;
      dialog.classList.toggle("is-history-preview", previewing);
      const historyItems = (todo.history || [])
        .slice(-5)
        .map((item) => `${escapeHtml(item.action)}: ${escapeHtml(item.byName || item.by)} (${formatDateTime(item.at)})`)
        .join("<br>");
      const snapshot = revision?.snapshot || {};
      const snapshotDate = [snapshot.date || "", snapshot.start && snapshot.end ? `${snapshot.start}–${snapshot.end}` : ""].filter(Boolean).join(" · ");
      const snapshotDetails = previewing ? `
        <section class="todo-history-preview" aria-live="polite">
          <h4>Prejšnje stanje pred spremembo</h4>
          <p><strong>${escapeHtml(snapshot.title || "Brez naziva")}</strong></p>
          <div class="todo-history-preview-grid">
            <span>Stranka: <b>${escapeHtml(snapshot.client || "—")}</b></span>
            <span>Datum in ura: <b>${escapeHtml(snapshotDate || "—")}</b></span>
            <span>Status: <b>${escapeHtml(todoStatus(snapshot.status).label)}</b></span>
            <span>Priloge: <b>${Number(snapshot.photos?.length || 0) + Number(snapshot.driveFiles?.length || 0)}</b></span>
          </div>
          ${snapshot.notes ? `<p><strong>Opis del</strong><br>${escapeHtml(snapshot.notes)}</p>` : ""}
          ${snapshot.material ? `<p><strong>Material</strong><br>${escapeHtml(snapshot.material)}</p>` : ""}
        </section>` : "";
      const navigation = revisions.length ? `
        <div class="todo-history-navigation">
          <button class="secondary" type="button" data-todo-history-nav="-1" aria-label="Starejši zapis" title="Starejši zapis" ${previewIndex === 0 ? "disabled" : ""}>&lsaquo;</button>
          <strong>${previewing ? `Zapis ${previewIndex + 1} od ${revisions.length}` : "Trenutno stanje"}</strong>
          <button class="secondary" type="button" data-todo-history-nav="1" aria-label="Novejši zapis" title="Novejši zapis" ${!previewing ? "disabled" : ""}>&rsaquo;</button>
        </div>` : '<p class="todo-meta">Prejšnje različice se začnejo hraniti ob naslednjem shranjevanju.</p>';
      audit.classList.remove("hidden");
      audit.innerHTML = `
        <details class="todo-form-activity-history">
          <summary>
            <span>Dejavnost uporabnikov</span>
            <span class="todo-form-activity-summary">${historyItems ? "Prikaži" : "Osnovni podatki"}</span>
          </summary>
          <div class="todo-form-activity-content">
            <div>Dodal: <strong>${escapeHtml(todo.createdByName || "-")}</strong> (${formatDateTime(todo.createdAt)})</div>
            <div>Zadnja sprememba: <strong>${escapeHtml(todo.updatedByName || todo.createdByName || "-")}</strong> (${formatDateTime(todo.updatedAt || todo.createdAt)})</div>
            ${historyItems ? `<div class="todo-form-activity-events">${historyItems}</div>` : ""}
            ${navigation}
            ${snapshotDetails}
          </div>
        </details>
      `;
    }

function applyTodoChangeNoticeToForm(todo) {
      const form = $("todoForm");
      form.querySelectorAll(".todo-change-highlight").forEach((element) => element.classList.remove("todo-change-highlight"));
      const noticeBox = $("todoFormChangeNotice");
      const notice = todoChangeNotice(todo);
      noticeBox.classList.toggle("hidden", !notice);
      const canAcknowledge = todoChangeNoticeCanBeAcknowledged(todo);
      const recipient = state.users.find((user) => user.id === todoChangeNoticeRecipientId());
      $("todoFormChangeNoticeText").textContent = notice
        ? `${todoChangeNoticeText(todo)}${canAcknowledge ? "" : ` Oznaka čaka na ${recipient?.name || "delavca"}.`}`
        : "";
      if (!notice) return;
      const mark = (...ids) => ids.forEach((id) => $(id)?.classList.add("todo-change-highlight"));
      const fields = new Set(notice.fields || []);
      if (fields.has("created")) {
        mark("todoFormClientField", "todoFormClientContactsField", "todoFormStatusField", "todoFormAssigneeField", "todoFormTaskField", "todoFormMaterialField", "todoFormDateTimeSection", "todoFormAttachments");
        $("todoFormNotes")?.closest("label")?.classList.add("todo-change-highlight");
        return;
      }
      if (fields.has("client")) mark("todoFormClientField", "todoFormClientContactsField");
      if (fields.has("assignment")) mark("todoFormAssigneeField");
      if (fields.has("title")) mark("todoFormTaskField");
      if (fields.has("notes")) $("todoFormNotes")?.closest("label")?.classList.add("todo-change-highlight");
      if (fields.has("material")) mark("todoFormMaterialField");
      if (fields.has("status")) mark("todoFormStatusField", "todoFormUrgentField", "todoFormOrderedField", "todoFormWarrantyField", "todoFormImportedField", "todoFormWorkFromHomeField");
      if (fields.has("schedule")) mark("todoFormDateTimeSection");
      if (fields.has("attachments")) mark("todoFormAttachments");
      if (fields.has("worker-billing")) mark("todoFormBilling");
      if (fields.has("client-billing")) mark("todoFormClientBilling");
    }

async function clearTodoChangeNoticeAfterOpen(todo) {
      if (!todoChangeNoticeCanBeAcknowledged(todo) || !todo?.id) return;
      const recipientId = todoChangeNoticeRecipientId();
      const ownId = String(state?.user?.id || "");
      const recipientQuery = recipientId && recipientId !== ownId ? `?recipient=${encodeURIComponent(recipientId)}` : "";
      const data = await api(`/api/todos/${encodeURIComponent(todo.id)}/change-notice/seen${recipientQuery}`, { method: "POST", body: "{}" });
      if (!Array.isArray(data.todos)) return;
      state.todos = data.todos;
      refreshClientList();
      render();
      const current = state.todos.find((item) => item.id === todo.id);
      if (current && $("todoDialog").open && $("todoFormId").value === todo.id) applyTodoChangeNoticeToForm(current);
    }

function navigateTodoHistory(offset) {
      const todo = state.todoHistoryLiveTodo;
      const revisions = Array.isArray(todo?.revisionHistory) ? todo.revisionHistory : [];
      if (!revisions.length) return;
      const current = Number(state.todoHistoryPreviewIndex);
      let next = current;
      if (offset < 0) next = current < 0 ? revisions.length - 1 : Math.max(0, current - 1);
      else if (offset > 0) next = current < 0 ? -1 : current >= revisions.length - 1 ? -1 : current + 1;
      state.todoHistoryPreviewIndex = next;
      renderTodoFormAudit(todo);
    }

function sourceProjectDetailsForTodo(todo = {}) {
      const sourceId = String(todo.sourceProjectTodoId || "").trim();
      const isTimeEntry = moduleValues.timeEntryStatusIds.has(todoStatus(todo.status).id);
      const candidate = sourceId ? state.todos.find((item) => item.id === sourceId) : null;
      const source = candidate && !moduleValues.timeEntryStatusIds.has(todoStatus(candidate.status).id) ? candidate : null;
      const sourceTitle = String(todo.sourceProjectTitle || "").trim();
      return {
        sourceId,
        source,
        sourceTitle,
        // A direct e-mail link opens before the full task snapshot arrives.
        // Until then an absent source is merely unknown, not deleted.
        sourceLookupPending: Boolean(isTimeEntry && sourceId && !source && !state.todoSnapshotLoaded),
        linkedToProject: Boolean(isTimeEntry && sourceId && (source || sourceTitle))
      };
    }

function refreshOpenTodoSourceProject() {
      const dialog = $("todoDialog");
      const id = $("todoFormId")?.value || "";
      if (!dialog?.open || !id) return;
      const todo = state.todos.find((item) => item.id === id);
      if (todo) renderTodoFormSourceProject(todo);
    }

function renderTodoFormSourceProject(todo) {
      const box = $("todoFormSourceProject");
      const button = $("openTodoSourceProject");
      const label = box.querySelector("span");
      const { source, sourceTitle, sourceLookupPending, linkedToProject } = sourceProjectDetailsForTodo(todo);
      box.classList.toggle("hidden", !linkedToProject || sourceLookupPending);
      button.dataset.sourceTodoId = source?.id || "";
      button.disabled = !source;
      label.textContent = source ? "Izvorno opravilo: " : "";
      button.textContent = source
        ? `Odpri in uredi: ${source.title || "opravilo"}`
        : `Izvorno opravilo \"${sourceTitle}\" ni ve\u010d na voljo`;
    }

function syncTodoFormDateRangeControls() {
      const date = $('todoFormDate').value;
      const endDate = $('todoFormEndDate');
      const calendarOnly = $('todoFormCalendarOnly');
      const calendarOnlyField = $('todoFormCalendarOnlyField');
      const isTimeEntry = moduleValues.timeEntryStatusIds.has($('todoFormStatus').value);
      const isMaterialEntry = $('todoFormStatus').value === 'material';
      const isNoteEntry = $('todoFormStatus').value === 'note';
      const lockedToOneDay = isTimeEntry || isMaterialEntry || isNoteEntry;
      const canShowOnlyInCalendar = Boolean(date && !lockedToOneDay);
      calendarOnlyField.classList.toggle('hidden', !canShowOnlyInCalendar);
      if (!canShowOnlyInCalendar) calendarOnly.checked = false;
      if (lockedToOneDay && date && endDate.value !== date) {
        endDate.value = date;
        endDate.dataset.auto = 'true';
      }
      const multiDay = Boolean(date && endDate.value && endDate.value > date);
      ['todoFormStart', 'todoFormEnd'].forEach((id) => {
        const field = $(id);
        field.disabled = multiDay || isMaterialEntry;
        field.closest('label').classList.toggle('hidden', multiDay || isMaterialEntry);
        if (multiDay || isMaterialEntry) field.value = '';
      });
      $('todoFormTimeFields').classList.toggle('hidden', isMaterialEntry);
      const endDateField = $('todoFormEndDateField');
      const endDateLocked = Boolean(lockedToOneDay && date);
      endDate.disabled = endDateLocked;
      $('setTodoFormEndDateTomorrow').disabled = endDateLocked;
      $('advanceTodoFormEndDate').disabled = endDateLocked;
      endDateField.classList.toggle('hidden', isMaterialEntry);
      endDateField.classList.toggle('date-range-locked', endDateLocked);
      renderTodoFormQuickTimePicker();
    }

function syncTodoFormEndDate({ force = false } = {}) {
      const date = $('todoFormDate').value;
      const endDate = $('todoFormEndDate');
      if (!date) {
        endDate.value = '';
        endDate.dataset.auto = 'true';
        syncTodoFormDateRangeControls();
        return;
      }
      if (force || !endDate.value || endDate.value < date || endDate.dataset.auto === 'true') endDate.value = date;
      endDate.dataset.auto = String(endDate.value === date);
      syncTodoFormDateRangeControls();
    }

function applyMealDefaults() {
      const now = new Date();
      const startMinutes = Math.min(23 * 60, Math.round((now.getHours() * 60 + now.getMinutes()) / 15) * 15);
      $("todoFormTask").value = "Malica";
      if (!$("todoFormDate").value) $("todoFormDate").value = dateKey(now);
      syncTodoFormEndDate({ force: true });
      $("todoFormStart").value = dayTimelineTime(startMinutes);
      $("todoFormEnd").value = dayTimelineTime(startMinutes + 45);
      $("todoFormClient").value = "";
      state.todoDialogClientContactIds = [];
      state.todoDialogClientContactClientId = "";
      state.todoDialogClientContactPickerOpen = false;
      renderTodoFormClientContacts();
      $("todoFormNotes").value = "";
      $("todoFormMaterial").value = "";
      state.todoDialogPhotos = [];
      state.todoDialogDriveFiles = [];
      renderTodoFormPhotos();
      renderTodoFormDriveFiles();
      renderTodoFormAssignees([activeWorkerId()], [activeWorkerId()]);
      renderTodoFormQuickTimePicker();
    }

function updateTodoFormLateTimeEntryNotice() {
      const notice = $("todoFormLateTimeEntryNotice");
      const status = $("todoFormStatus").value;
      const date = $("todoFormDate").value;
      const isLateEntry = moduleValues.timeEntryStatusIds.has(status) && Boolean(date) && date < dateKey(new Date());
      notice.classList.toggle("hidden", !isLateEntry);
      notice.textContent = isLateEntry
        ? "Pozni vpis ur: ure vpisuj, dokler si še pri stranki oziroma takoj, ko zaključiš opravilo. Sprememba bo poslana šefu s primerjavo stanja prej in potem."
        : "";
    }

function syncTodoFormDirectClientSettlement() {
      const box = $("todoFormDirectClientSettlement");
      const details = $("todoFormDirectClientSettlementDetails");
      const settled = $("todoFormDirectClientSettled");
      const amount = $("todoFormDirectClientAmount");
      const creditWorker = $("todoFormDirectClientCreditWorker");
      const stateText = $("todoFormDirectClientSettlementState");
      const saved = state.todoDialogClientSettlement || { confirmed: false };
      const eligible = Boolean($("todoFormId").value && $("todoFormStatus").value === "execution" && $("todoFormClient").value.trim());
      box.classList.toggle("hidden", !eligible);
      if (!eligible) return;
      const confirmed = Boolean(saved.confirmed);
      box.classList.toggle("is-confirmed", confirmed);
      settled.checked = confirmed || Boolean(settled.checked);
      settled.disabled = confirmed;
      amount.disabled = confirmed;
      creditWorker.disabled = confirmed;
      if (confirmed) {
        amount.value = Number(saved.amount || 0).toFixed(2);
        creditWorker.checked = Boolean(saved.creditedWorkerId);
        const credit = saved.creditedWorkerName ? ` · v dobro ${saved.creditedWorkerName}` : "";
        stateText.textContent = saved.direct
          ? `Poračunano s stranko: ${money(saved.amount || 0)} EUR${credit}.`
          : "Poračunano v skupnem obračunu stranke.";
        stateText.classList.remove("hidden");
        details.classList.remove("hidden");
        return;
      }
      stateText.textContent = "";
      stateText.classList.add("hidden");
      details.classList.toggle("hidden", !settled.checked);
    }

function updateTodoFormStatus() {
      updateTodoStatusControl($("todoFormStatus"));
      const selectedStatus = $("todoFormStatus").value;
      const completed = selectedStatus === "execution";
      const meal = selectedStatus === "meal";
      const materialEntry = selectedStatus === "material" || state.todoMaterialEntry;
      const noteEntry = selectedStatus === "note" || state.todoNoteEntry;
      const standaloneHours = Boolean(state.todoStandaloneHours && !state.todoHoursSourceId);
      const statusField = $("todoFormStatusField");
      const hideStatusField = !standaloneHours && (Boolean(state.todoHoursSourceId) || state.todoMealEntry || materialEntry || noteEntry || moduleValues.timeEntryStatusIds.has(selectedStatus));
      statusField.classList.toggle("hidden", hideStatusField);
      if (hideStatusField) statusField.open = false;
      const mealNote = $("todoFormMealNote");
      mealNote.classList.toggle("hidden", !meal);
      mealNote.textContent = meal ? `Malica se stranki ne obračuna. Delavcu se plača največ ${mealPaidMinutes()} min.` : "";
      $("todoFormTitle").textContent = materialEntry
        ? ($("todoFormId").value ? "Uredi vpis materiala" : "Vpis materiala")
        : noteEntry
          ? ($("todoFormId").value ? "Uredi zapisek" : "Nov zapisek")
        : meal ? ($("todoFormId").value ? "Uredi malico" : "Nova malica") : state.todoHoursSourceId || state.todoStandaloneHours
          ? "Vpis ur"
          : completed
            ? ($("todoFormId").value ? "Uredi vpis ur" : "Novo zaključeno opravilo")
            : $("todoFormId").value ? "Uredi opravilo" : "Novo opravilo";
      $("todoFormClientField").classList.toggle("hidden", meal);
      $("todoFormAssigneeField").classList.toggle("hidden", meal || materialEntry || noteEntry);
      $("todoFormAttachments").classList.toggle("hidden", meal);
      if (meal) $("todoFormClientContactsField").classList.add("hidden");
      else syncTodoFormClientContacts({ preserve: true });
      const logisticsStatus = moduleValues.todoLogisticsStatusIds.has(selectedStatus);
      ["todoFormTask", "todoFormNotes"].forEach((id) => $(id).closest("label").classList.toggle("hidden", meal));
      $("todoFormTaskField").firstChild.textContent = materialEntry ? "Naziv materiala ali dobave" : "Ime opravila";
      $("todoFormMaterialField").classList.toggle("hidden", meal || logisticsStatus);
      const supportsOrderConfirmation = moduleValues.todoOrderStatusIds.has(selectedStatus);
      $("todoFormOrderedField").classList.toggle("hidden", !supportsOrderConfirmation);
      if (!supportsOrderConfirmation) $("todoFormOrdered").checked = false;
      $("todoFormNotesLabel").textContent = materialEntry || logisticsStatus ? "Opis" : "Opis del";
      $("todoFormNotes").placeholder = materialEntry || logisticsStatus ? "Vpiši opis" : "Opiši, kaj se bo delalo";
      const timeEntry = moduleValues.timeEntryStatusIds.has(selectedStatus);
      const showWorkerMileage = timeEntry && !meal;
      const showHourlyRate = isAdminView() && timeEntry && !meal;
      const showClientMileage = completed && !meal;
      const showClientBillableHours = showClientMileage && isAdminView();
      $("todoFormClientBilling").classList.toggle("hidden", !showClientMileage);
      $("todoFormClientBillableHoursField").classList.toggle("hidden", !showClientBillableHours);
      if (!showClientBillableHours) $("todoFormClientBillableHoursResetField").classList.add("hidden");
      $("todoFormBilling").classList.toggle("hidden", !showWorkerMileage);
      syncTodoFormClientBillableHours();
      $("todoFormHourlyRateField").classList.toggle("hidden", !showHourlyRate);
      $("todoFormWorkFromHomeField").classList.toggle("hidden", !showWorkerMileage);
      if (!showWorkerMileage) $("todoFormWorkFromHome").checked = false;
      $("todoFormWarrantyField").classList.toggle("hidden", meal || materialEntry || noteEntry);
      if (meal || materialEntry || noteEntry) $("todoFormWarranty").checked = false;
      $("todoFormImportedField").classList.add("hidden");
      $("todoFormUrgentField").classList.toggle("hidden", timeEntry || materialEntry || noteEntry);
      if (timeEntry || materialEntry || noteEntry) $("todoFormUrgent").checked = false;
      syncTodoFormDateRangeControls();
      updateTodoFormLateTimeEntryNotice();
      syncTodoFormDirectClientSettlement();
    }

function renderTodoTaskSuggestions() {
      const cutoff = new Date();
      cutoff.setFullYear(cutoff.getFullYear() - 1);
      const cutoffDate = dateKey(cutoff);
      const selectedClient = todoFormSelectedClient();
      const selectedClientId = String(selectedClient?.clientId || selectedClient?.id || "").trim();
      const selectedClientName = normalizeText($("todoFormClient").value);
      const names = [...new Set(state.todos
        .filter((item) => item.title && (!item.date || item.date >= cutoffDate))
        .filter((item) => {
          if (!selectedClientName) return false;
          const itemClientId = String(item.clientId || "").trim();
          return selectedClientId
            ? itemClientId === selectedClientId
            : normalizeText(item.client) === selectedClientName;
        })
        .map((item) => item.title.trim())
        .filter(Boolean))]
        .sort((a, b) => a.localeCompare(b, "sl"));
      $("todoFormTaskSuggestions").innerHTML = names.map((name) => `<option value="${escapeHtml(name)}"></option>`).join("");
    }

function autosizeTodoNarrativeFields() {
      ["todoFormNotes", "todoFormMaterial"].forEach((id) => {
        const field = $(id);
        if (!field || field.closest(".hidden")) return;
        const minHeight = Math.max(82, Number.parseFloat(getComputedStyle(field).minHeight) || 0);
        field.style.height = "0px";
        field.style.height = `${Math.max(minHeight, field.scrollHeight)}px`;
      });
    }

function autosizeTodoNarrativeFieldsAfterLayout() {
      requestAnimationFrame(() => {
        autosizeTodoNarrativeFields();
        requestAnimationFrame(autosizeTodoNarrativeFields);
      });
    }

function installTaskFormBindings1() {
    $("todoFormClientBillableHours").addEventListener("input", () => {
      const input = $("todoFormClientBillableHours");
      if (String(input.value || "").trim()) input.dataset.manual = "true";
      syncTodoFormClientBillableHours();
    });
    $("todoFormClientBillableHours").addEventListener("change", () => {
      const input = $("todoFormClientBillableHours");
      const hours = parseBillingNumber(input.value, 10_000);
      if (hours === null && !String(input.value || "").trim()) input.dataset.manual = "false";
      else if (hours !== null) input.value = formatClientBillableHours(Math.round(hours * 60 / 15) * 15);
      syncTodoFormClientBillableHours();
    });
    $("todoFormClientBillableHoursReset").addEventListener("click", () => {
      syncTodoFormClientBillableHours({ reset: true });
    });
    ["todoFormStart", "todoFormEnd"].forEach((id) => {
      $(id).addEventListener("focus", () => {
        state.todoTimePickerTarget = id === "todoFormEnd" ? "end" : "start";
        state.todoTimePickerMode = "hour";
        state.todoTimePickerOpen = true;
      renderTodoFormQuickTimePicker();
      });
      $(id).addEventListener("change", (event) => {
        normalizeTodoFormTimes();
        syncTodoFormClientBillableHours();
        if (id === "todoFormStart") {
          rememberTodoStartTime($("todoFormStart").value);
          const endInput = $("todoFormEnd");
          if (event.isTrusted && endInput.dataset.autoSuggested === "true" && $("todoFormStart").value) {
            const start = dayTimelineMinutes($("todoFormStart").value);
            endInput.value = dayTimelineTime(Math.min(23 * 60 + 45, start + 60));
          }
        } else if (event.isTrusted) {
          $("todoFormEnd").dataset.autoSuggested = "false";
        }
      renderTodoFormQuickTimePicker();
        if (id === "todoFormStart" && $("todoFormStart").value && event.isTrusted) $("todoFormEnd").focus();
      });
    });
    $("todoFormQuickTimePicker").addEventListener("click", (event) => {
      const targetButton = event.target.closest("[data-time-picker-target]");
      if (targetButton) {
        state.todoTimeShiftDuration = null;
        state.todoTimePickerTarget = targetButton.dataset.timePickerTarget === "end" ? "end" : "start";
        state.todoTimePickerMode = "hour";
        state.todoTimePickerOpen = true;
      renderTodoFormQuickTimePicker();
        return;
      }
      const modeButton = event.target.closest("[data-time-picker-mode]");
      if (modeButton) {
        state.todoTimePickerMode = modeButton.dataset.timePickerMode === "minute" ? "minute" : "hour";
      renderTodoFormQuickTimePicker();
        return;
      }
      const hourButton = event.target.closest("[data-time-picker-hour]");
      if (hourButton) {
        state.todoTimePickerMode = "minute";
        setTodoFormQuickTime(state.todoTimePickerTarget, { hour: Number(hourButton.dataset.timePickerHour) });
        return;
      }
      const minuteButton = event.target.closest("[data-time-picker-minute]");
      if (minuteButton) {
        const target = state.todoTimePickerTarget;
        setTodoFormQuickTime(target, { minute: Number(minuteButton.dataset.timePickerMinute) });
        if (target === "start") {
          state.todoTimePickerTarget = "end";
          state.todoTimePickerMode = "hour";
          state.todoTimePickerOpen = true;
        } else {
          state.todoTimePickerOpen = false;
        }
        renderTodoFormQuickTimePicker();
      }
    });
    $("todoFormDate").addEventListener("change", () => {
      syncTodoFormEndDate();
      updateTodoFormLateTimeEntryNotice();
    });
    $("setTodoFormDateToday").addEventListener("click", () => {
      $("todoFormDate").value = dateKey(new Date());
      syncTodoFormEndDate();
      updateTodoFormLateTimeEntryNotice();
      $("todoFormDate").focus();
    });
    $("advanceTodoFormDate").addEventListener("click", () => {
      const current = $("todoFormDate").value || dateKey(new Date());
      $("todoFormDate").value = shiftDateKey(current, 1);
      syncTodoFormEndDate();
      updateTodoFormLateTimeEntryNotice();
      $("todoFormDate").focus();
    });
    $("setTodoFormEndDateTomorrow").addEventListener("click", () => {
      const startDate = $("todoFormDate").value || dateKey(new Date());
      $("todoFormEndDate").value = shiftDateKey(startDate, 1);
      $("todoFormEndDate").dataset.auto = "false";
      syncTodoFormDateRangeControls();
      $("todoFormEndDate").focus();
    });
    $("advanceTodoFormEndDate").addEventListener("click", () => {
      const startDate = $("todoFormDate").value || dateKey(new Date());
      const current = $("todoFormEndDate").value || startDate;
      const next = shiftDateKey(current, 1);
      $("todoFormEndDate").value = next < startDate ? startDate : next;
      $("todoFormEndDate").dataset.auto = "false";
      syncTodoFormDateRangeControls();
      $("todoFormEndDate").focus();
    });
    $("todoFormEndDate").addEventListener("change", () => {
      const date = $("todoFormDate").value;
      const endDate = $("todoFormEndDate");
      if (!date || !endDate.value || endDate.value < date) endDate.value = date;
      endDate.dataset.auto = String(!date || endDate.value === date);
      syncTodoFormDateRangeControls();
    });
    $("clearTodoFormDate").addEventListener("click", () => {
      $("todoFormDate").value = "";
      $("todoFormEndDate").value = "";
      $("todoFormEndDate").dataset.auto = "true";
      $("todoFormStart").value = "";
      $("todoFormEnd").value = "";
      syncTodoFormDateRangeControls();
      updateTodoFormLateTimeEntryNotice();
      $("todoFormDate").focus();
    });
    ["todoFormStatusField", "todoFormDateTimeSection"].forEach((id) => {
      $(id).addEventListener("toggle", (event) => {
        if (event.currentTarget.open) closeOtherTodoFormFoldouts(event.currentTarget);
      });
    });
    $("todoFormStatusChoices").addEventListener("click", (event) => {
      const button = event.target.closest("[data-status]");
      if (!button) return;
      $("todoFormStatus").value = button.dataset.status;
      if (!state.todoHoursSourceId && !state.todoMealEntry && !state.todoMaterialEntry && !moduleValues.timeEntryStatusIds.has(button.dataset.status)) {
        state.todoCreationTaskStatus = button.dataset.status;
      }
      if (todoStatusUsesInternalCompanyClient(button.dataset.status)) applyTodoFormInternalCompanyClient();
      if (button.dataset.status === "meal") applyMealDefaults();
      if (button.dataset.status === "note" && !$("todoFormDate").value) {
        const suggestion = suggestedNoteTimeRange();
        $("todoFormDate").value = suggestion.date;
        $("todoFormEndDate").value = suggestion.date;
        $("todoFormStart").value = suggestion.start;
        $("todoFormEnd").value = suggestion.end;
      }
      renderTodoStatusChoices(button.dataset.status);
      updateTodoFormStatus();
      $("todoFormStatusField").open = false;
    });
    $("todoFormDirectClientSettled").addEventListener("change", () => {
      syncTodoFormDirectClientSettlement();
      if (!$("todoFormDirectClientSettled").checked || state.todoDialogClientSettlement?.confirmed) return;
      requestAnimationFrame(() => {
        const amount = $("todoFormDirectClientAmount");
        amount.value = "";
        amount.focus();
      });
    });
    ["todoFormNotes", "todoFormMaterial"].forEach((id) => $(id).addEventListener("input", autosizeTodoNarrativeFields));
    $("todoFormHourlyRate").addEventListener("input", () => {
      $("todoFormHourlyRate").dataset.autoRate = "false";
    });
    $("todoFormAssignees").addEventListener("change", () => {
      const hourlyRate = $("todoFormHourlyRate");
      const isTimeEntry = Boolean(state.todoHoursSourceId || state.todoStandaloneHours || moduleValues.timeEntryStatusIds.has($("todoFormStatus").value));
      if (!isAdminView() || $("todoFormStatus").value !== "execution") return;
      const assignees = selectedTodoFormAssignees();
      if (assignees.length !== 1 || (!isTimeEntry && hourlyRate.dataset.autoRate !== "true")) return;
      hourlyRate.value = workerDefaultHourlyRate(assignees[0]);
      hourlyRate.dataset.autoRate = "true";
    });
    $("todoFormClient").addEventListener("focus", renderTodoClientSuggestions);
    $("todoFormClient").addEventListener("input", () => {
      renderTodoClientSuggestions();
      syncTodoFormClientContacts();
      renderTodoTaskSuggestions();
    });
    $("todoFormClient").addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if ($("todoFormClientSuggestions").classList.contains("hidden")) renderTodoClientSuggestions();
        setTodoClientSuggestionIndex(state.todoClientSuggestionIndex + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && state.todoClientSuggestionIndex >= 0 && !$("todoFormClientSuggestions").classList.contains("hidden")) {
        event.preventDefault();
        chooseTodoClientSuggestion(state.todoClientSuggestionIndex);
      } else if (event.key === "Escape") {
        hideTodoClientSuggestions();
      }
    });
    $("todoFormClientAutocomplete").addEventListener("focusout", (event) => {
      // Keep the list available while keyboard focus moves to an option or
      // its edit button. A blur timer can hide it during a held touch.
      if (!event.currentTarget.contains(event.relatedTarget)) hideTodoClientSuggestions();
    });
    $("todoFormClientSuggestions").addEventListener("mousedown", (event) => {
      // Retain input focus without cancelling touch scrolling. Never select
      // or remove the overlay on pointerdown: the remaining gesture could
      // otherwise activate a checkbox that was underneath it.
      if (event.target.closest("button")) event.preventDefault();
    });
    $("todoFormClientSuggestions").addEventListener("click", (event) => {
      const option = event.target.closest("[data-index]");
      if (!option) return;
      event.preventDefault();
      event.stopPropagation();
      chooseTodoClientSuggestion(Number(option.dataset.index));
    });
    $("todoFormClientContactPickerToggle").addEventListener("click", () => {
      if (!todoFormSelectedClient()) return;
      state.todoDialogClientContactPickerOpen = !state.todoDialogClientContactPickerOpen;
      renderTodoFormClientContacts();
    });
    $("todoFormClientContactPicker").addEventListener("change", (event) => {
      const input = event.target.closest("[data-todo-client-contact-id]");
      if (!input) return;
      const id = String(input.dataset.todoClientContactId || "");
      const selected = new Set(state.todoDialogClientContactIds);
      if (input.checked) selected.add(id); else selected.delete(id);
      state.todoDialogClientContactIds = [...selected];
      renderTodoFormClientContacts();
    });
    $("todoFormClientContactSelected").addEventListener("click", (event) => {
      const button = event.target.closest("[data-remove-todo-client-contact-id]");
      if (!button) return;
      state.todoDialogClientContactIds = state.todoDialogClientContactIds.filter((id) => id !== button.dataset.removeTodoClientContactId);
      renderTodoFormClientContacts();
    });
}

  return {
    todoFormSelectedClient,
    syncTodoFormClientContacts,
    invalidTodoForm,
    validateTodoHoursClient,
    validateTodo,
    setView,
    startTodoForDate,
    todoOrderForCurrentUser,
    timeEntryTargetUsers,
    renderTodoFormAssignees,
    selectedTodoFormAssignees,
    renderTodoFormAudit,
    applyTodoChangeNoticeToForm,
    clearTodoChangeNoticeAfterOpen,
    navigateTodoHistory,
    sourceProjectDetailsForTodo,
    refreshOpenTodoSourceProject,
    renderTodoFormSourceProject,
    syncTodoFormEndDate,
    applyMealDefaults,
    updateTodoFormLateTimeEntryNotice,
    updateTodoFormStatus,
    renderTodoTaskSuggestions,
    autosizeTodoNarrativeFields,
    autosizeTodoNarrativeFieldsAfterLayout,
    installTaskFormBindings1
  };
}
