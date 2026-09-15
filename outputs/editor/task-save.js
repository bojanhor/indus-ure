// editor/task-save: explicit dependencies; factory creation has no I/O or UI effects.
function createTaskSave({
  $,
  state,
  acquireTodoEditLockForDialog,
  activeWorkerId,
  announceQueuedLateTimeEntryReport,
  api,
  applyTodoChangeNoticeToForm,
  beginTodoMutation,
  capitalizeTodoText,
  clearTodoCreationDraft,
  clearTodoEditLockState,
  closeToolsMenu,
  createLocalUuid,
  deleteTodoFromDialog,
  duplicateTodoFromCurrent,
  duration,
  escapeHtml,
  findTodoClient,
  finishTodoMutation,
  firstFreeDayTimelineSlot,
  formatClientBillableHours,
  invalidTodoForm,
  isAdminView,
  isCurrentTodoRevision,
  isImportedTodo,
  isNetworkError,
  isNewTodoCreationDialog,
  manualClientBillableMinutes,
  markTodoDialogAttachmentsSaved,
  navigateTodoHistory,
  nextTodoOrder,
  normalizeClientName,
  normalizeTodoFormTimes,
  offlineTodoOps,
  openDayTimeline,
  openHoursTodoFromCurrent,
  openTodoDialog,
  parseBillingNumber,
  pauseTodoLockHeartbeat,
  queueOfflineTodo,
  refreshClientList,
  releaseTodoEditLockForDialog,
  rememberClientVehicle,
  removeOfflineTodoOp,
  render,
  renderDeletedTodos,
  renderTodoFormAudit,
  renderTodoFormSourceProject,
  resumeTodoLockHeartbeat,
  scheduleTodoCreationDraftSave,
  selectedTodoFormAssignees,
  setTodoDialogSaving,
  setTodoFormClientBillingLock,
  shareTodoPdf,
  showAppConfirm,
  showFormValidationError,
  showNotice,
  syncTodoDialogEditActions,
  syncTodoFormEndDate,
  todoAssigneeIds,
  todoCreationDraftFromForm,
  todoCreationDraftHasContent,
  todoFormClientBillableMinutes,
  uniqueTodosByEventId,
  updateOfflineSyncNotice,
  updateTodoFormStatus,
  validateTodo,
  validateTodoHoursClient,
  validationMessageForField,
  moduleValues
}) {
function announceClientBillableHoursWarning(warning) {
      if (!warning) return;
      showNotice(`Ure delavca so se spremenile iz ${formatClientBillableHours(Math.round(Number(warning.beforeWorkerHours || 0) * 60))} h na ${formatClientBillableHours(Math.round(Number(warning.afterWorkerHours || 0) * 60))} h. Ure za obra\u010dun stranki ostanejo ${formatClientBillableHours(Math.round(Number(warning.clientBillableHours || 0) * 60))} h.`);
    }

async function saveTodoToServer(todo) {
      const todoRevision = beginTodoMutation();
      const creating = !todo.id || String(todo.id).startsWith("offline-");
      const clientMutationId = creating ? String(todo.clientMutationId || createLocalUuid()) : "";
      const requestTodo = { ...(creating ? { ...todo, clientMutationId } : todo), editorWorkContext: state.workContext || "" };
      const editLockToken = !creating && requestTodo.id && state.todoEditLock?.todoId === requestTodo.id
        ? state.todoEditLock.token
        : "";
      if (editLockToken) await pauseTodoLockHeartbeat();
      const method = creating ? "POST" : "PUT";
      const path = creating ? "/api/todos" : `/api/todos/${requestTodo.id}`;
      const payload = editLockToken ? { ...requestTodo, editLockToken } : requestTodo;
      try {
        const data = await api(path, { method, body: JSON.stringify({ ...payload, baseUpdatedAt: requestTodo.updatedAt || "" }) });
        if (isCurrentTodoRevision(todoRevision)) {
          state.todos = data.todos;
          if (Array.isArray(data.debts)) state.debts = data.debts;
          refreshClientList();
          render();
        }
        announceQueuedLateTimeEntryReport(data);
        announceClientBillableHoursWarning(data.clientBillableHoursWarning);
        return data;
      } catch (error) {
        if (!isNetworkError(error)) {
          resumeTodoLockHeartbeat(requestTodo.id, editLockToken);
          throw error;
        }
        const localTodo = creating ? { ...requestTodo, id: requestTodo.id || "offline-" + createLocalUuid(), offlinePending: true } : { ...requestTodo, offlinePending: true };
        await queueOfflineTodo({ kind: creating ? "create" : "update", todoId: localTodo.id, todo: { ...requestTodo }, baseUpdatedAt: requestTodo.updatedAt || "" });
        if (isCurrentTodoRevision(todoRevision)) {
          const index = state.todos.findIndex((item) => item.id === requestTodo.id);
          if (index >= 0) state.todos[index] = localTodo;
          else state.todos.unshift(localTodo);
          refreshClientList();
          render();
        }
        return { todos: state.todos, queued: true };
      } finally {
        finishTodoMutation();
      }
    }

async function saveTodoTimeToServer(todo, start, end, date = todo.date) {
      const editLockToken = state.todoEditLock?.todoId === todo.id ? state.todoEditLock.token : "";
      if (!editLockToken) throw new Error("Opravila pred premikom ni bilo mogoče zakleniti.");
      const todoRevision = beginTodoMutation();
      try {
        await pauseTodoLockHeartbeat();
        const data = await api(`/api/todos/${encodeURIComponent(todo.id)}/time`, {
          method: "POST",
          body: JSON.stringify({ start, end, date, editLockToken, editorWorkContext: state.workContext || "" })
        });
        if (isCurrentTodoRevision(todoRevision)) {
          state.todos = data.todos;
          refreshClientList();
        }
        announceQueuedLateTimeEntryReport(data);
        announceClientBillableHoursWarning(data.clientBillableHoursWarning);
        return data;
      } catch (error) {
        if (!isNetworkError(error)) {
          resumeTodoLockHeartbeat(todo.id, editLockToken);
          throw error;
        }
        const localTodo = { ...todo, start, end, date, hoursNeedsReview: false, offlinePending: true };
        await queueOfflineTodo({ kind: "update", todoId: localTodo.id, todo: localTodo, baseUpdatedAt: todo.updatedAt || "" });
        if (isCurrentTodoRevision(todoRevision)) {
          const index = state.todos.findIndex((item) => item.id === todo.id);
          if (index >= 0) state.todos[index] = localTodo;
          refreshClientList();
        }
        return { todos: state.todos, queued: true };
      } finally {
        finishTodoMutation();
      }
    }

async function deleteTodoFromServer(id) {
      const todoRevision = beginTodoMutation();
      const editLockToken = state.todoEditLock?.todoId === id
        ? state.todoEditLock.token
        : "";
      if (editLockToken) await pauseTodoLockHeartbeat();
      const previousTodos = state.todos.slice();
      const deletedEventId = String(previousTodos.find((todo) => todo.id === id)?.assignmentGroupId || id);
      state.todos = state.todos.filter((todo) => String(todo.assignmentGroupId || todo.id) !== deletedEventId);
      refreshClientList();
      render();
      try {
        const data = await api(`/api/todos/${id}`, {
          method: "DELETE",
          body: JSON.stringify({ editLockToken, baseUpdatedAt: previousTodos.find((todo) => todo.id === id)?.updatedAt || "" })
        });
        if (isCurrentTodoRevision(todoRevision)) {
          state.todos = data.todos;
          state.deletedTodos = data.deletedTodos || state.deletedTodos;
          if ($("deletedTodosDialog")?.open) renderDeletedTodos();
          refreshClientList();
          render();
        }
        } catch (error) {
        if (isNetworkError(error)) {
          const deleted = previousTodos.find((todo) => todo.id === id);
          if (deleted?.id?.startsWith("offline-")) {
            const op = (await offlineTodoOps()).find((item) => item.todoId === id && item.userId === state.user.id);
            if (op) await removeOfflineTodoOp(op.id);
          } else {
            await queueOfflineTodo({ kind: "delete", todoId: id, baseUpdatedAt: deleted?.updatedAt || "" });
          }
          await updateOfflineSyncNotice();
          return { todos: state.todos, queued: true };
        }
        if (isCurrentTodoRevision(todoRevision)) {
          state.todos = previousTodos;
          refreshClientList();
          render();
        }
        resumeTodoLockHeartbeat(id, editLockToken);
        throw error;
      } finally {
        finishTodoMutation();
      }
    }

function savedTodoFromDialogResponse(data, todo) {
      const candidates = Array.isArray(data?.todos) ? data.todos : state.todos;
      if (todo.id) return candidates.find((item) => item.id === todo.id) || null;
      return candidates
        .filter((item) => item.title === todo.title
          && item.client === todo.client
          && item.status === todo.status
          && item.date === todo.date
          && item.start === todo.start
          && item.end === todo.end
          && todoAssigneeIds(item).includes(todo.syncUser))
        .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))[0] || null;
    }

