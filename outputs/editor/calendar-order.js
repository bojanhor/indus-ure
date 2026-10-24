"use strict";

function createCalendarOrderUi({ state, api, render, showNotice }) {
  let active = null, saving = false;
  async function save(sourceId, targetId, placement) {
    if (saving || !targetId || sourceId === targetId) return;
    if (state.offlineMode) { showNotice("Za razvrščanje koledarja potrebuješ povezavo."); return; }
    saving = true;
    try {
      const data = await api("/api/todos/calendar-order", { method: "POST", body: JSON.stringify({ sourceId, targetId, placement }) });
      state.todos = data.todos || state.todos; state.todoRevision += 1; render();
    } catch (error) { showNotice(error.message); }
    finally { saving = false; }
  }
  function clear() {
    const drag = active; active = null;
    if (!drag) return null;
    clearTimeout(drag.timer);
    drag.item.classList.remove("calendar-order-moving");
    drag.target?.classList.remove("calendar-order-before", "calendar-order-after");
    try { drag.handle.releasePointerCapture(drag.pointerId); } catch {}
    return drag;
  }
  function attach(item, todo, date) {
    if (!CalendarOrder.eligible(todo)) return;
    item.dataset.calendarOrderId = todo.id;
    item.dataset.calendarOrderDate = date;
    const handle = document.createElement("span");
    let suppressClickUntil = 0;
    handle.className = "calendar-order-handle";
    handle.textContent = "⠿";
    handle.tabIndex = 0; handle.setAttribute("role", "button");
    handle.setAttribute("aria-label", "Spremeni vrstni red opravila");
    handle.title = "Pridrži in povleci za vrstni red; puščici gor/dol za tipkovnico";
    // Touch browsers may fat-finger-retarget a nearby card tap to this handle.
    // A short tap must still open the event; only a held drag consumes it.
    handle.addEventListener("click", event => {
      event.preventDefault(); event.stopPropagation();
      if (Date.now() >= suppressClickUntil) item.click();
    });
    handle.addEventListener("pointerdown", event => {
      event.stopPropagation();
      if (!event.isPrimary || event.button !== 0 || saving || state.dayTimelineSaving) return;
      clear();
      const drag = { item, handle, pointerId: event.pointerId, x: event.clientX, y: event.clientY, ready: false };
      active = drag;
      drag.timer = setTimeout(() => { if (active === drag) { drag.ready = true; item.classList.add("calendar-order-moving"); } }, 300);
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", event => {
      event.stopPropagation();
      const drag = active;
      if (!drag || drag.handle !== handle || event.pointerId !== drag.pointerId) return;
      if (!drag.ready) { if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) > 9) clear(); return; }
      event.preventDefault();
      drag.target?.classList.remove("calendar-order-before", "calendar-order-after");
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-calendar-order-id]");
      drag.target = target && target !== item && target.dataset.calendarOrderDate === date ? target : null;
      if (drag.target) {
        const rect = target.getBoundingClientRect();
        drag.placement = event.clientY < rect.top + rect.height / 2 ? "before" : "after";
        target.classList.add(`calendar-order-${drag.placement}`);
      }
      const scroller = item.closest(".day-all-day");
      const bounds = scroller?.getBoundingClientRect();
      if (bounds) { if (event.clientY > bounds.bottom - 24) scroller.scrollTop += 12; else if (event.clientY < bounds.top + 24) scroller.scrollTop -= 12; }
    });
    handle.addEventListener("pointerup", event => {
      event.stopPropagation(); event.preventDefault();
      if (active?.handle !== handle) return;
      const drag = clear();
      if (drag?.ready) suppressClickUntil = Date.now() + 700;
      if (drag?.ready && drag.target) save(todo.id, drag.target.dataset.calendarOrderId, drag.placement);
    });
    for (const name of ["pointercancel", "lostpointercapture"]) handle.addEventListener(name, () => { if (active?.handle === handle) clear(); });
    handle.addEventListener("keydown", event => {
      event.stopPropagation();
      if (!["ArrowUp", "ArrowDown"].includes(event.key)) return;
      event.preventDefault();
      const items = [...item.parentElement.querySelectorAll("[data-calendar-order-id]")].filter(el => el.dataset.calendarOrderDate === date);
      const next = items[items.indexOf(item) + (event.key === "ArrowUp" ? -1 : 1)];
      if (next) save(todo.id, next.dataset.calendarOrderId, event.key === "ArrowUp" ? "before" : "after");
    });
    handle.addEventListener("contextmenu", event => event.preventDefault());
    item.prepend(handle);
  }
  return { attach };
}
