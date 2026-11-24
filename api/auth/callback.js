// Microsoft posts the id_token here (response_mode=form_post).

import { authConfig, sign, verify, cookie, getCookie, NONCE_COOKIE, SESSION_COOKIE, safeReturnPath } from "../../lib/session.js";
import { verifyIdToken } from "../../lib/entra.js";
import { landing, esc } from "../../lib/pages.js";

const fail = (status, note) => landing({ status, title: "Не вдалося увійти", note });

export async function POST(request) {
  const cfg = authConfig();
  if (cfg.missing.length) return landing({ status: 500, title: "Вхід ще не налаштовано", button: false, note: `У Vercel немає: <code>${cfg.missing.map(esc).join(", ")}</code>.` });

  const form = await request.formData();
  const err = form.get("error");
  if (err) {
    return fail(403, err === "access_denied"
      ? "Доступ до дашборда не надано. Попросіть адміністратора Microsoft 365 додати вас до застосунку."
      : "Microsoft повернув помилку: " + esc(form.get("error_description") || err));
  }

  const pending = await verify(getCookie(request, NONCE_COOKIE), cfg.secret);
  if (!pending || pending.state !== form.get("state")) return fail(400, "Сесія входу застаріла. Почніть вхід заново.");

  let claims;
  try {
    claims = await verifyIdToken(form.get("id_token"), { tenantId: cfg.tenantId, clientId: cfg.clientId, nonce: pending.nonce });
  } catch (e) {
    return fail(401, esc(e.message));
  }

  const email = String(claims.preferred_username || claims.email || claims.upn || "").toLowerCase();
  if (cfg.allowed.length && !cfg.allowed.includes(email)) {
    return fail(403, `Акаунт ${esc(email)} не має доступу до дашборда. Зверніться до власника дашборда.`);
  }

  const maxAge = Math.round(cfg.sessionHours * 3600);
  const session = await sign({ sub: claims.oid || claims.sub, email, name: claims.name || email, exp: Math.floor(Date.now() / 1000) + maxAge }, cfg.secret);

  const headers = new Headers({ Location: safeReturnPath(pending.r), "Cache-Control": "no-store" });
  headers.append("Set-Cookie", cookie(SESSION_COOKIE, session, { maxAge }));
  headers.append("Set-Cookie", cookie(NONCE_COOKIE, "", { maxAge: 0, sameSite: "None", path: "/api/auth" }));
  return new Response(null, { status: 303, headers });
}
