// Offline tests: session cookies, Microsoft id_token checks, the full sign-in round trip,
// middleware gating, channel rules, and /api/calls against a fake CallRail.
// Run: npm test

import assert from "node:assert/strict";
import { callrailMock } from "./fixtures.mjs";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
Object.assign(process.env, {
  AUTH_TENANT_ID: TENANT, AUTH_CLIENT_ID: CLIENT,
  SESSION_SECRET: "test-secret-test-secret-test-secret-123",
  CALLRAIL_API_KEY: "test-key",
});

const { sign, verify, safeReturnPath, b64urlEncode, SESSION_COOKIE, NONCE_COOKIE } = await import("../lib/session.js");
const { verifyIdToken } = await import("../lib/entra.js");
const { classify } = await import("../lib/callrail.js");

// --- fake Microsoft signing key + fetch interception ---
const kp = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const pub = { ...(await crypto.subtle.exportKey("jwk", kp.publicKey)), kid: "k1" };
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const s = String(url);
  if (s === `https://login.microsoftonline.com/${TENANT}/discovery/v2.0/keys`) return Response.json({ keys: [pub] });
  return callrailMock(s, init) || realFetch(url, init);
};
async function idToken(claims, key = kp.privateKey) {
  const h = b64urlEncode(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const now = Math.floor(Date.now() / 1000);
  const p = b64urlEncode(JSON.stringify({ iss: `https://login.microsoftonline.com/${TENANT}/v2.0`, aud: CLIENT, tid: TENANT, exp: now + 3600, nbf: now - 10, oid: "user-1", name: "Test User", preferred_username: "Test.User@freitty.com", ...claims }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(h + "." + p));
  return `${h}.${p}.${b64urlEncode(new Uint8Array(sig))}`;
}

let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok  ", name); }
  catch (e) { console.error("FAIL", name, "\n     ", e.message); process.exitCode = 1; }
}
const secret = process.env.SESSION_SECRET;
const cookieVal = (setCookie, name) => decodeURIComponent(new RegExp(`${name}=([^;]*)`).exec(setCookie)[1]);

await test("session: round trip, tamper, expiry, wrong secret", async () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const t = await sign({ email: "a@b.c", exp }, secret);
  assert.equal((await verify(t, secret)).email, "a@b.c");
  assert.equal(await verify(t.slice(0, -2) + "xx", secret), null);
  assert.equal(await verify(b64urlEncode(JSON.stringify({ email: "evil", exp })) + t.slice(t.indexOf(".")), secret), null);
  assert.equal(await verify(await sign({ exp: 1 }, secret), secret), null);
  assert.equal(await verify(t, secret + "x"), null);
  assert.equal(await verify("garbage", secret), null);
});

await test("safeReturnPath blocks open redirects", () => {
  assert.equal(safeReturnPath("/calls?x=1"), "/calls?x=1");
  for (const bad of ["//evil.com", "https://evil.com", "/\\evil.com", "evil", "/api/auth/login", null]) assert.equal(safeReturnPath(bad), "/");
});

await test("id_token: valid token accepted", async () => {
  const c = await verifyIdToken(await idToken({ nonce: "n1" }), { tenantId: TENANT, clientId: CLIENT, nonce: "n1" });
  assert.equal(c.oid, "user-1");
});

await test("id_token: wrong audience / tenant / issuer / nonce / expired / signature rejected", async () => {
  const o = { tenantId: TENANT, clientId: CLIENT, nonce: "n1" };
  const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
  const cases = [
    [{ nonce: "n1", aud: "other-app" }, /audience/],
    [{ nonce: "n1", tid: "other-tenant" }, /tenant/],
    [{ nonce: "n1", iss: "https://login.microsoftonline.com/common/v2.0" }, /issuer/],
    [{ nonce: "n2" }, /mismatch/],
    [{ nonce: "n1", exp: Math.floor(Date.now() / 1000) - 3600 }, /expired/],
  ];
  for (const [claims, re] of cases) await assert.rejects(verifyIdToken(await idToken(claims), o), re);
  await assert.rejects(verifyIdToken(await idToken({ nonce: "n1" }, other.privateKey), o), /signature/);
  await assert.rejects(verifyIdToken("a.b", o), /Malformed/);
});

