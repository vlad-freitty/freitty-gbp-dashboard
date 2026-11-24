// Tiny HTML responses for sign-in errors and sign-out. Kept plain on purpose.

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function page(status, title, bodyHtml, extraHeaders = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>
:root{--bg:#FAFAF8;--fg:#1F1F1D;--muted:#5F5E5A;--accent:#D85A30;--card:#fff;--border:rgba(0,0,0,.1)}
@media (prefers-color-scheme:dark){:root{--bg:#1A1A18;--fg:#F1EFE8;--muted:#B4B2A9;--card:#242421;--border:rgba(255,255,255,.1)}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--fg);
font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Arial,sans-serif;padding:16px}
.card{max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:12px;padding:24px}
h1{font-size:18px;font-weight:500;margin:0 0 8px}p{color:var(--muted);margin:0 0 16px}
a.btn{display:inline-block;background:var(--accent);color:#fff;text-decoration:none;padding:8px 14px;border-radius:8px}
code{font-size:12px}
</style></head><body><div class="card"><h1>${esc(title)}</h1>${bodyHtml}</div></body></html>`;
  return new Response(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...extraHeaders },
  });
}

export { esc };
