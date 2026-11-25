// «Матриці»: heat tables period × hub for every metric (the original Performance tab, redesigned),
// plus a period × day-of-week matrix. Uses the global period filter.
(function () {
  "use strict";
  const G = window.GBP, C = window.Charts, esc = C.esc;
  const $ = id => document.getElementById(id);
  const M = { gran: "week", rows: "period", cell: "abs", locs: null, dowMetric: "views", dowCell: "row" };

  const TABLES = [
    { id: "views", label: "Перегляди профілю, разом", keys: ["dmaps", "dsearch", "mmaps", "msearch"] },
    { id: "calls", label: "Дзвінки", keys: ["calls"] },
    { id: "dir", label: "Запити маршруту", keys: ["dir"] },
    { id: "web", label: "Переходи на сайт", keys: ["web"] },
    { id: "mmaps", label: "Перегляди: Карти, мобільні", keys: ["mmaps"] },
    { id: "msearch", label: "Перегляди: Пошук, мобільні", keys: ["msearch"] },
    { id: "dmaps", label: "Перегляди: Карти, комп’ютер", keys: ["dmaps"] },
    { id: "dsearch", label: "Перегляди: Пошук, комп’ютер", keys: ["dsearch"] },
  ];
  const DOW_METRICS = [
    { id: "views", label: "Перегляди профілю", keys: ["dmaps", "dsearch", "mmaps", "msearch"] },
    { id: "inter", label: "Взаємодії", keys: ["calls", "dir", "web"] },
    { id: "calls", label: "Дзвінки", keys: ["calls"] },
    { id: "dir", label: "Маршрути", keys: ["dir"] },
    { id: "web", label: "Переходи на сайт", keys: ["web"] },
  ];
  const DOW = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
  const SEQ = ["--seq-100", "--seq-200", "--seq-300", "--seq-400", "--seq-500", "--seq-600", "--seq-700"];

  const day = (locId, k, i) => { const P = G.D.P[locId][k]; return P[i + 1] - P[i]; };

  function periodOf(i) {
    const d = G.dateAt(i), y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (M.gran === "day") return { key: i, label: `${d.getUTCDate()} ${G.MON[m]}`, title: G.fmtDate(d) };
    if (M.gran === "month") return { key: y * 12 + m, label: `${G.MON[m]} ${String(y).slice(2)}`, title: `${G.MON_FULL[m]} ${y}` };
    const mon = i - ((d.getUTCDay() + 6) % 7);                       // Monday of the week
    const md = G.dateAt(mon);
    return { key: mon, label: `${md.getUTCDate()} ${G.MON[md.getUTCMonth()]}`, title: `тиждень з ${G.fmtDate(md)}` };
  }

  function cellStyle(intensity) {
    if (!(intensity > 0)) return "";
    const k = Math.min(SEQ.length - 1, Math.max(0, Math.ceil(intensity * SEQ.length) - 1));
    return `background:${C.color(SEQ[k])};color:${k >= 3 ? "#fff" : "var(--text)"}`;
  }

  function build(keys, locs, a, b) {
    const periods = new Map(), cols = locs.map(l => l.name);
    for (let i = a; i <= b; i++) {
      const p = periodOf(i);
      let row = periods.get(p.key);
      if (!row) { row = { ...p, v: {}, partial: false }; periods.set(p.key, row); }
      for (const l of locs) { let s = 0; for (const k of keys) s += day(l.id, k, i); row.v[l.name] = (row.v[l.name] || 0) + s; }
    }
    const rows = Array.from(periods.values()).sort((x, y) => y.key - x.key);   // newest first
    // mark periods cut by the period edges (incomplete weeks / months)
    if (M.gran !== "day" && rows.length) {
      const first = periodOf(a), last = periodOf(b);
      const fullLen = M.gran === "week" ? 7 : null;
      rows.forEach(r => {
        if (M.gran === "week") { r.partial = (r.key === first.key && a - r.key > 0) || (r.key === last.key && b - r.key + 1 < fullLen); }
        else { const s = G.dateAt(a), e = G.dateAt(b); r.partial = (r.key === first.key && s.getUTCDate() > 1) || (r.key === last.key && new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() + 1, 0)).getUTCDate() !== e.getUTCDate()); }
      });
    }
    const colTot = Object.fromEntries(cols.map(c => [c, rows.reduce((s, r) => s + (r.v[c] || 0), 0)]));
    rows.forEach(r => { r.tot = cols.reduce((s, c) => s + (r.v[c] || 0), 0); });
    const order = cols.slice().sort((x, y) => colTot[y] - colTot[x]);
    return { rows, cols: order, colTot, grand: rows.reduce((s, r) => s + r.tot, 0) };
  }

  function renderTable(el, mx) {
    // orientation: rows = periods (default) or hubs
    const byPeriod = M.rows === "period";
    const R = byPeriod ? mx.rows : mx.cols, K = byPeriod ? mx.cols : mx.rows;
    const val = (r, k) => (byPeriod ? r.v[k] : k.v[r]) || 0;
    const rTot = r => (byPeriod ? r.tot : mx.colTot[r]), kTot = k => (byPeriod ? mx.colTot[k] : k.tot);
    const rLab = r => (byPeriod ? `<span title="${esc(r.title)}">${esc(r.label)}${r.partial ? "*" : ""}</span>` : `<a href="${G.hubLink(r)}">${esc(r)}</a>`);
    const kLab = k => (byPeriod ? `<a href="${G.hubLink(k)}">${esc(k)}</a>` : `<span title="${esc(k.title)}">${esc(k.label)}${k.partial ? "*" : ""}</span>`);
    let max = 0; for (const r of R) for (const k of K) max = Math.max(max, val(r, k));
    const fmtCell = (v, r, k) => {
      if (M.cell === "abs") return v ? G.fmtInt(v) : "";
      const t = M.cell === "row" ? rTot(r) : kTot(k);
      return t ? G.fmtPct(v / t, 0) : "";
    };
    const inten = (v, r, k) => (M.cell === "abs" ? (max ? v / max : 0) : (() => { const t = M.cell === "row" ? rTot(r) : kTot(k); return t ? v / t : 0; })());
    el.innerHTML = `<thead><tr><th>${byPeriod ? "Період" : "Хаб"}</th>${K.map(k => `<th>${kLab(k)}</th>`).join("")}<th>Разом</th></tr></thead><tbody>` +
      R.map(r => `<tr><th>${rLab(r)}</th>${K.map(k => { const v = val(r, k); return `<td class="cell" style="${cellStyle(inten(v, r, k))}" title="${esc(byPeriod ? `${k}, ${r.title}` : `${r}, ${k.title}`)}: ${G.fmtInt(v)}">${fmtCell(v, r, k)}</td>`; }).join("")}<td class="cell tot">${G.fmtInt(rTot(r))}</td></tr>`).join("") +
      `<tr class="tot-row"><th>Разом</th>${K.map(k => `<td class="cell tot">${G.fmtInt(kTot(k))}</td>`).join("")}<td class="cell tot">${G.fmtInt(mx.grand)}</td></tr></tbody>`;
  }

  function renderDow(locs, a, b) {
    const met = DOW_METRICS.find(m => m.id === M.dowMetric) || DOW_METRICS[0];
    const periods = new Map();
    for (let i = a; i <= b; i++) {
      const p = periodOf(i), dw = (G.dateAt(i).getUTCDay() + 6) % 7;
      let row = periods.get(p.key); if (!row) { row = { ...p, v: Array(7).fill(0) }; periods.set(p.key, row); }
      for (const l of locs) for (const k of met.keys) row.v[dw] += day(l.id, k, i);
    }
    const rows = Array.from(periods.values()).sort((x, y) => y.key - x.key);
    const colTot = Array(7).fill(0); rows.forEach(r => r.v.forEach((v, d) => { colTot[d] += v; }));
    let max = 0; rows.forEach(r => r.v.forEach(v => { max = Math.max(max, v); }));
    $("mx-dow").innerHTML = `<thead><tr><th>Період</th>${DOW.map(d => `<th>${d}</th>`).join("")}<th>Разом</th></tr></thead><tbody>` +
      rows.map(r => { const t = r.v.reduce((s, v) => s + v, 0); return `<tr><th title="${esc(r.title)}">${esc(r.label)}</th>${r.v.map((v, d) => {
        const it = M.dowCell === "abs" ? (max ? v / max : 0) : (t ? (v / t) * 3.5 : 0);     // ×3.5: an even week (1/7 each) sits mid-ramp
        return `<td class="cell" style="${cellStyle(Math.min(1, it))}" title="${DOW[d]}, ${esc(r.title)}: ${G.fmtInt(v)}">${M.dowCell === "abs" ? (v ? G.fmtInt(v) : "") : t ? G.fmtPct(v / t, 0) : ""}</td>`; }).join("")}<td class="cell tot">${G.fmtInt(t)}</td></tr>`; }).join("") +
      `<tr class="tot-row"><th>Разом</th>${colTot.map(v => `<td class="cell tot">${G.fmtInt(v)}</td>`).join("")}<td class="cell tot">${G.fmtInt(colTot.reduce((s, v) => s + v, 0))}</td></tr></tbody>`;
  }

  function wire() {
    const seg = (id, key) => document.querySelectorAll(`#${id} button`).forEach(btn => btn.addEventListener("click", () => { M[key] = btn.dataset.v; G.store.set("gbp-mx-" + key, M[key]); render(); }));
    seg("mx-gran", "gran"); seg("mx-rows", "rows"); seg("mx-cell", "cell");
    $("mx-dow-metric").innerHTML = DOW_METRICS.map(m => `<option value="${m.id}">${esc(m.label)}</option>`).join("");
    $("mx-dow-metric").addEventListener("change", e => { M.dowMetric = e.target.value; render(); });
    $("mx-dow-cell").addEventListener("change", e => { M.dowCell = e.target.value; render(); });
    for (const k of ["gran", "rows", "cell"]) { const v = G.store.get("gbp-mx-" + k); if (v) M[k] = v; }
    M.wired = true;
  }

  function renderChips() {
    const all = G.D.locs.map(l => l.name);
    $("mx-locs").innerHTML = all.map(n => `<button type="button" class="chip" aria-pressed="${M.locs.has(n)}" data-n="${esc(n)}">${esc(n)}</button>`).join("") +
      `<button type="button" class="chip" data-all="1">Усі</button><button type="button" class="chip" data-none="1">Жодного</button>`;
    $("mx-locs").querySelectorAll(".chip").forEach(ch => ch.addEventListener("click", () => {
      if (ch.dataset.all) M.locs = new Set(all); else if (ch.dataset.none) M.locs = new Set();
      else { const n = ch.dataset.n; if (M.locs.has(n)) M.locs.delete(n); else M.locs.add(n); }
      render();
    }));
  }

  function render() {
    if (!M.wired) wire();
    if (!M.locs) M.locs = new Set(G.D.locs.map(l => l.name));
    ["gran", "rows", "cell"].forEach(k => document.querySelectorAll(`#mx-${k} button`).forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === M[k]))));
    $("mx-dow-metric").value = M.dowMetric; $("mx-dow-cell").value = M.dowCell;
    renderChips();
    const { a, b } = G.UI.period;
    const locs = G.D.locs.filter(l => M.locs.has(l.name));
    const grid = $("mx-grid");
    if (!locs.length) { grid.innerHTML = `<div class="card">${G.empty("Оберіть хоча б один хаб.", "ph-map-pin")}</div>`; $("mx-dow").innerHTML = ""; return; }
    const granLabel = { day: "днів", week: "тижнів", month: "місяців" }[M.gran];
    grid.innerHTML = TABLES.map(t => `<div class="card"><div class="card-head"><div><h2 class="title-3">${esc(t.label)}</h2><p class="note caption-5" id="mx-meta-${t.id}"></p></div></div>
      <div class="table-wrap mx-wrap"><table class="heat mx" id="mx-${t.id}"></table></div></div>`).join("");
    for (const t of TABLES) {
      const mx = build(t.keys, locs, a, b);
      renderTable($("mx-" + t.id), mx);
      $("mx-meta-" + t.id).textContent = `${mx.rows.length} ${granLabel} × ${locs.length} хабів · разом ${G.fmtInt(mx.grand)}`;
    }
    $("mx-note").textContent = M.gran === "day" ? "" : "* неповний період: тиждень або місяць обрізаний межами обраного періоду.";
    renderDow(locs, a, b);
  }

  window.Matrix = { render };
})();
