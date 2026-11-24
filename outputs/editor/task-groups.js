"use strict";

function createTaskGroupUi() {
  const dialog = $("taskGroupDialog");
  const form = $("taskGroupForm");
  const list = $("taskGroupEvents");
  $("editTaskGroup").innerHTML = taskActionIcons.edit;
  $("deleteTaskGroup").innerHTML = taskActionIcons.remove;
  let editing = null, dayReturn = null, suspended = false, saving = false, scrollTop = 0;
  const run = work => work().catch(error => showNotice(error.message));
  const groups = () => state.taskGroups || [];
  const members = group => contextTodos().filter(todo => group.eventIds.includes(todoEventId(todo)) && TaskGroups.active(todo));
  function inContext(group) {
    return isAdminView() || group.ownerId === activeWorkerId() || members(group).length > 0;
  }
  function card(group) {
    return TaskGroups.card(group, [...new Set(members(group).flatMap(todoAssigneeIds))]);
  }
  function calendarCards(workerIds) {
    return groups().filter(group => group.date && inContext(group)).map(card).filter(item => calendarWorkerMatchesIds(item, workerIds));
  }
  function collapseKey() { return `indus-ure:task-groups:${state.user?.id}:${state.workContext}`; }
  function collapsed() {
    try { return new Set(JSON.parse(localStorage.getItem(collapseKey()) || "[]")); } catch { return new Set(); }
  }
  function board(todos) {
    const groupList = groups().filter(inContext).filter(group => state.todoSortMode !== "manual_undated" || !group.date
      || todos.some(todo => group.eventIds.includes(todoEventId(todo))));
    const byEvent = new Map(groupList.flatMap(group => group.eventIds.map(id => [id, group.id])));
    return { byEvent, groupList, cards: groupList.map(card), childRows: new Map(groupList.map(group => [
      group.id, todos.filter(todo => byEvent.get(todoEventId(todo)) === group.id)
    ])) };
  }
  function searchGroups() {
    return groups().filter(inContext);
  }
  function reveal(id) {
    if (state.view !== "todos") setView("todos");
    if (state.todoSortMode !== "manual") {
      $("todoSortMode").value = "manual";
      $("todoSortMode").dispatchEvent(new Event("change", { bubbles: true }));
    }
    requestAnimationFrame(() => {
      const head = document.querySelector(`#todoItems .task-group-card[data-task-group-id="${CSS.escape(id)}"] .task-group-head`);
      if (head) focusTodoSearchResult(head, head.querySelector(".task-group-toggle"));
    });
  }
  function header(item, children) {
    const group = groups().find(group => group.id === item.groupId);
    const folded = collapsed().has(group.id);
    const outer = document.createElement("section");
    outer.className = "task-group-card";
    outer.dataset.taskGroupId = group.id;
    const head = document.createElement("div");
    head.className = "todo-item task-group-head";
    head.dataset.todoId = item.id;
    const count = children.length, ending = count % 100;
    const countText = count + (ending === 1 ? " dogodek" : ending === 2 ? " dogodka" : [3, 4].includes(ending) ? " dogodki" : " dogodkov");
    const summary = [todoDateTimeLabel(item), item.urgent ? "Nujna skupina" : "", countText,
      children.some(todo => todo.urgent) ? "Vsebuje nujno" : "", children.some(todoChangeNotice) ? "Spremenjeno" : ""].filter(Boolean).join(" · ");
    head.innerHTML = `<button class="drag-handle" type="button" aria-label="Povleci skupino">::</button>
      <button type="button" class="task-group-toggle" aria-expanded="${!folded}"><span class="task-group-chevron" aria-hidden="true">${folded ? "▸" : "▾"}</span> ${taskActionIcons.group} <strong>${escapeHtml(group.title)}</strong><small>${escapeHtml(summary)}</small></button>
      <button type="button" class="todo-edit-icon task-group-edit" aria-label="Uredi skupino" title="Uredi skupino">${taskActionIcons.edit}</button>`;
    bindTodoDragHandle(head, item.id);
    const body = document.createElement("div");
    body.className = "task-group-body";
    body.hidden = folded;
    if (!children.length) body.textContent = "Povleci opravilo v skupino.";
    const toggle = head.querySelector(".task-group-toggle");
    toggle.addEventListener("click", () => {
      const saved = collapsed();
      body.hidden = !body.hidden;
      if (body.hidden) saved.add(group.id); else saved.delete(group.id);
      localStorage.setItem(collapseKey(), JSON.stringify([...saved]));
      toggle.setAttribute("aria-expanded", String(!body.hidden));
      toggle.firstElementChild.textContent = body.hidden ? "▸" : "▾";
    });
    head.querySelector(".task-group-edit").onclick = () => run(() => open(group.id, { edit: true }));
    outer.append(head, body);
    return { outer, body };
  }
  function currentGroupId(todo) {
    if (!todo || todo._taskGroup) return "";
    return groups().find(group => group.eventIds.includes(todoEventId(todo)))?.id || "";
  }
  function refreshList() {
    list.replaceChildren();
    if (!editing) return;
    const group = groups().find(item => item.id === editing.id);
    if (!group || !inContext(group)) return;
    const todos = members(group).sort(todoManualCategorySort);
    const preferred = sortedTodosForMode(todos);
    const chosen = new Set(preferred.map(todo => todo.id));
    for (const todo of [...preferred, ...todos.filter(todo => !chosen.has(todo.id))]) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "secondary task-group-event-link";
      row.textContent = [todo.urgent ? "Nujno" : "", todo.title, todoDateTimeLabel(todo)].filter(Boolean).join(" · ");
      row.onclick = () => run(async () => {
        scrollTop = list.scrollTop;
        suspended = true;
        await closeModalBeforeTransition(dialog);
        const returned = async () => {
          suspended = false;
          await waitForModalHistoryTraversal();
          if (groups().some(item => item.id === group.id && inContext(item))) await open(group.id, { resume: true });
          else restoreDay();
        };
        $("todoDialog").addEventListener("close", returned, { once: true });
        try { await openTodoDialog(todo); }
        finally {
          if (!$("todoDialog").open) {
            $("todoDialog").removeEventListener("close", returned);
            if (suspended) await returned();
          }
        }
      });
      list.append(row);
    }
    if (!todos.length) list.textContent = "V skupini ni dogodkov za tvoj pogled.";
  }
  function restoreDay() {
    if (!dayReturn) return;
    const snapshot = dayReturn;
    dayReturn = null;
    void waitForModalHistoryTraversal().then(() => openDayTimeline(snapshot.date, { viewSnapshot: snapshot }));
  }
  function showFields(show) {
    form.hidden = !show;
    $("saveTaskGroup").hidden = !show;
    $("deleteTaskGroup").hidden = !editing || !show;
    $("editTaskGroup").setAttribute("aria-expanded", String(show));
  }
  async function open(id = "", { resume = false, edit = false } = {}) {
    if (saving) return;
    const group = groups().find(group => group.id === id);
    if (id && (!group || !inContext(group))) throw Error("Skupina ni na voljo.");
    if ($("dayTimelineDialog").open) {
      if (state.dayTimelineSaving || state.dayTimelineDrafts.size) throw Error("Najprej shrani ali prekliči spremembe dnevne časovnice.");
      const scroll = $("dayTimelineScroll");
      dayReturn = { date: state.dayTimelineDate, includeArchived: state.dayTimelineIncludeArchived, workerFilter: state.dayTimelineWorkerFilter,
        minuteHeight: state.dayTimelineMinuteHeight, scrollTop: scroll.scrollTop, scrollLeft: scroll.scrollLeft };
      await closeModalBeforeTransition($("dayTimelineDialog"));
    }
    editing = group || null;
    form.reset();
    $("taskGroupTitle").textContent = group ? "Skupina: " + group.title : "Nova skupina";
    $("editTaskGroup").hidden = !group;
    showFields(!group || edit);
    for (const key of ["title", "description", "date", "endDate", "start", "end"]) form.elements[key].value = group?.[key] || "";
    form.elements.urgent.checked = Boolean(group?.urgent);
    refreshList();
    if (!dialog.open) dialog.showModal();
    list.scrollTop = resume ? scrollTop : 0;
  }
  async function change(method, values = {}) {
    if (saving) return;
    if (state.offlineMode) throw Error("Za spremembo skupine potrebuješ povezavo.");
    saving = true;
    $("saveTaskGroup").disabled = $("deleteTaskGroup").disabled = true;
    const mutation = beginTodoMutation();
    try {
      const data = await api("/api/task-groups" + (editing ? "/" + encodeURIComponent(editing.id) : ""), {
        method, body: JSON.stringify({ ...values, revision: editing?.revision })
      });
      if (isCurrentTodoRevision(mutation)) state.taskGroups = data.taskGroups;
      if (dialog.open) await closeModalBeforeTransition(dialog);
      render(); saveOfflineSnapshotSoon();
      if (method === "POST" && data.id) reveal(data.id);
    } finally {
      finishTodoMutation();
      saving = false;
      $("saveTaskGroup").disabled = $("deleteTaskGroup").disabled = false;
    }
  }
  $("newTaskGroup").onclick = () => run(() => open());
  $("editTaskGroup").onclick = () => { showFields(form.hidden); if (!form.hidden) form.elements.title.focus(); };
  $("closeTaskGroup").onclick = () => dialog.close();
  $("deleteTaskGroup").onclick = () => run(async () => {
    if (await showAppConfirm("Razpustim skupino? Dogodki ostanejo med samostojnimi opravili.")) await change("DELETE");
  });
  $("taskGroupAllDay").onclick = () => { form.elements.start.value = form.elements.end.value = ""; };
  form.onsubmit = event => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    return run(() => change(editing ? "PUT" : "POST", { ...values, urgent: form.elements.urgent.checked }));
  };
  dialog.addEventListener("close", () => { if (!suspended) restoreDay(); });
  async function resumeLink() {
    const url = new URL(location.href);
    const id = url.searchParams.get("group");
    if (!id || !state.user || !state.todoSnapshotLoaded || state.startupHydrating || state.offlineMode) return;
    url.searchParams.delete("group"); history.replaceState(history.state, "", url);
    if (!dialog.open && !document.querySelector("dialog[open]")) await run(() => open(id));
  }
  async function moveDate(todo, startDate, endDate) {
    if (state.offlineMode) throw Error("Za premik skupine potrebuješ povezavo.");
    const mutation = beginTodoMutation();
    try {
      const data = await api("/api/task-groups/" + encodeURIComponent(todo.groupId), {
        method: "PUT", body: JSON.stringify({ ...todo, date: startDate, endDate })
      });
      if (isCurrentTodoRevision(mutation)) state.taskGroups = data.taskGroups;
      render(); saveOfflineSnapshotSoon();
    } finally { finishTodoMutation(); }
  }
  return { board, header, card, currentGroupId, calendarCards, moveDate, searchGroups, reveal, open: id => run(() => open(id)), resumeLink };
}