async function keepTodoDialogOpenAfterSave(data, todo, wasCreating) {
      const saved = savedTodoFromDialogResponse(data, todo);
      if (!saved) {
        showNotice("Opravilo je shranjeno. Za nadaljnje urejanje ga ponovno odpri.");
        return;
      }
      $("todoFormId").value = saved.id;
      state.todoCreationDraftCommitted = true;
      state.todoCreationDraftRestored = false;
      $("todoCreationTabs").classList.add("hidden");
      state.todoHistoryLiveTodo = state.user?.role === "boss" ? saved : null;
      state.todoHistoryPreviewIndex = -1;
      state.todoHistoryPreviewActive = false;
      $("todoDialog").classList.remove("is-history-preview");
      updateTodoFormStatus();
      syncTodoDialogEditActions(saved, true);
      setTodoFormClientBillingLock(saved);
      applyTodoChangeNoticeToForm(saved);
      renderTodoFormAudit(saved);
      renderTodoFormSourceProject(saved);
      if (wasCreating && !String(saved.id).startsWith("offline-") && !(await acquireTodoEditLockForDialog(saved.id))) {
        showNotice("Opravilo je shranjeno, vendar ga je pred nadaljnjim urejanjem treba znova odpreti.");
      }
      showNotice("Shranjeno.");
    }