const { GET: login } = await import("../api/auth/login.js");
const { POST: callback } = await import("../api/auth/callback.js");
const { GET: me } = await import("../api/me.js");
const { GET: calls } = await import("../api/calls.js");
const middleware = (await import("../middleware.js")).default;
const base = "https://dash.example.vercel.app";

async function signIn(claims = {}) {
  const res = await login(new Request(`${base}/api/auth/login?r=/%3Ftab%3Dcalls`));
  assert.equal(res.status, 302);
  const loc = new URL(res.headers.get("location"));
  assert.equal(loc.origin + loc.pathname, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/authorize`);
  assert.equal(loc.searchParams.get("redirect_uri"), `${base}/api/auth/callback`);
  assert.equal(loc.searchParams.get("response_mode"), "form_post");
  assert.equal(loc.searchParams.get("prompt"), "select_account");
  const sc = res.headers.get("set-cookie");
  assert.match(sc, /SameSite=None/); assert.match(sc, /HttpOnly/); assert.match(sc, /Secure/);
  const pending = cookieVal(sc, NONCE_COOKIE);
  const form = new URLSearchParams({ id_token: await idToken({ nonce: loc.searchParams.get("nonce"), ...claims }), state: loc.searchParams.get("state") });
  return callback(new Request(`${base}/api/auth/callback`, {
    method: "POST", body: form,
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: `${NONCE_COOKIE}=${encodeURIComponent(pending)}` },
  }));
}

let session;
await test("sign-in round trip sets a session and returns to the page", async () => {
  const res = await signIn();
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/?tab=calls");
  const sc = res.headers.get("set-cookie");
  session = cookieVal(sc, SESSION_COOKIE);
  const who = await (await me(new Request(`${base}/api/me`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` } }))).json();
  assert.equal(who.email, "test.user@freitty.com");
});

await test("callback shows a friendly page when Microsoft denies access", async () => {
  const res = await callback(new Request(`${base}/api/auth/callback`, {
    method: "POST", body: new URLSearchParams({ error: "access_denied", error_description: "<b>x</b>" }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }));
  assert.equal(res.status, 403);
  assert.match(await res.text(), /Доступ до дашборда не надано/);
});

await test("session lasts 12 hours by default", async () => {
  const res = await signIn();
  assert.match(res.headers.get("set-cookie"), /fs_session=[^;]+;[^,]*Max-Age=43200/);
});

await test("callback rejects a forged state", async () => {
  const res = await callback(new Request(`${base}/api/auth/callback`, {
    method: "POST", body: new URLSearchParams({ id_token: await idToken({ nonce: "x" }), state: "forged" }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }));
  assert.equal(res.status, 400);
});

await test("ALLOWED_EMAILS limits who gets in", async () => {
  process.env.ALLOWED_EMAILS = "someone.else@freitty.com";
  const denied = await signIn();
  assert.equal(denied.status, 403);
  assert.match(await denied.text(), /не має доступу/);
  process.env.ALLOWED_EMAILS = "Someone.Else@freitty.com, test.user@freitty.com";
  assert.equal((await signIn()).status, 303);
  delete process.env.ALLOWED_EMAILS;
});

await test("middleware: redirects pages, 401s data, passes signed-in users", async () => {
  const page = await middleware(new Request(`${base}/?tab=calls`, { headers: { accept: "text/html" } }));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Увійти через Microsoft/);
  assert.match(html, /href="\/api\/auth\/login\?r=%2F%3Ftab%3Dcalls"/);
  assert.equal((await middleware(new Request(`${base}/data.json`))).status, 401);
  assert.equal((await middleware(new Request(`${base}/api/calls?from=2026-01-01&to=2026-01-02`))).status, 401);
  const ok = await middleware(new Request(`${base}/data.json`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` } }));
  assert.equal(ok.headers.get("x-middleware-next"), "1");
  const bad = await middleware(new Request(`${base}/data.json`, { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session.slice(0, -3))}abc` } }));
  assert.equal(bad.status, 401);
});

