// editor/task-dialog: explicit dependencies; factory creation has no I/O or UI effects.
function createTaskDialog({
  $,
  state,
  acquireTodoEditLockForDialog,
  activeWorkerId,
  api,
  closeModalBeforeTransition,
  isNetworkError,
  applyMealDefaults,
  applyTodoChangeNoticeToForm,
  autosizeTodoNarrativeFields,
  autosizeTodoNarrativeFieldsAfterLayout,
  clearFormValidationError,
  clearTodoChangeNoticeAfterOpen,
  clearTodoCreationDraft,
  clearTodoEditLockState,
  dateKey,
  dayTimelineMinutes,
  dayTimelineTime,
  deleteTodoFromServer,
  discardTemporaryTodoAttachments,
  findClient,
  finishQuickCreateLink,
  formatClientBillableHours,
  hideTodoClientSuggestions,
  isAdminView,
  isNewTodoCreationDialog,
  loadTodoCreationDraft,
  manualClientBillableMinutes,
  openDayTimeline,
  persistTodoCreationDraft,
  preferredClientVehicle,
  releaseTodoEditLockForDialog,
  rememberedTodoStartTime,
  renderTodoFormAssignees,
  renderTodoFormAudit,
  renderTodoFormDriveFiles,
  renderTodoFormPhotos,
  renderTodoFormSourceProject,
  renderTodoStatusChoices,
  renderTodoTaskSuggestions,
  scheduleTodoFormPhotoPreviews,
  setTodoVideoUploadStatus,
  showAppConfirm,
  showNotice,
  sourceProjectDetailsForTodo,
  startTodoForDate,
  syncTodoFormClientBillableHours,
  syncTodoFormClientContacts,
  timeEntryTargetUsers,
  todoAssigneeIds,
  todoCanMarkChangedForOthers,
  todoChangeNoticeCanBeAcknowledged,
  todoCreationDraftFromForm,
  todoCreationDraftMode,
  todoEndDate,
  todoHourlyRate,
  todoStatus,
  updateTodoFormStatus,
  workerDefaultHourlyRate,
  moduleValues
}) {
let projectHoursApproval = "";
let projectHoursOpening = false;
let taskDialogGeneration = 0;

async function chooseExistingProjectHours(todo, generation) {
      const sourceId = String(todo.sourceProjectTodoId || "");
      const workerId = String(todo.syncUser || "");
      const date = String(todo.date || dateKey(new Date()));
      let data;
      let offline = false;
      try {
        data = await api(`/api/todos/${encodeURIComponent(sourceId)}/project-hours?date=${encodeURIComponent(date)}&workerId=${encodeURIComponent(workerId)}`);
      } catch (error) {
        if (!isNetworkError(error)) throw error;
        offline = true;
        const source = state.todos.find(item => item.id === sourceId);
        const sourceIds = new Set(state.todos.filter(item => item.id === sourceId
          || (source?.assignmentGroupId && item.assignmentGroupId === source.assignmentGroupId)).map(item => item.id));
        data = {
          entries: state.todos.filter(item => item.status === "execution" && !item.trashedAt
            && item.date === date && item.syncUser === workerId && sourceIds.has(item.sourceProjectTodoId)),
          workerName: timeEntryTargetUsers().find(item => item.id === workerId)?.name || workerId
        };
      }
      if (!$("todoDialog").open || generation !== taskDialogGeneration) return { action: "cancel" };
      const entries = data.entries.slice().sort((a, b) => String(a.start).localeCompare(String(b.start)) || a.id.localeCompare(b.id));
      const approval = JSON.stringify([sourceId, workerId, date, offline, entries.map(item => [item.id, item.start, item.end])]);
      if ((!entries.length && !offline) || projectHoursApproval === approval) return { action: "new", approval };
      const dialog = $("projectHoursExistsDialog");
      $("projectHoursExistsTitle").textContent = entries.length ? "Ure so že vpisane" : "Preverjanje brez povezave";
      const dateLabel = date.split("-").reverse().join(". ");
      $("projectHoursExistsMessage").textContent = `${data.workerName} · ${dateLabel}\nZa to opravilo ${entries.length ? "že obstajajo spodnji vpisi ur. Izberi vpis za urejanje ali izrecno ustvari novega." : "ni shranjenih vpisov v tej napravi."}${offline ? "\nBrez povezave: novih vpisov z drugih naprav ni mogoče preveriti." : ""}`;
      if (entries.length && !$("todoFormId").value) $("projectHoursExistsMessage").textContent += "\nČe izbereš urejanje obstoječega, se trenutni novi vpis zavrže.";
      const list = $("projectHoursExistsList");
      list.replaceChildren();
      entries.forEach((entry, index) => {
        const label = document.createElement("label");
        const radio = document.createElement("input");
        radio.type = "radio";
        radio.name = "existingProjectHours";
        radio.value = entry.id;
        radio.checked = index === 0;
        const text = document.createElement("span");
        text.textContent = `${entry.start || "—"}–${entry.end || "—"}`;
        label.append(radio, text);
        list.append(label);
      });
      $("projectHoursExistsEdit").hidden = !entries.length;
      return new Promise(resolve => {
        let settled = false;
        const finish = async choice => {
          if (settled) return;
          settled = true;
          dialog.removeEventListener("close", cancelled);
          await closeModalBeforeTransition(dialog);
          resolve(choice);
        };
        const cancelled = () => finish({ action: "cancel" });
        dialog.addEventListener("close", cancelled, { once: true });
        $("projectHoursExistsClose").onclick = cancelled;
        $("projectHoursExistsCreate").onclick = () => finish({ action: "new", approval });
        $("projectHoursExistsEdit").onclick = () => finish({ action: "edit", id: list.querySelector("input:checked")?.value });
        dialog.showModal();
        (entries.length ? $("projectHoursExistsEdit") : $("projectHoursExistsClose")).focus({ preventScroll: true });
      });
    }

async function openExistingProjectHours(id, generation) {
      // Fetch the current entry before dismissing any unsaved new form. Normal
      // editor locks/settlement restrictions still apply to the existing entry.
      let todo;
      try {
        todo = (await api(`/api/todos/${encodeURIComponent(id)}`)).todo;
      } catch (error) {
        if (!isNetworkError(error)) throw error;
        todo = state.todos.find(item => item.id === id);
        if (!todo) throw error;
      }
      if (!$("todoDialog").open || generation !== taskDialogGeneration) return;
      const day = state.todoDialogReturnDayDate;
      const view = state.todoDialogReturnDayView;
      state.todoDialogReturnDayDate = "";
      state.todoDialogReturnDayView = null;
      if (!$("todoFormId").value) {
        state.todoCreationDraftCommitted = true;
        await clearTodoCreationDraft();
      }
      state.todoHoursSourceId = "";
      await releaseTodoEditLockForDialog();
      await closeModalBeforeTransition($("todoDialog"));
      await openTodoDialog(todo);
      state.todoDialogReturnDayDate = day;
      state.todoDialogReturnDayView = view;
    }

async function confirmProjectHoursBeforeSave(todo) {
      const generation = taskDialogGeneration;
      const choice = await chooseExistingProjectHours(todo, generation);
      if (!$("todoDialog").open || generation !== taskDialogGeneration) return false;
      if (choice.action === "edit") await openExistingProjectHours(choice.id, generation);
      if (choice.action !== "new") return false;
      projectHoursApproval = choice.approval;
      return true;
    }

function syncTodoFormFooterActions() {
      const pairs = [
        ["deleteTodoFromDialog", "todoFooterDelete"],
        ["duplicateTodoFromDialog", "todoFooterDuplicate"],
        ["writeHoursFromTodo", "todoFooterWriteHours"],
        ["saveTodoDialog", "todoFooterSave"],
        ["closeTodoDialog", "todoFooterClose"]
      ];
      $("todoFormFooterActions").classList.remove("hidden");
      pairs.forEach(([sourceId, mirrorId]) => {
        const source = $(sourceId);
        const mirror = $(mirrorId);
        mirror.classList.toggle("hidden", source.classList.contains("hidden"));
        mirror.disabled = source.disabled;
      });
    }

function suggestedTimeRange(todo = {}) {
      const date = String(todo.date || dateKey(new Date()));
      const assignee = String(todo.syncUser || todo._hoursAssigneeIds?.[0] || activeWorkerId() || "");
      // A new hours entry continues after the latest existing hours entry for
      // this worker and day.  Calendar tasks must not influence payroll time.
      const latestEndMinutes = state.todos
        .filter((item) => item.date === date
          && item.start
          && item.end
          && moduleValues.timeEntryStatusIds.has(todoStatus(item.status).id)
          && (!assignee || todoAssigneeIds(item).includes(assignee)))
        .map((item) => dayTimelineMinutes(item.end))
        .filter((minutes) => minutes !== null)
        .reduce((latest, minutes) => Math.max(latest, minutes), null);
      const startMinutes = latestEndMinutes ?? dayTimelineMinutes(rememberedTodoStartTime()) ?? dayTimelineMinutes(moduleValues.appConfig.editor.defaultStart);
      return { start: dayTimelineTime(startMinutes), end: dayTimelineTime(Math.min(1440, startMinutes + moduleValues.appConfig.editor.defaultDurationMinutes)) };
    }

function suggestedNoteTimeRange() {
      const now = new Date();
      const startMinutes = Math.floor((now.getHours() * 60 + now.getMinutes()) / 15) * 15;
      return {
        date: dateKey(now),
        start: dayTimelineTime(startMinutes),
        end: dayTimelineTime(Math.min(23 * 60 + 45, startMinutes + 15))
      };
    }

function syncReportTodoDialogNavigation(todoId, navigationIds = null) {
      if (Array.isArray(navigationIds)) state.reportTodoNavigationIds = [...new Set(navigationIds.map((id) => String(id || "")).filter(Boolean))];
      else state.reportTodoNavigationIds = [];
      state.reportTodoNavigationIndex = state.reportTodoNavigationIds.indexOf(String(todoId || ""));
      const active = state.reportTodoNavigationIndex >= 0 && state.reportTodoNavigationIds.length > 1;
      const previous = $("previousReportTodo");
      const next = $("nextReportTodo");
      previous.classList.toggle("hidden", !active);
      next.classList.toggle("hidden", !active);
      previous.disabled = !active || state.reportTodoNavigationIndex === 0;
      next.disabled = !active || state.reportTodoNavigationIndex >= state.reportTodoNavigationIds.length - 1;
    }

async function openTodoDialog(todo = {}, { reportNavigationIds = null } = {}) {
      taskDialogGeneration++;
      projectHoursApproval = "";
      clearFormValidationError($("todoForm"));
      setTodoDialogSaving(false);
      const requestedCreationMode = todoCreationDraftMode(todo);
      const hasIncomingCreationData = Boolean(todo.title || todo.client || todo.notes || todo.material || todo._taskStatus || (todo._draftAssigneeIds || []).length || (todo.photos || []).length || (todo.driveFiles || []).length);
      if (!todo.id && !todo._skipPersistedDraft && !hasIncomingCreationData && requestedCreationMode !== "project-hours") {
        const savedDraft = await loadTodoCreationDraft(requestedCreationMode);
        if (savedDraft) todo = { ...savedDraft, _restoredCreationDraft: true };
      }
      if (!todo.status && todo._standaloneHours) todo = { ...todo, status: "execution" };
      if (!todo.status && todo._materialEntry) todo = { ...todo, status: "material" };
      if (!todo.status && todo._noteEntry) todo = { ...todo, status: "note" };
      if (!todo.status && todo._mealEntry) todo = { ...todo, status: "meal" };
      const editing = Boolean(todo.id);
      state.todoCreationDraftCommitted = editing;
      state.todoCreationDraftRestored = Boolean(todo._restoredCreationDraft);
      state.todoCreationDraftModeAtOpen = todoCreationDraftMode(todo);
      state.todoHistoryLiveTodo = editing && state.user?.role === "boss" ? todo : null;
      state.todoHistoryPreviewIndex = -1;
      state.todoHistoryPreviewActive = false;
      $("todoDialog").classList.remove("is-history-preview");
      $("todoFormNotifyOthers").checked = false;
      state.todoTimePickerTarget = "start";
      state.todoTimePickerMode = "hour";
      state.todoTimePickerOpen = false;
      syncReportTodoDialogNavigation(todo.id, reportNavigationIds);
      const requestedStatus = todoStatus(todo.status || "open").id;
      const requestedTaskStatus = todoStatus(todo._taskStatus || (moduleValues.timeEntryStatusIds.has(requestedStatus) ? "open" : requestedStatus)).id;
      state.todoHoursSourceId = String(todo._hoursSourceId || "");
      state.todoStandaloneHours = Boolean(todo._standaloneHours);
      state.todoMaterialEntry = Boolean(todo._materialEntry || requestedStatus === "material");
      state.todoNoteEntry = Boolean(todo._noteEntry || requestedStatus === "note");
      state.todoDialogClientSettlement = todo.clientSettlement || { confirmed: false };
      $("todoFormDirectClientSettled").checked = false;
      $("todoFormDirectClientSettled").disabled = false;
      $("todoFormDirectClientAmount").value = "";
      $("todoFormDirectClientAmount").disabled = false;
      $("todoFormDirectClientCreditWorker").checked = false;
      $("todoFormDirectClientCreditWorker").disabled = false;
      $("todoFormAssigneeLabel").textContent = (state.todoHoursSourceId || state.todoStandaloneHours || moduleValues.timeEntryStatusIds.has(requestedStatus))
        ? "Vpis ur za delavca"
        : isAdminView() ? "Dodeli delavcem" : "Delo opravil";
      state.todoMealEntry = Boolean(todo._mealEntry);
      state.todoCreationTaskStatus = !editing && !moduleValues.timeEntryStatusIds.has(requestedTaskStatus) && !["material", "note"].includes(requestedStatus) ? requestedTaskStatus : "open";
      state.todoDraftSourceProjectTodoId = String(todo.sourceProjectTodoId || "");
      state.todoDraftSourceProjectTitle = String(todo.sourceProjectTitle || sourceProjectDetailsForTodo(todo).source?.title || "").trim().slice(0, 300);
      const canChooseCreationMode = !editing && !state.todoHoursSourceId;
      const creationTabs = $("todoCreationTabs");
      creationTabs.classList.toggle("hidden", !canChooseCreationMode);
      creationTabs.dataset.date = todo.date || "";
      creationTabs.querySelectorAll("[data-create-mode]").forEach((button) => {
        const active = state.todoMealEntry ? button.dataset.createMode === "meal" : state.todoMaterialEntry ? button.dataset.createMode === "material" : state.todoNoteEntry ? button.dataset.createMode === "note" : state.todoStandaloneHours ? button.dataset.createMode === "hours" : button.dataset.createMode === "task";
        button.classList.toggle("active", active);
        button.setAttribute("aria-selected", String(active));
      });
      const client = findClient(todo.clientId || todo.client);
      const needsTimeSuggestion = !editing && (state.todoHoursSourceId || state.todoStandaloneHours || moduleValues.timeEntryStatusIds.has(requestedStatus)) && !todo.start && !todo.end;
      const suggestedTimes = needsTimeSuggestion ? suggestedTimeRange(todo) : null;
      const noteTimeSuggestion = !editing && state.todoNoteEntry && !todo.start && !todo.end ? suggestedNoteTimeRange() : null;
      $("todoFormId").value = todo.id || "";
      $("todoFormDraftNotice").classList.toggle("hidden", !state.todoCreationDraftRestored);
      $("todoFormStart").value = todo.start || suggestedTimes?.start || noteTimeSuggestion?.start || "";
      $("todoFormEnd").value = todo.end || suggestedTimes?.end || noteTimeSuggestion?.end || "";
      $("todoFormEnd").dataset.autoSuggested = String(!editing && !todo.end && Boolean(suggestedTimes || noteTimeSuggestion));
      state.todoTimeShiftDuration = null;
      $("todoFormDate").value = todo.date || (needsTimeSuggestion ? dateKey(new Date()) : noteTimeSuggestion?.date || "");
      $("todoFormEndDate").value = todo.date ? todoEndDate(todo) : "";
      $("todoFormEndDate").dataset.auto = String(!todo.date || todoEndDate(todo) === todo.date);
      $("todoFormClient").value = client?.search || todo.client || "";
      state.todoDialogClientContactClientId = String(client?.clientId || client?.id || "");
      state.todoDialogClientContactIds = Array.isArray(todo.clientContactIds)
        ? todo.clientContactIds.map((id) => String(id || "")).filter(Boolean)
        : [];
      state.todoDialogClientContactPickerOpen = false;
      $("todoFormClientContactsField").open = false;
      hideTodoClientSuggestions();
      $("todoFormTask").value = todo.title || "";
      renderTodoTaskSuggestions();
      $("todoFormNotes").value = state.todoHoursSourceId ? "" : todo.notes || "";
      $("todoFormMaterial").value = state.todoHoursSourceId ? "" : todo.material || "";
      $("todoFormStatus").value = requestedStatus;
      renderTodoStatusChoices(todo.status || "open");
      $("todoFormUrgent").checked = Boolean(todo.urgent);
      $("todoFormOrdered").checked = moduleValues.todoOrderStatusIds.has(todoStatus(todo.status || "open").id) && Boolean(todo.ordered);
      $("todoFormWarranty").checked = Boolean(todo.warranty);
      $("todoFormWorkFromHome").checked = Boolean(todo.workFromHome);
      $("todoFormImported").checked = Boolean(todo.imported);
      $("todoFormCalendarOnly").checked = Boolean(!moduleValues.timeEntryStatusIds.has(todoStatus(todo.status || "open").id) && todo.calendarOnly && todo.date);
      // Keep both optional sections compact when the form opens. Validation
      // opens the relevant one automatically if a required date or time is
      // missing, so a short form never hides the reason it cannot save.
      $("todoFormStatusField").open = false;
      $("todoFormDateTimeSection").open = Boolean(state.todoHoursSourceId || state.todoStandaloneHours || state.todoNoteEntry || moduleValues.timeEntryStatusIds.has(requestedStatus));
      updateTodoFormStatus();
      syncTodoFormClientContacts({ preserve: true });
       autosizeTodoNarrativeFields();
       if (state.todoMealEntry && !editing) applyMealDefaults();
      const draftAssignees = Array.isArray(todo._draftAssigneeIds)
        ? todo._draftAssigneeIds
        : state.todoMaterialEntry || state.todoNoteEntry
          ? [todo.syncUser || activeWorkerId()]
          : todo._adminCreate
            ? []
            : todo._hoursAssigneeIds?.length
        ? todo._hoursAssigneeIds
        : (todo._duplicateAssigneeIds?.length ? todo._duplicateAssigneeIds : [activeWorkerId()]);
      const selectedAssignees = editing ? todoAssigneeIds(todo) : draftAssignees;
      const isTimeEntryForm = Boolean(state.todoHoursSourceId || state.todoStandaloneHours || moduleValues.timeEntryStatusIds.has(requestedStatus));
      const permittedAssigneeIds = isTimeEntryForm ? timeEntryTargetUsers().map((worker) => worker.id) : null;
      renderTodoFormAssignees(selectedAssignees, permittedAssigneeIds, { disabled: state.todoMaterialEntry || state.todoNoteEntry, single: isTimeEntryForm });
      state.todoDialogPhotos = (todo.photos || []).map((photo) => ({ ...photo }));
      state.todoDialogDriveFiles = (todo.driveFiles || []).map((file) => ({ ...file }));
      // Render the attachment list immediately but defer image previews.  On
      // mobile a large event otherwise blocks the first dialog paint while its
      // image decoder and network queue are started.
      renderTodoFormPhotos({ imagePreviews: false });
      renderTodoFormDriveFiles();
      const rateWorkerId = todo.syncUser || selectedAssignees[0] || activeWorkerId();
      const requestedHourlyRate = Number(todo.billingHourlyRate);
      const hourlyRateInput = $("todoFormHourlyRate");
      hourlyRateInput.value = editing
        ? todoHourlyRate(todo)
        : (Number.isFinite(requestedHourlyRate) ? requestedHourlyRate : workerDefaultHourlyRate(rateWorkerId));
      hourlyRateInput.dataset.autoRate = String(!editing && !Number.isFinite(requestedHourlyRate));
      $("todoFormBillingKm").value = Number(todo.billingKm || 0);
      $("todoFormClientKm").value = Number(todo.clientKm || 0);
      const clientBillableHoursInput = $("todoFormClientBillableHours");
      const manualClientMinutes = manualClientBillableMinutes(todo.clientBillableMinutes);
      const hasManualClientBillableMinutes = editing && isAdminView() && manualClientMinutes !== null;
      clientBillableHoursInput.dataset.manual = String(hasManualClientBillableMinutes);
      if (hasManualClientBillableMinutes) clientBillableHoursInput.value = formatClientBillableHours(manualClientMinutes);
      syncTodoFormClientBillableHours();
      $("todoFormClientVehicle").value = editing ? (todo.clientVehicle === "van" ? "van" : "personal") : (todo.clientVehicle === "van" ? "van" : preferredClientVehicle());
      syncTodoDialogEditActions(todo, editing);
      setTodoFormClientBillingLock(todo);
      applyTodoChangeNoticeToForm(todo);
      renderTodoFormAudit(todo);
      renderTodoFormSourceProject(todo);
      $("todoFormAttachmentInput").value = "";
      $("todoFormCameraInput").value = "";
      $("todoFormVideoInput").value = "";
      $("todoFormAttachmentMenu").open = false;
      setTodoVideoUploadStatus("");
      $("todoFormDriveLink").value = "";
      $("todoFormDriveLinkPanel").classList.add("hidden");
      // The content now scrolls independently of the dialog/header. Do not
      // carry the previous entry's scroll position into a newly opened form.
      $("todoDialog").showModal();
      // Focus the shell immediately, before the user can tap a field. A late
      // animation-frame focus would steal their input and close suggestions.
      $("todoDialog").focus({ preventScroll: true });
      $("todoDialogScroll").scrollTop = 0;
      if (editing) {
        // The edit lock protects writes, not reading the form.  Showing the
        // read-only shell first avoids a multi-second blank wait after reload.
        setTodoDialogOpening(true);
        scheduleTodoFormPhotoPreviews();
        let todoEditorOpenResult = "error";
        try {
          if (!(await acquireTodoEditLockForDialog(todo.id))) {
            todoEditorOpenResult = "rejected";
            setTodoDialogOpening(false);
            $("todoDialog").close();
            return false;
          }
          if (!$("todoDialog").open) {
            // The user may close the shell while a slow first lock request is
            // pending. Release the late lock instead of leaving it behind.
            todoEditorOpenResult = "closed";
            await releaseTodoEditLockForDialog();
            setTodoDialogOpening(false);
            return false;
          }
          todoEditorOpenResult = "ready";
          if (state.todoHandoverFreshTodo) {
            const latest = state.todoHandoverFreshTodo;
            state.todoHandoverFreshTodo = null;
            return await openTodoDialog(latest, { reportNavigationIds });
          }
          setTodoDialogOpening(false);
        } catch (error) {
          todoEditorOpenResult = "error";
          throw error;
        } finally {
          if (todoEditorOpenResult !== "ready" && $("todoDialog").open) setTodoDialogOpening(false);

        }
      } else {
        scheduleTodoFormPhotoPreviews();
      }
      autosizeTodoNarrativeFieldsAfterLayout();
      // Opening a marked task means it has been read. Do this in the
      // background so the editor is never held up; a failed request simply
      // leaves the marker in place for the next refresh.
      if (editing && todoChangeNoticeCanBeAcknowledged(todo)) {
        void clearTodoChangeNoticeAfterOpen(todo).catch((error) => console.warn("Oznake spremembe ni bilo mogoče označiti kot prebrano:", error));
      }
      if (state.todoCreationDraftRestored) showNotice("Nedokončan osnutek je obnovljen.");
      return true;
    }

async function navigateReportTodo(offset) {
      const currentIndex = state.reportTodoNavigationIndex;
      const targetId = state.reportTodoNavigationIds[currentIndex + offset];
      const target = state.todos.find((todo) => todo.id === targetId);
      if (!target) return;
      await releaseTodoEditLockForDialog();
      if ($("todoDialog").open) $("todoDialog").close();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await openTodoDialog(target, { reportNavigationIds: state.reportTodoNavigationIds });
    }

function setTodoDialogOpening(opening) {
      const form = $("todoForm");
      const status = $("todoFormOpeningStatus");
      if (opening) status.textContent = "Odpiram opravilo …";
      form.classList.toggle("is-opening", Boolean(opening));
      status.classList.toggle("hidden", !opening);
      for (const control of form.querySelectorAll("input, textarea, select, button")) {
        const canClose = control.id === "closeTodoDialog" || control.id === "todoFooterClose";
        if (opening && !canClose && !control.disabled) {
          control.dataset.todoDialogOpeningWasEnabled = "true";
          control.disabled = true;
        } else if (!opening && control.dataset.todoDialogOpeningWasEnabled === "true") {
          control.disabled = false;
          delete control.dataset.todoDialogOpeningWasEnabled;
        }
      }
    }

function setTodoDialogSaving(saving) {
      const form = $("todoForm");
      const save = $("saveTodoDialog");
      const saveWithoutClosing = $("saveTodoWithoutClosing");
      const status = $("todoFormActionStatus");
      form.classList.toggle("is-saving", Boolean(saving));
      form.setAttribute("aria-busy", String(Boolean(saving)));
      form.querySelectorAll("input, textarea, select, button").forEach((control) => {
        if (saving) {
          if (!control.disabled) {
            control.dataset.todoDialogWasEnabled = "true";
            control.disabled = true;
          }
        } else if (control.dataset.todoDialogWasEnabled === "true") {
          control.disabled = false;
          delete control.dataset.todoDialogWasEnabled;
        }
      });
      save.classList.toggle("is-saving", Boolean(saving));
      save.setAttribute("aria-busy", String(Boolean(saving)));
      save.title = saving ? "Shranjujem opravilo" : "Shrani in zapri";
      save.setAttribute("aria-label", saving ? "Shranjujem opravilo" : "Shrani in zapri");
      saveWithoutClosing.classList.toggle("is-saving", Boolean(saving));
      saveWithoutClosing.setAttribute("aria-busy", String(Boolean(saving)));
      saveWithoutClosing.title = saving ? "Shranjujem opravilo" : "Shrani brez zapiranja";
      saveWithoutClosing.setAttribute("aria-label", saving ? "Shranjujem opravilo" : "Shrani brez zapiranja");
      status.textContent = saving ? "Shranjujem opravilo." : "";
      syncTodoFormFooterActions();
    }

async function openHoursTodoFromCurrent() {
      if (projectHoursOpening) return;
      const sourceId = $("todoFormId").value;
      const source = state.todos.find((todo) => todo.id === sourceId);
      if (!source) return;
      if (!moduleValues.projectHoursSourceStatuses.has(source.status)) throw new Error("Ta vrsta zapisa ni opravilo, na katero lahko vpišeš nove ure.");
      projectHoursOpening = true;
      try {
        const generation = taskDialogGeneration;
        const workerId = activeWorkerId() || source.syncUser || state.user?.id || "";
        const choice = await chooseExistingProjectHours({ sourceProjectTodoId: sourceId, syncUser: workerId, date: source.date }, generation);
        if (!$("todoDialog").open || generation !== taskDialogGeneration) return;
        if (choice.action === "edit") return await openExistingProjectHours(choice.id, generation);
        if (choice.action !== "new") return;
        state.todoHoursSourceOriginal = {
          status: source.status,
          done: Boolean(source.done)
        };
        await releaseTodoEditLockForDialog();
        const returnDay = state.todoDialogReturnDayDate;
        const returnView = state.todoDialogReturnDayView;
        state.todoDialogReturnDayDate = "";
        state.todoDialogReturnDayView = null;
        await closeModalBeforeTransition($("todoDialog"));
        await openTodoDialog({
          _hoursSourceId: source.id,
          client: source.client,
          clientId: source.clientId,
          title: source.title,
          date: source.date,
          start: "",
          end: "",
          status: "execution",
          urgent: false,
          warranty: Boolean(source.warranty),
          syncUser: workerId,
          _hoursAssigneeIds: [workerId],
          sourceProjectTitle: source.title || "",
          photos: (source.photos || []).map((photo) => ({ ...photo })),
          driveFiles: (source.driveFiles || []).map((file) => ({ ...file })),
          billingHourlyRate: source.billingHourlyRate ?? null,
          billingKm: 0,
          clientKm: 0,
          clientVehicle: "personal"
        });
        state.todoDialogReturnDayDate = returnDay;
        state.todoDialogReturnDayView = returnView;
        projectHoursApproval = choice.approval;
      } finally {
        projectHoursOpening = false;
      }
    }

async function openStandaloneHoursDialog(date = dateKey(new Date()), { adminCreate = false, draft = {} } = {}) {
      await openTodoDialog({
        ...draft,
        _standaloneHours: true,
        _adminCreate: adminCreate,
        date: draft.date || date || dateKey(new Date()),
        status: "execution",
        urgent: false,
        photos: draft.photos || []
      });
    }

async function openMealTodoDialog(date = dateKey(new Date())) {
      await openTodoDialog({
        _mealEntry: true,
        date,
        status: "meal",
        urgent: false,
        photos: [],
        driveFiles: []
      });
    }

async function openMaterialEntryDialog(date = dateKey(new Date()), { draft = {} } = {}) {
      await openTodoDialog({
        ...draft,
        _materialEntry: true,
        _adminCreate: false,
        date: draft.date || date || dateKey(new Date()),
        endDate: draft.date || date || dateKey(new Date()),
        start: "",
        end: "",
        status: "material",
        title: draft.title || "Dobava materiala",
        urgent: false,
        warranty: false,
        billingHourlyRate: null,
        billingKm: 0,
        clientKm: 0,
        clientVehicle: "personal",
        materialAmount: draft.materialAmount ?? 0,
        externalDelivery: draft.externalDelivery ?? true
      });
    }

function syncTodoDialogEditActions(todo, editing = Boolean(todo?.id)) {
      $("deleteTodoFromDialog").classList.toggle("hidden", !editing);
      $("duplicateTodoFromDialog").classList.toggle("hidden", !editing || Boolean(state.todoHoursSourceId));
      $("writeHoursFromTodo").classList.toggle("hidden", !editing || Boolean(state.todoHoursSourceId) || !moduleValues.projectHoursSourceStatuses.has(todo.status));
      $("todoFormChangeActions").classList.toggle("hidden", !editing || !todoCanMarkChangedForOthers(todo));
      $("shareTodoPdf").classList.toggle("hidden", !editing);
      const isExistingTimeEntry = editing && moduleValues.timeEntryStatusIds.has(todoStatus(todo.status).id);
      const showCompletionRequest = editing && state.user?.role === "boss";
      $("requestTodoCompletion").textContent = isExistingTimeEntry ? "Zahtevaj dopolnitev vnosa ur" : "Zahtevaj dopolnitev";
      $("requestTodoCompletion").setAttribute("aria-label", isExistingTimeEntry ? "Zahtevaj dopolnitev vnosa ur" : "Zahtevaj dopolnitev opravila");
      $("requestTodoCompletion").classList.toggle("hidden", !showCompletionRequest);
      syncTodoFormFooterActions();
    }

function setTodoFormClientBillingLock(todo = {}) {
      const form = $("todoForm");
      const notice = $("todoFormClientBillingLock");
      const settlement = todo?.clientSettlement || state.todoDialogClientSettlement || {};
      const locked = Boolean(todo?.id && settlement.confirmed);
      form.classList.toggle("is-client-billing-locked", locked);
      notice.classList.toggle("hidden", !locked);
      notice.textContent = locked
        ? `Dogodek je že poračunan s stranko ${todo.client || ""}. Zaklenjen je za spremembe. Za dodatno delo ali popravek uporabi »Podvoji opravilo« in ustvari nov dogodek.`
        : "";
      const readableControls = new Set([
        "closeTodoDialog", "todoFooterClose", "duplicateTodoFromDialog", "todoFooterDuplicate",
        "shareTodoPdf", "previousReportTodo", "nextReportTodo"
      ]);
      form.querySelectorAll("input, textarea, select, button").forEach((control) => {
        const canRead = readableControls.has(control.id)
          || control.classList.contains("todo-form-attachment-preview")
          || control.classList.contains("share-todo-form-photo");
        if (locked && !canRead && !control.disabled) {
          control.disabled = true;
          control.dataset.clientBillingLockDisabled = "true";
        } else if (!locked && control.dataset.clientBillingLockDisabled === "true") {
          control.disabled = false;
          delete control.dataset.clientBillingLockDisabled;
        }
      });
      if (locked) $("todoFormAttachmentMenu").open = false;
      syncTodoFormFooterActions();
    }

async function openNoteEntryDialog({ draft = {} } = {}) {
      const suggestion = suggestedNoteTimeRange();
      await openTodoDialog({
        ...draft,
        _noteEntry: true,
        _adminCreate: false,
        date: draft.date || suggestion.date,
        endDate: draft.endDate || draft.date || suggestion.date,
        start: draft.start || suggestion.start,
        end: draft.end || suggestion.end,
        status: "note",
        urgent: false,
        warranty: false,
        billingHourlyRate: null,
        billingKm: 0,
        clientKm: 0,
        clientVehicle: "personal"
      });
    }

async function duplicateTodoFromCurrent() {
      const sourceId = $("todoFormId").value;
      const source = state.todos.find((todo) => todo.id === sourceId);
      if (!source) return;
      const duplicate = {
        _duplicateAssigneeIds: todoAssigneeIds(source),
        client: source.client,
        clientId: source.clientId,
        title: source.title,
        notes: source.notes,
        material: source.material,
        date: source.date,
        start: source.start,
        end: source.end,
        status: source.status,
        urgent: source.status === "execution" ? false : Boolean(source.urgent),
        warranty: Boolean(source.warranty),
        // Klon vnosa ur nima izvora: povezava s starim projektom bi lahko bila že zaprta.
        sourceProjectTodoId: "",
        sourceProjectTitle: "",
        _standaloneHours: moduleValues.timeEntryStatusIds.has(source.status),
        billingHourlyRate: source.billingHourlyRate ?? null,
        billingKm: 0,
        clientKm: 0,
        clientVehicle: "personal",
        photos: (source.photos || []).map((photo) => ({ ...photo, id: "" })),
        driveFiles: (source.driveFiles || []).map((file) => ({ ...file, id: "" }))
      };
      await releaseTodoEditLockForDialog();
      $("todoDialog").close();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await openTodoDialog(duplicate);
    }

function openProjectCompletionDialog(sourceId) {
      const source = state.todos.find((todo) => todo.id === sourceId);
      state.todoHoursCompletionSourceId = sourceId || "";
      $("projectCompletionTask").textContent = source?.title || "Brez imena opravila";
      $("projectCompletionClient").textContent = source?.client || "Brez stranke";
      $("rescheduleProject").textContent = source?.date
        ? "Ne, prestavi opravilo na drug dan"
        : "Obdrži opravilo";
      $("projectCompletionDialog").showModal();
    }

async function handleHoursProjectCompletion(deleteProject) {
      const sourceId = state.todoHoursCompletionSourceId;
      const sourceOriginal = state.todoHoursSourceOriginal;
      state.todoHoursCompletionSourceId = "";
      state.todoHoursSourceOriginal = null;
      $("projectCompletionDialog").close();
      const source = state.todos.find((todo) => todo.id === sourceId);
      if (!source) return;
      if (!deleteProject) {
        const originalStatus = sourceOriginal?.status || (source.status === "execution" ? "open" : source.status);
        await openTodoDialog({ ...source, status: originalStatus, done: false });
        return;
      }
      if (!(await acquireTodoEditLockForDialog(sourceId))) return;
      try {
        await deleteTodoFromServer(sourceId);
        clearTodoEditLockState();
      } catch (error) {
        await releaseTodoEditLockForDialog();
        throw error;
      }
    }

async function deleteTodoFromDialog() {
      const id = $("todoFormId").value;
      if (!id || !await showAppConfirm("Premaknem opravilo v Izbrisano? Obnovitev je možna 30 dni.")) return;
      const returnDayDate = state.todoDialogReturnDayDate;
      const returnDayView = state.todoDialogReturnDayView;
      state.todoDialogReturnDayDate = "";
      state.todoDialogReturnDayView = null;
      await deleteTodoFromServer(id);
      $("todoDialog").close();
      if (returnDayDate) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        openDayTimeline(returnDayDate, { viewSnapshot: returnDayView });
      }
    }

