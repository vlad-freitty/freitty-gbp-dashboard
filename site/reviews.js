// «Відгуки»: Google reviews for every hub (GBP v4 API, refreshed daily with the rest).
(function () {
  "use strict";
  const G = window.GBP, C = window.Charts, esc = C.esc;
  const $ = id => document.getElementById(id);
  const R = { hub: "all", stars: "all", reply: "all", q: "", sort: { col: "ts", asc: false } };
  const DAY = 86400000;
  // diverging blue <-> red with a gray midpoint: 5★ … 1★
  const STAR_COLORS = { 5: "--seq-500", 4: "--seq-300", 3: "--neutral-series", 2: "--s2", 1: "--s8" };
  const stars = n => `<span class="stars" aria-label="${n} з 5">${"★".repeat(n)}<span class="off">${"★".repeat(5 - n)}</span></span>`;
  const fmtRating = v => (v == null ? "—" : v.toFixed(1).replace(".", ","));
  const trim = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };

  function all() { return G.D.reviews || []; }
  function inRange(list, a, b) { const t0 = G.dateAt(a).getTime(), t1 = G.dateAt(b).getTime() + DAY; return list.filter(r => r.ts >= t0 && r.ts < t1); }
  function avg(list) { const s = list.filter(r => r.stars); return s.length ? s.reduce((x, r) => x + r.stars, 0) / s.length : null; }

  function render() {
    const D = G.D, list = all();
    if (!list.length && !Object.keys(D.reviewSummary || {}).length) {
      ["rv-kpis", "rv-todo", "rv-hubs", "rv-dist", "rv-months", "rv-table"].forEach(id => { $(id).innerHTML = ""; });
      $("rv-todo").innerHTML = G.empty("Відгуки ще не завантажені. Вони з’являться після наступного щоденного оновлення.", "ph-chat-circle-dots");
      return;
    }
    const { a, b } = G.UI.period, len = b - a + 1;
    const cur = inRange(list, a, b), prev = inRange(list, a - len, a - 1);
    // Google's own average & total per hub (covers reviews without text too)
    const sum = D.reviewSummary || {};
    let wSum = 0, wN = 0, total = 0;
    for (const l of D.locs) { const s = sum[l.id]; if (s && s.total) { wSum += (s.avg || 0) * s.total; wN += s.total; total += s.total; } }
    const unreplied = list.filter(r => !r.reply);
    const negCur = cur.filter(r => r.stars && r.stars <= 3);
    const replied = list.filter(r => r.reply && r.replyTs);
    const replyDays = replied.map(r => (r.replyTs - r.ts) / DAY).filter(d => d >= 0).sort((x, y) => x - y);
    const median = replyDays.length ? replyDays[Math.floor(replyDays.length / 2)] : null;
    G.renderKpis($("rv-kpis"), [
      { label: "Середня оцінка", icon: "ph-star", value: wN ? fmtRating(wSum / wN) : "—", delta: `<span>за даними Google, усі хаби</span>` },
      { label: "Відгуків усього", icon: "ph-chat-circle-dots", value: G.fmtInt(total || list.length), delta: `<span>на ${D.locs.filter(l => (sum[l.id] || {}).total).length} профілях</span>` },
      { label: "Нових за період", icon: "ph-plus-circle", value: G.fmtInt(cur.length), delta: prev.length ? `<span class="${cur.length >= prev.length ? "up" : "down"}">${G.fmtDelta((cur.length - prev.length) / prev.length)}</span><span>до попереднього періоду</span>` : `<span>середня ${fmtRating(avg(cur))}</span>` },
      { label: "Без відповіді", icon: "ph-chat-centered-dots", value: G.fmtInt(unreplied.length), delta: unreplied.length ? `<span class="down">${unreplied.filter(r => r.stars && r.stars <= 3).length} з них на 3★ і нижче</span>` : `<span class="up">на всі відповіли</span>` },
      { label: "Негативні за період", icon: "ph-thumbs-down", value: G.fmtInt(negCur.length), delta: `<span>3★ і нижче</span>` },
      { label: "Відповідаємо за", icon: "ph-timer", value: median == null ? "—" : median < 1 ? "<1 дн." : `${Math.round(median)} дн.`, delta: `<span>медіана, від відгуку до відповіді</span>` },
    ]);

    // needs a reply: negatives first, then newest
    const todo = unreplied.slice().sort((x, y) => ((x.stars || 5) <= 3 ? 0 : 1) - ((y.stars || 5) <= 3 ? 0 : 1) || y.ts - x.ts).slice(0, 30);
    $("rv-todo-note").textContent = unreplied.length ? `${G.fmtInt(unreplied.length)} відгуків без відповіді власника. Спершу негативні, далі найновіші. Відповідати в профілі Google Business.` : "";
    $("rv-todo").innerHTML = todo.length ? `<table class="t"><thead><tr><th>Дата</th><th>Хаб</th><th>Оцінка</th><th>Відгук</th><th>Автор</th></tr></thead><tbody>` +
      todo.map(r => `<tr><td class="nowrap">${G.fmtDate(new Date(r.ts))}<div class="sub">${daysAgo(r.ts)}</div></td><td class="nowrap"><a href="${G.hubLink(r.hub)}">${esc(r.hub)}</a></td><td class="nowrap">${stars(r.stars || 0)}</td>
        <td class="wrap">${r.comment ? esc(trim(r.comment, 220)) : `<span class="muted">без тексту</span>`}</td><td class="nowrap">${esc(r.reviewer || "Анонім")}</td></tr>`).join("") + "</tbody></table>"
      : G.empty("На всі відгуки є відповідь.", "ph-check-circle");

    // rating by hub (Google's figure), worst first
    const hubRows = D.locs.map(l => ({ l, s: sum[l.id] || {}, cur: cur.filter(r => r.locId === l.id) })).filter(h => h.s.total);
    hubRows.sort((x, y) => (x.s.avg || 0) - (y.s.avg || 0));
    if (hubRows.length) C.hbars($("rv-hubs"), {
      rows: hubRows.map(h => ({ label: h.l.name, key: h.l.name, value: h.s.avg || 0, valueText: `${fmtRating(h.s.avg)} · ${G.fmtInt(h.s.total)}`,
        color: (h.s.avg || 0) < 4 ? "--s8" : (h.s.avg || 0) < 4.5 ? "--s2" : "--s1",
        tip: C.tipRows(h.l.name, [{ label: "Середня оцінка", value: fmtRating(h.s.avg) }, { label: "Відгуків усього", value: G.fmtInt(h.s.total) }, { label: "Нових за період", value: G.fmtInt(h.cur.length) }, { label: "Без відповіді", value: G.fmtInt(list.filter(r => r.locId === h.l.id && !r.reply).length) }]) })),
      max: 5, onClick: r => { R.hub = G.D.byName[r.key].id; $("rv-hub").value = R.hub; renderTable(); $("rv-table").scrollIntoView({ behavior: "smooth", block: "start" }); },
    });
    else $("rv-hubs").innerHTML = G.empty("Ще немає оцінок.");

    // distribution in period
    const dist = [5, 4, 3, 2, 1].map(s => ({ name: `${s}★`, value: cur.filter(r => r.stars === s).length, color: STAR_COLORS[s] }));
    if (cur.length) C.segmented($("rv-dist"), dist, { valueLabel: "Відгуків" });
    else $("rv-dist").innerHTML = G.empty("За обраний період нових відгуків немає.", "ph-chat-circle");

    // by month (period months), stacked by stars
    const ms = G.months(a, b);
    const series = [5, 4, 3, 2, 1].map(s => ({ name: `${s}★`, color: STAR_COLORS[s], values: ms.map(m => inRange(list, m.a, m.b).filter(r => r.stars === s).length) }));
    $("rv-months-legend").innerHTML = series.map(s => `<span><span class="swatch" style="background:${C.color(s.color)}"></span>${s.name}</span>`).join("");
    C.columns($("rv-months"), { categories: ms.map(m => m.label), series, height: 240, fmt: G.fmtInt, tipTitle: i => `${G.MON_FULL[ms[i].m]} ${ms[i].y}`, ariaLabel: "Нові відгуки за місяцями, за оцінкою" });

    // filters
    const hs = $("rv-hub");
    if (!hs.options.length) {
      hs.innerHTML = `<option value="all">Усі хаби</option>` + D.locs.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
      $("rv-stars").innerHTML = `<option value="all">Будь-яка оцінка</option><option value="neg">3★ і нижче</option>` + [5, 4, 3, 2, 1].map(s => `<option value="${s}">${s}★</option>`).join("");
      $("rv-reply").innerHTML = `<option value="all">З відповіддю і без</option><option value="no">Без відповіді</option><option value="yes">З відповіддю</option>`;
      hs.addEventListener("change", () => { R.hub = hs.value; renderTable(); });
      $("rv-stars").addEventListener("change", e => { R.stars = e.target.value; renderTable(); });
      $("rv-reply").addEventListener("change", e => { R.reply = e.target.value; renderTable(); });
      let t; $("rv-q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(() => { R.q = e.target.value; renderTable(); }, 200); });
    }
    if (G.UI.reviewsHub) { const l = D.byName[G.UI.reviewsHub]; if (l) { R.hub = l.id; hs.value = l.id; } G.UI.reviewsHub = null; }
    renderTable();
  }

  function daysAgo(t) { const d = Math.floor((Date.now() - t) / DAY); return d <= 0 ? "сьогодні" : d === 1 ? "учора" : `${d} дн. тому`; }

  function renderTable() {
    let rows = all().slice();
    if (R.hub !== "all") rows = rows.filter(r => r.locId === R.hub);
    if (R.stars === "neg") rows = rows.filter(r => r.stars && r.stars <= 3); else if (R.stars !== "all") rows = rows.filter(r => r.stars === +R.stars);
    if (R.reply === "no") rows = rows.filter(r => !r.reply); else if (R.reply === "yes") rows = rows.filter(r => r.reply);
    const q = R.q.trim().toLowerCase(); if (q) rows = rows.filter(r => [r.comment, r.reviewer, r.reply].some(v => (v || "").toLowerCase().includes(q)));
    const st = R.sort, list = G.sortRows(rows, st).slice(0, 400), tbl = $("rv-table");
    tbl.innerHTML = `<thead><tr>${G.th("Дата", "ts", st)}${G.th("Хаб", "hub", st, { type: "text" })}${G.th("Оцінка", "stars", st)}<th>Відгук</th><th>Відповідь власника</th></tr></thead><tbody>` +
      (list.length ? list.map(r => `<tr><td class="nowrap">${G.fmtDate(new Date(r.ts))}<div class="sub">${esc(r.reviewer || "Анонім")}</div></td><td class="nowrap"><a href="${G.hubLink(r.hub)}">${esc(r.hub)}</a></td><td class="nowrap">${stars(r.stars || 0)}</td>
        <td class="wrap">${r.comment ? esc(trim(r.comment, 400)) : `<span class="muted">без тексту</span>`}</td>
        <td class="wrap">${r.reply ? `${esc(trim(r.reply, 240))}<div class="sub">${r.replyTs ? G.fmtDate(new Date(r.replyTs)) : ""}</div>` : `<span class="badge ${r.stars && r.stars <= 3 ? "bad" : "warn"}">Без відповіді</span>`}</td></tr>`).join("")
        + (rows.length > list.length ? `<tr><td colspan="5" class="muted caption-5">Показано ${list.length} з ${G.fmtInt(rows.length)}. Звузьте фільтр.</td></tr>` : "")
        : `<tr><td colspan="5">${G.empty("Жоден відгук не відповідає фільтрам.", "ph-magnifying-glass")}</td></tr>`) + "</tbody>";
    G.sortable(tbl, st, renderTable);
  }

  window.Reviews = { render, stars, fmtRating };
})();