async function saveTodoFromDialog({ closeAfterSave = true, handover = false } = {}) {
      if (state.todoHistoryPreviewActive) {
        showNotice("Gledaš prejšnjo različico. Z desno puščico se vrni na trenutno stanje, nato lahko urejaš.");
        return;
      }
      if (state.todoDialogPhotos.some((photo) => photo.uploading)) {
        return showFormValidationError($("todoForm"), "Počakaj, da se nalaganje videa konča, nato shrani opravilo.", $("todoFormAttachments"));
      }
      normalizeTodoFormTimes();
      syncTodoFormEndDate();
      const id = $("todoFormId").value;
      const existing = id ? state.todos.find((todo) => todo.id === id) : null;
      const client = findTodoClient($("todoFormClient").value);
      const meal = $("todoFormStatus").value === "meal";
      const materialEntry = $("todoFormStatus").value === "material";
      const noteEntry = $("todoFormStatus").value === "note";
      const assigneeIds = selectedTodoFormAssignees();
      if (!meal && !materialEntry && !noteEntry && !assigneeIds.length) {
        return invalidTodoForm("Izberi vsaj enega izvajalca.", $("todoFormAssignees").querySelector("input") || $("todoFormAssigneeLabel"));
      }
      if (meal || materialEntry || noteEntry) assigneeIds.splice(0, assigneeIds.length, existing?.syncUser || activeWorkerId());
      const hourlyRate = parseBillingNumber($("todoFormHourlyRate").value, 10_000);
      const billingKm = parseBillingNumber($("todoFormBillingKm").value, 1_000_000);
      const clientKm = parseBillingNumber($("todoFormClientKm").value, 1_000_000);
      const clientVehicle = $("todoFormClientVehicle").value === "van" ? "van" : "personal";
      const materialAmount = materialEntry ? Number(existing?.materialAmount || 0) : 0;
      const selectedStatus = $("todoFormStatus").value;
      const isHoursEntry = Boolean(state.todoHoursSourceId || state.todoStandaloneHours || moduleValues.timeEntryStatusIds.has(selectedStatus));
      const clientBillableMinutes = selectedStatus === "execution"
        ? (isAdminView() ? todoFormClientBillableMinutes() : (existing?.clientBillableMinutes ?? null))
        : null;
      const title = meal ? "Malica" : capitalizeTodoText($("todoFormTask").value);
      const notes = meal ? "" : capitalizeTodoText($("todoFormNotes").value);
      const material = meal ? "" : capitalizeTodoText($("todoFormMaterial").value);
      $("todoFormTask").value = title;
      $("todoFormNotes").value = notes;
      $("todoFormMaterial").value = material;
      const sourceProjectTodoId = String(existing?.sourceProjectTodoId || state.todoHoursSourceId || state.todoDraftSourceProjectTodoId || "");
      const sourceProjectTitle = sourceProjectTodoId
        ? String(existing?.sourceProjectTitle || state.todoDraftSourceProjectTitle || "").trim().slice(0, 300)
        : "";
      const todo = {
        ...(existing || {}),
        id: id || undefined,
        start: $("todoFormStart").value,
        end: $("todoFormEnd").value,
        date: $("todoFormDate").value,
        endDate: $("todoFormEndDate").value,
        client: meal ? "" : client?.name || normalizeClientName($("todoFormClient").value),
        clientId: meal ? "" : client?.clientId || client?.id || "",
        title,
        notes,
        material,
        status: selectedStatus,
        order: existing?.order || nextTodoOrder(),
        assigneeIds,
        syncUser: existing?.syncUser || assigneeIds[0] || activeWorkerId(),
        urgent: moduleValues.timeEntryStatusIds.has(selectedStatus) || materialEntry || noteEntry ? false : $("todoFormUrgent").checked,
        imported: Boolean(existing?.imported),
        ordered: moduleValues.todoOrderStatusIds.has($("todoFormStatus").value) && $("todoFormOrdered").checked,
        warranty: !meal && !materialEntry && !noteEntry && Boolean($("todoFormWarranty").checked),
        sourceProjectTodoId,
        sourceProjectTitle,
        done: selectedStatus === "execution" || materialEntry || noteEntry,
        billingHourlyRate: materialEntry || noteEntry ? null : hourlyRate,
        clientBillableMinutes,
        billingKm: materialEntry || noteEntry ? 0 : billingKm,
        workFromHome: !materialEntry && !noteEntry && Boolean($("todoFormWorkFromHome").checked),
        clientContactIds: meal ? [] : [...state.todoDialogClientContactIds],
        clientKm: meal || materialEntry || noteEntry ? 0 : clientKm,
        clientVehicle: meal || materialEntry || noteEntry ? "personal" : clientVehicle,
        materialAmount: materialEntry ? materialAmount : 0,
        externalDelivery: materialEntry,
        calendarOnly: Boolean(!moduleValues.timeEntryStatusIds.has(selectedStatus) && !materialEntry && !noteEntry && $("todoFormDate").value && $("todoFormCalendarOnly").checked),
        notifyOthers: Boolean(existing && !isHoursEntry && $("todoFormNotifyOthers").checked),
        driveFiles: state.todoDialogDriveFiles,
        photos: state.todoDialogPhotos
      };
      // Check before confirmations, optimistic closing and the automatic
      // missing-time slot path, which intentionally skips full validation.
      if (!validateTodoHoursClient(todo)) return;
      const previousClientBillableMinutes = manualClientBillableMinutes(existing?.clientBillableMinutes);
      const workerHoursChanged = Boolean(existing)
        && Math.round(duration(existing) * 60) !== Math.round(duration(todo) * 60);
      if (workerHoursChanged && Number.isFinite(previousClientBillableMinutes) && previousClientBillableMinutes >= 0 && clientBillableMinutes !== null) {
        if (handover) return false;
        const accepted = await showAppConfirm(
          `Ure delavca se spremenijo iz ${formatClientBillableHours(Math.round(duration(existing) * 60))} h na ${formatClientBillableHours(Math.round(duration(todo) * 60))} h.\n\nUre za obra\u010dun stranki ostanejo ro\u010dno nastavljene na ${formatClientBillableHours(previousClientBillableMinutes)} h. Nadaljujem?`
        );
        if (!accepted) return;
      }
      const requestDirectClientSettlement = Boolean(existing
        && selectedStatus === "execution"
        && !existing?.clientSettlement?.confirmed
        && $("todoFormDirectClientSettled").checked);
      if (requestDirectClientSettlement) {
        if (handover) return false;
        const rawDirectAmount = String($("todoFormDirectClientAmount").value || "").trim();
        const directAmount = Number(rawDirectAmount.replace(",", "."));
        if (!rawDirectAmount || !Number.isFinite(directAmount) || directAmount < 0) {
          return invalidTodoForm("Za pora\u010dun s stranko vpi\u0161i prejeti znesek.", "todoFormDirectClientAmount");
        }
        const settlementNotice = directAmount === 0
          ? "Prejeti znesek je 0 EUR. Dogodek bo ozna\u010den kot pora\u010dunan s stranko in skrit iz seznama \u00bbZa obra\u010dun\u00ab. Nadaljujem?"
          : "Dogodek bo ozna\u010den kot pora\u010dunan s stranko in skrit iz seznama \u00bbZa obra\u010dun\u00ab. Prika\u017ee se le, \u010de v obra\u010dunu strank vklju\u010di\u0161 \u00bbPrika\u017ei obra\u010dunano\u00ab. Nadaljujem?";
        if (!await showAppConfirm(settlementNotice)) return;
        todo.directClientSettlement = {
          confirmed: true,
          amount: directAmount,
          creditWorker: Boolean($("todoFormDirectClientCreditWorker").checked)
        };
      }
      if (meal) {
        todo.photos = [];
        todo.driveFiles = [];
      }
      if (isHoursEntry && (!todo.start || !todo.end)) {
        if (handover) return false;
        if (!todo.date) {
          return invalidTodoForm("Za vpis delovnih ur izberi datum.", "todoFormDate");
        }
        showNotice("Za vpis ur nastavi uro od in do. Dodan je prvi prost enourni termin, ki ga lahko takoj popraviš v dnevnem pogledu.");
        const slot = firstFreeDayTimelineSlot(todo.date);
        const data = await saveTodoToServer({ ...todo, ...slot, hoursNeedsReview: true });
        markTodoDialogAttachmentsSaved();
        if (todo.status === "execution" && !meal) rememberClientVehicle(clientVehicle);
        const saved = (data.todos || []).filter((item) => {
          const sameSlot = item.date === todo.date && item.start === slot.start && item.end === slot.end && item.title === todo.title;
          return sameSlot && (!state.todoHoursSourceId || item.sourceProjectTodoId === state.todoHoursSourceId);
        }).sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
        state.dayTimelineHoursWarning = {
          todoId: saved?.id || "",
          assignmentGroupId: saved?.assignmentGroupId || "",
          sourceId: state.todoHoursSourceId
        };
        state.todoHoursFixingTime = true;
        if (!id) {
          state.todoCreationDraftCommitted = true;
          await clearTodoCreationDraft();
        }
        $("todoDialog").close();
        await new Promise((resolve) => setTimeout(resolve, 0));
        openDayTimeline(todo.date);
        return;
      }
      if (!validateTodo(todo)) return;
      if (todo.status === "execution" && !meal) {
        const missingClientKm = Number(todo.clientKm || 0) === 0;
        const missingWorkerKm = Number(todo.billingKm || 0) === 0;
        if (!handover && (missingClientKm || missingWorkerKm)) {
          const missing = [
            missingClientKm ? "Kilometrina za stranko je 0 km." : "",
            missingWorkerKm ? "Kilometrina za delavca je 0 km." : ""
          ].filter(Boolean).join("\n");
          if (!await showAppConfirm(`${missing}\n\nNadaljujem brez vpisane kilometrine?`)) return;
        }
      }
      const activeAssignee = activeWorkerId();
      if (handover && existing && !isAdminView()
          && todoAssigneeIds(existing).includes(activeAssignee)
          && !assigneeIds.includes(activeAssignee)) return false;
      if (existing && !isAdminView()
          && todoAssigneeIds(existing).includes(activeAssignee)
          && !assigneeIds.includes(activeAssignee)
          && !await showAppConfirm("Odstranil si sebe iz opravila. Po shranjevanju ga v svojem delavskem pogledu ne boš več videl ali mogel odpreti. Vseeno shranim?")) {
        return;
      }
      // The primary checkmark is deliberately optimistic: validation and all
      // confirmations have already finished, so the editor can disappear
      // while the small write completes in the background. Project-hour
      // flows retain their completion hand-off until their write is finished.
      const backgroundSave = Boolean(closeAfterSave && !state.todoHoursSourceId && $("todoDialog").open);
      if (backgroundSave) {
        state.todoDialogBackgroundSave = true;
        $("todoDialog").close();
      }
      let data;
      try {
        data = await saveTodoToServer(todo);
      } catch (error) {
        if (backgroundSave) await releaseTodoEditLockForDialog();
        throw error;
      } finally {
        if (backgroundSave) {
          state.todoDialogBackgroundSave = false;
          clearTodoEditLockState();
        }
      }
      markTodoDialogAttachmentsSaved();
      if (todo.status === "execution" && !meal) rememberClientVehicle(clientVehicle);
      if (state.todoHoursSourceId) state.todoHoursSavedSourceId = state.todoHoursSourceId;
      if (!id) {
        state.todoCreationDraftCommitted = true;
        await clearTodoCreationDraft();
      }
      if (closeAfterSave) {
        if (!backgroundSave) $("todoDialog").close();
        return;
      }
      await keepTodoDialogOpenAfterSave(data, todo, !id);
      return !data.queued;
    }

