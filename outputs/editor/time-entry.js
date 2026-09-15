// Time picker and independent client-billable hours. No HTTP/server dependency.
function createTimeEntryEditor({ $, state, parseBillingNumber, clearFormValidationError, updateTodoFormLateTimeEntryNotice, localStorage }) {
// BEGIN preserved time-entry editor
    function dayTimelineMinutes(value) {
      const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
      if (!match) return null;
      return Number(match[1]) * 60 + Number(match[2]);
    }

    function dayTimelineTime(minutes) {
      const value = Math.max(0, Math.min(1440, Math.round(Number(minutes) || 0)));
      const hours = Math.floor(value / 60);
      const mins = value % 60;
      return String(hours).padStart(2, "0") + ":" + String(mins).padStart(2, "0");
    }

    function roundTimeToQuarter(value) {
      const minutes = dayTimelineMinutes(value);
      if (minutes === null) return "";
      return dayTimelineTime(Math.min(23 * 60 + 45, Math.round(minutes / 15) * 15));
    }

    function normalizeTodoFormTimes() {
      ["todoFormStart", "todoFormEnd"].forEach((id) => {
        const input = $(id);
        if (input.value) input.value = roundTimeToQuarter(input.value);
      });
    }

    function todoFormWorkerMinutes() {
      const start = dayTimelineMinutes($("todoFormStart").value);
      const end = dayTimelineMinutes($("todoFormEnd").value);
      return start !== null && end !== null && end > start ? end - start : 0;
    }

    function todoTimePickerDurationLabel() {
      const total = todoFormWorkerMinutes();
      if (!total) return "Skupaj \u2014";
      const hours = Math.floor(total / 60);
      const minutes = total % 60;
      return "Skupaj " + (hours ? hours + " h" : "") + (hours && minutes ? " " : "") + (minutes ? minutes + " min" : "");
    }

    function formatClientBillableHours(minutes) {
      return Number((Math.max(0, Number(minutes) || 0) / 60).toFixed(2)).toLocaleString("sl-SI", { maximumFractionDigits: 2 });
    }

    function todoFormClientBillableHoursIsManual() {
      return $("todoFormClientBillableHours").dataset.manual === "true";
    }

    function syncTodoFormClientBillableHours({ reset = false } = {}) {
      const field = $("todoFormClientBillableHoursField");
      const resetField = $("todoFormClientBillableHoursResetField");
      const input = $("todoFormClientBillableHours");
      const note = $("todoFormClientBillableHoursNote");
      const enabled = !field.classList.contains("hidden");
      if (reset) input.dataset.manual = "false";
      if (enabled && !todoFormClientBillableHoursIsManual()) input.value = formatClientBillableHours(todoFormWorkerMinutes());
      const manual = enabled && todoFormClientBillableHoursIsManual();
      resetField.classList.toggle("hidden", !enabled || !manual);
      note.textContent = manual
        ? "Ro\u010dno nastavljeno. Sprememba delav\u010devih ur te vrednosti ne bo spremenila."
        : "Samodejno sledi uram delavca.";
    }

    function todoFormClientBillableMinutes() {
      if (!todoFormClientBillableHoursIsManual()) return null;
      const hours = parseBillingNumber($("todoFormClientBillableHours").value, 10_000);
      return hours === null ? null : Math.round(hours * 60 / 15) * 15;
    }

    function todoTimePickerStorageKey() {
      return `indus-ure-last-time-${state.user?.id || "anonymous"}`;
    }

    function rememberedTodoStartTime() {
      try {
        const value = String(localStorage.getItem(todoTimePickerStorageKey()) || "");
        return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? roundTimeToQuarter(value) : "";
      } catch {
        return "";
      }
    }

    function rememberTodoStartTime(value) {
      const normalized = roundTimeToQuarter(value || "");
      if (!normalized) return;
      try { localStorage.setItem(todoTimePickerStorageKey(), normalized); } catch {}
    }

    function todoTimePickerParts(value, fallback = "") {
      const normalized = roundTimeToQuarter(value || fallback || "");
      const match = /^(\d{2}):(\d{2})$/.exec(normalized);
      return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
    }

    function todoTimePickerDefault(target) {
      if (target === "end") {
        const start = dayTimelineMinutes($("todoFormStart").value);
        if (start !== null) return dayTimelineTime(Math.min(23 * 60 + 45, start + 60));
      }
      return rememberedTodoStartTime() || "08:00";
    }

    function renderTodoFormQuickTimePicker() {
      const picker = $("todoFormQuickTimePicker");
      const timeFields = $("todoFormTimeFields");
      if (!picker || !timeFields) return;
      const unavailable = timeFields.classList.contains("hidden") || $("todoFormStart").disabled || $("todoFormEnd").disabled;
      picker.classList.toggle("hidden", unavailable);
      if (unavailable) return;
      const isOpen = state.todoTimePickerOpen === true;
      picker.classList.toggle("is-closed", !isOpen);
      const target = state.todoTimePickerTarget === "end" ? "end" : "start";
      const mode = state.todoTimePickerMode === "minute" ? "minute" : "hour";
      const input = $(target === "end" ? "todoFormEnd" : "todoFormStart");
      const parts = todoTimePickerParts(input.value, todoTimePickerDefault(target));
      const currentHour = parts.hour;
      const currentMinute = parts.minute;
      const startValue = roundTimeToQuarter($("todoFormStart").value || todoTimePickerDefault("start")) || "08:00";
      const startMinutes = dayTimelineMinutes(startValue);
      const endFallback = dayTimelineTime(Math.min(23 * 60 + 45, (startMinutes === null ? 8 * 60 : startMinutes) + 60));
      const endValue = roundTimeToQuarter($("todoFormEnd").value || endFallback) || endFallback;
      $("todoFormQuickTimeStart").classList.toggle("active", isOpen && target === "start");
      $("todoFormQuickTimeEnd").classList.toggle("active", isOpen && target === "end");
      $("todoFormQuickTimeStart").setAttribute("aria-pressed", String(isOpen && target === "start"));
      $("todoFormQuickTimeEnd").setAttribute("aria-pressed", String(isOpen && target === "end"));
      $("todoFormQuickTimeStart").textContent = `Od ${startValue}`;
      $("todoFormQuickTimeEnd").textContent = `Do ${endValue}`;
      $("todoFormQuickTimeDuration").textContent = todoTimePickerDurationLabel();
      $("todoFormQuickTimeHourMode").classList.toggle("active", mode === "hour");
      $("todoFormQuickTimeMinuteMode").classList.toggle("active", mode === "minute");
      $("todoFormQuickTimeHourMode").setAttribute("aria-pressed", String(mode === "hour"));
      $("todoFormQuickTimeMinuteMode").setAttribute("aria-pressed", String(mode === "minute"));
      $("todoFormQuickTimeHint").textContent = mode === "hour"
        ? `Izbira ure ${target === "end" ? "konca" : "začetka"}.`
        : `Izbira minut ${target === "end" ? "konca" : "začetka"}.`;
      const center = `<div class="todo-time-picker-center"><span><time>${String(currentHour).padStart(2, "0")}:${String(currentMinute).padStart(2, "0")}</time><small>${mode === "hour" ? "ura" : "minute"}</small></span></div>`;
      const choices = mode === "hour"
        ? Array.from({ length: 24 }, (_, hour) => {
            const value = String(hour).padStart(2, "0");
            const ring = hour >= 12 ? "inner" : "outer";
            return `<button class="todo-time-picker-choice ${ring}-${hour % 12} ${currentHour === hour ? "active" : ""}" type="button" data-time-picker-hour="${hour}" aria-label="${value} ur" aria-pressed="${currentHour === hour}">${value}</button>`;
          }).join("")
        : [0, 15, 30, 45].map((minute) => {
            const value = String(minute).padStart(2, "0");
            return `<button class="todo-time-picker-choice minute minute-${minute} ${currentMinute === minute ? "active" : ""}" type="button" data-time-picker-minute="${minute}" aria-label="${value} minut" aria-pressed="${currentMinute === minute}">${value}</button>`;
          }).join("");
      $("todoFormQuickTimeDial").innerHTML = `${center}${choices}`;
    }

    function setTodoFormQuickTime(target, { hour = null, minute = null } = {}) {
      const id = target === "end" ? "todoFormEnd" : "todoFormStart";
      const input = $(id);
      if (input.disabled) return;
      const fallback = todoTimePickerParts(input.value, todoTimePickerDefault(target));
      const nextHour = hour === null ? fallback.hour : Math.max(0, Math.min(23, Number(hour)));
      const nextMinute = minute === null ? fallback.minute : Math.max(0, Math.min(45, Number(minute)));
      input.value = `${String(nextHour).padStart(2, "0")}:${String(Math.round(nextMinute / 15) * 15).padStart(2, "0")}`;
      clearFormValidationError($("todoForm"), input);
      normalizeTodoFormTimes();
      if (target === "start") {
        rememberTodoStartTime(input.value);
        const endInput = $("todoFormEnd");
        // The initial end time is merely a one-hour suggestion. Until the
        // user chooses an end time, keep that suggestion one hour after the
        // start time they pick in the circular selector.
        if (!endInput.value || endInput.dataset.autoSuggested === "true") {
          const start = dayTimelineMinutes(input.value);
          endInput.value = dayTimelineTime(Math.min(23 * 60 + 45, start + 60));
          endInput.dataset.autoSuggested = "true";
        }
      } else {
        $("todoFormEnd").dataset.autoSuggested = "false";
      }
      updateTodoFormLateTimeEntryNotice();
      syncTodoFormClientBillableHours();
      renderTodoFormQuickTimePicker();
    }
// END preserved time-entry editor
  return { dayTimelineMinutes, dayTimelineTime, roundTimeToQuarter, normalizeTodoFormTimes, todoFormWorkerMinutes, todoTimePickerDurationLabel, formatClientBillableHours, todoFormClientBillableHoursIsManual, syncTodoFormClientBillableHours, todoFormClientBillableMinutes, todoTimePickerStorageKey, rememberedTodoStartTime, rememberTodoStartTime, todoTimePickerParts, todoTimePickerDefault, renderTodoFormQuickTimePicker, setTodoFormQuickTime };
}
