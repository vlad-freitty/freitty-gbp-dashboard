// Microsoft posts the id_token here (response_mode=form_post).

import { authConfig, sign, verify, cookie, getCookie, NONCE_COOKIE, SESSION_COOKIE, safeReturnPath } from "../../lib/session.js";
import { verifyIdToken } from "../../lib/entra.js";
import { page, esc } from "../../lib/pages.js";

const retry = `<p><a class="btn" href="/api/auth/login">Try again</a></p>`;

export async function POST(request) {
  const cfg = authConfig();
  if (cfg.missing.length) return page(500, "Sign-in is not configured", `<p>Missing: <code>${cfg.missing.map(esc).join(", ")}</code></p>`);

  const form = await request.formData();
  if (form.get("error")) {
    return page(401, "Sign-in failed", `<p>${esc(form.get("error_description") || form.get("error"))}</p>${retry}`);
  }

  const pending = await verify(getCookie(request, NONCE_COOKIE), cfg.secret);
  if (!pending || pending.state !== form.get("state")) {
    return page(400, "Sign-in expired", `<p>The sign-in took too long or was started in another tab.</p>${retry}`);
  }

  let claims;
  try {
    claims = await verifyIdToken(form.get("id_token"), { tenantId: cfg.tenantId, clientId: cfg.clientId, nonce: pending.nonce });
  } catch (e) {
    return page(401, "Sign-in failed", `<p>${esc(e.message)}</p>${retry}`);
  }

  const email = String(claims.preferred_username || claims.email || claims.upn || "").toLowerCase();
  if (cfg.allowed.length && !cfg.allowed.includes(email)) {
    return page(403, "No access", `<p>${esc(email)} is not on the list of people who can open this dashboard. Ask the dashboard owner to add you.</p>`);
  }

  const maxAge = Math.round(cfg.sessionDays * 86400);
  const session = await sign({ sub: claims.oid || claims.sub, email, name: claims.name || email, exp: Math.floor(Date.now() / 1000) + maxAge }, cfg.secret);

  const headers = new Headers({ Location: safeReturnPath(pending.r), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, session, { maxAge }));
  headers.append("Set-Cookie", cookie(NONCE_COOKIE, "", { maxAge: 0, sameSite: "None", path: "/api/auth" }));
  return new Response(null, { status: 303, headers });
}