await test("middleware fails closed when sign-in is not configured", async () => {
  const keep = process.env.AUTH_CLIENT_ID; delete process.env.AUTH_CLIENT_ID;
  const res = await middleware(new Request(`${base}/`, { headers: { accept: "text/html" } }));
  process.env.AUTH_CLIENT_ID = keep;
  assert.equal(res.status, 500);
  const t = await res.text();
  assert.match(t, /AUTH_CLIENT_ID/);
  assert.doesNotMatch(t, /Увійти через Microsoft/);
});

await test("matcher leaves /api/auth/* open and gates everything else", async () => {
  const { config } = await import("../middleware.js");
  const re = new RegExp("^" + config.matcher[0].replace(/\(\(\?!/, "((?!") + "$");
  for (const p of ["/", "/data.json", "/calls.js", "/api/calls", "/api/me"]) assert.ok(re.test(p), p);
  for (const p of ["/api/auth/login", "/api/auth/callback"]) assert.ok(!re.test(p), p);
});

await test("channel rules", () => {
  const T = {
    gmb: { name: "GBP Chicago", source: { type: "google_my_business" } },
    ext: { name: "Call asset", source: { type: "google_ad_extension" } },
    paid: { name: "Site paid", source: { type: "search", search_engine: "google", search_type: "paid" } },
    org: { name: "Site organic", source: { type: "search", search_engine: "google", search_type: "organic" } },
  };
  assert.equal(classify({ source: "Google My Business" }, T.gmb), "Google Maps (organic)");
  assert.equal(classify({ source: "Google My Business", gclid: "x" }, T.gmb), "Google Maps Ads");
  assert.equal(classify({ source: "Google Ads" }, T.ext), "Google Ads");
  assert.equal(classify({ source: "Google Paid", medium: "cpc" }, T.paid), "Google Ads");
  assert.equal(classify({ source: "Google Organic", medium: "organic" }, T.org), "Google organic (site)");
  assert.equal(classify({ source: "Facebook" }, undefined), "Other: Facebook");
  assert.equal(classify({}, undefined), "Other");
});

await test("/api/calls: signed out → 401, bad input → 400, pagination collects every call", async () => {
  assert.equal((await calls(new Request(`${base}/api/calls?from=2026-01-01&to=2026-01-31`))).status, 401);
  const h = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` } };
  assert.equal((await calls(new Request(`${base}/api/calls?from=2026-02-01&to=2026-01-01`, h))).status, 400);
  assert.equal((await calls(new Request(`${base}/api/calls?from=2020-01-01&to=2020-02-01`, h))).status, 400);
  const to = new Date().toISOString().slice(0, 10), from = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
  const res = await calls(new Request(`${base}/api/calls?from=${from}&to=${to}`, h));
  assert.equal(res.status, 200, await res.clone().text());
  const j = await res.json();
  assert.ok(j.calls.length > 500, "expected several pages of calls, got " + j.calls.length);
  assert.equal(new Set(j.calls.map(c => c.id)).size, j.calls.length, "duplicate calls across pages");
  assert.equal(j.truncated, false);
  const chans = new Set(j.calls.map(c => c.ch));
  for (const ch of ["Google Ads", "Google Maps Ads", "Google Maps (organic)", "Google organic (site)"]) assert.ok(chans.has(ch), ch);
  assert.match(j.calls[0].num, /^\+1\d{10}$/);
  assert.equal(res.headers.get("cache-control"), "private, no-store");
});

await test("/api/calls: a wrong CallRail key is reported, not crashed", async () => {
  process.env.CALLRAIL_API_KEY = "wrong";
  const h = { headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(session)}` } };
  const res = await calls(new Request(`${base}/api/calls?from=2026-11-01&to=2026-11-02&fresh=1`, h));
  process.env.CALLRAIL_API_KEY = "test-key";
  assert.equal(res.status, 502);
  assert.match((await res.json()).error, /CallRail 401/);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
