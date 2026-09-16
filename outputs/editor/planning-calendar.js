"use strict";

function createPlanningCalendarUi({ api, $, getUser, showNotice, showAppConfirm, openAccount }) {
  let current = null, timer = null, refreshing = false;
  async function refresh() {
    if (refreshing || !$("accountDialog").open) return;
    refreshing = true;
    try {
      current = await api("/api/planning-calendar/status");
      const boss = getUser()?.role === "boss";
      const status = $("planningCalendarStatus");
      status.textContent = !current.connected ? "Google Koledar še ni povezan. Povezavo uredi šef."
        : !current.enabled ? "Sinhronizacija je začasno ustavljena. V Googlu ostane zadnji preneseni pogled."
        : current.lastError || (current.running ? "Dogodki se prenašajo v ozadju …"
          : current.lastSuccessAt ? `Nazadnje usklajeno: ${new Date(current.lastSuccessAt).toLocaleString("sl-SI")}`
            : "Povezava je potrjena. Prva sinhronizacija je v čakalni vrsti.");
      if (current.needsEmail) status.textContent += " Za deljenje osebnega koledarja naj šef dopolni tvoj Google e-naslov.";
      $("connectPlanningCalendar").classList.toggle("hidden", !current.canConnect);
      $("connectPlanningCalendar").disabled = !current.configured;
      $("connectPlanningCalendar").textContent = current.connected ? "Ponovno poveži Google" : "Poveži Google Koledar";
      $("syncPlanningCalendar").classList.toggle("hidden", !boss || !current.connected || !current.enabled);
      $("syncPlanningCalendar").disabled = current.running;
      $("pausePlanningCalendar").classList.toggle("hidden", !boss || !current.connected);
      $("pausePlanningCalendar").textContent = current.enabled ? "Začasno ustavi" : "Nadaljuj sinhronizacijo";
      const links = $("planningCalendarLinks");
      links.replaceChildren();
      for (const calendar of current.calendars || []) {
        const link = document.createElement("a");
        link.className = "secondary";
        link.textContent = `${calendar.title} (${calendar.count}) — dodaj / odpri`;
        link.href = calendar.url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        links.append(link);
      }
    } catch (error) { $("planningCalendarStatus").textContent = error.message; }
    finally { refreshing = false; }
  }
  async function connect() {
    if (!await showAppConfirm("Povežem namenski službeni Google koledar? Dogodki za planiranje bodo poslani Googlu in deljeni z dodeljenimi delavci samo za ogled. Zasebnih koledarjev ne bomo spreminjali.")) return;
    const data = await api("/api/planning-calendar/auth", { method: "POST", body: "{}" });
    // Same-tab navigation also works in Android installed-app mode.
    location.assign(data.url);
  }
  function open() {
    refresh();
    if (timer) clearInterval(timer);
    timer = setInterval(() => { if ($("accountDialog").open) refresh(); else { clearInterval(timer); timer = null; } }, 5000);
  }
  $("connectPlanningCalendar").addEventListener("click", () => connect().catch(error => showNotice(error.message)));
  $("syncPlanningCalendar").addEventListener("click", async () => {
    try { await api("/api/planning-calendar/sync", { method: "POST", body: "{}" }); showNotice("Sinhronizacija je dodana v čakalno vrsto."); await refresh(); }
    catch (error) { showNotice(error.message); }
  });
  $("pausePlanningCalendar").addEventListener("click", async () => {
    try { await api("/api/planning-calendar/enabled", { method: "PUT", body: JSON.stringify({ enabled: !current?.enabled }) }); await refresh(); }
    catch (error) { showNotice(error.message); }
  });
  function resume() {
    const url = new URL(location.href);
    if (url.searchParams.get("planning_calendar") !== "connected") return;
    url.searchParams.delete("planning_calendar");
    history.replaceState(history.state, "", url);
    openAccount();
  }
  return { open, resume };
}
