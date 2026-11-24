// Signed session cookie shared by middleware.js and the /api functions.
// Format: base64url(JSON payload) + "." + base64url(HMAC-SHA256(payload, SESSION_SECRET)).
// Uses Web Crypto only, so it runs in Routing Middleware and in Node functions.

export const SESSION_COOKIE = "fs_session";
export const NONCE_COOKIE = "fs_auth";

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64urlEncode(bytes) {
  if (typeof bytes === "string") bytes = enc.encode(bytes);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlDecodeJSON(str) {
  return JSON.parse(dec.decode(b64urlDecode(str)));
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function sign(payload, secret) {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(body));
  return body + "." + b64urlEncode(new Uint8Array(sig));
}

/** Returns the payload if the signature is valid and it has not expired, else null. */
export async function verify(token, secret) {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  let sig;
  try { sig = b64urlDecode(token.slice(dot + 1)); } catch { return null; }
  const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), sig, enc.encode(body));
  if (!ok) return null;
  let payload;
  try { payload = b64urlDecodeJSON(body); } catch { return null; }
  if (!payload.exp || Date.now() / 1000 > payload.exp) return null;
  return payload;
}

export function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function cookie(name, value, { maxAge, sameSite = "Lax", path = "/" } = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; Secure; SameSite=${sameSite}`;
  if (maxAge !== undefined) c += `; Max-Age=${maxAge}`;
  return c;
}

export function authConfig(env = process.env) {
  const cfg = {
    tenantId: env.AUTH_TENANT_ID || "",
    clientId: env.AUTH_CLIENT_ID || "",
    secret: env.SESSION_SECRET || "",
    allowed: (env.ALLOWED_EMAILS || "").split(",").map(s => s.trim().toLowerCase()).filter(Boolean),
    sessionHours: Number(env.SESSION_HOURS || 12), // same as the CS Wiki
  };
  cfg.missing = ["AUTH_TENANT_ID", "AUTH_CLIENT_ID", "SESSION_SECRET"].filter(k => !env[k]);
  if (cfg.secret && cfg.secret.length < 32) cfg.missing.push("SESSION_SECRET (at least 32 characters)");
  return cfg;
}

/** The signed-in user for this request, or null. */
export async function currentUser(request, env = process.env) {
  const cfg = authConfig(env);
  if (cfg.missing.length) return null;
  return verify(getCookie(request, SESSION_COOKIE), cfg.secret);
}

/** Only allow same-site relative return paths ("/x", never "//evil" or "https://..."). */
export function safeReturnPath(p) {
  if (typeof p !== "string" || !p.startsWith("/") || p.startsWith("//") || p.startsWith("/\\")) return "/";
  if (p.startsWith("/api/auth/")) return "/";
  return p.slice(0, 500);
}
