// editor/worker-billing: explicit dependencies; factory creation has no I/O or UI effects.
function createWorkerBilling({
  $,
  state,
  activeWorker,
  activeWorkerId,
  api,
  dateKey,
  duration,
  escapeHtml,
  financialEntryActions,
  formatDate,
  isAdminView,
  isImportedTodo,
  loadAll,
  minutes,
  money,
  openAdvanceDialog,
  openDayTimeline,
  openDebtDialog,
  parseDate,
  render,
  renderDebtDialog,
  renderReport,
  setView,
  setWorkContext,
  showAppConfirm,
  showAppPrompt,
  showFormValidationError,
  showNotice,
  todoClientSearchText,
  todoStatus,
  uniqueTodosByEventId,
  userDisplayName,
  moduleValues
}) {
async function saveBillingSettings(settings) {
      const data = await api("/api/settings/billing", { method: "PUT", body: JSON.stringify(settings) });
      state.settings = data.settings || state.settings;
      renderReport();
      renderBillingView();
    }

async function lockCurrentReportRange() {
      if (!await showAppConfirm(`Zaklenem obdobje ${$("reportFrom").value} - ${$("reportTo").value} kot obračunano? Ibro potem ne bo mogel spreminjati ur in kilometrov v tem obdobju.`)) return;
      const data = await api("/api/billing-locks", {
        method: "POST",
        body: JSON.stringify({ from: $("reportFrom").value, to: $("reportTo").value, note: "Obračunano" })
      });
      state.billingLocks = data.billingLocks || [];
      showNotice("Obdobje je zaklenjeno kot obračunano.");
    }

async function editBillingSetting(key) {
      const billing = state.settings.billing || { hourlyRate: 15, kmRate: 0.22, workerOwnVehicleKmRate: 0.22, commuteKmPerDay: 28 };
      const labels = {
        hourlyRate: "urna postavka EUR",

        commuteKmPerDay: "kilometri dom-sluzba na dan"
      };
      const next = await showAppPrompt(`Vpiši ${labels[key]}:`, billing[key]);
      if (next === null) return;
      const value = Number(String(next).replace(",", "."));
      if (!Number.isFinite(value) || value < 0) {
        showNotice("Vnesi pravilno številko.");
        return;
      }
      await saveBillingSettings({ ...billing, [key]: value });
    }

function workerDefaultHourlyRate(userId) {
      const worker = state.workerBilling.find((item) => item.id === userId);
      const fallback = Number(state.settings.billing?.hourlyRate || 15);
      return Number.isFinite(Number(worker?.hourlyRate)) ? Number(worker.hourlyRate) : fallback;
    }

function workerCommuteKmOneWay(userId) {
      const worker = state.workerBilling.find((item) => item.id === userId)
        || state.users.find((item) => item.id === userId);
      const value = Number(worker?.commuteKmOneWay || 0);
      return Number.isFinite(value) && value >= 0 ? value : 0;
    }

function withDailyCommuteInBilling(lines, workerId) {
      const dailyCommuteKm = Number((workerCommuteKmOneWay(workerId) * 2).toFixed(2));
      if (!dailyCommuteKm) return lines;
      const appliedDates = new Set();
      return lines.map((line) => {
        const workerKm = Number(line.workerKm ?? line.km ?? 0);
        // Delo od doma se normalno plača, ne sme pa sprožiti poti dom–fabrika.
        // Malica je plačan čas, vendar sama po sebi ne pomeni poti v službo.
        // Ne sme dobiti kilometrine in ne sme porabiti dnevne poti za teren.
        const addCommute = line.status !== "meal" && Boolean(line.commuteEligible) && !Boolean(line.workFromHome) && !appliedDates.has(line.date);
        if (addCommute) appliedDates.add(line.date);
        const commuteKm = addCommute ? dailyCommuteKm : 0;
        const km = Number((workerKm + commuteKm).toFixed(2));
        const kmAmount = Number((km * Number(line.kmRate || 0)).toFixed(2));
        return {
          ...line,
          workerKm,
          commuteKm,
          km,
          kmAmount,
          totalAmount: Number((Number(line.workAmount || 0) + kmAmount).toFixed(2))
        };
      });
    }

function todoHourlyRate(todo) {
      if (todo.billingHourlyRate !== null && todo.billingHourlyRate !== undefined && todo.billingHourlyRate !== "") {
        const value = Number(todo.billingHourlyRate);
        if (Number.isFinite(value)) return value;
      }
      return workerDefaultHourlyRate(todo.syncUser || todo.createdBy);
    }

function parseBillingNumber(value, maximum) {
      const number = Number(String(value).replace(",", "."));
      return Number.isFinite(number) && number >= 0 && number <= maximum ? number : null;
    }

function renderWorkerBillingTable() {
      const body = $("workerBillingRows");
      if (!body) return;
      body.replaceChildren();
      state.workerBilling
        .slice()
        .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), "sl"))
        .forEach((worker) => {
          const row = document.createElement("tr");
          row.dataset.userId = worker.id;
          row.innerHTML = `
            <td><strong>${escapeHtml(worker.name || worker.id)}</strong></td>
            <td>${worker.role === "boss" ? "Šef in delavec" : "Delavec"}</td>
            <td><input class="worker-rate-input" type="number" min="0" max="10000" step="0.01" value="${Number(worker.hourlyRate || 0)}" aria-label="Urna postavka za ${escapeHtml(worker.name || worker.id)}"> EUR/h</td>
            <td><input class="worker-commute-input" type="number" min="0" max="1000000" step="0.1" value="${Number(worker.commuteKmOneWay || 0)}" aria-label="Pot v službo v eno smer za ${escapeHtml(worker.name || worker.id)}"> km</td>
            <td><input class="worker-export-title-input" type="text" maxlength="120" value="${escapeHtml(worker.exportTitle || "")}" placeholder="Npr. monter" aria-label="Naziv izvajalca v izvozu za ${escapeHtml(worker.name || worker.id)}"></td>
            <td><button class="secondary save-worker-rate" type="button">Shrani</button></td>
          `;
          row.querySelector(".save-worker-rate").addEventListener("click", async (event) => {
            const input = row.querySelector(".worker-rate-input");
            const hourlyRate = parseBillingNumber(input.value, 10_000);
            const commuteKmOneWay = parseBillingNumber(row.querySelector(".worker-commute-input").value, 1_000_000);
            const exportTitle = row.querySelector(".worker-export-title-input").value.trim();
            if (hourlyRate === null || commuteKmOneWay === null) {
              showNotice("Vnesi pravilno urno postavko in pot v sluzbo.");
              return;
            }
            event.currentTarget.disabled = true;
            try {
              const data = await api("/api/workers/billing", {
                method: "PUT",
                body: JSON.stringify({ userId: worker.id, hourlyRate, commuteKmOneWay, exportTitle })
              });
              state.workerBilling = data.workers || state.workerBilling;
              render();
            } catch (error) {
              event.currentTarget.disabled = false;
              showNotice(error.message);
            }
          });
          body.appendChild(row);
        });
    }

async function saveDebtToServer(debt) {
      const method = debt.id ? "PUT" : "POST";
      const path = debt.id ? `/api/debts/${debt.id}` : "/api/debts";
      const data = await api(path, { method, body: JSON.stringify(debt) });
      state.debts = data.debts;
      render();
      renderDebtDialog();
    }

async function deleteDebtFromServer(id) {
      const data = await api(`/api/debts/${id}`, { method: "DELETE" });
      state.debts = data.debts;
      render();
      renderDebtDialog();
    }

function openPaymentDialog() {
      const payroll = payrollForBilling(billingWorkerId(), billingRange());
      if (!payroll) return;
      const remaining = Number(payroll.remainingAmount ?? (Number(payroll.payoutAmount || payroll.totalAmount || 0) - Number(payroll.paidAmount || 0)));
      if (remaining <= 0.005) { showNotice("Ta obračun je že v celoti izplačan."); return; }
      $("paymentRemaining").textContent = `Preostanek za izplačilo: ${money(remaining)} EUR`;
      $("paymentAmount").value = "";
      $("paymentAmount").max = remaining.toFixed(2);
      $("paymentNote").value = "";
      $("paymentDialog").showModal();
    }

