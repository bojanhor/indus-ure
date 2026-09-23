// Progressive enhancement: native links outside editable text, never intercept typing.
function createContactLinks({ escapeHtml }) {
  const fieldActions = new WeakMap();
  function matches(value) {
    const text = String(value || "");
    const pattern = /https?:\/\/[^\s<>"']+|\bwww\.[^\s<>"']+|[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+|(?:\+\d(?:[ ()\/-]*\d){6,14}|0[1-7](?:[ ()\/-]*\d){7})(?![\p{L}\p{N}])/giu;
    const result = [];
    for (const match of text.matchAll(pattern)) {
      const label = match[0].replace(/[),.;!?]+$/, "");
      let href, kind;
      if (/^(https?:\/\/|www\.)/i.test(label)) {
        href = /^www\./i.test(label) ? `https://${label}` : label;
        try { const parsed = new URL(href); if (!["http:", "https:"].includes(parsed.protocol) || !parsed.hostname) continue; } catch { continue; }
        kind = "url";
      } else if (label.includes("@")) { href = `mailto:${label}`; kind = "email"; }
      else {
        // Explicit boundary check avoids regex lookbehind on older iPhones.
        if (match.index > 0 && /[\p{L}\p{N}]/u.test(text[match.index - 1])) continue;
        href = `tel:${label.replace(/\(0\)/g, "").replace(/[^+0-9]/g, "")}`; kind = "phone";
      }
      result.push({ index: match.index, label, href, kind });
    }
    return result;
  }
  function anchor(item) {
    const action = item.kind === "phone" ? "Pokliči" : item.kind === "email" ? "Pošlji e-pošto" : "Odpri povezavo";
    return `<a class="inline-url" href="${escapeHtml(item.href)}" title="${escapeHtml(action + ': ' + item.label)}"${item.kind === "url" ? ' target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(item.label)}</a>`;
  }
  function render(value) {
    const text = String(value || ""); let html = "", last = 0;
    for (const item of matches(text)) { html += escapeHtml(text.slice(last, item.index)) + anchor(item); last = item.index + item.label.length; }
    return html + escapeHtml(text.slice(last));
  }
  function enhanceField(field) {
    if (!field?.matches?.('textarea, input[type="text"], input[type="tel"], input[type="email"], input[type="url"]') || field.closest(".client-autocomplete") || field.matches('[role="combobox"]')) return;
    let actions = fieldActions.get(field);
    if (!actions?.isConnected) actions = null;
    const items = [...new Map(matches(field.value).map(item => [item.href, item])).values()].slice(0, 25);
    if (!items.length) { actions?.remove(); return; }
    if (!actions) {
      actions = document.createElement("span"); actions.className = "field-contact-links";
      fieldActions.set(field, actions);
      actions.setAttribute("aria-label", "Povezave iz besedila");
      // Do not activate parent cards/labels. Keep native click and long-press menus.
      actions.addEventListener("click", event => event.stopPropagation());
      // Keep action labels out of the input's accessible name and label click area.
      (field.closest("label") || field).after(actions);
    }
    const html = items.map(anchor).join(" ");
    if (actions.innerHTML !== html) actions.innerHTML = html;
  }
  function enhance(root) {
    if (root?.closest?.(".field-contact-links")) return;
    enhanceField(root);
    root?.querySelectorAll?.('textarea, input[type="text"], input[type="tel"], input[type="email"], input[type="url"]').forEach(enhanceField);
  }
  function install() {
    document.addEventListener("focusin", event => enhanceField(event.target));
    document.addEventListener("input", event => enhanceField(event.target));
    document.addEventListener("click", event => {
      const form = event.target.closest("form");
      if (form) requestAnimationFrame(() => enhance(form));
    });
    const pending = new Set(); let frame = 0;
    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.type === "attributes") pending.add(record.target);
        else for (const node of record.addedNodes) if (node.nodeType === 1 && !node.closest(".field-contact-links")) pending.add(node);
      }
      if (pending.size && !frame) frame = requestAnimationFrame(() => {
        frame = 0; const roots = [...pending]; pending.clear();
        roots.filter(root => root.isConnected).forEach(enhance);
      });
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
  }
  return { matches, render, install };
}
