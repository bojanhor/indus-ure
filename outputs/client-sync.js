"use strict";

const crypto = require("crypto");

const DEFAULT_CLIENT_SHEET_RANGE = "'Baza Strank'!A:I";
const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isStableClientId(value) {
  return CLIENT_ID_PATTERN.test(String(value || "").trim());
}

function createClientId() {
  return crypto.randomUUID();
}

function normalizedText(value) {
  return String(value || "").trim().toLocaleLowerCase("sl");
}

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

function normalizeStoredClient(client = {}) {
  const taxId = taxIdFromClient(client);
  const legacyId = String(client.clientId || client.id || "").trim();
  const clientId = isStableClientId(legacyId) ? legacyId : createClientId();
  const syncError = String(client.syncError || "").trim();
  const source = String(client.source || (client.sheetRow || client.createdBy === "google-sheets" ? "google-sheets" : "local"));
  return {
    id: clientId,
    clientId,
    name: String(client.name || client.search || "").trim(),
    search: String(client.search || client.name || "").trim(),
    email: String(client.email || "").trim(),
    address: String(client.address || "").trim(),
    city: String(client.city || "").trim(),
    postal: String(client.postal || "").trim(),
    country: String(client.country || "").trim(),
    taxId,
    vatPayer: Boolean(client.vatPayer),
    source,
    needsReview: client.needsReview === undefined ? Boolean(!taxId || syncError) : Boolean(client.needsReview),
    syncError,
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
    name,
    search: String(row?.[0] || name).trim(),
    email: String(row?.[2] || "").trim(),
    address: String(row?.[3] || "").trim(),
    city: String(row?.[4] || "").trim(),
    postal: String(row?.[5] || "").trim(),
    country: String(row?.[6] || "").trim(),
    taxId,
    vatPayer: /^(DA|YES|TRUE|1)$/i.test(String(row?.[8] || "").trim()),
    sheetRow: rowNumber
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
  const existingByRow = new Map();
  existingClients.map((client) => normalizeStoredClient(client)).forEach((client) => {
    const taxId = taxIdFromClient(client);
    if (taxId) existingByTax.set(taxId, client);
    [client.name, client.search].filter(Boolean).forEach((value) => existingByName.set(normalizedText(value), client));
    if (client.sheetRow) existingByRow.set(client.sheetRow, client);
  });

  const issues = [];
  const seenSignatures = new Set();
  const clients = [];
  records.forEach((client) => {
    let syncError = "";
    if (!client.taxId) syncError = "V Google Sheetu manjka davcna stevilka.";
    else if (!isUsableTaxId(client.taxId)) syncError = "Davcna stevilka v Google Sheetu ni veljavna.";
    else if ((taxCounts.get(client.taxId) || 0) > 1) syncError = "Davcna stevilka se v Google Sheetu ponovi.";
    if (syncError) issues.push({ row: client.sheetRow, name: client.name, taxId: client.taxId, error: syncError });
    const uniqueTax = client.taxId && (taxCounts.get(client.taxId) || 0) === 1;
    const previous = (uniqueTax ? existingByTax.get(client.taxId) : null)
      || existingByName.get(normalizedText(client.search))
      || existingByName.get(normalizedText(client.name))
      || existingByRow.get(client.sheetRow)
      || {};
    const normalized = normalizeStoredClient({
      ...previous,
      ...client,
      id: previous.clientId || previous.id,
      clientId: previous.clientId || previous.id,
      source: "google-sheets",
      needsReview: Boolean(syncError),
      syncError,
      createdBy: previous.createdBy || "google-sheets",
      createdAt: previous.createdAt || new Date().toISOString()
    });
    const signature = [normalized.taxId, normalizedText(normalized.search), normalizedText(normalized.name)].join("|");
    if (seenSignatures.has(signature)) return;
    seenSignatures.add(signature);
    clients.push(normalized);
  });

  return {
    clients,
    issues,
    total: records.length,
    usable: clients.filter((client) => !client.syncError).length,
    missingTax: issues.filter((issue) => issue.error.includes("manjka")).length,
    duplicateTax: issues.filter((issue) => issue.error.includes("ponovi")).length
  };
}

function rekeyClientReferences(db, previousClients, clients) {
  const previousById = new Map();
  previousClients.forEach((client) => {
    [client.clientId, client.id].filter(Boolean).forEach((value) => previousById.set(normalizedText(value), client));
  });
  const nextById = new Map();
  const nextByTax = new Map();
  const nextByName = new Map();
  clients.forEach((client) => {
    [client.clientId, client.id].filter(Boolean).forEach((value) => nextById.set(normalizedText(value), client));
    if (client.taxId) nextByTax.set(client.taxId, client);
    [client.name, client.search].filter(Boolean).forEach((value) => nextByName.set(normalizedText(value), client));
  });

  let updated = 0;
  const unresolved = [];
  const migrate = (item, kind) => {
    if (!item.client && !item.clientId) return;
    const rawId = String(item.clientId || "").trim();
    const normalizedId = normalizeTaxId(rawId);
    const previous = previousById.get(normalizedText(rawId));
    const previousTax = taxIdFromClient(previous || {});
    const match = nextById.get(normalizedText(rawId))
      || (isUsableTaxId(normalizedId) ? nextByTax.get(normalizedId) : null)
      || (previousTax ? nextByTax.get(previousTax) : null)
      || nextByName.get(normalizedText(previous?.name || item.client))
      || nextByName.get(normalizedText(previous?.search));
    if (!match) {
      unresolved.push({ kind, id: item.id || "", client: item.client || "", clientId: rawId });
      return;
    }
    if (item.clientId !== match.clientId || item.client !== match.name) updated++;
    item.clientId = match.clientId;
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
  createClientId,
  findFirstEmptyClientRow,
  isStableClientId,
  isUsableTaxId,
  normalizeStoredClient,
  normalizeTaxId,
  parseSheetClients,
  rekeyClientReferences,
  sheetAppendRange,
  sheetRowRange,
  taxIdFromClient
};