function installTaskCreationBindings1() {
    $("newTodoButton").addEventListener("click", () => startTodoForDate());
    $("writeHoursButton").addEventListener("click", () => openStandaloneHoursDialog().catch((error) => showNotice(error.message)));
    $("materialEntryButton").addEventListener("click", () => openMaterialEntryDialog().catch((error) => showNotice(error.message)));
    document.addEventListener("keydown", (event) => {
      if ((event.key !== "Enter") || (!event.ctrlKey && !event.metaKey) || event.isComposing) return;
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.matches("input, textarea, select")) return;
      const form = target.closest("form");
      const submit = form?.querySelector('button[type="submit"]:not([disabled])');
      if (!submit) return;
      event.preventDefault();
      if (typeof form.requestSubmit === "function") form.requestSubmit(submit);
      else submit.click();
    });
    $("todoCreationTabs").addEventListener("click", async (event) => {
      const tab = event.target.closest("[data-create-mode]");
      if (!tab) return;
      const draft = todoCreationDraftFromForm();
      const date = draft.date || $("todoCreationTabs").dataset.date || dateKey(new Date());
      const mode = tab.dataset.createMode;
      const wantsHours = mode === "hours";
      const wantsMaterial = mode === "material";
      const wantsNote = mode === "note";
      if ((wantsHours && state.todoStandaloneHours) || (wantsMaterial && state.todoMaterialEntry) || (wantsNote && state.todoNoteEntry) || (!wantsHours && !wantsMaterial && !wantsNote && !state.todoStandaloneHours && !state.todoMaterialEntry && !state.todoNoteEntry)) return;
      const quickTransition = Boolean(state.quickCreateMode);
      if (quickTransition) state.quickCreateTransitioning = true;
      $("todoDialog").close();
      // A dialog remains in its closing phase until the next task. Opening a
      // second modal immediately could leave the day view's top half blank on
      // Android. Let the browser finish that transition first.
      await new Promise((resolve) => setTimeout(resolve, 0));
      try {
        await (wantsHours
          ? openStandaloneHoursDialog(date, { adminCreate: isAdminView(), draft })
          : wantsMaterial
            ? openMaterialEntryDialog(date, { draft })
            : wantsNote
              ? openNoteEntryDialog({ draft })
            : openTodoDialog({ ...draft, date, status: draft._taskStatus || "open", _adminCreate: isAdminView() })
        );
        if (!quickTransition) return;
        const nextMode = wantsHours ? "hours" : wantsMaterial ? "material" : wantsNote ? "note" : "task";
        state.quickCreateMode = nextMode;
        const current = new URL(location.href);
        current.searchParams.set("quick", nextMode);
        history.replaceState(history.state, "", current.pathname + current.search + current.hash);
      } catch (error) {
        showNotice(error.message);
      } finally {
        state.quickCreateTransitioning = false;
      }
    });
}