async function savePaymentFromDialog() {
      const payroll = payrollForBilling(billingWorkerId(), billingRange());
      if (!payroll) return;
      const amount = Number(String($("paymentAmount").value || "").replace(",", "."));
      const remaining = Number(payroll.remainingAmount ?? (Number(payroll.payoutAmount || payroll.totalAmount || 0) - Number(payroll.paidAmount || 0)));
      if (!Number.isFinite(amount) || amount <= 0) return showFormValidationError($("paymentForm"), "Vpiši znesek za izplačilo.", $("paymentAmount"));
      if (amount > remaining + 0.005) return showFormValidationError($("paymentForm"), `Znesek ne sme presegati preostanka (${money(remaining)} EUR).`, $("paymentAmount"));
      const data = await api(`/api/payrolls/${encodeURIComponent(payroll.id)}/payments`, { method: "POST", body: JSON.stringify({ amount, note: $("paymentNote").value.trim() }) });
      state.payrolls = data.payrolls || state.payrolls;
      $("paymentDialog").close();
      await loadAll();
      renderBillingView();
    }

function advanceProjectOptions() {
      const query = $("advanceProjectSearch")?.value.trim().toLocaleLowerCase("sl") || "";
      return uniqueTodosByEventId(state.todos).filter((todo) => !isImportedTodo(todo) && ["execution", "open", "in_progress", "internal"].includes(todo.status)).filter((todo) => !query || `${todo.title} ${todoClientSearchText(todo)} ${todo.notes}`.toLocaleLowerCase("sl").includes(query)).sort((a, b) => String(a.title).localeCompare(String(b.title), "sl"));
    }

function renderAdvanceProjects() {
      const select = $("advanceProject"); if (!select) return;
      const selected = select.value;
      select.innerHTML = `<option value="">Brez povezave</option>${advanceProjectOptions().map((todo) => `<option value="${escapeHtml(todo.id)}">${escapeHtml([todo.client, todo.title, todoStatus(todo.status).label].filter(Boolean).join(" · "))}</option>`).join("")}`;
      if ([...select.options].some((option) => option.value === selected)) select.value = selected;
    }

async function deleteAdvanceFromBilling(id) {
      if (!await showAppConfirm("Izbrišem založeni znesek?")) return;
      const before = state.advances;
      state.advances = before.filter((item) => item.id !== id);
      renderBillingView();
      try {
        const data = await api(`/api/advances/${encodeURIComponent(id)}`, { method: "DELETE" });
        state.advances = data.advances || state.advances;
        await loadAll();
        renderBillingView();
      } catch (error) {
        state.advances = before;
        renderBillingView();
        throw error;
      }
    }

async function deletePersonalPurchaseFromBilling(id) {
      if (!await showAppConfirm("Izbrišem osebni nakup?")) return;
      const before = state.personalPurchases;
      state.personalPurchases = before.filter((item) => item.id !== id);
      renderBillingView();
      try {
        const data = await api(`/api/personal-purchases/${encodeURIComponent(id)}`, { method: "DELETE" });
        state.personalPurchases = data.purchases || state.personalPurchases;
        await loadAll();
        renderBillingView();
      } catch (error) {
        state.personalPurchases = before;
        renderBillingView();
        throw error;
      }
    }

async function deletePayrollPaymentFromBilling(payrollId, paymentId) {
      if (!await showAppConfirm("Izbrišem evidentirano izplačilo? Obračun bo znova odprt za preostanek izplačila.")) return;
      const data = await api(`/api/payrolls/${encodeURIComponent(payrollId)}/payments/${encodeURIComponent(paymentId)}`, { method: "DELETE" });
      state.payrolls = data.payrolls || state.payrolls;
      await loadAll();
      renderBillingView();
    }

function manualClientBillableMinutes(value) {
      if (value === null || value === "" || typeof value === "undefined") return null;
      const number = Number(value);
      return Number.isFinite(number) && number >= 0 && number <= 1000000 ? Math.round(number / 15) * 15 : null;
    }

function optionalReportHours(todo = {}) {
      const raw = todo?.reportHours;
      if (raw === null || raw === "" || typeof raw === "undefined") return null;
      const hours = Number(raw);
      return Number.isFinite(hours) ? hours : null;
    }

function todoClientBillableMinutes(todo = {}) {
      const reportHours = optionalReportHours(todo);
      if (reportHours !== null) return Math.round(reportHours * 60);
      const grouped = manualClientBillableMinutes(todo.eventClientBillableMinutes);
      if (grouped !== null) return grouped;
      const manual = manualClientBillableMinutes(todo.clientBillableMinutes);
      return manual === null ? Math.round(duration(todo) * 60) : manual;
    }

function todoClientBillableHours(todo = {}) {
      return Number((todoClientBillableMinutes(todo) / 60).toFixed(2));
    }

function mealPaidMinutes() {
      const configured = Number(state.settings?.billing?.mealPaidMinutes);
      return Number.isFinite(configured) ? Math.max(0, Math.min(240, Math.round(configured))) : 45;
    }

function payrollMinutesForTodo(todo) {
      const total = Math.round(duration(todo) * 60);
      return todo.status === "meal" ? Math.min(total, mealPaidMinutes()) : total;
    }

function uniqueHours(entries) {
      const byDate = new Map();
      entries.forEach((entry) => {
        if (!entry.date || !entry.start || !entry.end) return;
        const start = minutes(entry.start);
        const end = minutes(entry.end);
        if (end <= start) return;
        if (!byDate.has(entry.date)) byDate.set(entry.date, []);
        byDate.get(entry.date).push([start, end]);
      });
      let total = 0;
      byDate.forEach((intervals) => {
        intervals.sort((a, b) => a[0] - b[0]);
        let current = null;
        intervals.forEach(([start, end]) => {
          if (!current) {
            current = [start, end];
            return;
          }
          if (start <= current[1]) {
            current[1] = Math.max(current[1], end);
          } else {
            total += current[1] - current[0];
            current = [start, end];
          }
        });
        if (current) total += current[1] - current[0];
      });
      return total / 60;
    }

function openBillingRangePicker() {
      const range = billingRange();
      state.billingRangeDraft = { from: range.from, to: range.to, month: range.from.slice(0, 7) };
      renderBillingRangePicker();
      $("billingRangeDialog").showModal();
    }

