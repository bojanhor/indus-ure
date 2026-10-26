"use strict";

function createAbsenceUi({ $, state, api, render, escapeHtml, showNotice, showAppConfirm, dateKey, activeWorkerId, closeModalBeforeTransition, openDayTimeline }) {
  let current = null, saving = false, pendingLink = new URL(location.href).searchParams.get("absence");
  let returnDay = null;
  const dialog = $("absenceDialog");
  function viewers(selected = []) {
    const workerId = $("absenceWorker").value;
    $("absenceViewers").innerHTML = state.users.map(user => {
      const mandatory = user.role === "boss" || user.id === workerId;
      return `<label><input type="checkbox" value="${escapeHtml(user.id)}" ${mandatory || selected.includes(user.id) ? "checked" : ""} ${mandatory || current?.canEdit === false ? "disabled" : ""}>${escapeHtml(user.name || user.id)}${mandatory ? " (vedno)" : ""}</label>`;
    }).join("");
  }
  function open(item = null, date = dateKey(new Date())) {
    if (saving) return;
    current = item;
    const editable = !item || item.canEdit;
    const users = (state.user.role === "boss" ? state.users : state.users.filter(user => user.id === (item?.workerId || state.user.id))).slice();
    if (item && !users.some(user => user.id === item.workerId)) users.push({ id: item.workerId, name: item.workerName || item.workerId });
    $("absenceWorker").innerHTML = users.map(user => `<option value="${escapeHtml(user.id)}">${escapeHtml(user.name || user.id)}</option>`).join("");
    $("absenceWorker").value = item?.workerId || (users.some(user => user.id === activeWorkerId()) ? activeWorkerId() : state.user.id);
    const boss = state.user.role === "boss";
    $("absenceWorker").hidden = !boss;
    $("absenceWorkerName").hidden = boss;
    $("absenceWorkerName").textContent = users.find(user => user.id === $("absenceWorker").value)?.name || item?.workerName || state.user.name;
    $("absenceDate").value = item?.date || date;
    $("absenceEndDate").value = item?.endDate || date;
    $("absenceReason").value = item?.reason || "vacation";
    for (const id of ["absenceWorker", "absenceDate", "absenceEndDate", "absenceReason"]) $(id).disabled = !editable;
    $("absenceWorker").disabled = !editable || state.user.role !== "boss";
    $("absenceTitle").textContent = item ? editable ? "Uredi odsotnost" : "Odsotnost – samo ogled" : "Nova odsotnost";
    $("saveAbsence").classList.toggle("hidden", !editable);
    $("deleteAbsence").classList.toggle("hidden", !item || !editable);
    $("absenceError").textContent = "";
    viewers(item?.viewerIds || []);
    dialog.showModal();
  }
  async function mutate(remove = false) {
    if (saving || current?.canEdit === false) return;
    if (state.offlineMode) { $("absenceError").textContent = "Za shranjevanje odsotnosti potrebuješ povezavo."; return; }
    if (remove && !await showAppConfirm("Izbrišem to odsotnost? Šef jo lahko obnovi prek zgodovine Undo.")) return;
    const item = current;
    const body = { workerId: $("absenceWorker").value, date: $("absenceDate").value, endDate: $("absenceEndDate").value,
      reason: $("absenceReason").value, viewerIds: [...$("absenceViewers").querySelectorAll("input:checked")].map(input => input.value), baseUpdatedAt: item?.updatedAt };
    saving = true; $("saveAbsence").disabled = true; $("deleteAbsence").disabled = true;
    try {
      const data = await api(`/api/absences${item ? `/${encodeURIComponent(item.id)}` : ""}`, { method: remove ? "DELETE" : item ? "PUT" : "POST", body: JSON.stringify(body) });
      state.absences = data.absences || [];
      if (dialog.open) dialog.close();
      render();
      showNotice(remove ? "Odsotnost je izbrisana." : "Odsotnost je shranjena.");
    } catch (error) { $("absenceError").textContent = error.message; if (!dialog.open) showNotice(error.message); }
    finally { saving = false; $("saveAbsence").disabled = false; $("deleteAbsence").disabled = false; }
  }
  $("absenceWorker").addEventListener("change", () => viewers());
  $("absenceDate").addEventListener("change", () => { if ($("absenceEndDate").value < $("absenceDate").value) $("absenceEndDate").value = $("absenceDate").value; });
  $("closeAbsence").addEventListener("click", () => dialog.close());
  $("saveAbsence").addEventListener("click", () => mutate());
  $("deleteAbsence").addEventListener("click", () => mutate(true));
  $("absenceForm").addEventListener("submit", event => { event.preventDefault(); mutate(); });
  for (const id of ["absenceEntryButton", "dayAbsenceButton"]) $(id).addEventListener("click", () => open(null, id === "dayAbsenceButton" ? state.dayTimelineDate : dateKey(new Date())));
  $("todoCreationAbsence").addEventListener("click", async () => {
    // Closing a new task preserves its draft through the existing close binding.
    // Do not turn an unfinished task into an absence or save a work entry.
    const date = $("todoFormDate").value || $("todoCreationTabs").dataset.date || dateKey(new Date());
    const back = state.todoDialogReturnDayDate ? { date: state.todoDialogReturnDayDate, viewSnapshot: state.todoDialogReturnDayView } : null;
    state.todoDialogReturnDayDate = "";
    state.todoDialogReturnDayView = null;
    await closeModalBeforeTransition($("todoDialog"));
    open(null, date);
    returnDay = back;
  });
  dialog.addEventListener("close", async () => {
    const back = returnDay; returnDay = null;
    if (!back) return;
    await closeModalBeforeTransition(dialog);
    if (!dialog.open && !$("todoDialog").open && !$("dayTimelineDialog").open) openDayTimeline(back.date, { viewSnapshot: back.viewSnapshot });
  });
  function resume() {
    if (!pendingLink || !state.absencesLoaded) return;
    const id = pendingLink; pendingLink = "";
    const url = new URL(location.href); url.searchParams.delete("absence"); history.replaceState(history.state, "", url);
    const item = state.absences.find(item => item.id === id);
    if (item) open(item); else showNotice("Odsotnost ni na voljo ali zanjo nimaš dostopa.");
  }
  return { open, resume };
}