function installTaskDialogBindings1() {
    moduleValues.modalActionMirrors.forEach(([mirrorId, sourceId]) => {
      $(mirrorId).addEventListener("click", () => {
        const source = $(sourceId);
        if (!source.disabled && !source.classList.contains("hidden")) source.click();
      });
    });
    $("closeTodoDialog").addEventListener("click", () => {
      // X is an explicit discard action for a new, unsaved form.  It must not
      // leave a local draft behind that would unexpectedly reappear later.
      if (isNewTodoCreationDialog()) {
        state.todoCreationDraftCommitted = true;
        clearTodoCreationDraft().catch(() => {});
      }
      $("todoDialog").close();
    });
    $("discardTodoCreationDraft").addEventListener("click", async () => {
      if (!await showAppConfirm("Zavržem nedokončan osnutek in odprem prazen obrazec?", {
        title: "Zavrzi osnutek",
        confirmLabel: "Zavrzi",
        danger: true
      })) return;
      const mode = todoCreationDraftMode({
        _standaloneHours: state.todoStandaloneHours,
        _materialEntry: state.todoMaterialEntry,
        _noteEntry: state.todoNoteEntry,
        _mealEntry: state.todoMealEntry
      });
      state.todoCreationDraftCommitted = true;
      await clearTodoCreationDraft();
      $("todoDialog").close();
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (mode === "hours") await openStandaloneHoursDialog();
      else if (mode === "material") await openMaterialEntryDialog();
      else if (mode === "note") await openNoteEntryDialog();
      else await openTodoDialog({ _skipPersistedDraft: true, _adminCreate: isAdminView() });
    });
}

