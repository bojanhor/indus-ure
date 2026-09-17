// Boss-only editing of a fixed, validated server file. No arbitrary paths.
function createAppConfigEditor({ $, api, showAppConfirm, showNotice }) {
  const labels = {"uploads":["Priloge",{"maxAttachments":"Največ prilog na opravilo","pdfMaxMb":"Največji PDF (MB)","imageMaxMb":"Največja izvorna fotografija (MB)","videoMaxMb":"Največji video (MB)","imageDisplayMaxSide":"Daljša stran shranjene slike (px)","imageThumbnailMaxSide":"Daljša stran sličice (px)","imageProcessTimeoutSeconds":"Čas za obdelavo slike (s)","pendingHours":"Hramba nepripetih naloženih prilog (h)"}],"history":["Zgodovina in koš",{"trashDays":"Hramba izbrisanih opravil (dni)","auditDays":"Hramba dnevnika (dni)","auditMaxEvents":"Največ zapisov v dnevniku","undoActions":"Število dejanj Undo","eventVersions":"Število različic dogodka"}],"reports":["Izvozi in e-pošta",{"pdfTotalMb":"Skupna velikost PDF izvoza s prilogami (MB)","gmailAttachmentMb":"Največja e-poštna priloga (MB)","gmailTotalMb":"Skupne e-poštne priloge (MB)","downloadTicketMinutes":"Veljavnost dovoljenja za prenos (min)"}],"network":["Povezava",{"requestTimeoutSeconds":"Čas za običajno zahtevo (s)","uploadTimeoutSeconds":"Čas za nalaganje (s)","refreshSeconds":"Osveževanje v ozadju (s)"}],"editor":["Urejevalnik",{"defaultStart":"Privzeta začetna ura","defaultDurationMinutes":"Privzeto trajanje (min)","clientSuggestions":"Število predlogov strank","noticeSeconds":"Trajanje kratkega obvestila (s)","photoBrushPixels":"Najmanjša širina čopiča (px)","photoTextPixels":"Začetna velikost besedila na sliki (px)","photoTouchPixels":"Velikost območja dotika besedila (px)","jpegMaxSide":"Daljša stran urejene slike (px)","jpegQuality":"Začetna kakovost JPEG (%)","dragHoldMs":"Držanje pred premikom opravila (ms)","calendarDragHoldMs":"Držanje pred premikom v koledarju (ms)","groupDragHoldMs":"Držanje pred premikom skupine (ms)"}],"locks":["Zaklepi",{"leaseSeconds":"Veljavnost zaklepa (s)","heartbeatSeconds":"Obnavljanje zaklepa (s)"}],"calendar":["Google Koledar",{"pollSeconds":"Preverjanje sprememb (s)","reconcileSeconds":"Celotno preverjanje usklajenosti (s)","debounceMs":"Združevanje hitrih sprememb (ms)","retryMaxSeconds":"Največji zamik ponovitve (s)"}],"monitor":["Nadzor strežnika",{"intervalSeconds":"Interval pregleda (s)","maxRssMb":"Opozorilo za RAM procesa (MB)","diskWarningPercent":"Opozorilo za zaseden disk (%)","backupStaleHours":"Opozorilo za starost kopije (h)","alertCooldownHours":"Razmik med ponovljenimi opozorili (h)"}]};
  let snapshot = null;
  function render(value) {
    const container = $("technicalConfigFields");
    container.replaceChildren();
    for (const [section, fields] of Object.entries(snapshot.rules)) {
      const box = document.createElement("fieldset");
      const legend = document.createElement("legend");
      legend.textContent = labels[section][0]; box.append(legend);
      for (const [key, rule] of Object.entries(fields)) {
        const label = document.createElement("label");
        label.textContent = labels[section][1][key];
        const input = document.createElement("input");
        input.dataset.section = section; input.dataset.key = key;
        input.id = "config-" + section + "-" + key;
        input.type = rule === "time" ? "time" : "number";
        if (rule === "time") input.step = "900";
        else { input.min = rule[0]; input.max = rule[1]; input.step = rule[2] || 1; }
        input.required = true; input.value = value[section][key];
        label.append(input); box.append(label);
      }
      container.append(box);
    }
  }
  async function openTechnicalConfig() {
    snapshot = await api("/api/app-config");
    render(snapshot.config);
    $("technicalConfigError").textContent = "";
    $("technicalConfigPrevious").disabled = !snapshot.previous;
    $("technicalConfigDialog").showModal();
  }
  function installAppConfigBindings() {
    $("openTechnicalConfig").addEventListener("click", () => openTechnicalConfig().catch(error => showNotice(error.message)));
    $("closeTechnicalConfig").addEventListener("click", () => $("technicalConfigDialog").close());
    $("technicalConfigPrevious").addEventListener("click", () => {
      if (snapshot.previous) {
        render(snapshot.previous);
        $("technicalConfigError").textContent = "Povrnjena različica je samo osnutek. Za uveljavitev klikni Shrani in osveži.";
      }
    });
    $("technicalConfigReload").addEventListener("click", async () => {
      if (!await showAppConfirm("Ponovno naložim nastavitve in zavržem spremembe v tem obrazcu?")) return;
      try { snapshot = await api("/api/app-config"); render(snapshot.config); $("technicalConfigError").textContent = ""; $("technicalConfigPrevious").disabled = !snapshot.previous; }
      catch (error) { $("technicalConfigError").textContent = error.message; }
    });
    $("technicalConfigForm").addEventListener("submit", async event => {
      event.preventDefault();
      const config = JSON.parse(JSON.stringify(snapshot.config)), changes = [];
      for (const input of $("technicalConfigFields").querySelectorAll("input")) {
        const {section, key} = input.dataset;
        const value = input.type === "time" ? input.value : Number(input.value);
        config[section][key] = value;
        if (value !== snapshot.config[section][key]) changes.push(labels[section][1][key] + ": " + snapshot.config[section][key] + " → " + value);
      }
      if (!changes.length) { $("technicalConfigError").textContent = "Ni sprememb."; return; }
      const retentionWarning = Object.keys(config.history).some(key => config.history[key] < snapshot.config.history[key])
        ? "\n\nOPOZORILO: zmanjšanje hrambe ali števila zapisov lahko ob rednem čiščenju trajno odstrani stare zapise. Povrnitev nastavitve jih ne obnovi." : "";
      if (!await showAppConfirm(changes.join("\n") + retentionWarning + "\n\nShranim in osvežim aplikacijo?", { title: "Sprememba tehničnih nastavitev", confirmLabel: "Shrani in osveži", danger: Boolean(retentionWarning) })) return;
      const button = $("technicalConfigSave"); button.disabled = true;
      $("technicalConfigError").textContent = "Shranjujem …";
      try {
        await api("/api/app-config", {method:"PUT", body:JSON.stringify({config, revision:snapshot.revision})});
        location.reload();
      } catch (error) {
        $("technicalConfigError").textContent = error.message + " Vnesene vrednosti so ostale v obrazcu.";
        button.disabled = false;
      }
    });
  }
  return { openTechnicalConfig, installAppConfigBindings };
}
