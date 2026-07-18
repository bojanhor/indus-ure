"use strict";

// Stable, local identity for customers. A customer can exist with only an
// alias; tax ID is useful business data but never the primary key.
const crypto = require("crypto");

const CLIENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function createClientId() {
  return crypto.randomUUID();
}

function isStableClientId(value) {
  return CLIENT_ID_PATTERN.test(String(value || "").trim());
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

function normalizedClientSource(value) {
  const source = String(value || "").trim().toLowerCase();
  if (["local", "ad-hoc", "legacy-import"].includes(source)) return source;
  return source ? "legacy-import" : "local";
}

function normalizeStoredClient(client = {}) {
  const taxId = taxIdFromClient(client);
  const legacyId = String(client.clientId || client.id || "").trim();
  const clientId = isStableClientId(legacyId) ? legacyId : createClientId();
  const importIssue = String(client.syncError || client.importIssue || "").trim();
  const source = normalizedClientSource(client.source || (client.sheetRow ? "legacy-import" : ""));
  return {
    id: clientId,
    clientId,
    name: String(client.name || client.search || "").trim(),
    search: String(client.search || client.name || "").trim(),
    email: String(client.email || "").trim(),
    phone: String(client.phone || "").trim(),
    address: String(client.address || "").trim(),
    city: String(client.city || "").trim(),
    postal: String(client.postal || "").trim(),
    country: String(client.country || "").trim(),
    taxId,
    vatPayer: Boolean(client.vatPayer),
    source,
    needsReview: client.needsReview === undefined ? Boolean(!taxId || importIssue) : Boolean(client.needsReview),
    importIssue,
    createdBy: client.createdBy || "system",
    createdAt: client.createdAt || new Date().toISOString(),
    updatedAt: client.updatedAt || client.createdAt || new Date().toISOString()
  };
}

function resolveStableClientId(clients, value) {
  const key = normalizedText(value);
  if (!key) return "";
  const exact = (clients || []).find((client) => [client.clientId, client.id, client.taxId, client.search, client.name]
    .some((candidate) => normalizedText(candidate) === key));
  return exact?.clientId || "";
}

module.exports = {
  createClientId,
  isStableClientId,
  isUsableTaxId,
  normalizeStoredClient,
  normalizeTaxId,
  normalizedText,
  resolveStableClientId,
  taxIdFromClient
};