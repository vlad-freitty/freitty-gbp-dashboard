// Gates the whole site (dashboard, data.json, /api/calls) behind a Microsoft sign-in.
// Only /api/auth/* is reachable without a session.

import { next } from "@vercel/functions";
import { authConfig, currentUser } from "./lib/session.js";
import { page, esc } from "./lib/pages.js";

export const config = {
  matcher: ["/((?!api/auth/).*)"],
};

export default async function middleware(request) {
  const cfg = authConfig();
  if (cfg.missing.length) {
    return page(500, "Sign-in is not configured",
      `<p>Set these environment variables in Vercel (Project → Settings → Environment Variables), then redeploy:</p>
       <p><code>${cfg.missing.map(esc).join("<br>")}</code></p>`);
  }

  if (await currentUser(request)) return next();

  const url = new URL(request.url);
  const wantsPage = request.method === "GET" && !url.pathname.startsWith("/api/")
    && (request.headers.get("accept") || "").includes("text/html");
  if (wantsPage) {
    const login = new URL("/api/auth/login", url.origin);
    login.searchParams.set("r", url.pathname + url.search);
    return Response.redirect(login.toString(), 302);
  }
  return new Response(JSON.stringify({ error: "signed_out" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
