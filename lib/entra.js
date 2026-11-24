// Verifies a Microsoft Entra ID (Azure AD) v2.0 id_token with Web Crypto.
// Checks: RS256 signature against the tenant's published keys, issuer, audience,
// tenant id, expiry, and the nonce we sent.

import { b64urlDecode, b64urlDecodeJSON } from "./session.js";

const enc = new TextEncoder();
let jwksCache = { url: "", at: 0, keys: [] };

async function getKeys(tenantId, force = false) {
  const url = `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`;
  if (!force && jwksCache.url === url && Date.now() - jwksCache.at < 6 * 3600 * 1000) return jwksCache.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load Microsoft signing keys (HTTP ${res.status})`);
  const { keys } = await res.json();
  jwksCache = { url, at: Date.now(), keys };
  return keys;
}

export async function verifyIdToken(idToken, { tenantId, clientId, nonce }) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("Malformed id_token");
  const header = b64urlDecodeJSON(parts[0]);
  const claims = b64urlDecodeJSON(parts[1]);
  if (header.alg !== "RS256") throw new Error("Unexpected token algorithm");

  let jwk = (await getKeys(tenantId)).find(k => k.kid === header.kid);
  if (!jwk) jwk = (await getKeys(tenantId, true)).find(k => k.kid === header.kid); // keys rotate
  if (!jwk) throw new Error("Unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  if (!ok) throw new Error("Bad token signature");

  const now = Date.now() / 1000;
  if (claims.iss !== `https://login.microsoftonline.com/${tenantId}/v2.0`) throw new Error("Wrong token issuer");
  if (claims.aud !== clientId) throw new Error("Wrong token audience");
  if (claims.tid !== tenantId) throw new Error("Account is not in the FREITTY tenant");
  if (!claims.exp || now > claims.exp + 300) throw new Error("Token expired");
  if (claims.nbf && now + 300 < claims.nbf) throw new Error("Token not yet valid");
  if (!nonce || claims.nonce !== nonce) throw new Error("Sign-in request mismatch, please try again");
  return claims;
}
