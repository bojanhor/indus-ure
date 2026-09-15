// editor/drafts: explicit dependencies; factory creation has no I/O or UI effects.
function createCreationDrafts({
  $,
  state,
  offlineStoreRequest,
  openTodoDialog,
  selectedTodoFormAssignees,
  todoFormSelectedClient,
  todoStatus,
  moduleValues
}) {
function todoCreationDraftFromForm() {
      const selectedClient = todoFormSelectedClient();
      const selectedStatus = todoStatus($("todoFormStatus").value).id;
      const taskStatus = todoStatus(
        state.todoCreationTaskStatus || (moduleValues.timeEntryStatusIds.has(selectedStatus) ? "open" : selectedStatus)
      ).id;
      const optionalNumber = (id) => {
        const value = String($(id).value || "").trim();
        return value === "" ? undefined : Number(value);
      };
      return {
        _creationMode: state.todoHoursSourceId
          ? "project-hours"
          : state.todoStandaloneHours
            ? "hours"
            : state.todoMaterialEntry
              ? "material"
              : state.todoNoteEntry
                ? "note"
                : state.todoMealEntry
                  ? "meal"
                  : selectedStatus === "material"
                    ? "material"
                    : selectedStatus === "note"
                      ? "note"
                      : selectedStatus === "meal"
                        ? "meal"
                        : "task",
        _taskStatus: moduleValues.timeEntryStatusIds.has(taskStatus) ? "open" : taskStatus,
        _draftAssigneeIds: selectedTodoFormAssignees(),
        client: $("todoFormClient").value.trim(),
        clientId: selectedClient?.clientId || selectedClient?.id || "",
        clientContactIds: [...state.todoDialogClientContactIds],
        title: $("todoFormTask").value,
        notes: $("todoFormNotes").value,
        material: $("todoFormMaterial").value,
        date: $("todoFormDate").value,
        endDate: $("todoFormEndDate").value,
        start: $("todoFormStart").value,
        end: $("todoFormEnd").value,
        urgent: $("todoFormUrgent").checked,
        ordered: $("todoFormOrdered").checked,
        warranty: $("todoFormWarranty").checked,
        workFromHome: $("todoFormWorkFromHome").checked,
        calendarOnly: $("todoFormCalendarOnly").checked,
        billingHourlyRate: optionalNumber("todoFormHourlyRate"),
        billingKm: optionalNumber("todoFormBillingKm"),
        clientKm: optionalNumber("todoFormClientKm"),
        clientVehicle: $("todoFormClientVehicle").value,
        materialAmount: 0,
        externalDelivery: true,
        photos: state.todoDialogPhotos.map((photo) => ({ ...photo })),
        driveFiles: state.todoDialogDriveFiles.map((file) => ({ ...file }))
      };
    }

function todoCreationDraftKey(userId = state.user?.id) {
      const id = String(userId || "").trim();
      return id ? `${moduleValues.offlineTodoCreationDraftPrefix}${id}` : "";
    }

function todoCreationDraftHasContent(draft) {
      if (!draft || typeof draft !== "object") return false;
      return [
        draft.client,
        draft.title,
        draft.notes,
        draft.material,
        ...(draft.photos || []).map((photo) => photo?.data || photo?.attachmentId || photo?.url || photo?.name),
        ...(draft.driveFiles || []).map((file) => file?.url || file?.fileId || file?.name)
      ].some((value) => String(value || "").trim());
    }

function todoCreationDraftMode(todo = {}) {
      if (todo._hoursSourceId) return "project-hours";
      if (todo._standaloneHours) return "hours";
      if (todo._materialEntry || todoStatus(todo.status).id === "material") return "material";
      if (todo._noteEntry || todoStatus(todo.status).id === "note") return "note";
      if (todo._mealEntry || todoStatus(todo.status).id === "meal") return "meal";
      return "task";
    }

function persistableTodoCreationDraftPhotos(photos, { compact = false } = {}) {
      return (photos || [])
        .filter((photo) => !photo?.uploading)
        .map((photo) => {
          const copy = { ...photo };
          if (compact) {
            delete copy.data;
            delete copy.url;
            delete copy.thumbnailData;
            delete copy.thumbnailUrl;
          }
          return copy;
        })
        .filter((photo) => photo.data || photo.url || photo.attachmentId || photo.name);
    }

function creationDraftStorageRecord(draft, { compact = false } = {}) {
      const key = todoCreationDraftKey();
      if (!key) return null;
      return {
        key,
        userId: state.user.id,
        savedAt: Date.now(),
        draft: {
          ...draft,
          photos: persistableTodoCreationDraftPhotos(draft.photos, { compact }),
          driveFiles: (draft.driveFiles || []).map((file) => ({ ...file }))
        }
      };
    }

function isNewTodoCreationDialog() {
      return Boolean(state.user?.id && !$("todoFormId").value && !state.todoCreationDraftCommitted && state.todoCreationDraftModeAtOpen !== "project-hours");
    }

function writeTodoCreationDraftFallback(record) {
      if (!record?.key) return;
      try {
        localStorage.setItem(record.key, JSON.stringify(record));
      } catch {
        // A full browser quota must never make typing in the form fail.
      }
    }

async function clearTodoCreationDraft(userId = state.user?.id) {
      const key = todoCreationDraftKey(userId);
      if (!key) return;
      if (moduleValues.offlineTodoCreationDraftTimer) {
        clearTimeout(moduleValues.offlineTodoCreationDraftTimer);
        moduleValues.offlineTodoCreationDraftTimer = 0;
      }
      localStorage.removeItem(key);
      try {
        await offlineStoreRequest(moduleValues.offlineTodoCreationDraftStore, "readwrite", (store) => store.delete(key));
      } catch {
        // localStorage is already cleared; IndexedDB is only the richer copy.
      }
    }

async function persistTodoCreationDraft() {
      if (!isNewTodoCreationDialog()) return;
      const draft = todoCreationDraftFromForm();
      if (!todoCreationDraftHasContent(draft)) {
        await clearTodoCreationDraft();
        return;
      }
      // This small synchronous copy survives a browser process being killed
      // before IndexedDB can finish writing.  The IndexedDB copy additionally
      // retains locally selected images and PDF files.
      writeTodoCreationDraftFallback(creationDraftStorageRecord(draft, { compact: true }));
      try {
        await offlineStoreRequest(moduleValues.offlineTodoCreationDraftStore, "readwrite", (store) => store.put(creationDraftStorageRecord(draft)));
      } catch {
        // The fallback above remains enough to restore the written fields.
      }
    }

function scheduleTodoCreationDraftSave() {
      if (!isNewTodoCreationDialog()) return;
      if (moduleValues.offlineTodoCreationDraftTimer) clearTimeout(moduleValues.offlineTodoCreationDraftTimer);
      moduleValues.offlineTodoCreationDraftTimer = window.setTimeout(() => {
        moduleValues.offlineTodoCreationDraftTimer = 0;
        persistTodoCreationDraft().catch(() => {});
      }, 300);
    }

async function loadTodoCreationDraft(requestedMode = "") {
      const key = todoCreationDraftKey();
      if (!key) return null;
      let localRecord = null;
      try { localRecord = JSON.parse(localStorage.getItem(key) || "null"); } catch { localStorage.removeItem(key); }
      let indexedRecord = null;
      try { indexedRecord = await offlineStoreRequest(moduleValues.offlineTodoCreationDraftStore, "readonly", (store) => store.get(key)); } catch {}
      const record = [localRecord, indexedRecord]
        .filter((item) => item?.draft && Number(item.savedAt || 0) > 0)
        .sort((left, right) => Number(right.savedAt) - Number(left.savedAt))[0];
      if (!record) return null;
      if (Date.now() - Number(record.savedAt) > moduleValues.offlineTodoCreationDraftMaxAgeMs) {
        await clearTodoCreationDraft();
        return null;
      }
      const mode = String(record.draft._creationMode || "task");
      if (requestedMode && mode !== requestedMode) return null;
      return {
        ...record.draft,
        _standaloneHours: mode === "hours",
        _materialEntry: mode === "material",
        _noteEntry: mode === "note",
        _mealEntry: mode === "meal"
      };
    }

async function openRecoveredTodoCreationDraftAtStartup() {
      if (!state.user || state.quickCreateMode || $("todoDialog").open) return false;
      const draft = await loadTodoCreationDraft();
      if (!draft) return false;
      await openTodoDialog({ ...draft, _restoredCreationDraft: true, _skipPersistedDraft: true });
      return true;
    }

  return {
    todoCreationDraftFromForm,
    todoCreationDraftHasContent,
    todoCreationDraftMode,
    isNewTodoCreationDialog,
    clearTodoCreationDraft,
    persistTodoCreationDraft,
    scheduleTodoCreationDraftSave,
    loadTodoCreationDraft,
    openRecoveredTodoCreationDraftAtStartup
  };
}
