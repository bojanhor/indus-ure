"use strict";

function createTaskDragActions() {
  const tray = $("todoDragActions");
  const targets = [...tray.querySelectorAll("[data-todo-drag-action]")];
  const dialog = $("todoGroupDropDialog");
  const form = $("todoGroupDropForm");
  const select = $("todoGroupDropChoice");
  const search = $("todoGroupDropSearch");
  const title = $("todoGroupDropName");
  const ownerField = $("todoGroupDropOwner");
  const submit = $("todoGroupDropSave");
  const remove = $("todoGroupDropRemove");
  const NEW_GROUP = "new:";
  let gesture = null;
  let dragHost = null;
  let selection = null;

  for (const target of targets) {
    target.insertAdjacentHTML("afterbegin", taskActionIcons[target.dataset.todoDragAction === "trash" ? "remove" : "group"]);
  }
  function canTrash(todo) {
    const user = state.user;
    return Boolean(user && todo?.id && !todo._taskGroup && !todo._absence && !todo.trashedAt && !todo.archivedAt
      && !todo.settlementEdit?.clientLocked && !todo.settlementEdit?.workerLocked && !todo.clientSettlement?.confirmed
      && (user.role === "boss" || todo.syncUser === user.id || todo.createdBy === user.id));
  }
  function canGroup(todo) {
    return canTrash(todo) && TaskGroups.active(todo) && todoCanManualReorder(todo) && !state.offlineMode;
  }
  function show(owner, todo, host = document.body) {
    const trash = canTrash(todo), group = canGroup(todo);
    if (!trash && !group) return;
    if (gesture) clear(gesture);
    gesture = owner;
    for (const el of targets) el.hidden = el.dataset.todoDragAction === "trash" ? !trash : !group;
    host.append(tray);
    tray.hidden = false;
    dragHost = host;
    const edge = host === document.body ? window.innerHeight : host.getBoundingClientRect().bottom;
    host.style.setProperty("--todo-drag-space", Math.ceil(edge - tray.getBoundingClientRect().top + 12) + "px");
    host.classList.add("todo-drag-host");
  }
  function hit(owner, x, y) {
    if (gesture !== owner) return "";
    const point = Math.hypot(x - owner.startX, y - owner.startY) > 12
      ? document.elementFromPoint(x, y)?.closest("[data-todo-drag-action]") : null;
    for (const el of targets) el.classList.toggle("is-drop-target", el === point);
    return point?.parentElement === tray && !point.hidden ? point.dataset.todoDragAction : "";
  }
  function clear(owner) {
    if (!owner || gesture !== owner) return;
    gesture = null;
    tray.hidden = true;
    dragHost?.classList.remove("todo-drag-host");
    dragHost?.style.removeProperty("--todo-drag-space");
    dragHost = null;
    for (const target of targets) target.classList.remove("is-drop-target");
    document.body.append(tray);
  }
  function scrollBottom(edge) {
    return gesture ? Math.min(edge, tray.getBoundingClientRect().top - 6) : edge;
  }
  const recentKey = () => `indus-ure-recent-task-groups:${state.user?.id || "anonymous"}`;
  function recentGroups() {
    try {
      const ids = JSON.parse(localStorage.getItem(recentKey()) || "[]");
      return Array.isArray(ids) ? ids.filter(id => typeof id === "string").slice(0, 5) : [];
    } catch { return []; }
  }
  function rememberGroup(id) {
    if (!id) return;
    try { localStorage.setItem(recentKey(), JSON.stringify([id, ...recentGroups().filter(item => item !== id)].slice(0, 5))); } catch {}
  }
  function syncEditor(todo) {
    const groupId = taskGroupUi.currentGroupId(todo);
    const group = state.taskGroups?.find(item => item.id === groupId);
    $("todoGroupEditorAction").hidden = !canGroup(todo);
    $("todoGroupEditorCurrent").textContent = group ? "Skupina: " + group.title : "";
  }
  async function moveToGroup(todo, { groupId, newTitle, ownerId, fromGroupId = taskGroupUi.currentGroupId(todo) }) {
    const current = findTodoOrderItem(todo.id);
    if (!canGroup(current)) throw Error("Tega opravila ni mogoče premakniti v skupino.");
    if (newTitle === undefined && groupId === fromGroupId) return;
    if (newTitle === undefined && groupId && !taskGroupUi.searchGroups().some(group => group.id === groupId)) {
      throw Error("Ciljna skupina ni na voljo.");
    }
    await reorderTodos(current.id, "", "after", "", {
      fromGroupId, ...(newTitle === undefined ? { targetGroupId: groupId } : { newGroupTitle: newTitle, newGroupOwnerId: ownerId || "" })
    });
    if ($("todoDialog").open) {
      const opened = state.todos.find(item => item.id === $("todoFormId").value);
      syncEditor(opened);
      const initial = state.todoFormPlanningDates;
      const from = $("todoFormDate"), to = $("todoFormEndDate");
      if (opened?.id === todo.id && initial?.date === from.value && initial?.endDate === to.value
        && ($("todoFormStart").value || "") === (opened.start || "") && ($("todoFormEnd").value || "") === (opened.end || "")) {
        const projected = taskGroupUi.calendarProjection(opened);
        from.value = projected.date || "";
        to.value = todoEndDate(projected) || "";
        to.dataset.auto = String(from.value === to.value);
        syncTodoFormEndDate();
        state.todoFormPlanningDates = { date: from.value, endDate: to.value };
      }
    }
    if ($("taskGroupDialog").open) taskGroupUi.refreshList();
  }
  function updateForm() {
    const create = selection?.kind === "group" && select.value === NEW_GROUP;
    const chooseOwner = create && state.user?.role === "boss";
    title.closest("label").hidden = !create;
    title.required = create;
    ownerField.closest("label").hidden = !chooseOwner;
    ownerField.disabled = !chooseOwner;
    submit.textContent = create ? "Ustvari in dodaj" : "Dodaj v skupino";
    submit.disabled = Boolean(selection?.saving || !select.value);
    remove.hidden = !(selection?.kind === "group" && selection.fromGroupId);
    remove.disabled = Boolean(selection?.saving);
  }
  function renderChoices(initial = false) {
    const isGroup = selection.kind === "group";
    const old = select.value;
    const needle = normalizeText(search.value);
    const found = selection.items.filter(item => !needle || normalizeText(item.searchText || item.title).includes(needle))
      .sort((a, b) => a.title.localeCompare(b.title, "sl"));
    const placeholder = new Option(found.length ? (isGroup ? "Izberi skupino" : "Izberi opravilo") : "Ni zadetkov", "", true, true);
    placeholder.disabled = true;
    select.replaceChildren(placeholder);
    if (isGroup) {
      const ids = recentGroups();
      const recent = ids.map(id => found.find(item => item.id === id)).filter(Boolean);
      const others = found.filter(item => !ids.includes(item.id));
      for (const [label, items] of [["Nazadnje uporabljene", recent], ["Po abecedi", others]]) {
        if (!items.length) continue;
        const options = document.createElement("optgroup");
        options.label = label;
        options.append(...items.map(item => new Option(item.title, item.id)));
        select.append(options);
      }
      select.append(new Option("Nova skupina…", NEW_GROUP));
    } else {
      select.append(...found.map(item => new Option(item.title + (item.client ? " — " + item.client : ""), item.id)));
    }
    if (found.some(item => item.id === old) || (isGroup && old === NEW_GROUP)) select.value = old;
    else if (initial && isGroup && !selection.items.length) select.value = NEW_GROUP;
    updateForm();
  }
  function openPicker(next, heading, subject) {
    if (dialog.open) return;
    selection = { ...next, saving: false };
    clearFormValidationError(form);
    form.reset();
    select.replaceChildren();
    $("todoGroupDropTitle").textContent = heading;
    $("todoGroupDropEvent").textContent = subject;
    $("todoGroupDropSearchLabel").textContent = next.kind === "group" ? "Išči skupino" : "Išči opravilo";
    $("todoGroupDropChoiceLabel").textContent = next.kind === "group" ? "Skupina" : "Opravilo";
    if (state.user?.role === "boss") taskGroupUi.fillOwners(ownerField);
    renderChoices(true);
    dialog.showModal();
    (select.value === NEW_GROUP ? title : search).focus();
  }
  function chooseGroup(todo) {
    if (!canGroup(todo)) return;
    const fromGroupId = taskGroupUi.currentGroupId(todo);
    const groups = taskGroupUi.searchGroups().filter(group => group.id !== fromGroupId);
    openPicker({ kind: "group", todo, fromGroupId, items: groups }, "Dodaj v skupino", todo.title || "Brez naslova");
  }
  function chooseTodo(group) {
    const items = contextTodos().filter(canGroup).map(todo => ({
      id: todo.id, todo, title: todo.title || "Brez naslova", client: todoClientCalendarName(todo),
      searchText: [todo.title, todoClientCalendarName(todo), todo.notes].filter(Boolean).join(" "), fromGroupId: taskGroupUi.currentGroupId(todo)
    })).filter(item => item.fromGroupId !== group.id);
    openPicker({ kind: "todo", group, items }, "Dodaj opravilo v skupino", group.title);
  }
  search.addEventListener("input", () => { if (selection && !selection.saving) renderChoices(); });
  select.addEventListener("change", () => {
    clearFormValidationError(form);
    updateForm();
    if (select.value === NEW_GROUP) title.focus();
  });
  $("todoGroupDropClose").onclick = () => dialog.close();
  $("todoGroupEditorButton").onclick = () => chooseGroup(state.todos.find(todo => todo.id === $("todoFormId").value));
  async function save(removing = false) {
    const current = selection;
    if (!current || current.saving || (removing ? !current.fromGroupId : !select.value)) return;
    const option = current.items.find(item => item.id === select.value);
    const create = select.value === NEW_GROUP;
    current.saving = true;
    updateForm();
    try {
      if (current.kind === "todo") {
        if (!option) return;
        await moveToGroup(option.todo, { fromGroupId: option.fromGroupId, groupId: current.group.id });
      } else {
        await moveToGroup(current.todo, {
          fromGroupId: current.fromGroupId, groupId: removing ? "" : select.value,
          newTitle: !removing && create ? title.value.trim() : undefined, ownerId: ownerField.value
        });
      }
      if (dialog.open && selection === current) dialog.close();
      showNotice(removing ? "Opravilo je odstranjeno iz skupine." : "Opravilo je dodano v skupino.");
    } catch (error) {
      if (dialog.open && selection === current) showFormValidationError(form, error.message);
      else showNotice(error.message);
    } finally {
      current.saving = false;
      if (selection === current) updateForm();
    }
  }
  remove.onclick = () => void save(true);
  form.addEventListener("submit", event => {
    event.preventDefault();
    void save();
  });
  async function commit(action, todo, groupId = "") {
    try {
      if (action === "group") { chooseGroup(todo); return; }
      if (action === "group-card") { await moveToGroup(todo, { groupId }); return; }
      if (action !== "trash" || !canTrash(todo) || $("appConfirmDialog").open) return;
      const name = todo.title || "Brez naslova";
      if (!await showAppConfirm(`Premaknem opravilo »${name}« v koš? Obnovitev je možna 30 dni.`, {
        title: "Premik v koš", confirmLabel: "Premakni v koš", danger: true
      })) return;
      const latest = state.todos.find(item => item.id === todo.id);
      if (!canTrash(latest) || latest.updatedAt !== todo.updatedAt) throw Error("Opravilo se je medtem spremenilo. Ponovi premik.");
      await deleteTodoFromServer(latest.id);
      showNotice("Opravilo je premaknjeno v koš.");
    } catch (error) { showNotice(error.message); }
  }
  return { show, hit, clear, scrollBottom, canTrash, canGroup, commit, syncEditor, chooseTodo, rememberGroup };
}
