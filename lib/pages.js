// Sign-in page shown before Microsoft (same pattern as the CS Wiki): the dashboard's own look,
// one clear "Sign in with Microsoft" button. Also used for sign-in errors and sign-out.

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * @param {object} o
 * @param {string} [o.title]
 * @param {string} [o.note]   HTML (escape any user/remote text before passing it in)
 * @param {"ok"|""} [o.tone]
 * @param {string} [o.ret]    path to return to after sign-in
 * @param {boolean} [o.button] show the sign-in button
 */
export function landing({ status = 200, title = "Вхід у дашборд", note = "", tone = "", ret = "/", button = true, headers = {} } = {}) {
  const href = "/api/auth/login" + (ret && ret !== "/" ? "?r=" + encodeURIComponent(ret) : "");
  const html = `<!doctype html><html lang="uk"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow">
<title>FREITTY Dashboard</title>
<style>
:root{--bg:#FAFAF8;--surface:#fff;--fg:#1F1F1D;--muted:#5F5E5A;--line:rgba(0,0,0,.1);--accent:#D85A30;--accent-fg:#fff;
  --warn:#9A6700;--warn-soft:#FFF4D6;--ok:#0F6E56;--ok-soft:#E1F5EE;
  --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,"Helvetica Neue",Arial,sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#1A1A18;--surface:#242421;--fg:#F1EFE8;--muted:#B4B2A9;--line:rgba(255,255,255,.1);
  --warn:#E3B341;--warn-soft:rgba(154,103,0,.22);--ok:#5cc58f;--ok-soft:rgba(15,110,86,.22);color-scheme:dark}}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--bg);color:var(--fg);font-family:var(--font)}
body{display:grid;place-items:center;min-height:100vh;padding:24px 16px}
.card{width:100%;max-width:420px;background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:32px 28px 26px;box-shadow:0 18px 48px rgba(10,20,40,.08)}
.bar{width:36px;height:4px;border-radius:2px;background:var(--accent);margin:0 0 22px}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:22px}
.mk{width:42px;height:42px;border-radius:10px;background:var(--accent);color:var(--accent-fg);display:grid;place-items:center;font-weight:600;font-size:16px;letter-spacing:.02em}
.brand b{display:block;font-size:19px;font-weight:600}
.brand span{color:var(--muted);font-size:14px}
h1{font-size:22px;font-weight:600;margin:0 0 8px;text-wrap:balance}
p{color:var(--muted);line-height:1.55;margin:0 0 20px;font-size:15px}
.note{border-radius:8px;padding:10px 12px;margin:0 0 18px;font-size:14px;line-height:1.5;background:var(--warn-soft);color:var(--warn);overflow-wrap:anywhere}
.note.ok{background:var(--ok-soft);color:var(--ok)}
.note code{font-size:13px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px 16px;border-radius:9px;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-weight:600;font-size:15.5px}
.btn:hover{filter:brightness(1.06)}
.btn:focus-visible{outline:3px solid var(--fg);outline-offset:2px}
.ms{display:grid;grid-template-columns:8px 8px;gap:2px}
.ms i{width:8px;height:8px;display:block}
.foot{margin-top:18px;font-size:12.5px;color:var(--muted);line-height:1.5}
</style></head><body>
<main class="card">
  <div class="bar" aria-hidden="true"></div>
  <div class="brand"><div class="mk">FT</div><div><b>FREITTY Dashboard</b><span>Google Business Profile і дзвінки</span></div></div>
  <h1>${esc(title)}</h1>
  ${note ? `<div class="note ${tone === "ok" ? "ok" : ""}" role="status">${note}</div>` : ""}
  ${button ? `<p>Статистика Google Business Profile по локаціях і дзвінки з реклами та карт (CallRail).</p>
  <a class="btn" href="${esc(href)}"><span class="ms" aria-hidden="true"><i style="background:#f25022"></i><i style="background:#7fba00"></i><i style="background:#00a4ef"></i><i style="background:#ffb900"></i></span>Увійти через Microsoft</a>
  <div class="foot">Лише для працівників компанії, робочим акаунтом Microsoft 365. Якщо доступу немає, зверніться до власника дашборда.</div>` : ""}
</main></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", ...headers },
  });
}