function installProjectCompletionBindings1() {
    $("deleteCompletedProject").addEventListener("click", () => handleHoursProjectCompletion(true).catch((error) => showNotice(error.message)));
    $("rescheduleProject").addEventListener("click", () => handleHoursProjectCompletion(false).catch((error) => showNotice(error.message)));
}

function installTaskCloseBindings1() {
    $("todoDialog").addEventListener("close", finishQuickCreateLink);
    $("todoDialog").addEventListener("close", () => {
      if (!state.todoDialogBackgroundSave) releaseTodoEditLockForDialog();
    });
    $("todoDialog").addEventListener("close", () => { if ($("completionRequestDialog").open) $("completionRequestDialog").close(); });
    $("todoDialog").addEventListener("close", () => {
      const returnDayDate = state.todoDialogReturnDayDate;
      const returnDayView = state.todoDialogReturnDayView;
      state.todoDialogReturnDayDate = "";
      state.todoDialogReturnDayView = null;
      // A normal edit/cancel from daily view returns to the same day. Hour-entry
      // flows have their own completion path immediately below.
      if (!returnDayDate || state.todoHoursSourceId || state.todoHoursFixingTime) return;
      setTimeout(() => {
        if (!$("todoDialog").open && !$("dayTimelineDialog").open) openDayTimeline(returnDayDate, { viewSnapshot: returnDayView });
      }, 0);
    });
    $("todoDialog").addEventListener("close", () => {
      const sourceId = state.todoHoursSourceId;
      state.todoHoursSourceId = "";
      if (state.todoHoursFixingTime) {
        state.todoHoursFixingTime = false;
        return;
      }
      if (!sourceId) return;
      if (state.todoHoursSavedSourceId === sourceId) {
        state.todoHoursSavedSourceId = "";
        state.todoHoursCompletionSourceId = sourceId;
        openProjectCompletionDialog(sourceId);
        return;
      }
      setTimeout(() => {
        const source = state.todos.find((todo) => todo.id === sourceId);
        if (source && !$("todoDialog").open) {
          openTodoDialog(source).catch((error) => showNotice(error.message));
        }
      }, 0);
    });
    $("todoDialog").addEventListener("close", hideTodoClientSuggestions);
    $("todoDialog").addEventListener("close", () => {
      const keepAsDraft = isNewTodoCreationDialog();
      if (keepAsDraft) persistTodoCreationDraft().catch(() => {});
      else discardTemporaryTodoAttachments();
      state.todoDialogPhotos = [];
      state.todoDialogDriveFiles = [];
      state.todoCreationDraftRestored = false;
    });
}

  return {
    confirmProjectHoursBeforeSave,
    suggestedNoteTimeRange,
    openTodoDialog,
    navigateReportTodo,
    setTodoDialogOpening,
    setTodoDialogSaving,
    openHoursTodoFromCurrent,
    openStandaloneHoursDialog,
    openMaterialEntryDialog,
    syncTodoDialogEditActions,
    setTodoFormClientBillingLock,
    duplicateTodoFromCurrent,
    openProjectCompletionDialog,
    deleteTodoFromDialog,
    installTaskCreationBindings1,
    installTaskDialogBindings1,
    installProjectCompletionBindings1,
    installTaskCloseBindings1
  };
}