async function submitTodoDialog({ closeAfterSave = true } = {}) {
      if (moduleValues.todoDialogSaveInFlight) return;
      const form = $("todoForm");
      const invalidField = [...form.elements].find((control) => control.willValidate && !control.validity.valid);
      if (invalidField) {
        showFormValidationError(form, validationMessageForField(invalidField), invalidField);
        return;
      }
      moduleValues.todoDialogSaveInFlight = true;
      setTodoDialogSaving(true);
      try {
        await saveTodoFromDialog({ closeAfterSave });
      } catch (error) {
        const message = error.message || "Opravila ni bilo mogoče shraniti.";
        if ($("todoDialog").open) showFormValidationError(form, message);
        else showNotice(message);
      } finally {
        moduleValues.todoDialogSaveInFlight = false;
        setTodoDialogSaving(false);
      }
    }

function completionRequestTodos() {
      return uniqueTodosByEventId(state.todos || [])
        .filter((todo) => !todo.archivedAt && !isImportedTodo(todo))
        .sort((a, b) => completionRequestTodoLabel(a).localeCompare(completionRequestTodoLabel(b), "sl"));
    }

function completionRequestTodoLabel(todo) {
      return [todo.date || "Brez datuma", todo.client, todo.title || "Brez naslova"].filter(Boolean).join(" \u00b7 ");
    }

