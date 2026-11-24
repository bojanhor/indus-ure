"use strict";

function createTaskDragActions() {
  const tray = $("todoDragActions");
  const targets = [...tray.querySelectorAll("[data-todo-drag-action]")];
  const dialog = $("todoGroupDropDialog");
  const form = $("todoGroupDropForm");
  const select = $("todoGroupDropChoice");
  const title = $("todoGroupDropName");
  const submit = $("todoGroupDropSave");
  const NEW_GROUP = "new:";
  let gesture = null;
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
    for (const target of targets) target.classList.remove("is-drop-target");
    document.body.append(tray);
  }
  async function moveToGroup(todo, { groupId, newTitle, fromGroupId = taskGroupUi.currentGroupId(todo) }) {
    const current = findTodoOrderItem(todo.id);
    if (!canGroup(current)) throw Error("Tega opravila ni mogoče premakniti v skupino.");
    if (newTitle === undefined && groupId === fromGroupId) return;
    if (newTitle === undefined && !taskGroupUi.searchGroups().some(group => group.id === groupId)) {
      throw Error("Ciljna skupina ni na voljo.");
    }
    await reorderTodos(current.id, "", "after", "", {
      fromGroupId, ...(newTitle === undefined ? { targetGroupId: groupId } : { newGroupTitle: newTitle })
    });
    showNotice("Opravilo je dodano v skupino.");
  }
  function updateForm() {
    const create = select.value === NEW_GROUP;
    title.closest("label").hidden = !create;
    title.required = create;
    submit.textContent = create ? "Ustvari in dodaj" : "Dodaj";
  }
  function chooseGroup(todo) {
    if (dialog.open || !canGroup(todo)) return;
    const fromGroupId = taskGroupUi.currentGroupId(todo);
    const groups = taskGroupUi.searchGroups().filter(group => group.id !== fromGroupId)
      .sort((a, b) => a.title.localeCompare(b.title, "sl"));
    selection = { todo, fromGroupId, saving: false };
    clearFormValidationError(form);
    form.reset();
    $("todoGroupDropEvent").textContent = todo.title || "Brez naslova";
    const placeholder = new Option("Izberi skupino", "", true, true);
    placeholder.disabled = true;
    select.replaceChildren(placeholder, ...groups.map(group => new Option(group.title, group.id)), new Option("Nova skupina…", NEW_GROUP));
    if (!groups.length) select.value = NEW_GROUP;
    submit.disabled = false;
    updateForm();
    dialog.showModal();
    (select.value === NEW_GROUP ? title : select).focus();
  }
  select.addEventListener("change", () => {
    clearFormValidationError(form);
    updateForm();
    if (select.value === NEW_GROUP) title.focus();
  });
  $("todoGroupDropClose").onclick = () => dialog.close();
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const current = selection;
    if (!current || current.saving || !select.value) return;
    current.saving = true;
    submit.disabled = true;
    try {
      await moveToGroup(current.todo, {
        fromGroupId: current.fromGroupId, groupId: select.value,
        newTitle: select.value === NEW_GROUP ? title.value.trim() : undefined
      });
      if (dialog.open && selection === current) dialog.close();
    } catch (error) {
      if (dialog.open && selection === current) showFormValidationError(form, error.message);
      else showNotice(error.message);
    } finally {
      current.saving = false;
      if (selection === current) submit.disabled = false;
    }
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
  return { show, hit, clear, canTrash, canGroup, commit };
}
