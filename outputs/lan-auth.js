"use strict";

const crypto = require("node:crypto");
const { isIP } = require("node:net");
const { promisify } = require("node:util");
const scrypt = promisify(crypto.scrypt);
const options = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function lanAddress(req, network = "192.168.50.") {
  const peer = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  const address = String(req.headers["x-real-ip"] || "").trim().replace(/^::ffff:/, "");
  return (peer === "127.0.0.1" || peer === "::1") && network === "192.168.50."
    && isIP(address) === 4 && address.startsWith(network) ? address : "";
}

function passwordError(value) {
  return typeof value !== "string" || value.length < 12 || value.length > 128
    ? "Geslo INDUS mora imeti od 12 do 128 znakov." : "";
}

async function hash(value) {
  if (passwordError(value)) throw new Error(passwordError(value));
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = await scrypt(value, salt, 32, options);
  return `scrypt-v1$${salt}$${derived.toString("hex")}`;
}

async function verify(value, stored) {
  const match = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{64})$/.exec(String(stored || ""));
  // Unknown / disabled accounts still perform the same work; no account oracle.
  const derived = await scrypt(String(value || "").slice(0, 128), match?.[1] || "0".repeat(32), 32, options);
  return Boolean(match) && typeof value === "string" && value.length <= 128
    && crypto.timingSafeEqual(derived, Buffer.from(match[2], "hex"));
}

function sameOriginLogin(req) {
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) return false;
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  if (!req.headers.origin) return true; // Non-browser support clients do not send Origin.
  try {
    const origin = new URL(req.headers.origin);
    const protocol = req.socket?.encrypted || req.headers["x-forwarded-proto"] === "https" ? "https:" : "http:";
    return origin.protocol === protocol && origin.host === req.headers.host;
  } catch { return false; }
}

function createLimiter() {
  const failures = new Map();
  const keys = (address, email) => [`ip:${address}`, `account:${email}`];
  function prune(now) {
    for (const [key, attempts] of failures) {
      const recent = attempts.filter(at => now - at < 10 * 60_000);
      if (recent.length) failures.set(key, recent); else failures.delete(key);
    }
  }
  return {
    allowed(address, email, now = Date.now()) {
      prune(now);
      return failures.size < 4096 && keys(address, email).every(key => (failures.get(key)?.length || 0) < 6);
    },
    fail(address, email, now = Date.now()) {
      for (const key of keys(address, email)) failures.set(key, [...(failures.get(key) || []), now].slice(-6));
    },
    clear(address, email) { for (const key of keys(address, email)) failures.delete(key); }
  };
}

module.exports = { lanAddress, passwordError, hash, verify, sameOriginLogin, createLimiter };