function completionRequestStatus(message = "", kind = "") {
      const node = $("completionRequestStatus");
      node.textContent = message;
      node.hidden = !message;
      node.className = "completion-request-status" + (kind ? " " + kind : "");
    }

function setCompletionRequestSending(sending) {
      const dialog = $("completionRequestDialog");
      const submit = $("completionRequestSubmit");
      dialog.querySelectorAll("select, textarea, input[name='completionRecipient'], #cancelCompletionRequestDialog").forEach((field) => {
        field.disabled = Boolean(sending);
      });
      submit.disabled = Boolean(sending);
      submit.setAttribute("aria-busy", String(Boolean(sending)));
      submit.textContent = sending ? "Pošiljam e-pošto …" : "Pošlji zahtevek";
    }

function renderCompletionRequestRecipients(todo, preferredRecipientId = "") {
      const container = $("completionRequestRecipients");
      const allowedIds = new Set([...todoAssigneeIds(todo), String(todo.createdBy || ""), String(todo.syncUser || "")].filter(Boolean));
      const recipients = (state.users || []).filter((user) => allowedIds.has(String(user.id)));
      const defaultId = String(preferredRecipientId || todo.createdBy || todo.syncUser || recipients[0]?.id || "");
      container.innerHTML = recipients.length
        ? recipients.map((user) => `<label class="completion-request-recipient"><input type="checkbox" name="completionRecipient" value="${escapeHtml(String(user.id))}"${String(user.id) === defaultId ? " checked" : ""}> <span>${escapeHtml(user.name || user.id)}${user.email ? " (" + escapeHtml(user.email) + ")" : ""}</span></label>`).join("")
        : '<p class="todo-meta">Za to opravilo ni prejemnika.</p>';
    }

