// Gates the whole site (dashboard, data.json, /api/calls) behind a Microsoft sign-in.
// Only /api/auth/* is reachable without a session. Signed-out visitors see our own sign-in
// page first (same as the CS Wiki); Microsoft opens only after they press the button.

import { next } from "@vercel/functions";
import { authConfig, currentUser } from "./lib/session.js";
import { landing, esc } from "./lib/pages.js";

export const config = {
  matcher: ["/((?!api/auth/).*)"],
};

export default async function middleware(request) {
  const cfg = authConfig();
  if (cfg.missing.length) {
    return landing({
      status: 500, title: "Вхід ще не налаштовано", button: false,
      note: `У Vercel (Settings → Environment Variables) немає: <code>${cfg.missing.map(esc).join(", ")}</code>. Додайте їх і зробіть Redeploy.`,
    });
  }

  if (await currentUser(request)) return next();

  const url = new URL(request.url);
  const wantsPage = request.method === "GET" && !url.pathname.startsWith("/api/")
    && (request.headers.get("accept") || "").includes("text/html");
  if (wantsPage) return landing({ ret: url.pathname + url.search });
  return new Response(JSON.stringify({ error: "signed_out" }), {
    status: 401,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
