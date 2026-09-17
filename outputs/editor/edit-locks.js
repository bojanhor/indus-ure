// editor/edit-locks: explicit dependencies; factory creation has no I/O or UI effects.
function createEditLocks({
  $,
  state,
  api,
  createLocalUuid,
  isNetworkError,
  loadTodos,
  saveTodoFromDialog,
  scheduleOfflineTodoRetry,
  setTodoDialogOpening,
  setTodoDialogSaving,
  showNotice,
  updateOfflineSyncNotice,
  moduleValues
}) {
function todoLockUrl(todoId) {
      return `/api/todos/${encodeURIComponent(todoId)}/lock`;
    }

function todoHandoverApi(todoId, body) {
      return api(`${todoLockUrl(todoId)}/handover`, {
        method: "POST", body: JSON.stringify(body), requestTimeoutMs: 8_000
      });
    }

function stopTodoHandoverWatch() {
      clearInterval(moduleValues.todoHandoverWatch);
      clearInterval(moduleValues.todoHandoverCountdown);
      moduleValues.todoHandoverWatch = moduleValues.todoHandoverCountdown = null;
      moduleValues.todoHandoverRequest = null;
      if ($("todoHandoverDialog").open) $("todoHandoverDialog").close();
    }

async function finishTodoHandover(allow) {
      const request = moduleValues.todoHandoverRequest;
      const lock = state.todoEditLock;
      if (!request || !lock || moduleValues.todoHandoverSaving) return;
      moduleValues.todoHandoverSaving = true;
      clearInterval(moduleValues.todoHandoverCountdown);
      $("todoHandoverSave").disabled = $("todoHandoverDeny").disabled = true;
      try {
        if (!allow) {
          await todoHandoverApi(lock.todoId, { action: "deny", requestId: request.requestId, lockToken: lock.token });
          showNotice("Prevzem ni dovoljen. Urejanje ostaja pri tebi.");
        } else {
          $("todoHandoverMessage").textContent = "Shranjujem spremembe pred predajo …";
          if (moduleValues.todoDialogSaveInFlight || state.todoDialogPhotos.some((photo) => photo.uploading)) throw new Error("Počakaj na trenutno shranjevanje oziroma nalaganje prilog in ponovi prevzem.");
          moduleValues.todoDialogSaveInFlight = true;
          setTodoDialogSaving(true);
          const saved = await saveTodoFromDialog({ closeAfterSave: false, handover: true });
          if (!saved) throw new Error("Obrazec potrebuje tvojo potrditev ali popravek. Prevzem je preklican, neshranjena vsebina ostaja odprta.");
          await releaseTodoEditLockForDialog();
          $("todoDialog").close();
          showNotice("Spremembe so shranjene. Urejanje je predano drugi napravi.");
        }
      } catch (error) {
        await todoHandoverApi(lock.todoId, { action: "failed", requestId: request.requestId, lockToken: lock.token }).catch(() => {});
        showNotice(error.message);
      } finally {
        moduleValues.todoHandoverSaving = false;
        moduleValues.todoDialogSaveInFlight = false;
        setTodoDialogSaving(false);
        moduleValues.todoHandoverRequest = null;
        $("todoHandoverDialog").close();
        $("todoHandoverSave").disabled = $("todoHandoverDeny").disabled = false;
      }
    }

function startTodoHandoverWatch() {
      if (moduleValues.todoHandoverWatch) return;
      moduleValues.todoHandoverWatch = setInterval(async () => {
        const lock = state.todoEditLock;
        if (!lock || moduleValues.todoHandoverPolling || moduleValues.todoHandoverSaving || !$("todoDialog").open) return;
        moduleValues.todoHandoverPolling = true;
        try {
          const request = await todoHandoverApi(lock.todoId, { action: "poll", lockToken: lock.token });
          if (moduleValues.todoHandoverRequest && request.status !== "waiting") {
            clearInterval(moduleValues.todoHandoverCountdown);
            moduleValues.todoHandoverRequest = null;
            $("todoHandoverDialog").close();
          }
          if (moduleValues.todoHandoverRequest) return;
          if (request.status !== "waiting" || state.todoEditLock?.token !== lock.token) return;
          moduleValues.todoHandoverRequest = request;
          const tick = () => {
            const seconds = Math.max(0, Math.ceil((request.deadline - Date.now()) / 1000));
            $("todoHandoverMessage").textContent = `${request.requesterName} želi urejati ta vpis na drugi napravi. Čez ${seconds} s bom samodejno shranil in zaprl. Lahko prevzem zavrneš.`;
            if (!seconds) void finishTodoHandover(true);
          };
          $("todoHandoverDialog").showModal();
          tick();
          moduleValues.todoHandoverCountdown = setInterval(tick, 250);
        } catch { /* A failed notification never discards the open form. */ }
        finally { moduleValues.todoHandoverPolling = false; }
      }, 2_000);
    }

async function waitForTodoHandover(todoId, lock) {
      let requestId = "";
      let accepted = false;
      const started = Date.now();
      try {
      while ($("todoDialog").open && Date.now() - started < 120_000) {
        const result = await todoHandoverApi(todoId, { action: "request", requestId });
        requestId = result.requestId || requestId;
        if (result.status === "ready") { accepted = true; return true; }
        if (result.status !== "waiting") {
          showNotice(result.status === "denied" ? "Uporabnik je prevzem zavrnil. Poskusi kasneje."
            : result.status === "failed" ? "Na drugi napravi obrazca ni bilo mogoče varno shraniti. Vsebina tam ostaja odprta."
            : "Prevzem trenutno ni na voljo. Poskusi znova.");
          return false;
        }
        const seconds = Math.max(0, Math.ceil((result.deadline - Date.now()) / 1000));
        $("todoFormOpeningStatus").textContent = seconds
          ? `${lock.lockedByName} je prejel prošnjo za prevzem. Čakam odgovor (${seconds} s) …`
          : "Čakam varno shranjevanje. Če je druga naprava nedosegljiva, počakam iztek zaklepa; neshranjene vsebine ne prepisujem.";
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      return false;
      } finally {
        if (requestId && !accepted) await todoHandoverApi(todoId, { action: "cancel", requestId }).catch(() => {});
      }
    }

function clearTodoEditLockState() {
      stopTodoHandoverWatch();
      if (state.todoLockHeartbeat) clearInterval(state.todoLockHeartbeat);
      state.todoLockHeartbeat = null;
      state.todoEditLock = null;
    }

async function pauseTodoLockHeartbeat() {
      if (state.todoLockHeartbeat) clearInterval(state.todoLockHeartbeat);
      state.todoLockHeartbeat = null;
      if (state.todoLockRenewPromise) await state.todoLockRenewPromise;
    }

function resumeTodoLockHeartbeat(todoId, token) {
      const current = state.todoEditLock;
      if (!current || state.todoLockHeartbeat || state.offlineMode || !navigator.onLine) return;
      if (current.todoId !== todoId || current.token !== token) return;
      state.todoLockHeartbeat = setInterval(renewTodoEditLock, moduleValues.appConfig.locks.heartbeatSeconds * 1000);
    }

function renewTodoEditLock() {
      const current = state.todoEditLock;
      if (!current || state.offlineMode || !navigator.onLine) return Promise.resolve();
      if (state.todoLockRenewPromise) return state.todoLockRenewPromise;
      const renewal = (async () => {
        try {
          const data = await api(todoLockUrl(current.todoId), {
            method: "POST",
            body: JSON.stringify({ lockToken: current.token })
          });
          if (state.todoEditLock?.todoId === current.todoId && state.todoEditLock?.token === current.token) {
            state.todoEditLock = { todoId: current.todoId, token: data.lockToken, expiresAt: data.lock?.expiresAt || "" };
          }
        } catch (error) {
          if (state.todoEditLock?.todoId !== current.todoId || state.todoEditLock?.token !== current.token) return;
          if (isNetworkError(error)) {
            if (state.todoLockHeartbeat) clearInterval(state.todoLockHeartbeat);
            state.todoLockHeartbeat = null;
            state.offlineMode = true;
            scheduleOfflineTodoRetry();
            updateOfflineSyncNotice().catch(() => {});
            showNotice("Stre\u017enik trenutno ni dosegljiv. Urejanje lahko nadaljuje\u0161; sprememba se bo poslala samodejno.");
            return;
          }
          clearTodoEditLockState();
          // Never discard unsaved text when a sleeping device loses its lease.
          if ($("todoDialog").open) {
            setTodoDialogOpening(true);
            $("todoFormOpeningStatus").textContent = "Urejanje je prevzela druga naprava. Tvoja neshranjena vsebina ostaja v tem obrazcu; ne bo samodejno prepisala novejšega vpisa.";
          }
          showNotice(error.message);
        }
      })();
      state.todoLockRenewPromise = renewal;
      renewal.finally(() => {
        if (state.todoLockRenewPromise === renewal) state.todoLockRenewPromise = null;
      });
      return renewal;
    }

async function acquireTodoEditLockForDialog(todoId) {
      if (state.todoLockPending) return false;
      state.todoLockPending = true;
      try {
        if (state.offlineMode || !navigator.onLine) {
          state.todoEditLock = { todoId, token: `offline-${createLocalUuid()}`, expiresAt: new Date(state.sessionExpiresAt || Date.now()).toISOString() };
          scheduleOfflineTodoRetry();
          return true;
        }
        const current = state.todoEditLock?.todoId === todoId ? state.todoEditLock : null;
        let data;
        try {
          data = await api(todoLockUrl(todoId), {
            method: "POST", body: JSON.stringify({ lockToken: current?.token || "" })
          });
        } catch (error) {
          if (error.status !== 409 || !error.lock) throw error;
          try {
            if (!await waitForTodoHandover(todoId, error.lock)) return false;
          } catch (handoverError) {
            showNotice("Prevzem ni uspel zaradi povezave. Druga naprava obdrži urejanje; poskusi znova.");
            return false;
          }
          if (!$("todoDialog").open) return false;
          data = await api(todoLockUrl(todoId), { method: "POST", body: "{}" });
          let fresh;
          try { fresh = await api(`/api/todos/${encodeURIComponent(todoId)}`); }
          catch (refreshError) {
            await api(todoLockUrl(todoId), {method:"DELETE",body:JSON.stringify({lockToken:data.lockToken})}).catch(() => {});
            showNotice("Prevzem je ustavljen: novejšega vpisa ni mogoče naložiti. Poskusi znova, ko bo povezava vzpostavljena.");
            return false;
          }
          state.todoHandoverFreshTodo = fresh.todo;
          state.todos = state.todos.map((todo) => todo.id === fresh.todo.id ? fresh.todo : todo);
        }
        if (state.todoLockHeartbeat) clearInterval(state.todoLockHeartbeat);
        state.todoEditLock = { todoId, token: data.lockToken, expiresAt: data.lock?.expiresAt || "" };
        state.todoLockHeartbeat = setInterval(renewTodoEditLock, moduleValues.appConfig.locks.heartbeatSeconds * 1000);
        startTodoHandoverWatch();
        return true;
      } catch (error) {
        if (isNetworkError(error)) {
          state.offlineMode = true;
          state.todoEditLock = { todoId, token: `offline-${createLocalUuid()}`, expiresAt: new Date(state.sessionExpiresAt || Date.now()).toISOString() };
          scheduleOfflineTodoRetry();
          updateOfflineSyncNotice().catch(() => {});
          showNotice("Stre\u017enik trenutno ni dosegljiv. Opravilo lahko uredi\u0161 lokalno; prenos se bo ponovil samodejno.");
          return true;
        }
        if (error?.code === "todo_not_found" || error?.code === "todo_not_editable") {
          if (state.todoEditLock?.todoId === todoId) clearTodoEditLockState();
          try { await loadTodos(); } catch (refreshError) { if (!isNetworkError(refreshError)) throw refreshError; }
          showNotice(error.code === "todo_not_found"
            ? "Opravilo je bilo medtem odstranjeno."
            : "Opravilo ni ve\u010d dodeljeno tebi oziroma ga ne more\u0161 urejati.");
          return false;
        }
        showNotice(error.message);
        return false;
      } finally {
        state.todoLockPending = false;
      }
    }

async function releaseTodoEditLockForDialog() {
      const openedLock = state.todoEditLock;
      await pauseTodoLockHeartbeat();
      const current = state.todoEditLock?.todoId === openedLock?.todoId ? state.todoEditLock : openedLock;
      clearTodoEditLockState();
      if (!current || state.offlineMode || !navigator.onLine) return;
      try {
        await api(todoLockUrl(current.todoId), {
          method: "DELETE",
          body: JSON.stringify({ lockToken: current.token })
        });
      } catch {}
    }

function releaseTodoEditLockOnPageHide() {
      const current = state.todoEditLock;
      clearTodoEditLockState();
      if (!current || !state.token || state.offlineMode || !navigator.onLine) return;
      fetch(todoLockUrl(current.todoId), {
        method: "DELETE",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": state.csrfToken },
        body: JSON.stringify({ lockToken: current.token }),
        keepalive: true
      }).catch(() => {});
    }

function installEditLockBindings1() {
    $("todoHandoverSave").addEventListener("click", () => void finishTodoHandover(true));
    $("todoHandoverDeny").addEventListener("click", () => void finishTodoHandover(false));
    $("todoHandoverDialog").addEventListener("cancel", (event) => { event.preventDefault(); void finishTodoHandover(false); });
}

  return {
    todoLockUrl,
    clearTodoEditLockState,
    pauseTodoLockHeartbeat,
    resumeTodoLockHeartbeat,
    acquireTodoEditLockForDialog,
    releaseTodoEditLockForDialog,
    releaseTodoEditLockOnPageHide,
    installEditLockBindings1
  };
}