function updateCompletionRequestTodo(todoId, preferredRecipientId = "") {
      const todo = completionRequestTodos().find((item) => item.id === String(todoId));
      if (!todo) throw new Error("Izbranega opravila ni ve\u010d med aktivnimi opravili.");
      $("completionRequestTodoSelect").value = todo.id;
      $("completionRequestDialog").dataset.todoId = todo.id;
      renderCompletionRequestRecipients(todo, preferredRecipientId);
    }

function openCompletionRequestDialog(todoId = "") {
      const todos = completionRequestTodos();
      if (!todos.length) throw new Error("Ni aktivnega opravila, za katerega bi lahko poslal zahtevek.");
      $("completionRequestTodoSelect").innerHTML = todos.map((todo) => `<option value="${escapeHtml(todo.id)}">${escapeHtml(completionRequestTodoLabel(todo))}</option>`).join("");
      updateCompletionRequestTodo(String(todoId || $("todoFormId").value || todos[0].id));
      $("completionRequestComment").value = "";
      $("completionRequestSubmit").hidden = false;
      $("cancelCompletionRequestDialog").textContent = "Prekliči";
      setCompletionRequestSending(false);
      completionRequestStatus();
      $("completionRequestDialog").showModal();
      requestAnimationFrame(() => $("completionRequestComment").focus());
    }