function shiftBillingRangePickerMonth(direction) {
      const draft = state.billingRangeDraft;
      if (!draft) return;
      const [year, month] = String(draft.month || dateKey(new Date()).slice(0, 7)).split("-").map(Number);
      const target = new Date(year, month - 1 + direction, 1);
      const targetMonth = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, "0")}`;
      const maxDate = billingMaximumSelectableDate();
      if (direction > 0 && targetMonth > maxDate.slice(0, 7)) return;
      draft.month = targetMonth;
      renderBillingRangePicker();
    }

function selectBillingRangeDate(key) {
      const draft = state.billingRangeDraft;
      const maxDate = billingMaximumSelectableDate();
      if (!draft || key > maxDate) return;
      if (!draft.from || draft.to) {
        draft.from = key;
        draft.to = "";
      } else if (key < draft.from) {
        draft.to = draft.from;
        draft.from = key;
      } else {
        draft.to = key;
      }
      renderBillingRangePicker();
    }

function renderBillingRangePicker() {
      const draft = state.billingRangeDraft;
      if (!draft) return;
      const maxDate = billingMaximumSelectableDate();
      const [year, month] = String(draft.month).split("-").map(Number);
      const first = new Date(year, month - 1, 1);
      const daysInMonth = new Date(year, month, 0).getDate();
      const leading = (first.getDay() + 6) % 7;
      $("billingRangeMonthTitle").textContent = `${moduleValues.monthNames[month - 1]} ${year}`;
      $("billingRangeNext").disabled = draft.month >= maxDate.slice(0, 7);
      $("billingRangeNext").title = $("billingRangeNext").disabled ? "Novejše obračunsko obdobje še ni na voljo." : "Naslednji mesec";
      const cells = Array.from({ length: leading }, () => `<span class="billing-range-empty" aria-hidden="true"></span>`);
      for (let day = 1; day <= daysInMonth; day += 1) {
        const key = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
        const unavailable = key > maxDate;
        const inRange = !unavailable && Boolean(draft.from && draft.to && key >= draft.from && key <= draft.to);
        const classes = [inRange ? "is-range" : "", key === draft.from ? "is-range-start" : "", key === draft.to ? "is-range-end" : ""].filter(Boolean).join(" ");
        cells.push(`<button type="button" class="${classes}" data-range-date="${key}" aria-label="${escapeHtml(formatDate(key))}"${unavailable ? " disabled" : ""}>${day}</button>`);
      }
      $("billingRangeCalendarDays").innerHTML = cells.join("");
      $("billingRangeCalendarDays").querySelectorAll("[data-range-date]").forEach((button) => button.addEventListener("click", () => selectBillingRangeDate(button.dataset.rangeDate)));
      $("billingRangeHint").textContent = !draft.from || !draft.to
        ? "Izberi začetek in konec obdobja. Za en sam dan klikni datum dvakrat."
        : `Izbrano: ${billingRangeLabel(draft)}.`;
    }

function applyBillingRangePicker() {
      const draft = state.billingRangeDraft;
      const maxDate = billingMaximumSelectableDate();
      if (!draft?.from || draft.from > maxDate) return;
      $("billingFrom").value = draft.from;
      $("billingTo").value = (draft.to || draft.from) > maxDate ? maxDate : (draft.to || draft.from);
      saveBillingRangeSelection(billingWorkerId(), { from: $("billingFrom").value, to: $("billingTo").value });
      $("billingRangeDialog").close();
      state.billingRangeDraft = null;
      renderBillingView();
    }

function billingTodayKey(now = new Date()) {
      return dateKey(now);
    }

function billingDateAfter(key) {
      const date = parseDate(key);
      date.setDate(date.getDate() + 1);
      return dateKey(date);
    }

function billingDateBefore(key) {
      const date = parseDate(key);
      date.setDate(date.getDate() - 1);
      return dateKey(date);
    }

function billingMonthStart(key) {
      return /^\d{4}-\d{2}-\d{2}$/.test(String(key || "")) ? `${String(key).slice(0, 7)}-01` : "";
    }

function billingMaximumSelectableDate(now = new Date()) {
      return billingTodayKey(now);
    }

function billingMonthEnd(key) {
      const [year, month] = String(key || "").slice(0, 7).split("-").map(Number);
      if (!year || !month) return "";
      return `${year}-${String(month).padStart(2, "0")}-${String(new Date(year, month, 0).getDate()).padStart(2, "0")}`;
    }

function billingRangeSelectionForWorker(workerId) {
      const selection = state.billingRangeSelections?.[workerId];
      if (selection?.mode !== "custom") return { mode: "auto", from: "", to: "" };
      return { mode: "custom", from: String(selection.from || ""), to: String(selection.to || "") };
    }

function saveBillingRangeSelection(workerId, range) {
      if (!workerId) return;
      state.billingRangeSelections[workerId] = {
        mode: "custom",
        from: String(range?.from || ""),
        to: String(range?.to || "")
      };
    }

function billingAvailableEntryDates(workerId, now = new Date()) {
      const maxDate = billingMaximumSelectableDate(now);
      return [...new Set(billingLiveLines(workerId, { from: "1900-01-01", to: maxDate })
        .map((line) => String(line.date || ""))
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) && date <= maxDate))]
        .sort((left, right) => left.localeCompare(right));
    }

function billingFallbackEntryDate(workerId, targetDate, now = new Date()) {
      const dates = billingAvailableEntryDates(workerId, now);
      const onOrBefore = dates.filter((date) => date <= targetDate);
      return onOrBefore.at(-1) || dates[0] || "";
    }

function applyBillingRangeSelection(workerId, range) {
      if (!workerId || !range?.from || !range?.to) return null;
      $("billingFrom").value = range.from;
      $("billingTo").value = range.to;
      saveBillingRangeSelection(workerId, range);
      renderBillingView();
      return { from: $("billingFrom").value, to: $("billingTo").value };
    }

function applyBillingQuickRange(preset, now = new Date()) {
      const workerId = billingWorkerId();
      const today = billingMaximumSelectableDate(now);
      const currentMonthStart = billingMonthStart(today);
      const latest = latestBillingPeriod(workerId, now);
      let range = null;
      let notice = "";

      if (preset === "current-month") {
        range = {
          from: [currentMonthStart, latest?.from || currentMonthStart].sort().at(-1),
          to: today
        };
      } else if (preset === "previous-month") {
        const previousMonthEnd = billingDateBefore(currentMonthStart);
        range = { from: billingMonthStart(previousMonthEnd), to: previousMonthEnd };
      } else if (preset === "open-to-yesterday") {
        const yesterday = billingDateBefore(today);
        const previous = latestCompletedPayroll(workerId);
        const availableDates = billingAvailableEntryDates(workerId, now).filter((date) => date <= yesterday);
        const from = previous ? billingDateAfter(previous.to) : (availableDates[0] || billingMonthStart(yesterday));
        if (from > yesterday) {
          showNotice("Do včeraj ni odprtih dni za obračun.");
          return;
        }
        range = { from, to: yesterday };
      } else if (preset === "today" || preset === "yesterday") {
        const requestedDate = preset === "today" ? today : billingDateBefore(today);
        let selectedDate = requestedDate;
        const availableDates = billingAvailableEntryDates(workerId, now);
        if (!availableDates.includes(requestedDate)) {
          const fallbackDate = billingFallbackEntryDate(workerId, requestedDate, now);
          if (fallbackDate) {
            selectedDate = fallbackDate;
            notice = `Za ${preset === "today" ? "danes" : "včeraj"} ni vpisanih ur. Prikazan je ${formatDate(fallbackDate)}, kjer so vpisane ure.`;
          } else {
            notice = `Za ${preset === "today" ? "danes" : "včeraj"} ni vpisanih ur.`;
          }
        }
        range = { from: selectedDate, to: selectedDate };
      }

      if (!range) return;
      applyBillingRangeSelection(workerId, range);
      if (notice) showNotice(notice);
    }

function latestCompletedPayroll(workerId) {
      return state.payrolls
        .filter((payroll) => payroll.workerId === workerId
          && ["archiving", "confirmed", "paid"].includes(payroll.status)
          && /^\d{4}-\d{2}-\d{2}$/.test(String(payroll.to || "")))
        .sort((left, right) => String(right.to).localeCompare(String(left.to)))[0] || null;
    }

function billingPayrollsForWorker(workerId) {
      return state.payrolls
        .filter((payroll) => payroll.workerId === workerId
          && /^\d{4}-\d{2}-\d{2}$/.test(String(payroll.from || ""))
          && /^\d{4}-\d{2}-\d{2}$/.test(String(payroll.to || "")))
        .slice()
        .sort((left, right) => String(left.from).localeCompare(String(right.from)) || String(left.to).localeCompare(String(right.to)));
    }

function earliestBillingPayroll(workerId) {
      return billingPayrollsForWorker(workerId)[0] || null;
    }

function latestOpenBillingPayroll(workerId) {
      return billingPayrollsForWorker(workerId)
        .filter((payroll) => ["draft", "archiving"].includes(payroll.status))
        .sort((left, right) => String(right.to).localeCompare(String(left.to)))[0] || null;
    }

function billingPreviousPayroll(workerId, current = {}) {
      const range = typeof current === "string" ? { from: current, to: current } : (current || {});
      return billingPayrollsForWorker(workerId)
        .filter((payroll) => !(payroll.from === range.from && payroll.to === range.to))
        .filter((payroll) => payroll.to <= String(range.from || ""))
        .sort((left, right) => String(right.to).localeCompare(String(left.to)) || String(right.from).localeCompare(String(left.from)))[0] || null;
    }

function billingNextPayroll(workerId, current = {}) {
      const range = typeof current === "string" ? { from: current, to: current } : (current || {});
      return billingPayrollsForWorker(workerId)
        .filter((payroll) => !(payroll.from === range.from && payroll.to === range.to))
        .filter((payroll) => payroll.from >= String(range.to || ""))
        .sort((left, right) => String(left.from).localeCompare(String(right.from)) || String(left.to).localeCompare(String(right.to)))[0] || null;
    }

function latestBillingPeriod(workerId, now = new Date()) {
      const today = billingTodayKey(now);
      const previous = latestCompletedPayroll(workerId);
      const from = previous ? billingDateAfter(previous.to) : today.slice(0, 7) + "-01";
      if (from > today) return null;
      return { from, to: today };
    }

function updateBillingRangeControls(range = null) {
      const workerId = billingWorkerId();
      const latest = latestBillingPeriod(workerId);
      const earliest = earliestBillingPayroll(workerId);
      const current = range || { from: $("billingFrom").value, to: $("billingTo").value };
      const selectedPayroll = billingPayrollsForWorker(workerId).find((payroll) => payroll.from === current?.from && payroll.to === current?.to);
      const normalMaxDate = billingMaximumSelectableDate();
      const maxDate = selectedPayroll?.to > normalMaxDate ? selectedPayroll.to : normalMaxDate;
      $("billingFrom").min = earliest?.from || "";
      $("billingTo").min = earliest?.from || "";
      $("billingFrom").max = maxDate;
      $("billingTo").max = maxDate;
      const previous = $("billingPrevMonth");
      const previousPayroll = billingPreviousPayroll(workerId, current);
      previous.disabled = !previousPayroll;
      previous.title = previous.disabled ? "Starejšega obračuna ni." : "Prejšnji obračun";
      const next = $("billingNextMonth");
      const nextPayroll = billingNextPayroll(workerId, current);
      next.disabled = !nextPayroll && (!latest || !current?.to || current.to >= latest.to);
      next.title = next.disabled ? "Novejše obračunsko obdobje še ni na voljo." : "Naslednje obdobje";
    }

function billingRange() {
      const monthInput = $("billingMonth");
      const workerId = billingWorkerId();
      const latest = latestBillingPeriod(workerId);
      const earliest = earliestBillingPayroll(workerId);
      const openPayroll = latestOpenBillingPayroll(workerId);
      const fallback = latest || openPayroll || (() => {
        const today = billingTodayKey();
        return { from: `${today.slice(0, 7)}-01`, to: today };
      })();
      const fromInput = $("billingFrom");
      const toInput = $("billingTo");
      const selection = billingRangeSelectionForWorker(workerId);
      const custom = selection.mode === "custom";
      const openCoversNewestRange = Boolean(openPayroll && (!latest || openPayroll.to >= latest.to));

      // The automatic view always follows the latest billable day. A deliberate
      // custom choice, or an open draft that already covers that day, stays put.
      if (custom) {
        fromInput.value = selection.from;
        toInput.value = selection.to;
      } else if (openCoversNewestRange) {
        fromInput.value = openPayroll.from;
        toInput.value = openPayroll.to;
      } else {
        fromInput.value = fallback.from;
        toInput.value = fallback.to;
      }

      if (!/^\d{4}-\d{2}-\d{2}$/.test(fromInput.value)) fromInput.value = fallback.from;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(toInput.value) || toInput.value < fromInput.value) toInput.value = fallback.to;
      const selectedPayroll = billingPayrollsForWorker(workerId).find((payroll) => payroll.from === fromInput.value && payroll.to === toInput.value);
      // Older browsers may still have the former shared-boundary selection in
      // local storage. A stored payroll itself remains readable, but a new
      // range beginning on the already settled final day must start tomorrow.
      const previousConfirmed = latestCompletedPayroll(workerId);
      if (!selectedPayroll && previousConfirmed && fromInput.value === previousConfirmed.to) {
        fromInput.value = billingDateAfter(previousConfirmed.to);
        if (toInput.value < fromInput.value) toInput.value = fromInput.value;
      }
      const maxDate = billingMaximumSelectableDate();
      if (!selectedPayroll && (fromInput.value > maxDate || toInput.value > maxDate)) {
        fromInput.value = fallback.from;
        toInput.value = fallback.to;
      }
      if (earliest && fromInput.value < earliest.from) {
        fromInput.value = earliest.from;
        toInput.value = earliest.to;
      }
      const range = { from: fromInput.value, to: toInput.value };
      if (custom) saveBillingRangeSelection(workerId, range);
      monthInput.value = range.from.slice(0, 7);
      updateBillingRangeControls(range);
      return range;
    }

function staleOpenBillingPayroll(workerId) {
      const latest = latestBillingPeriod(workerId);
      const open = latestOpenBillingPayroll(workerId);
      if (!latest || !open || open.to >= latest.to || open.from !== latest.from) return null;
      return open;
    }

function billingRangeLabel(range) {
      if (!range?.from || !range?.to) return "";
      const from = formatDate(range.from);
      const to = formatDate(range.to);
      return range.from === range.to ? from : `${from} – ${to}`;
    }

function billingWorkerId() {
      if (!isAdminView()) return activeWorkerId();
      const workers = state.workerBilling.length ? state.workerBilling : state.users;
      const valid = new Set(workers.map((worker) => worker.id));
      valid.add(moduleValues.allBillingWorkersId);
      if (!valid.has(state.billingWorkerId)) {
        const stored = localStorage.getItem(moduleValues.billingWorkerKey) || "";
        state.billingWorkerId = valid.has(stored) ? stored : (workers[0]?.id || state.user?.id || "");
      }
      return state.billingWorkerId;
    }

function billingWorker() {
      const workerId = billingWorkerId();
      return state.workerBilling.find((worker) => worker.id === workerId)
        || state.users.find((worker) => worker.id === workerId)
        || activeWorker();
    }

function payrollForBilling(workerId, range) {
      return state.payrolls.find((payroll) => payroll.workerId === workerId && payroll.from === range.from && payroll.to === range.to) || null;
    }

function lockedBillingTodoIds(workerId) {
      return new Set(state.payrolls
        .filter((payroll) => payroll.workerId === workerId && ["archiving", "confirmed", "paid"].includes(payroll.status))
        .flatMap((payroll) => payroll.lines || [])
        .map((line) => String(line.todoId || ""))
        .filter(Boolean));
    }

function lockedBillingFinancialIds(workerId, field) {
      return new Set(state.payrolls
        .filter((payroll) => payroll.workerId === workerId && ["archiving", "confirmed", "paid"].includes(payroll.status))
        .flatMap((payroll) => Array.isArray(payroll[field]) ? payroll[field] : [])
        .map((id) => String(id || ""))
        .filter(Boolean));
    }

function billingLiveLines(workerId, range) {
      const kmRate = Number(state.settings.billing?.workerOwnVehicleKmRate ?? state.settings.billing?.kmRate ?? 0);
      const lockedTodoIds = lockedBillingTodoIds(workerId);
      const lines = state.todos
        .filter((todo) => !isImportedTodo(todo) && (todo.syncUser || todo.createdBy) === workerId && moduleValues.payrollPaidTodoStatuses.has(todo.status) && String(todo.date || "") >= range.from && String(todo.date || "") <= range.to)
        .filter((todo) => !lockedTodoIds.has(String(todo.id || "")))
        .map((todo) => {
          const minutes = payrollMinutesForTodo(todo);
          const scheduledMinutes = Math.round(duration(todo) * 60);
          const unpaidMealMinutes = todo.status === "meal" ? Math.max(0, scheduledMinutes - minutes) : 0;
          const hours = minutes / 60;
          const hourlyRate = todoHourlyRate(todo);
          const workerKm = Number(todo.billingKm || 0);
          const workAmount = Number((hours * hourlyRate).toFixed(2));
          const kmAmount = Number((workerKm * kmRate).toFixed(2));
          return { todoId: todo.id, assignmentGroupId: todo.assignmentGroupId || todo.id, workerId, date: todo.date, start: todo.start, end: todo.end, title: todo.title, client: todo.client, status: todo.status, minutes, unpaidMealMinutes, hours, hourlyRate, workerKm, workFromHome: Boolean(todo.workFromHome), commuteEligible: Boolean(todo.commuteEligible), commuteKm: 0, km: workerKm, kmRate, workAmount, kmAmount, totalAmount: Number((workAmount + kmAmount).toFixed(2)) };
        })
        .filter((line) => line.hours > 0)
        .sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.start).localeCompare(String(b.start)) || String(a.title).localeCompare(String(b.title)));
      return withDailyCommuteInBilling(lines, workerId);
    }

function billingAdvances(workerId, range) {
      const lockedIds = lockedBillingFinancialIds(workerId, "advanceIds");
      return (state.advances || []).filter((advance) => advance.person === workerId && advance.date >= range.from && advance.date <= range.to && !lockedIds.has(String(advance.id || "")));
    }

function billingPersonalPurchases(workerId, range) {
      const lockedIds = lockedBillingFinancialIds(workerId, "personalPurchaseIds");
      return (state.personalPurchases || []).filter((purchase) => purchase.person === workerId && purchase.date >= range.from && purchase.date <= range.to && !lockedIds.has(String(purchase.id || "")));
    }

function billingClientReceipts(workerId, range) {
      const lockedIds = lockedBillingFinancialIds(workerId, "clientReceiptIds");
      return (state.debts || []).filter((receipt) => receipt.type === "client_receipt"
        && receipt.person === workerId
        && receipt.date >= range.from
        && receipt.date <= range.to
        && !lockedIds.has(String(receipt.id || "")));
    }

function billingDisplayActivities(workerId, range, billedLines) {
      return (billedLines || []).filter((line) => String(line.date || "") >= range.from && String(line.date || "") <= range.to).filter((line) => /^\d{2}:\d{2}$/.test(String(line.start || "")) && /^\d{2}:\d{2}$/.test(String(line.end || ""))).filter((line) => Number(line.minutes || 0) > 0).map((line) => ({ ...line, payable: true })).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.start).localeCompare(String(b.start)) || String(a.end).localeCompare(String(b.end)));
    }

function billingGapMinutes(previous, next) {
      return Math.max(0, minutes(next.start) - minutes(previous.end));
    }

function billingGapLabel(value) {
      const minutes = Math.round(Number(value) || 0);
      if (minutes < 60) return `${minutes} min`;
      const hours = Math.floor(minutes / 60);
      const remaining = minutes % 60;
      return remaining ? `${hours} h ${remaining} min` : `${hours} h`;
    }

function openBillingDayTimeline(workerId, date) {
      if (!date) return;
      if (isAdminView() && workerId && workerId !== activeWorkerId()) setWorkContext(`worker:${workerId}`);
      openDayTimeline(date, { includeArchived: true });
    }

function billingLineTotals(lines) {
      const minutes = lines.reduce((total, line) => total + Number(line.minutes || 0), 0);
      const workAmount = Number(lines.reduce((total, line) => total + Number(line.workAmount || 0), 0).toFixed(2));
      const km = Number(lines.reduce((total, line) => total + Number(line.km || 0), 0).toFixed(2));
      const kmAmount = Number(lines.reduce((total, line) => total + Number(line.kmAmount || 0), 0).toFixed(2));
      return { minutes, hours: minutes / 60, km, workAmount, kmAmount, totalAmount: Number((workAmount + kmAmount).toFixed(2)) };
    }

function billingUnpaidMealMinutes(line) {
      if (String(line?.status || "") !== "meal") return 0;
      const storedMinutes = Math.max(0, Math.round(Number(line?.unpaidMealMinutes || 0)));
      const start = /^\d{2}:\d{2}$/.test(String(line?.start || "")) ? minutes(line.start) : NaN;
      const end = /^\d{2}:\d{2}$/.test(String(line?.end || "")) ? minutes(line.end) : NaN;
      const scheduledMinutes = end - start;
      const inferredMinutes = Number.isFinite(scheduledMinutes)
        ? Math.max(0, scheduledMinutes - Math.round(Number(line?.minutes || 0)))
        : 0;
      return Math.max(storedMinutes, inferredMinutes);
    }

function billingHoursBreakdown(lines) {
      const groups = [];
      const append = (rawMinutes, rawRate, type) => {
        const groupMinutes = Math.max(0, Math.round(Number(rawMinutes || 0)));
        if (!groupMinutes) return;
        const hourlyRate = Number.isFinite(Number(rawRate)) ? Number(rawRate) : 0;
        const previous = groups[groups.length - 1];
        if (previous && previous.type === type && previous.hourlyRate === hourlyRate) {
          previous.minutes += groupMinutes;
          return;
        }
        groups.push({ minutes: groupMinutes, hourlyRate, type });
      };
      lines.forEach((line) => {
        const type = String(line?.status || "") === "meal" ? "meal" : "work";
        append(line?.minutes, line?.hourlyRate, type);
        if (type === "meal") append(billingUnpaidMealMinutes(line), 0, "meal");
      });
      return groups.map((group) => `${group.type === "meal" ? "malica " : ""}${(group.minutes / 60).toLocaleString("sl-SI", { maximumFractionDigits: 2 })} h po ${money(group.hourlyRate)} EUR/h`).join(" · ");
    }

function billingDayBreakdownMarkup(lines, totals) {
      const workGroups = [];
      const kmGroups = [];
      const appendWork = (rawMinutes, rawRate, type) => {
        const minutesValue = Math.max(0, Math.round(Number(rawMinutes || 0)));
        if (!minutesValue) return;
        const hourlyRate = Number.isFinite(Number(rawRate)) ? Number(rawRate) : 0;
        const existing = workGroups.find((group) => group.hourlyRate === hourlyRate && group.type === type);
        if (existing) existing.minutes += minutesValue;
        else workGroups.push({ minutes: minutesValue, hourlyRate, type });
      };
      const appendKm = (line) => {
        const km = Math.max(0, Number(line?.km || 0));
        if (!km) return;
        const kmRate = Number.isFinite(Number(line?.kmRate)) ? Number(line.kmRate) : 0;
        const amount = Number(line?.kmAmount || 0);
        const existing = kmGroups.find((group) => group.kmRate === kmRate);
        if (existing) {
          existing.km += km;
          existing.amount += amount;
        } else {
          kmGroups.push({ km, kmRate, amount });
        }
      };
      lines.forEach((line) => {
        const type = String(line?.status || "") === "meal" ? "meal" : "work";
        appendWork(line?.minutes, line?.hourlyRate, type);
        if (type === "meal") appendWork(billingUnpaidMealMinutes(line), 0, "meal");
        appendKm(line);
      });
      const rows = [
        ...workGroups.map((group) => {
          const hours = group.minutes / 60;
          const label = `${group.type === "meal" ? "Malica" : "Delo"}: ${hours.toLocaleString("sl-SI", { maximumFractionDigits: 2 })} h po ${money(group.hourlyRate)} EUR/h`;
          return `<span class="billing-day-breakdown-line is-detail"><span>${escapeHtml(label)}</span><strong>${money(hours * group.hourlyRate)} EUR</strong></span>`;
        }),
        ...kmGroups.map((group) => {
          const label = `Prevoz: ${group.km.toLocaleString("sl-SI", { maximumFractionDigits: 1 })} km po ${money(group.kmRate)} EUR/km`;
          return `<span class="billing-day-breakdown-line is-detail"><span>${escapeHtml(label)}</span><strong>${money(group.amount)} EUR</strong></span>`;
        })
      ];
      rows.push(`<span class="billing-day-breakdown-line is-total"><span>Skupaj delo</span><strong>${money(totals.workAmount)} EUR</strong></span>`);
      rows.push(`<span class="billing-day-breakdown-line is-total"><span>Skupaj prevoz · ${totals.km.toLocaleString("sl-SI", { maximumFractionDigits: 1 })} km</span><strong>${money(totals.kmAmount)} EUR</strong></span>`);
      rows.push(`<span class="billing-day-breakdown-line is-total is-payout"><span>Skupaj za izplačilo</span><strong>${money(totals.totalAmount)} EUR</strong></span>`);
      return `<span class="billing-day-breakdown">${rows.join("")}</span>`;
    }

function payrollStateLabel(payroll, isAdmin) {
      if (!payroll) return isAdmin ? "Za potrditev" : "V pripravi";
      if (payroll.status === "draft") return "Odprto za potrditev";
      if (payroll.status === "archiving") return "Arhiviranje v teku";
      if (payroll.status === "confirmed") return "Potrjeno · arhivirano";
      return "Plačano";
    }

function renderBillingWorkerSelect(workerId) {
      const select = $("billingWorker");
      if (!select || !isAdminView()) return;
      const workers = (state.workerBilling.length ? state.workerBilling : state.users)
        .slice()
        .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), "sl"));
      select.innerHTML = '<option value="' + moduleValues.allBillingWorkersId + '">Vsi delavci</option>' + workers.map((worker) => '<option value="' + escapeHtml(worker.id) + '">' + escapeHtml(worker.name || worker.id) + (worker.role === "boss" ? " (šef)" : "") + '</option>').join("");
      select.value = workerId;
    }

function payrollPeriodEnded(range, now = new Date()) {
      return Boolean(range?.to && range.to <= dateKey(now));
    }

function payrollConfirmationHint(range) {
      return `Potrditev obračuna je mogoča po ${formatDate(range.to)}.`;
    }

function billingNoteStorageKey(workerId, range) {
      return `indus-ure:billing-note:${workerId || ""}:${range?.from || ""}:${range?.to || ""}`;
    }

function billingNoteValue(workerId, range, payroll) {
      if (payroll && ["archiving", "confirmed", "paid"].includes(payroll.status)) return String(payroll.note || "");
      return localStorage.getItem(billingNoteStorageKey(workerId, range)) ?? String(payroll?.note || "");
    }

function renderBillingExplorer() {
      const box = $("billingExplorer");
      const showAllWorkers = isAdminView() && billingWorkerId() === moduleValues.allBillingWorkersId;
      box.classList.toggle("hidden", !showAllWorkers);
      if (!showAllWorkers) { box.replaceChildren(); return; }
      const oldestVisible = new Date();
      oldestVisible.setFullYear(oldestVisible.getFullYear() - 1);
      const oldestVisibleKey = dateKey(oldestVisible);
      const rows = state.payrolls
        .filter((payroll) => String(payroll.to || (payroll.month || "") + "-31") >= oldestVisibleKey)
        .sort((a, b) => String(b.to || b.month || "").localeCompare(String(a.to || a.month || "")) || String(a.updatedAt || "").localeCompare(String(b.updatedAt || "")));
      const rowMarkup = rows.map((payroll) => {
        const from = payroll.from || String(payroll.month || "") + "-01";
        const to = payroll.to || String(payroll.month || "") + "-31";
        return '<button class="billing-explorer-row" type="button" data-worker-id="' + escapeHtml(payroll.workerId) + '" data-from="' + escapeHtml(from) + '" data-to="' + escapeHtml(to) + '"><strong>' + escapeHtml(userDisplayName(payroll.workerId)) + '</strong><span>' + escapeHtml(billingRangeLabel(payroll)) + '</span><span>' + money(payroll.payoutAmount ?? payroll.totalAmount) + ' EUR · ' + escapeHtml(payrollStateLabel(payroll, true)) + '</span></button>';
      }).join("");
      box.innerHTML = '<div class="todo-head"><strong>Vsi obračuni</strong><span class="todo-meta">' + rows.length + '</span></div>' + (rowMarkup || '<p class="todo-meta">Še ni shranjenih obračunov v zadnjem letu.</p>');
      box.querySelectorAll(".billing-explorer-row").forEach((button) => button.addEventListener("click", () => {
        state.billingWorkerId = button.dataset.workerId;
        $("billingFrom").value = button.dataset.from;
        $("billingTo").value = button.dataset.to;
        saveBillingRangeSelection(state.billingWorkerId, { from: button.dataset.from, to: button.dataset.to });
        renderBillingView();
      }));
    }

function openStaleBillingDraft(payroll) {
      if (!payroll) return;
      saveBillingRangeSelection(billingWorkerId(), { from: payroll.from, to: payroll.to });
      renderBillingView();
    }

async function discardStaleBillingDraft(payroll) {
      if (!payroll || payroll.status !== "draft") return;
      const label = billingRangeLabel(payroll);
      if (!await showAppConfirm(`Zavrzem osnutek obračuna ${label}? Opravljene ure in finančni vnosi ostanejo nespremenjeni.`)) return;
      const data = await api(`/api/payrolls/${encodeURIComponent(payroll.id)}`, { method: "DELETE" });
      state.payrolls = data.payrolls || state.payrolls;
      delete state.billingRangeSelections[billingWorkerId()];
      await loadAll();
      renderBillingView();
    }

function renderBillingView() {
      const admin = isAdminView();
      const workerId = billingWorkerId();
      const allWorkers = admin && workerId === moduleValues.allBillingWorkersId;
      const screen = document.querySelector(".billing-screen");
      screen.classList.toggle("is-all-workers", allWorkers);
      renderBillingWorkerSelect(workerId);
      const period = document.querySelector(".billing-period");
      const quickRanges = $("billingQuickRanges");
      [period, quickRanges].forEach((element) => element?.classList.toggle("hidden", allWorkers));
      if (allWorkers) {
        $("billingViewTitle").textContent = "Vsi obračuni";
        $("billingSubtitle").hidden = false;
        $("billingSubtitle").textContent = "Pregled zadnjega leta";
        $("billingState").textContent = "";
        $("billingState").className = "billing-state hidden";
        ["billingStaleDraftNotice", "billingSummary", "billingPayments", "billingNotePanel", "billingActions", "billingSettlementActions", "billingPeriodHint", "billingDayList"].forEach((id) => $(id).classList.add("hidden"));
        $("billingActionProgress").hidden = true;
        renderBillingExplorer();
        return;
      }
      ["billingSummary", "billingPayments", "billingNotePanel", "billingActions", "billingSettlementActions", "billingDayList"].forEach((id) => $(id).classList.remove("hidden"));
      $("billingState").classList.remove("hidden");
      const range = billingRange();
      const worker = billingWorker();
      const payroll = payrollForBilling(workerId, range);
      const staleDraft = staleOpenBillingPayroll(workerId);
      const staleNotice = $("billingStaleDraftNotice");
      if (staleDraft) {
        const statusText = staleDraft.status === "archiving"
          ? "Potrjevanje odprtega obračuna je treba najprej dokončati."
          : "Osnutek ne vključuje najnovejših ur.";
        staleNotice.innerHTML = `<span>${escapeHtml(`${statusText} ${billingRangeLabel(staleDraft)}.`)}</span><span class="billing-stale-draft-actions"><button class="secondary" type="button" data-open-stale-payroll>Odpri osnutek</button>${admin && staleDraft.status === "draft" ? '<button class="secondary" type="button" data-discard-stale-payroll>Zavrzi osnutek</button>' : ""}</span>`;
        staleNotice.classList.remove("hidden");
        staleNotice.querySelector("[data-open-stale-payroll]").addEventListener("click", () => openStaleBillingDraft(staleDraft));
        staleNotice.querySelector("[data-discard-stale-payroll]")?.addEventListener("click", () => discardStaleBillingDraft(staleDraft).catch((error) => showNotice(error.message)));
      } else {
        staleNotice.classList.add("hidden");
        staleNotice.replaceChildren();
      }
      const useSnapshot = Boolean(payroll && ["archiving", "confirmed", "paid"].includes(payroll.status));
      const lines = useSnapshot ? payroll.lines : billingLiveLines(workerId, range);
      const baseTotals = useSnapshot ? { minutes: Number(payroll.minutes || 0), hours: Number(payroll.hours || 0), km: Number(payroll.km || 0), workAmount: Number(payroll.workAmount || 0), kmAmount: Number(payroll.kmAmount || 0), totalAmount: Number(payroll.totalAmount || 0) } : billingLineTotals(lines);
      const advances = useSnapshot ? (payroll.advanceIds || []).map((id) => (state.advances || []).find((item) => item.id === id)).filter(Boolean) : billingAdvances(workerId, range);
      const advanceAmount = useSnapshot ? Number(payroll.advanceAmount || 0) : Number(advances.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2));
      const clientReceipts = useSnapshot ? (payroll.clientReceiptIds || []).map((id) => (state.debts || []).find((item) => item.id === id)).filter(Boolean) : billingClientReceipts(workerId, range);
      const clientReceiptAmount = useSnapshot ? Number(payroll.clientReceiptAmount || 0) : Number(clientReceipts.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2));
      const purchases = useSnapshot ? (payroll.personalPurchaseIds || []).map((id) => (state.personalPurchases || []).find((item) => item.id === id)).filter(Boolean) : billingPersonalPurchases(workerId, range);
      const personalPurchaseAmount = useSnapshot ? Number(payroll.personalPurchaseAmount || 0) : Number(purchases.reduce((sum, item) => sum + Number(item.amount || 0), 0).toFixed(2));
      const payoutAmount = Math.max(0, Number((baseTotals.totalAmount + advanceAmount + clientReceiptAmount - personalPurchaseAmount).toFixed(2)));
      const paidAmount = payroll ? Number(payroll.paidAmount || 0) : 0;
      const remainingAmount = Number((payoutAmount - paidAmount).toFixed(2));
      const stateLabel = payrollStateLabel(payroll, admin);
      $("billingViewTitle").textContent = `Obračun ur · ${worker?.name || "Delavec"}`;
      $("billingSubtitle").textContent = "";
      $("billingSubtitle").hidden = true;
      const status = $("billingState"); status.textContent = stateLabel; status.className = `billing-state ${payroll?.status || ""}`;
      const noteInput = $("billingNote");
      const noteText = billingNoteValue(workerId, range, payroll);
      if (document.activeElement !== noteInput) noteInput.value = noteText;
      noteInput.disabled = Boolean(payroll && ["archiving", "confirmed", "paid"].includes(payroll.status));
      const noteRead = $("billingNoteRead"); noteRead.textContent = noteText ? `Opomba za delavca: ${noteText}` : ""; noteRead.classList.toggle("hidden", admin || !noteText);
            const baseAmount = Number((baseTotals.workAmount + baseTotals.kmAmount).toFixed(2));
      const differenceAmount = Number((advanceAmount + clientReceiptAmount - personalPurchaseAmount - paidAmount).toFixed(2));
      const summaryRows = [
        { label: "Ure", formula: `${baseTotals.hours.toLocaleString("sl-SI", { maximumFractionDigits: 2 })} h`, value: `${money(baseTotals.workAmount)} EUR` },
        { label: "Kilometrina", formula: `${baseTotals.km.toLocaleString("sl-SI", { maximumFractionDigits: 1 })} km`, value: `${money(baseTotals.kmAmount)} EUR` },
        { label: "Znesek skupaj", value: `${money(baseAmount)} EUR`, emphasis: true },
        { label: "Zalo\u017eeno", value: `${money(advanceAmount)} EUR` },
        { label: "Prejeta sredstva", value: `${money(clientReceiptAmount)} EUR` },
        { label: "Osebni nakupi", value: `-${money(personalPurchaseAmount)} EUR` },
        { label: "\u017de izpla\u010dano", value: `-${money(paidAmount)} EUR` },
        { label: "Razlika", value: `${money(differenceAmount)} EUR`, emphasis: true },
        { label: "Za izpla\u010dilo", value: `${money(remainingAmount)} EUR`, payout: true }
      ];
      $("billingSummary").innerHTML = summaryRows.map((row) => `<div class="billing-summary-row${row.emphasis ? " is-emphasis" : ""}${row.payout ? " is-payout" : ""}"><span class="billing-summary-label">${escapeHtml(row.label)}</span><span class="billing-summary-formula">${escapeHtml(row.formula || "")}</span><strong class="billing-summary-value">${escapeHtml(row.value)}</strong></div>`).join("");
      $("billingPayments").replaceChildren();
      const readyForConfirmation = !payroll || ["draft", "archiving"].includes(payroll.status);
      const periodEnded = payrollPeriodEnded(range);
      const confirmButton = $("billingConfirm"); const showConfirmation = admin && readyForConfirmation && Boolean(lines.length);
      confirmButton.classList.toggle("hidden", !showConfirmation); confirmButton.disabled = showConfirmation && !periodEnded; confirmButton.textContent = payroll?.status === "archiving" ? "Nadaljuj arhiviranje" : "Potrdi obračun"; confirmButton.title = showConfirmation && !periodEnded ? payrollConfirmationHint(range) : "";
      const periodHint = $("billingPeriodHint"); periodHint.textContent = showConfirmation && !periodEnded ? payrollConfirmationHint(range) : ""; periodHint.classList.toggle("hidden", !(showConfirmation && !periodEnded));
      $("billingMarkPaid").classList.toggle("hidden", !admin || payroll?.status !== "confirmed");
      $("billingMarkPaid").disabled = moduleValues.billingPaidActionInFlight;
      $("billingAddPayment").classList.toggle("hidden", !admin || !payroll || !["confirmed", "paid"].includes(payroll.status) || remainingAmount <= 0.005);
      $("billingAddAdvance").classList.toggle("hidden", Boolean(payroll && ["confirmed", "paid"].includes(payroll.status)));
      $("billingAddPurchase").classList.toggle("hidden", Boolean(payroll && ["confirmed", "paid"].includes(payroll.status)));
      $("billingDownloadXlsx").classList.toggle("hidden", allWorkers);
      $("billingDownloadXlsx").disabled = !range?.from || !range?.to;

      const list = $("billingDayList");
      const activities = billingDisplayActivities(workerId, range, lines);
      const paymentItems = (payroll?.payments || []).map((payment) => ({
        ...payment,
        date: /^\d{4}-\d{2}-\d{2}/.test(String(payment.createdAt || "")) ? String(payment.createdAt).slice(0, 10) : ""
      })).filter((payment) => payment.date >= range.from && payment.date <= range.to);
      const dayRows = new Map();
      const ensureDay = (date) => {
        if (!dayRows.has(date)) dayRows.set(date, { work: [], advances: [], clientReceipts: [], purchases: [], payments: [] });
        return dayRows.get(date);
      };
      activities.forEach((activity) => ensureDay(activity.date).work.push(activity));
      advances.forEach((advance) => ensureDay(advance.date).advances.push(advance));
      clientReceipts.forEach((receipt) => ensureDay(receipt.date).clientReceipts.push(receipt));
      purchases.forEach((purchase) => ensureDay(purchase.date).purchases.push(purchase));
      paymentItems.forEach((payment) => ensureDay(payment.date).payments.push(payment));
      const isBoss = state.user?.role === "boss";
      if (!dayRows.size) list.innerHTML = `<div class="billing-empty">V tem obdobju ni zaključenih ur, založitev, prejetih sredstev, osebnih nakupov ali izplačil.</div>`;
      else {
        list.innerHTML = [...dayRows.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([date, items]) => {
          const day = billingLineTotals(items.work);
          const hasGap = items.work.some((row, index) => index > 0 && billingGapMinutes(items.work[index - 1], row) > 0);
          const financialDate = `<time class="billing-financial-date" datetime="${escapeHtml(date)}">${escapeHtml(formatDate(date))}</time>`;
          const financialRows = [
            ...items.advances.map((advance) => `<div class="billing-financial-row advance">${financialDate}<span>Založeno${advance.reason ? ` · ${escapeHtml(advance.reason)}` : ""}</span><strong>${money(advance.amount)} EUR</strong>${financialEntryActions(advance, "advance")}</div>`),
            ...items.clientReceipts.map((receipt) => `<div class="billing-financial-row receipt">${financialDate}<span>Prejeta sredstva${receipt.reason ? ` · ${escapeHtml(receipt.reason)}` : ""}</span><strong>+${money(receipt.amount)} EUR</strong></div>`),
            ...items.purchases.map((purchase) => `<div class="billing-financial-row purchase">${financialDate}<span>Osebni nakup${purchase.reason ? ` · ${escapeHtml(purchase.reason)}` : ""}</span><strong>-${money(purchase.amount)} EUR</strong>${financialEntryActions(purchase, "purchase")}</div>`),
            ...items.payments.map((payment) => `<div class="billing-financial-row payment">${financialDate}<span>Izplačano${payment.note ? ` · ${escapeHtml(payment.note)}` : ""}</span><strong>${money(payment.amount)} EUR</strong>${isBoss ? `<button class="danger billing-financial-delete delete-billing-payment" type="button" data-payroll-id="${escapeHtml(payroll.id)}" data-payment-id="${escapeHtml(payment.id)}">Izbriši</button>` : ""}</div>`)
          ].join("");
          if (!items.work.length) return `<div class="billing-day billing-financial-only">${financialRows}</div>`;
          const dayBreakdown = billingDayBreakdownMarkup(items.work, day);
          return `<div class="billing-day"><button class="billing-day-overview billing-open-day" type="button" data-date="${escapeHtml(date)}" data-worker-id="${escapeHtml(workerId)}"><span class="billing-day-date"><strong>${escapeHtml(formatDate(date))}</strong>${hasGap ? '<span class="billing-gap-alert" title="Ure niso v neprekinjenem kosu" aria-label="Ure niso v neprekinjenem kosu">↕</span>' : ""}</span>${dayBreakdown}</button>${financialRows}</div>`;
        }).join("");
        list.querySelectorAll(".billing-open-day").forEach((button) => button.addEventListener("click", () => openBillingDayTimeline(button.dataset.workerId, button.dataset.date)));
        list.querySelectorAll(".edit-billing-advance").forEach((button) => button.addEventListener("click", () => {
          const advance = state.advances.find((item) => item.id === button.dataset.entryId);
          if (advance) openAdvanceDialog("advance", advance);
        }));
        list.querySelectorAll(".edit-billing-purchase").forEach((button) => button.addEventListener("click", () => {
          const purchase = state.personalPurchases.find((item) => item.id === button.dataset.entryId);
          if (purchase) openAdvanceDialog("purchase", purchase);
        }));
        list.querySelectorAll(".delete-billing-advance").forEach((button) => button.addEventListener("click", () => deleteAdvanceFromBilling(button.dataset.entryId).catch((error) => showNotice(error.message))));
        list.querySelectorAll(".delete-billing-purchase").forEach((button) => button.addEventListener("click", () => deletePersonalPurchaseFromBilling(button.dataset.entryId).catch((error) => showNotice(error.message))));
        list.querySelectorAll(".delete-billing-payment").forEach((button) => button.addEventListener("click", () => deletePayrollPaymentFromBilling(button.dataset.payrollId, button.dataset.paymentId).catch((error) => showNotice(error.message))));
      }
      renderBillingExplorer();
    }

function downloadWorkerPayrollXlsx() {
      const workerId = billingWorkerId();
      const range = billingRange();
      if (!workerId || workerId === moduleValues.allBillingWorkersId || !range?.from || !range?.to) return;
      const query = new URLSearchParams({ workerId, from: range.from, to: range.to });
      const anchor = document.createElement("a");
      anchor.href = `/api/payroll-export.xlsx?${query.toString()}`;
      anchor.download = "";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    }

async function confirmPayroll() {
      const workerId = billingWorkerId();
      const range = billingRange();
      if (!payrollPeriodEnded(range)) throw new Error(payrollConfirmationHint(range));
      const payroll = payrollForBilling(workerId, range);
      const note = billingNoteValue(workerId, range, payroll);
      if (payroll && !["draft", "archiving"].includes(payroll.status)) return;
      if (!await showAppConfirm("Potrdim obračun delavca? Zaključeni vnosi ur se zaklenejo. Projektni vnosi ostanejo aktivni, dokler ni potrjen tudi obračun stranki.")) return;
      if (payroll) { await changePayroll("confirm", true, note); return; }
      const data = await api("/api/payrolls", { method: "POST", body: JSON.stringify({ workerId, from: range.from, to: range.to, note }) });
      state.payrolls = data.payrolls || state.payrolls;
      localStorage.removeItem(billingNoteStorageKey(workerId, range));
      await loadAll(); renderBillingView();
    }

function setBillingPaidActionProgress(active, message = "") {
      moduleValues.billingPaidActionInFlight = Boolean(active);
      const progress = $("billingActionProgress");
      const button = $("billingMarkPaid");
      progress.hidden = !active;
      $("billingActionProgressText").textContent = active ? (message || "Označujem obračun kot plačan …") : "";
      button.disabled = Boolean(active);
      button.setAttribute("aria-busy", String(Boolean(active)));
    }

async function changePayroll(action, skipConfirmation = false, note = undefined) {
      const payroll = payrollForBilling(billingWorkerId(), billingRange());
      if (!payroll) return;
      const messages = { confirm: "Potrdim obračun delavca? Ure in postavke se zaklenejo. Projektni vnosi se premaknejo v arhiv šele, ko je potrjen tudi obračun stranki.", paid: "Označim obračun kot plačan?", reopen: "Ponovno odprem obračun? Ure bo mogoče znova popravljati.", delete: "Izbrišem osnutek obračuna? Opravljenih ur ne bom izbrisal." };
      if (!skipConfirmation && messages[action] && !await showAppConfirm(messages[action])) return;
      const paid = action === "paid";
      if (paid && moduleValues.billingPaidActionInFlight) return;
      if (paid) setBillingPaidActionProgress(true);
      try {
        const data = action === "delete"
          ? await api("/api/payrolls/" + encodeURIComponent(payroll.id), { method: "DELETE" })
          : await api("/api/payrolls/" + encodeURIComponent(payroll.id), { method: "PUT", body: JSON.stringify({ action, ...(note === undefined ? {} : { note }) }) });
        state.payrolls = data.payrolls || state.payrolls;
        await loadAll();
        renderBillingView();
      } finally {
        if (paid) setBillingPaidActionProgress(false);
      }
    }

function installWorkerDebtBindings1() {
    document.querySelectorAll(".debt-stat").forEach((button) => {
      button.addEventListener("click", () => openDebtDialog({ person: button.dataset.debtPerson || "ibro" }));
    });
    $("closeDebt").addEventListener("click", () => $("debtDialog").close());
    $("debtMonth").addEventListener("change", renderDebtDialog);
    $("saveDebt").addEventListener("click", async () => {
      try {
        await saveDebtToServer({
          id: $("debtId").value || undefined,
          month: $("debtMonth").value,
          person: $("debtPerson").value,
          amount: Number($("debtAmount").value || 0),
          reason: $("debtReason").value.trim()
        });
        $("debtId").value = "";
        $("debtAmount").value = "";
        $("debtReason").value = "";
      } catch (error) {
        showNotice(error.message);
      }
    });
    $("deleteDebt").addEventListener("click", async () => {
      const id = $("debtId").value;
      if (!id) return;
      if (!await showAppConfirm("Izbrišem ta dolg?")) return;
      await deleteDebtFromServer(id);
      $("debtId").value = "";
      $("debtAmount").value = "";
      $("debtReason").value = "";
      $("deleteDebt").style.display = "none";
    });
    $("debtList").addEventListener("click", async (event) => {
      const item = event.target.closest(".debt-item");
      if (!item) return;
      const debt = state.debts.find((row) => row.id === item.dataset.debtId);
      if (!debt) return;
      if (event.target.closest(".remove-debt")) {
        if (!await showAppConfirm("Izbrišem ta dolg?")) return;
        await deleteDebtFromServer(debt.id);
        return;
      }
      if (event.target.closest(".edit-debt") || item) {
        $("debtId").value = debt.id;
        $("debtMonth").value = debt.month;
        $("debtPerson").value = debt.person;
        $("debtAmount").value = debt.amount || "";
        $("debtReason").value = debt.reason || "";
        $("deleteDebt").style.display = "inline-flex";
      }
    });
}

function installWorkerBillingBindings1() {
    $("billingTopViewBtn").addEventListener("click", () => setView("billing"));
    $("clientBillingTopViewBtn").addEventListener("click", () => {
      state.reportClient = "";
      state.reportClientId = "";
      $("reportClient").value = "";
      setView("report");
    });
    $("billingMenuBtn").addEventListener("click", () => {
      setView("billing");
      $("toolsMenu").open = false;
    });
    $("clientBillingMenuBtn").addEventListener("click", () => {
      state.reportClient = "";
      state.reportClientId = "";
      $("reportClient").value = "";
      setView("report");
      $("toolsMenu").open = false;
    });
    ["billingFrom", "billingTo"].forEach((id) => $(id).addEventListener("change", () => {
      saveBillingRangeSelection(billingWorkerId(), { from: $("billingFrom").value, to: $("billingTo").value });
      renderBillingView();
    }));
    document.querySelectorAll("[data-billing-range-preset]").forEach((button) => button.addEventListener("click", () => applyBillingQuickRange(button.dataset.billingRangePreset)));
    $("billingRangePrev").addEventListener("click", () => shiftBillingRangePickerMonth(-1));
    $("billingRangeNext").addEventListener("click", () => shiftBillingRangePickerMonth(1));
    $("closeBillingRangeDialog").addEventListener("click", () => $("billingRangeDialog").close());
    $("cancelBillingRangeDialog").addEventListener("click", () => $("billingRangeDialog").close());
    $("applyBillingRangeDialog").addEventListener("click", applyBillingRangePicker);
    $("billingNote").addEventListener("input", () => localStorage.setItem(billingNoteStorageKey(billingWorkerId(), billingRange()), $("billingNote").value));
    $("billingWorker").addEventListener("change", () => { state.billingWorkerId = $("billingWorker").value; localStorage.setItem(moduleValues.billingWorkerKey, state.billingWorkerId); renderBillingView(); });
    $("billingConfirm").addEventListener("click", () => confirmPayroll().catch((error) => showNotice(error.message)));
    $("billingDownloadXlsx").addEventListener("click", downloadWorkerPayrollXlsx);
    $("billingMarkPaid").addEventListener("click", () => changePayroll("paid").catch((error) => showNotice(error.message)));
    $("billingAddPayment").addEventListener("click", openPaymentDialog);
    $("billingAddAdvance").addEventListener("click", openAdvanceDialog);
    $("billingAddPurchase").addEventListener("click", () => openAdvanceDialog("purchase"));
    $("closePaymentDialog").addEventListener("click", () => $("paymentDialog").close());
    $("cancelPaymentDialog").addEventListener("click", () => $("paymentDialog").close());
    $("paymentForm").addEventListener("submit", (event) => { event.preventDefault(); savePaymentFromDialog().catch((error) => showFormValidationError($("paymentForm"), error.message || "Izplačila ni bilo mogoče shraniti.", $("paymentAmount"))); });
    ["billingPrevMonth", "billingNextMonth"].forEach((id) => $(id).addEventListener("click", () => {
      const range = billingRange();
      const workerId = billingWorkerId();
      const direction = id === "billingNextMonth" ? 1 : -1;
      const previousPayroll = billingPreviousPayroll(workerId, range);
      const nextPayroll = billingNextPayroll(workerId, range);
      if (direction < 0) {
        if (!previousPayroll) return;
        $("billingFrom").value = previousPayroll.from;
        $("billingTo").value = previousPayroll.to;
        saveBillingRangeSelection(workerId, { from: previousPayroll.from, to: previousPayroll.to });
        renderBillingView();
        return;
      }
      if (nextPayroll) {
        $("billingFrom").value = nextPayroll.from;
        $("billingTo").value = nextPayroll.to;
        saveBillingRangeSelection(workerId, { from: nextPayroll.from, to: nextPayroll.to });
        renderBillingView();
        return;
      }
      const latest = latestBillingPeriod(workerId);
      if (!latest || range.to >= latest.to) return;
      const start = parseDate(range.to);
      const end = parseDate(range.to);
      const previousStart = parseDate(range.from);
      const span = Math.round((end - previousStart) / 86400000) + 1;
      end.setDate(end.getDate() + Math.max(0, span - 1));
      const nextFrom = dateKey(start);
      const nextTo = [dateKey(end), latest.to].sort()[0];
      if (nextTo < nextFrom) {
        $("billingFrom").value = latest.from;
        $("billingTo").value = latest.to;
      } else {
        $("billingFrom").value = nextFrom;
        $("billingTo").value = nextTo;
      }
      saveBillingRangeSelection(workerId, { from: $("billingFrom").value, to: $("billingTo").value });
      renderBillingView();
    }));
}

  return {
    saveBillingSettings,
    editBillingSetting,
    workerDefaultHourlyRate,
    todoHourlyRate,
    parseBillingNumber,
    renderWorkerBillingTable,
    renderAdvanceProjects,
    manualClientBillableMinutes,
    todoClientBillableHours,
    mealPaidMinutes,
    saveBillingRangeSelection,
    billingRange,
    billingWorkerId,
    billingGapLabel,
    renderBillingView,
    installWorkerDebtBindings1,
    installWorkerBillingBindings1
  };
}
