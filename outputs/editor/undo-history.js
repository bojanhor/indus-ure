// editor/undo-history: explicit dependencies; factory creation has no I/O or UI effects.
function createUndoHistory({
  $,
  state,
  api,
  escapeHtml,
  formatDateTime,
  loadAll,
  setView,
  showAppConfirm,
  showNotice
}) {
function undoActionTimestamp(action) {
      const value = String(action?.createdAt || "");
      return Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
    }

function renderUndoHistory() {
      const dialog = $("undoHistoryDialog");
      const list = $("undoHistoryList");
      const subtitle = $("undoHistorySubtitle");
      const note = $("undoHistoryNote");
      if (!dialog || !list || !subtitle || !note) return;
      const actions = Array.isArray(state.undoActions) ? state.undoActions.slice() : [];
      actions.sort((left, right) => undoActionTimestamp(right) - undoActionTimestamp(left));
      const available = actions.find((action) => action.canUndo);
      subtitle.textContent = actions.length ? actions.length + (actions.length === 1 ? " dejanje" : " dejanj") : "Brez dejanj";
      note.textContent = available
        ? "Razveljavitev se izvaja strogo po vrsti. Med postopkom sistem začasno blokira shranjevanje na vseh napravah."
        : "Prikazanih je zadnjih 20 poslovnih sprememb. Že razveljavljeni zapisi ostanejo vidni zaradi preglednosti.";
      if (!actions.length) {
        list.innerHTML = '<p class="todo-meta">Za razveljavitev še ni zabeleženih dejanj.</p>';
        return;
      }
      list.innerHTML = actions.map((action) => {
        const undone = Boolean(action.undoneAt);
        const current = Boolean(action.canUndo);
        const stateLabel = undone
          ? "Razveljavljeno" + (action.undoneByName ? " · " + action.undoneByName : "")
          : "";
        const button = current
          ? '<button class="primary" type="button" data-undo-history-id="' + escapeHtml(action.id) + '">Razveljavi</button>'
          : "";
        const time = undoActionTimestamp(action) ? formatDateTime(action.createdAt) : "Čas ni na voljo";
        const actor = action.actorName || "Sistem";
        return '<article class="undo-history-action' + (current ? " is-current" : "") + (undone ? " is-undone" : "") + '">' +
          '<div><strong>' + escapeHtml(action.action || "Spremenjeni podatki") + '</strong>' +
          '<p>' + escapeHtml(actor) + ' · ' + escapeHtml(time) + (undone && action.undoAction ? '<br>' + escapeHtml(action.undoAction) : "") + '</p></div>' +
          '<div class="actions">' + (stateLabel ? '<span class="undo-history-state">' + escapeHtml(stateLabel) + '</span>' : '') + button + '</div></article>';
      }).join("");
    }

async function openUndoHistory() {
      const data = await api("/api/undo-journal", { recoverSession: false });
      state.undoActions = Array.isArray(data.actions) ? data.actions : [];
      state.undoLocked = Boolean(data.locked);
      renderUndoHistory();
      $("undoHistoryDialog").showModal();
    }

async function undoHistoryAction(id) {
      const action = (state.undoActions || []).find((item) => item.id === id);
      if (!action?.canUndo) throw new Error("To dejanje ni več naslednje za razveljavitev.");
      const confirmed = await showAppConfirm("Razveljavim dejanje?\n\n" + (action.action || "Sprememba podatkov") + "\n\nMed postopkom bo shranjevanje na vseh napravah za trenutek blokirano.");
      if (!confirmed) return;
      const data = await api("/api/undo-journal/" + encodeURIComponent(id), {
        method: "POST",
        body: JSON.stringify({ confirm: true })
      });
      state.undoActions = Array.isArray(data.actions) ? data.actions : [];
      state.syncRevision = Math.max(state.syncRevision || 0, Number(data.syncRevision || 0));
      await loadAll();
      setView(state.view);
      renderUndoHistory();
      showNotice("Razveljavljeno: " + (data.undoneAction || action.action));
    }

function installUndoHistoryBindings1() {
    $("undoHistoryBtn").addEventListener("click", () => openUndoHistory().catch((error) => showNotice(error.message)));
    $("closeUndoHistory").addEventListener("click", () => $("undoHistoryDialog").close());
    $("undoHistoryList").addEventListener("click", (event) => {
      const button = event.target.closest("[data-undo-history-id]");
      if (!button) return;
      undoHistoryAction(button.dataset.undoHistoryId).catch((error) => showNotice(error.message));
    });
}

  return {
    installUndoHistoryBindings1
  };
}
