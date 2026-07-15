"use strict";

const DEFAULT_CLIENT_SHEET_RANGE = "'Baza Strank'!A:I";

function normalizeTaxId(value) {
  return String(value || "")
    .trim()
    .replace(/^tax:/i, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

function isUsableTaxId(value) {
  const taxId = normalizeTaxId(value);
  return /^(?=.{8,20}$)(?=.*\d)[A-Z0-9]+$/.test(taxId);
}

function taxIdFromClient(client = {}) {
  const direct = normalizeTaxId(client.taxId);
  if (isUsableTaxId(direct)) return direct;
  const legacy = normalizeTaxId(client.clientId || client.id);
  return isUsableTaxId(legacy) ? legacy : "";
}

function normalizeStoredClient(client = {}, { preserveLegacyId = true } = {}) {
  const taxId = taxIdFromClient(client);
  const legacyId = String(client.clientId || client.id || "").trim();
  const usable = Boolean(taxId && !client.syncError);
  const clientId = usable ? taxId : preserveLegacyId ? legacyId : "";
  return {
    id: clientId,
    clientId,
    name: String(client.name || "").trim(),
    search: String(client.search || client.name || "").trim(),
    email: String(client.email || "").trim(),
    address: String(client.address || "").trim(),
    city: String(client.city || "").trim(),
    postal: String(client.postal || "").trim(),
    country: String(client.country || "").trim(),
    taxId,
    vatPayer: Boolean(client.vatPayer),
    syncError: String(client.syncError || "").trim(),
    sheetRow: Number(client.sheetRow || 0),
    createdBy: client.createdBy || "system",
    createdAt: client.createdAt || new Date().toISOString()
  };
}

function sheetRowToClient(row, rowNumber) {
  const name = String(row?.[1] || "").trim();
  if (!name) return null;
  const taxId = normalizeTaxId(row?.[7]);
  return {
    id: taxId,
    clientId: taxId,
    name,
    search: String(row?.[0] || name).trim(),
    email: String(row?.[2] || "").trim(),
    address: String(row?.[3] || "").trim(),
    city: String(row?.[4] || "").trim(),
    postal: String(row?.[5] || "").trim(),
    country: String(row?.[6] || "").trim(),
    taxId,
    vatPayer: /^(DA|YES|TRUE|1)$/i.test(String(row?.[8] || "").trim()),
    syncError: "",
    sheetRow: rowNumber,
    createdBy: "google-sheets",
    createdAt: new Date().toISOString()
  };
}

function parseSheetClients(rows = [], existingClients = []) {
  const records = rows.slice(1)
    .map((row, index) => sheetRowToClient(row, index + 2))
    .filter(Boolean);
  const taxCounts = new Map();
  records.forEach((client) => {
    if (!isUsableTaxId(client.taxId)) return;
    taxCounts.set(client.taxId, (taxCounts.get(client.taxId) || 0) + 1);
  });

  const existingByTax = new Map();
  const existingByName = new Map();
  existingClients.forEach((client) => {
    const taxId = taxIdFromClient(client);
    if (taxId) existingByTax.set(taxId, client);
    if (client.name) existingByName.set(String(client.name).trim().toLowerCase(), client);
  });

  const issues = [];
  const clients = records.map((client) => {
    let syncError = "";
    if (!client.taxId) syncError = "V Google Sheetu manjka davcna stevilka.";
    else if (!isUsableTaxId(client.taxId)) syncError = "Davcna stevilka v Google Sheetu ni veljavna.";
    else if ((taxCounts.get(client.taxId) || 0) > 1) syncError = "Davcna stevilka se v Google Sheetu ponovi.";
    if (syncError) issues.push({ row: client.sheetRow, name: client.name, taxId: client.taxId, error: syncError });
    const previous = existingByTax.get(client.taxId) || existingByName.get(client.name.toLowerCase()) || {};
    return {
      ...client,
      id: syncError ? "" : client.taxId,
      clientId: syncError ? "" : client.taxId,
      syncError,
      createdBy: previous.createdBy || "google-sheets",
      createdAt: previous.createdAt || new Date().toISOString()
    };
  });

  return {
    clients,
    issues,
    total: clients.length,
    usable: clients.filter((client) => client.clientId).length,
    missingTax: issues.filter((issue) => issue.error.includes("manjka")).length,
    duplicateTax: issues.filter((issue) => issue.error.includes("ponovi")).length
  };
}

function rekeyClientReferences(db, previousClients, clients) {
  const previousById = new Map();
  previousClients.forEach((client) => {
    [client.clientId, client.id].filter(Boolean).forEach((value) => previousById.set(String(value).trim().toLowerCase(), client));
  });
  const nextByTax = new Map();
  const nextByName = new Map();
  clients.filter((client) => client.clientId).forEach((client) => {
    nextByTax.set(client.taxId, client);
    [client.name, client.search].filter(Boolean).forEach((value) => nextByName.set(String(value).trim().toLowerCase(), client));
  });

  let updated = 0;
  const unresolved = [];
  const migrate = (item, kind) => {
    if (!item.client && !item.clientId) return;
    const rawId = String(item.clientId || "").trim();
    const normalizedId = normalizeTaxId(rawId);
    const previous = previousById.get(rawId.toLowerCase());
    const previousTax = taxIdFromClient(previous || {});
    const match = (isUsableTaxId(normalizedId) ? nextByTax.get(normalizedId) : null)
      || (previousTax ? nextByTax.get(previousTax) : null)
      || nextByName.get(String(previous?.name || item.client || "").trim().toLowerCase())
      || nextByName.get(String(previous?.search || "").trim().toLowerCase());
    if (!match) {
      unresolved.push({ kind, id: item.id || "", client: item.client || "", clientId: rawId });
      return;
    }
    if (item.clientId !== match.taxId || item.client !== match.name) updated++;
    item.clientId = match.taxId;
    item.client = match.name;
  };
  (db.entries || []).forEach((item) => migrate(item, "entry"));
  (db.todos || []).forEach((item) => migrate(item, "todo"));
  return { updated, unresolved };
}

function clientToSheetRow(client, existingRow = []) {
  const value = (field, index, fallback = "") => String(client[field] || existingRow[index] || fallback).trim();
  return [
    value("search", 0, client.name),
    value("name", 1),
    value("email", 2),
    value("address", 3),
    value("city", 4),
    value("postal", 5),
    value("country", 6, "Slovenija"),
    normalizeTaxId(client.taxId),
    client.vatPayer ? "DA" : "NE"
  ];
}

function sheetPrefix(range = DEFAULT_CLIENT_SHEET_RANGE) {
  const value = String(range || DEFAULT_CLIENT_SHEET_RANGE);
  return value.includes("!") ? value.slice(0, value.indexOf("!")) : "'Baza Strank'";
}

function sheetRowRange(range, rowNumber) {
  return `${sheetPrefix(range)}!A${rowNumber}:I${rowNumber}`;
}

function sheetAppendRange(range) {
  return `${sheetPrefix(range)}!A:I`;
}

function findFirstEmptyClientRow(rows = []) {
  const index = rows.slice(1).findIndex((row) => {
    const firstEight = Array.from({ length: 8 }, (_, column) => String(row?.[column] || "").trim());
    return firstEight.every((value) => !value);
  });
  return index < 0 ? 0 : index + 2;
}

module.exports = {
  DEFAULT_CLIENT_SHEET_RANGE,
  clientToSheetRow,
  findFirstEmptyClientRow,
  isUsableTaxId,
  normalizeStoredClient,
  normalizeTaxId,
  parseSheetClients,
  rekeyClientReferences,
  sheetAppendRange,
  sheetRowRange,
  taxIdFromClient
};