async function submitCompletionRequest() {
      const dialog = $("completionRequestDialog");
      const todoId = String(dialog.dataset.todoId || "");
      if (!todoId) return showFormValidationError($("completionRequestForm"), "Izberi opravilo.", $("completionRequestTodoSelect"));
      const recipientUserIds = [...document.querySelectorAll('input[name="completionRecipient"]:checked')].map((input) => input.value);
      if (!recipientUserIds.length) return showFormValidationError($("completionRequestForm"), "Izberi vsaj enega prejemnika.", $("completionRequestRecipients").querySelector("input") || $("completionRequestRecipients"));
      const submit = $("completionRequestSubmit");
      setCompletionRequestSending(true);
      completionRequestStatus("Pošiljam zahtevek po e-pošti. Počakaj na potrditev …", "pending");
      try {
        const data = await api("/api/todos/" + encodeURIComponent(todoId) + "/completion-request", {
          method: "POST",
          body: JSON.stringify({ comment: $("completionRequestComment").value.trim(), recipientUserIds })
        });
        const recipients = (data.recipients || []).map((recipient) => recipient.name || recipient.email).filter(Boolean);
        completionRequestStatus("Zahtevek je poslan: " + (recipients.join(", ") || "prejemnikom") + ". E-pošta je uspešno predana Gmailu.", "success");
        submit.hidden = true;
        $("cancelCompletionRequestDialog").textContent = "Zapri";
        $("cancelCompletionRequestDialog").disabled = false;
        showNotice("Zahtevek je uspe\u0161no poslan: " + (recipients.join(", ") || "prejemnikom") + ".");
      } catch (error) {
        completionRequestStatus(error.message || "Po\u0161iljanje zahtevka ni uspelo.", "error");
        throw error;
      } finally {
        if (!submit.hidden) setCompletionRequestSending(false);
      }
    }

