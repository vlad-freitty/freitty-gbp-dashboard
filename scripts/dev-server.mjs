// Local preview with FAKE data: fake CallRail calls and a fake sign-in (/__dev/login).
// Never reaches CallRail or Microsoft. Run: npm run dev  → http://localhost:8765
// On Vercel, middleware.js and api/* run natively; this file is not deployed (it's outside site/ and api/).

import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { callrailMock } from "./fixtures.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const PORT = Number(process.env.PORT || 8765);
Object.assign(process.env, {
  AUTH_TENANT_ID: "dev-tenant", AUTH_CLIENT_ID: "dev-client",
  SESSION_SECRET: "dev-only-secret-dev-only-secret-0000", CALLRAIL_API_KEY: "test-key",
});

const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => callrailMock(String(url), init) || realFetch(url, init);

const { sign, cookie, SESSION_COOKIE } = await import("../lib/session.js");
const middleware = (await import("../middleware.js")).default;
const routes = {
  "/api/calls": await import("../api/calls.js"),
  "/api/me": await import("../api/me.js"),
  "/api/auth/logout": await import("../api/auth/logout.js"),
};
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" };

async function handle(req) {
  const url = new URL(req.url);
  if (url.pathname === "/__dev/login") {
    const s = await sign({ email: "dev@local", name: "Local dev", exp: Math.floor(Date.now() / 1000) + 86400 }, process.env.SESSION_SECRET);
    return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": cookie(SESSION_COOKIE, s, { maxAge: 86400 }) } });
  }
  if (url.pathname === "/api/auth/login") return Response.redirect(`${url.origin}/__dev/login`, 302);
  if (!url.pathname.startsWith("/api/auth/")) {
    const mw = await middleware(req);
    if (mw.headers.get("x-middleware-next") !== "1") return mw;
  }
  const mod = routes[url.pathname];
  if (mod) return mod[req.method] ? mod[req.method](req) : new Response("Method not allowed", { status: 405 });
  let p = url.pathname === "/" ? "/index.html" : url.pathname;
  if (!extname(p)) p += ".html";
  const file = normalize(join(root, "site", p));
  if (!file.startsWith(join(root, "site"))) return new Response("Forbidden", { status: 403 });
  try { return new Response(await readFile(file), { headers: { "Content-Type": TYPES[extname(file)] || "application/octet-stream" } }); }
  catch { return new Response("Not found", { status: 404 }); }
}

http.createServer(async (nreq, nres) => {
  try {
    const chunks = []; for await (const c of nreq) chunks.push(c);
    const req = new Request(`http://localhost:${PORT}${nreq.url}`, {
      method: nreq.method, headers: nreq.headers, body: chunks.length ? Buffer.concat(chunks) : undefined,
    });
    const res = await handle(req);
    const headers = {};
    res.headers.forEach((v, k) => { if (k !== "set-cookie") headers[k] = v; });
    const sc = res.headers.getSetCookie();
    // Browsers drop Secure cookies on plain http except localhost; strip it anyway for other dev hosts.
    if (sc.length) headers["set-cookie"] = sc.map(c => c.replace("; Secure", ""));
    nres.writeHead(res.status, headers);
    nres.end(Buffer.from(await res.arrayBuffer()));
  } catch (e) {
    console.error(e); nres.writeHead(500); nres.end(String(e));
  }
}).listen(PORT, () => console.log(`Dev preview (fake data) on http://localhost:${PORT}`));