function installTaskSaveBindings1() {
    $("todoForm").addEventListener("submit", (event) => {
      event.preventDefault();
      submitTodoDialog();
    });
    $("saveTodoWithoutClosing").addEventListener("click", () => {
      submitTodoDialog({ closeAfterSave: false });
    });
    ["input", "change"].forEach((eventName) => {
      $("todoForm").addEventListener(eventName, scheduleTodoCreationDraftSave);
    });
    $("todoForm").addEventListener("click", () => {
      // Time and status controls are buttons, so they do not always emit an
      // input event. Debouncing keeps their change in the same local draft.
      window.setTimeout(scheduleTodoCreationDraftSave, 0);
    });
    $("todoForm").addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || (!event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      submitTodoDialog();
    });
    $("todoDialog").addEventListener("click", (event) => {
      if (event.target !== event.currentTarget) return;
      event.preventDefault();
      const isNew = isNewTodoCreationDialog();
      const hasContent = isNew && todoCreationDraftHasContent(todoCreationDraftFromForm());
      // An accidental tap outside a filled-in form must never discard it.
      // stopImmediatePropagation also prevents the generic dialog backdrop
      // handler registered by initializeModalBackNavigation from closing it.
      if (!isNew || hasContent || moduleValues.todoDialogSaveInFlight) {
        event.stopImmediatePropagation();
        return;
      }
      // An empty new form can be dismissed by touching the backdrop.
      state.todoCreationDraftCommitted = true;
      clearTodoCreationDraft().catch(() => {});
      event.currentTarget.close();
    });
    $("todoDialog").addEventListener("cancel", (event) => {
      if (moduleValues.todoDialogSaveInFlight) event.preventDefault();
    });
    $("todoFormAudit").addEventListener("click", (event) => {
      const button = event.target.closest("[data-todo-history-nav]");
      if (!button || button.disabled) return;
      navigateTodoHistory(Number(button.dataset.todoHistoryNav || 0));
    });
    $("deleteTodoFromDialog").addEventListener("click", () => deleteTodoFromDialog().catch((error) => showNotice(error.message)));
    $("duplicateTodoFromDialog").addEventListener("click", () => duplicateTodoFromCurrent().catch((error) => showNotice(error.message)));
    $("openTodoSourceProject").addEventListener("click", async (event) => {
      const sourceId = event.currentTarget.dataset.sourceTodoId || "";
      const source = state.todos.find((todo) => todo.id === sourceId);
      if (!source) {
        showNotice("Izvorno opravilo ni več na voljo.");
        return;
      }
      await releaseTodoEditLockForDialog();
      $("todoDialog").close();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await openTodoDialog(source);
    });
    $("writeHoursFromTodo").addEventListener("click", () => openHoursTodoFromCurrent().catch((error) => showNotice(error.message)));
    $("shareTodoPdf").addEventListener("click", () => shareTodoPdf().catch((error) => showNotice(error.message)));
    $("requestTodoCompletion").addEventListener("click", () => {
      try { openCompletionRequestDialog($("todoFormId").value); } catch (error) { showNotice(error.message); }
    });
    $("requestCompletionMenuBtn")?.addEventListener("click", () => {
      try {
        closeToolsMenu();
        openCompletionRequestDialog();
      } catch (error) { showNotice(error.message); }
    });
    ["closeCompletionRequestDialog", "cancelCompletionRequestDialog"].forEach((id) => $(id).addEventListener("click", () => $("completionRequestDialog").close()));
}

function installCompletionBindings1() {
    $("completionRequestTodoSelect").addEventListener("change", (event) => {
      try {
        updateCompletionRequestTodo(event.target.value);
        completionRequestStatus();
      } catch (error) {
        completionRequestStatus(error.message || "Izbira opravila ni uspela.", "error");
      }
    });
    $("completionRequestForm").addEventListener("submit", (event) => {
      event.preventDefault();
      submitCompletionRequest().catch((error) => showFormValidationError($("completionRequestForm"), error.message || "Zahtevka ni bilo mogoče poslati."));
    });
    $("completionRequestDialog").addEventListener("click", (event) => {
      if (event.target === event.currentTarget) $("completionRequestDialog").close();
    });
}

  return {
    announceClientBillableHoursWarning,
    saveTodoToServer,
    deleteTodoFromServer,
    saveTodoFromDialog,
    installTaskSaveBindings1,
    installCompletionBindings1
  };
}
