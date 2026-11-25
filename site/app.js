// FREITTY · GBP dashboard — data model, period filter, router, pages.
(function () {
  "use strict";
  const C = window.Charts, esc = C.esc;
  const $ = id => document.getElementById(id);

  // ---------- formatting ----------
  const nf0 = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 0 });
  const fmtInt = n => (n == null || !Number.isFinite(n) ? "—" : nf0.format(Math.round(n)));
  const fmtPct = (x, d = 1) => (x == null || !Number.isFinite(x) ? "—" : (x * 100).toFixed(d).replace(".", ",") + "%");
  const fmtDelta = x => (x == null || !Number.isFinite(x) ? "—" : Math.abs(x) < 0.005 ? "0%" : (x > 0 ? "+" : "−") + Math.abs(x * 100).toFixed(0) + "%");
  const MON = ["січ", "лют", "бер", "кві", "тра", "чер", "лип", "сер", "вер", "жов", "лис", "гру"];
  const MON_FULL = ["січень", "лютий", "березень", "квітень", "травень", "червень", "липень", "серпень", "вересень", "жовтень", "листопад", "грудень"];
  const DAY = 86400000;
  const iso = d => d.toISOString().slice(0, 10);
  const fmtDate = d => `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const fmtDay = d => `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  const monthLabel = (y, m) => `${MON[m]} ${String(y).slice(2)}`;

  // ---------- metrics ----------
  const MT = {
    dmaps: "BUSINESS_IMPRESSIONS_DESKTOP_MAPS", dsearch: "BUSINESS_IMPRESSIONS_DESKTOP_SEARCH",
    mmaps: "BUSINESS_IMPRESSIONS_MOBILE_MAPS", msearch: "BUSINESS_IMPRESSIONS_MOBILE_SEARCH",
    calls: "CALL_CLICKS", dir: "BUSINESS_DIRECTION_REQUESTS", web: "WEBSITE_CLICKS",
  };
  const VIEWS = ["dmaps", "dsearch", "mmaps", "msearch"], MAPS = ["dmaps", "mmaps"], ACTIONS = ["calls", "dir", "web"];
  const METRIC_SETS = { views: VIEWS, calls: ["calls"], dir: ["dir"], web: ["web"], inter: ACTIONS };
  const METRIC_LABEL = { views: "Перегляди профілю", calls: "Дзвінки", dir: "Маршрути", web: "Переходи на сайт", inter: "Взаємодії" };
  const ACTION_SERIES = [
    { key: "calls", name: "Дзвінки", color: "--s1" },
    { key: "dir", name: "Маршрути", color: "--s2" },
    { key: "web", name: "Переходи на сайт", color: "--s3" },
  ];

  // ---------- state ----------
  const D = { ready: false };
  const UI = { page: "overview", hub: null, period: { preset: "180", a: 0, b: 0 }, ovSort: { col: "calls", asc: false }, ovQ: "" };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } },
  };

  // ---------- data ----------
  async function load() {
    const [res, lab] = await Promise.all([fetch("data.json", { cache: "no-store" }), fetch("intent_labels.json").catch(() => null)]);
    if (!res.ok) throw new Error(`data.json: HTTP ${res.status}`);
    const j = await res.json();
    const labels = lab && lab.ok ? await lab.json() : {};
    D.meta = { generated_at: j.generated_at, last_pull: j.last_pull };
    D.start = new Date(j.start + "T00:00:00Z");
    D.end = new Date(j.end + "T00:00:00Z");
    D.n = Math.round((D.end - D.start) / DAY) + 1;
    // Google returns 0 (not null) for days it hasn't reported yet: the data really ends on the
    // last day with any profile views across the network. Trailing zero days are dropped.
    {
      let last = D.n - 1;
      const viewsOn = i => j.locations.reduce((s, l) => s + [MT.mmaps, MT.msearch, MT.dmaps, MT.dsearch].reduce((t, m) => t + (((j.daily[l.id] || {})[m] || [])[i] || 0), 0), 0);
      while (last > 0 && viewsOn(last) === 0) last--;
      D.reportedTo = D.end; D.n = last + 1; D.end = new Date(D.start.getTime() + last * DAY);
    }
    D.locs = j.locations.map(l => ({ id: l.id, name: l.name, address: l.address || "" }));
    D.byName = Object.fromEntries(D.locs.map(l => [l.name, l]));
    // prefix sums per location per metric key; cov = days with any data
    D.P = {}; D.first = {};
    for (const l of D.locs) {
      const per = j.daily[l.id] || {};
      const P = {};
      let firstIdx = D.n;
      for (const [k, name] of Object.entries(MT)) {
        const arr = per[name] || [];
        const p = new Float64Array(D.n + 1);
        for (let i = 0; i < D.n; i++) {
          const v = arr[i];
          p[i + 1] = p[i] + (v || 0);
          if (v != null && v > 0 && i < firstIdx) firstIdx = i;
        }
        P[k] = p;
      }
      const any = per[MT.mmaps] || [];
      const cov = new Float64Array(D.n + 1);
      for (let i = 0; i < D.n; i++) cov[i + 1] = cov[i] + (any[i] != null ? 1 : 0);
      P.cov = cov;
      D.P[l.id] = P; D.first[l.id] = firstIdx;
    }
    // keywords: [y, m, locIdx, kw, v, thr]
    D.kw = j.keywords.rows.map(([y, m, li, kw, v, thr]) => ({ y, m, ym: y * 12 + m - 1, loc: j.locations[li].id, kw, v, thr: !!thr }));
    D.intent = window.Intent.make(D.locs, labels);
    for (const r of D.kw) { r.cat = D.intent.classify(r.kw); r.grp = window.Intent.groupOf(r.cat); }
    // posts
    const pc = (j.posts && j.posts.cols) || [];
    D.posts = ((j.posts && j.posts.rows) || []).map(r => {
      const p = Object.fromEntries(pc.map((c, i) => [c, r[i]]));
      p.locId = j.locations[p.loc].id; p.hub = j.locations[p.loc].name;
      p.t = p.create_time ? new Date(p.create_time) : null;
      return p;
    });
    // reviews
    const rv = j.reviews || {}, rc = rv.cols || [];
    D.reviews = (rv.rows || []).map(r => {
      const x = Object.fromEntries(rc.map((c, i) => [c, r[i]]));
      x.locId = j.locations[x.loc].id; x.hub = j.locations[x.loc].name;
      x.ts = x.create_time ? Date.parse(x.create_time) : 0;
      x.replyTs = x.reply_time ? Date.parse(x.reply_time) : 0;
      return x;
    });
    D.reviewSummary = {};
    for (const [li, [avg, total]] of Object.entries(rv.summary || {})) D.reviewSummary[j.locations[+li].id] = { avg, total };
    D.ready = true;
  }

  // sum of metric keys over day indices [a, b] inclusive
  function sum(locId, keys, a, b) {
    const P = D.P[locId]; if (!P || b < a) return 0;
    a = Math.max(0, a); b = Math.min(D.n - 1, b);
    let s = 0; for (const k of keys) s += P[k][b + 1] - P[k][a];
    return s;
  }
  const sumAll = (keys, a, b, locs = D.locs) => locs.reduce((s, l) => s + sum(l.id, keys, a, b), 0);
  const covDays = (locId, a, b) => { const P = D.P[locId]; a = Math.max(0, a); b = Math.min(D.n - 1, b); return b < a ? 0 : P.cov[b + 1] - P.cov[a]; };
  const dateAt = i => new Date(D.start.getTime() + i * DAY);
  const idxOf = d => Math.round((d - D.start) / DAY);

  function hubStats(locId, a, b) {
    const v = k => sum(locId, [k], a, b);
    const views = sum(locId, VIEWS, a, b), maps = sum(locId, MAPS, a, b);
    const calls = v("calls"), dir = v("dir"), web = v("web"), inter = calls + dir + web;
    return { views, maps, calls, dir, web, inter, rate: views ? inter / views : null, mapsShare: views ? maps / views : null,
      mobile: views ? (v("mmaps") + v("msearch")) / views : null };
  }

  // months overlapping [a,b]; partial = month extends past data end
  function months(a, b) {
    const out = [];
    const s = dateAt(a), e = dateAt(b);
    let y = s.getUTCFullYear(), m = s.getUTCMonth();
    while (y < e.getUTCFullYear() || (y === e.getUTCFullYear() && m <= e.getUTCMonth())) {
      const ms = Date.UTC(y, m, 1), me = Date.UTC(y, m + 1, 0);
      const ia = Math.max(a, idxOf(new Date(ms))), ib = Math.min(b, idxOf(new Date(me)));
      const dim = new Date(me).getUTCDate();
      const fullMonthEnd = idxOf(new Date(me));
      out.push({ y, m, ym: y * 12 + m, a: ia, b: ib, days: ib - ia + 1, dim, partial: fullMonthEnd > D.n - 1, label: monthLabel(y, m) });
      m++; if (m > 11) { m = 0; y++; }
    }
    return out;
  }
  function monthlySeries(locs, a, b) {
    let ms = months(a, b);
    // a month cut by the period start would show as a misleading stub: chart full months only
    while (ms.length > 1 && ms[0].days < ms[0].dim && !ms[0].partial) ms = ms.slice(1);
    const series = ACTION_SERIES.map(s => ({ ...s, values: ms.map(mo => sumAll([s.key], mo.a, mo.b, locs)) }));
    const last = ms[ms.length - 1];
    let partial = null;
    if (last && last.partial && last.days > 0) {
      const tot = series.reduce((acc, s) => acc + s.values[ms.length - 1], 0);
      partial = { index: ms.length - 1, total: (tot / last.days) * last.dim, label: `Темп на повний місяць (${last.days} з ${last.dim} днів)` };
    }
    return { ms, series, partial };
  }

  // ---------- period ----------
  function setPreset(p) {
    const b = D.n - 1;
    const len = p === "all" ? D.n : +p;
    UI.period = { preset: p, a: Math.max(0, b - len + 1), b };
    store.set("gbp-period", p);
    syncPeriodUI();
  }
  function syncPeriodUI() {
    document.querySelectorAll("#period-presets button").forEach(btn => btn.setAttribute("aria-pressed", String(btn.dataset.p === UI.period.preset)));
    const f = $("period-from"), t = $("period-to");
    f.min = t.min = iso(D.start); f.max = t.max = iso(D.end);
    f.value = iso(dateAt(UI.period.a)); t.value = iso(dateAt(UI.period.b));
    const len = UI.period.b - UI.period.a + 1;
    $("period-note").textContent = `${fmtDate(dateAt(UI.period.a))} – ${fmtDate(dateAt(UI.period.b))} · ${len} дн. · порівняння з попередніми ${len} дн.`;
  }
  const prevRange = () => { const len = UI.period.b - UI.period.a + 1; return [UI.period.a - len, UI.period.a - 1]; };
  // hubs with data through the whole previous period: the fair base for "vs previous period"
  function comparableLocs() {
    const [pa, pb] = prevRange(), len = pb - pa + 1;
    if (pa < 0) return [];
    return D.locs.filter(l => D.first[l.id] <= pa + 3 && covDays(l.id, pa, pb) >= 0.9 * len);
  }

  // ---------- small UI helpers ----------
  function deltaHtml(cur, prev, { goodUp = true } = {}) {
    if (!(prev > 0)) return `<span class="flat">немає бази для порівняння</span>`;
    const d = (cur - prev) / prev;
    const cls = Math.abs(d) < 0.005 ? "flat" : (d > 0) === goodUp ? "up" : "down";
    const icon = cls === "flat" ? "ph-minus" : d > 0 ? "ph-arrow-up-right" : "ph-arrow-down-right";
    return `<span class="${cls}"><i class="ph ${icon}" aria-hidden="true"></i> ${fmtDelta(d)}</span><span>до попереднього періоду</span>`;
  }
  function kpiTile({ label, value, delta, spark, icon }) {
    const id = "sp" + Math.random().toString(36).slice(2, 8);
    return { html: `<div class="kpi"><div class="kpi-label">${icon ? `<i class="ph ${icon}" aria-hidden="true"></i>` : ""}${esc(label)}</div>
      <div class="kpi-value">${value}</div><div class="kpi-delta">${delta || ""}</div>${spark ? `<div class="kpi-spark" id="${id}"></div>` : ""}</div>`, id, spark };
  }
  function renderKpis(container, tiles) {
    const built = tiles.map(kpiTile);
    container.innerHTML = built.map(b => b.html).join("");
    built.forEach(b => { if (b.spark) C.spark($(b.id), b.spark); });
  }
  function weeklyValues(locs, keys, a, b) {
    const out = [];
    for (let e = b; e - 6 >= a; e -= 7) out.unshift(sumAll(keys, e - 6, e, locs));
    return out;
  }
  function legend(container, series) {
    container.innerHTML = series.map(s => `<span><span class="swatch" style="background:${C.color(s.color)}"></span>${esc(s.name)}</span>`).join("");
  }
  function empty(msg, icon = "ph-tray") { return `<div class="empty"><i class="ph ${icon}" aria-hidden="true"></i><span class="body-6">${esc(msg)}</span></div>`; }
  const hubLink = name => `#hub/${encodeURIComponent(name)}`;
  function sortable(table, state, rerender) {
    table.querySelectorAll("th.sortable").forEach(th => th.addEventListener("click", () => {
      const col = th.dataset.col;
      if (state.col === col) state.asc = !state.asc; else { state.col = col; state.asc = th.dataset.type === "text"; }
      rerender();
    }));
  }
  function th(label, col, state, { num = false, type = "num", title = "" } = {}) {
    const arr = state.col === col ? (state.asc ? "↑" : "↓") : "";
    return `<th class="sortable${num ? " num" : ""}" data-col="${col}" data-type="${type}" title="${esc(title)}" aria-sort="${state.col === col ? (state.asc ? "ascending" : "descending") : "none"}">${esc(label)} <span class="arr">${arr}</span></th>`;
  }
  function sortRows(rows, state) {
    const dir = state.asc ? 1 : -1;
    return rows.sort((x, y) => {
      const a = x[state.col], b = y[state.col];
      if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1;
      return (typeof a === "string" ? a.localeCompare(b, "uk") : a - b) * dir;
    });
  }

  // ---------- keyword helpers ----------
  function kwPeriod(a, b, locId) {
    const yms = new Set(months(a, b).map(m => m.ym));
    let rows = D.kw.filter(r => yms.has(r.ym) && (!locId || r.loc === locId));
    let note = "";
    if (!rows.length) {
      // period inside a month Google hasn't reported keywords for yet: fall back to the latest month
      const latest = Math.max(...D.kw.filter(r => !locId || r.loc === locId).map(r => r.ym));
      if (Number.isFinite(latest)) {
        rows = D.kw.filter(r => r.ym === latest && (!locId || r.loc === locId));
        note = `Google ще не дав запити за обраний період; показано ${MON_FULL[latest % 12]} ${Math.floor(latest / 12)}.`;
      }
    }
    return { rows, note };
  }
  function intentMix(rows) {
    const g = { buyer: 0, brand: 0, geo: 0, generic: 0, noise: 0 };
    let counted = 0;
    for (const r of rows) if (!r.thr) { g[r.grp] += r.v; counted += r.v; }
    return { g, counted, buyerShare: counted ? g.buyer / counted : null };
  }

  // =====================================================================
  // SIGNALS (last 7 days vs prior 4-week weekly average)
  // =====================================================================
  const SIG = { dropPct: 30, upPct: 50, minBase: { views: 100, calls: 8, web: 8, dir: 8 } };
  function computeSignals() {
    const e = D.n - 1, cA = e - 6, bA = e - 34, bB = e - 7;
    const out = [];
    for (const l of D.locs) {
      const groups = [["views", VIEWS, "Перегляди"], ["calls", ["calls"], "Дзвінки"], ["web", ["web"], "Переходи на сайт"], ["dir", ["dir"], "Маршрути"]];
      const cd = covDays(l.id, cA, e), bd = covDays(l.id, bA, bB);
      if (!cd || !bd) continue;
      const vCur = (sum(l.id, VIEWS, cA, e) / cd) * 7, vBase = (sum(l.id, VIEWS, bA, bB) / bd) * 7;
      if (vBase > 0 && vCur === 0) {
        out.push({ sev: "crit", hub: l.name, t: "Нуль переглядів за тиждень", b: `Було близько ${fmtInt(vBase)} на тиждень. Перевірте профіль у GBP: його могли призупинити або зняти з верифікації.` });
        continue;
      }
      for (const [k, keys, label] of groups) {
        const cur = (sum(l.id, keys, cA, e) / cd) * 7, base = (sum(l.id, keys, bA, bB) / bd) * 7;
        if (!(base >= SIG.minBase[k])) continue;
        const pct = (cur - base) / base;
        if (pct <= -SIG.dropPct / 100) out.push({ sev: "down", hub: l.name, t: `${label} ${fmtDelta(pct)}`, b: `${fmtInt(cur)} за останні 7 днів проти ~${fmtInt(base)} на тиждень раніше.`, pct });
        else if (pct >= SIG.upPct / 100) out.push({ sev: "up", hub: l.name, t: `${label} ${fmtDelta(pct)}`, b: `${fmtInt(cur)} за останні 7 днів проти ~${fmtInt(base)} на тиждень раніше.`, pct });
      }
    }
    // new negative reviews (last 14 days), unanswered ones flagged hardest
    const since = Date.now() - 14 * DAY;
    for (const r of D.reviews || []) {
      if (!(r.ts >= since) || !r.stars || r.stars > 3) continue;
      out.push({ sev: r.reply ? "down" : "crit", hub: r.hub, t: `Відгук ${r.stars}★${r.reply ? "" : ", без відповіді"}`, b: r.comment ? `«${r.comment.replace(/\s+/g, " ").slice(0, 110)}${r.comment.length > 110 ? "…" : ""}»` : "Оцінка без тексту.", link: `#reviews/${encodeURIComponent(r.hub)}`, pct: -1 });
    }
    const order = { crit: 0, down: 1, up: 2 };
    return { list: out.sort((x, y) => order[x.sev] - order[y.sev] || (x.pct ?? 0) - (y.pct ?? 0)), cA, e, bA, bB };
  }

  // =====================================================================
  // OVERVIEW
  // =====================================================================
  function renderOverview() {
    const { a, b } = UI.period, [pa, pb] = prevRange();
    const comp = comparableLocs();
    const cur = {}, cmpCur = {}, prev = {};
    for (const k of ["views", "calls", "dir", "web"]) {
      cur[k] = sumAll(METRIC_SETS[k], a, b);
      cmpCur[k] = sumAll(METRIC_SETS[k], a, b, comp); prev[k] = sumAll(METRIC_SETS[k], pa, pb, comp);
    }
    const inter = o => o.calls + o.dir + o.web;
    const rateCur = cur.views ? inter(cur) / cur.views : null;
    const rateCmp = cmpCur.views ? inter(cmpCur) / cmpCur.views : null, ratePrev = prev.views ? inter(prev) / prev.views : null;
    const base = comp.length === D.locs.length ? "" : `<span>за ${comp.length} хабами з даними в обох періодах</span>`;
    const dl = (c, p) => (comp.length ? deltaHtml(c, p) + base : `<span class="flat">немає даних за попередній період</span>`);
    renderKpis($("ov-kpis"), [
      { label: "Перегляди профілю", icon: "ph-eye", value: fmtInt(cur.views), delta: dl(cmpCur.views, prev.views), spark: weeklyValues(D.locs, VIEWS, a, b) },
      { label: "Дзвінки", icon: "ph-phone", value: fmtInt(cur.calls), delta: dl(cmpCur.calls, prev.calls), spark: weeklyValues(D.locs, ["calls"], a, b) },
      { label: "Маршрути", icon: "ph-navigation-arrow", value: fmtInt(cur.dir), delta: dl(cmpCur.dir, prev.dir), spark: weeklyValues(D.locs, ["dir"], a, b) },
      { label: "Переходи на сайт", icon: "ph-globe", value: fmtInt(cur.web), delta: dl(cmpCur.web, prev.web), spark: weeklyValues(D.locs, ["web"], a, b) },
      { label: "Коефіцієнт взаємодії", icon: "ph-hand-tap", value: fmtPct(rateCur), delta: ratePrev ? dl(rateCmp, ratePrev) : "" },
    ]);

    // signals
    const S = computeSignals();
    $("sig-window").textContent = `Останні 7 днів (${fmtDay(dateAt(S.cA))} – ${fmtDay(dateAt(S.e))}) проти середнього тижня за ${fmtDay(dateAt(S.bA))} – ${fmtDay(dateAt(S.bB))}. Позначено падіння від ${SIG.dropPct}% і зростання від ${SIG.upPct}%; хаби з малою базою не враховано.`;
    const icon = { crit: "ph-fill ph-warning-octagon", down: "ph-fill ph-trend-down", up: "ph-fill ph-trend-up" };
    const bad = S.list.filter(s => s.sev !== "up"), good = S.list.filter(s => s.sev === "up");
    const card = s => `<button type="button" class="signal ${s.sev}" data-hub="${esc(s.hub)}" data-link="${esc(s.link || "")}"><i class="ph ${icon[s.sev]}" aria-hidden="true"></i><span><span class="t">${esc(s.hub)} · ${esc(s.t)}</span><span class="b" style="display:block">${esc(s.b)}</span></span></button>`;
    $("ov-signals").innerHTML =
      (bad.length ? `<div class="caption-4 muted" style="margin-bottom:8px">Потребує перевірки: ${bad.length}</div><div class="signals">${bad.map(card).join("")}</div>`
        : `<div class="ok-note body-5"><i class="ph ph-check-circle" aria-hidden="true"></i>Жоден хаб не просів на ${SIG.dropPct}% і більше. Термінового нічого.</div>`) +
      (good.length ? `<div class="caption-4 muted" style="margin:16px 0 8px">Зростають: ${good.length}</div><div class="signals">${good.map(card).join("")}</div>` : "");
    $("ov-signals").querySelectorAll(".signal").forEach(btn => btn.addEventListener("click", () => { location.hash = btn.dataset.link || hubLink(btn.dataset.hub); }));

    // monthly
    const MS = monthlySeries(D.locs, a, b);
    legend($("ov-monthly-legend"), ACTION_SERIES);
    C.columns($("ov-monthly"), {
      categories: MS.ms.map(m => m.label), series: MS.series, partial: MS.partial, fmt: fmtInt,
      tipTitle: i => `${MON_FULL[MS.ms[i].m]} ${MS.ms[i].y}${MS.ms[i].days < MS.ms[i].dim && !MS.ms[i].partial ? ` (${MS.ms[i].days} дн. у періоді)` : ""}`,
      ariaLabel: "Дзвінки, маршрути й переходи на сайт за місяцями",
    });

    // calls by hub
    const stats = D.locs.map(l => ({ l, ...hubStats(l.id, a, b) }));
    const byCalls = stats.slice().sort((x, y) => y.calls - x.calls);
    C.hbars($("ov-calls"), {
      rows: byCalls.map(s => ({ label: s.l.name, value: s.calls, key: s.l.name })), fmt: fmtInt, valueLabel: "Дзвінки",
      onClick: r => { location.hash = hubLink(r.key); },
    });

    // scatter: maps share vs interaction rate
    const pts = stats.filter(s => s.views > 0).map(s => ({ x: s.mapsShare, y: s.rate, size: s.views, label: s.l.name, key: s.l.name, s }));
    const hi = pts.filter(p => p.x > 0.85), lo = pts.filter(p => p.x <= 0.76);
    const maxHi = hi.length ? Math.max(...hi.map(p => p.y)) : null, minLo = lo.length ? Math.min(...lo.map(p => p.y)) : null;
    $("ov-scatter-note").textContent = `Обраний період. Кожна точка: хаб; розмір відповідає переглядам профілю. Понад 85% переглядів на Картах: ${hi.length} хабів, найвищий коефіцієнт взаємодії серед них ${fmtPct(maxHi)}. До 76% на Картах: ${lo.length} хабів, найнижчий коефіцієнт ${fmtPct(minLo)}. Високу частку Карт часто дають переглядачі, які не шукали саме вас.`;
    const xs = pts.map(p => p.x);
    const top = pts.slice().sort((p, q) => q.y - p.y).slice(0, 3).map(p => p.key);
    C.scatter($("ov-scatter"), {
      points: pts, height: 340, xMin: Math.floor(Math.min(...xs, 0.5) * 20) / 20, xMax: 1,
      xFmt: v => Math.round(v * 100) + "%", yFmt: v => Math.round(v * 100) + "%", xLabel: "Частка переглядів профілю на Картах Google",
      refX: 0.85, refLabel: "85%", labelKeys: Array.from(new Set(top)),
      tip: p => C.tipRows(p.label, [
        { label: "Частка Карт", value: fmtPct(p.x) }, { label: "Коефіцієнт взаємодії", value: fmtPct(p.y) },
        { label: "Перегляди", value: fmtInt(p.size) }, { label: "Взаємодії", value: fmtInt(p.s.inter) }]),
      onClick: p => { location.hash = hubLink(p.key); }, ariaLabel: "Частка Карт проти коефіцієнта взаємодії за хабами",
    });

    renderOverviewTable(stats);
  }

  function renderOverviewTable(stats) {
    const { a, b } = UI.period, [pa, pb] = prevRange();
    const lastIdx = D.n - 1, endD = dateAt(lastIdx);
    const curMs = Date.UTC(endD.getUTCFullYear(), endD.getUTCMonth(), 1);
    const curA = idxOf(new Date(curMs)), dim = new Date(Date.UTC(endD.getUTCFullYear(), endD.getUTCMonth() + 1, 0)).getUTCDate();
    const prevMs = new Date(Date.UTC(endD.getUTCFullYear(), endD.getUTCMonth() - 1, 1)), prevA = idxOf(prevMs), prevB = curA - 1;
    const rows = stats.map(s => {
      const kw = kwPeriod(a, b, s.l.id).rows, mix = intentMix(kw);
      const prevCalls = sum(s.l.id, ["calls"], pa, pb);
      const daysCur = lastIdx - curA + 1;
      const pace = daysCur > 0 ? (sum(s.l.id, ACTIONS, curA, lastIdx) / daysCur) * dim : null;
      const prevFull = sum(s.l.id, ACTIONS, prevA, prevB);
      return { hub: s.l.name, calls: s.calls, dCalls: prevCalls > 0 ? (s.calls - prevCalls) / prevCalls : null, dir: s.dir, web: s.web, inter: s.inter,
        views: s.views, rate: s.rate, maps: s.mapsShare, buyer: mix.buyerShare, pace: prevFull > 0 && pace != null ? (pace - prevFull) / prevFull : null,
        rating: (D.reviewSummary[s.l.id] || {}).avg ?? null, nRev: (D.reviewSummary[s.l.id] || {}).total ?? null };
    });
    const q = UI.ovQ.trim().toLowerCase();
    const shown = sortRows(rows.filter(r => !q || r.hub.toLowerCase().includes(q)), UI.ovSort);
    const maxCalls = Math.max(1, ...rows.map(r => r.calls));
    const st = UI.ovSort, tbl = $("ov-table");
    const dcls = v => (v == null ? "zero" : v > 0.005 ? "pos" : v < -0.005 ? "neg" : "zero");
    tbl.innerHTML = `<thead><tr>${th("Хаб", "hub", st, { type: "text" })}${th("Дзвінки", "calls", st, { num: true })}${th("Зміна", "dCalls", st, { num: true, title: "Дзвінки проти попереднього періоду такої ж довжини" })}${th("Маршрути", "dir", st, { num: true })}${th("Переходи на сайт", "web", st, { num: true })}${th("Взаємодії", "inter", st, { num: true })}${th("Перегляди", "views", st, { num: true })}${th("Коеф. взаємодії", "rate", st, { num: true, title: "Взаємодії / перегляди профілю" })}${th("Частка Карт", "maps", st, { num: true })}${th("Купівельний намір", "buyer", st, { num: true, title: "Частка купівельних серед врахованих пошукових запитів" })}${th("Темп місяця", "pace", st, { num: true, title: "Взаємодії поточного місяця в перерахунку на повний місяць проти минулого місяця" })}${th("Оцінка", "rating", st, { num: true, title: "Середня оцінка Google і кількість відгуків" })}</tr></thead><tbody>` +
      (shown.length ? shown.map(r => `<tr class="clickable" tabindex="0" data-hub="${esc(r.hub)}"><td class="body-5">${esc(r.hub)}</td>
        <td class="num"><span class="inline-bar"><span class="bar" style="width:${Math.max(2, (64 * r.calls) / maxCalls)}px"></span>${fmtInt(r.calls)}</span></td>
        <td class="num ${dcls(r.dCalls)}">${fmtDelta(r.dCalls)}</td><td class="num">${fmtInt(r.dir)}</td><td class="num">${fmtInt(r.web)}</td><td class="num">${fmtInt(r.inter)}</td>
        <td class="num">${fmtInt(r.views)}</td><td class="num">${fmtPct(r.rate)}</td><td class="num">${fmtPct(r.maps)}</td><td class="num">${fmtPct(r.buyer)}</td><td class="num ${dcls(r.pace)}">${fmtDelta(r.pace)}</td><td class="num">${r.rating != null ? `${r.rating.toFixed(1).replace(".", ",")} <span class="sub">(${fmtInt(r.nRev)})</span>` : "—"}</td></tr>`).join("")
        : `<tr><td colspan="12">${empty("Жоден хаб не відповідає пошуку.", "ph-magnifying-glass")}</td></tr>`) + "</tbody>";
    sortable(tbl, st, () => renderOverviewTable(stats));
    tbl.querySelectorAll("tr.clickable").forEach(tr => {
      const go = () => { location.hash = hubLink(tr.dataset.hub); };
      tr.addEventListener("click", go); tr.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
    });
  }

  // =====================================================================
  // HUB
  // =====================================================================
  function renderHub() {
    const sel = $("hub-select");
    if (!sel.options.length) {
      sel.innerHTML = D.locs.map(l => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join("");
      sel.addEventListener("change", () => { location.hash = hubLink(sel.value); });
    }
    const loc = D.byName[UI.hub] || D.locs.find(l => l.name.startsWith("Stockton")) || D.locs[0];
    UI.hub = loc.name; sel.value = loc.name;
    $("hub-address").textContent = loc.address;
    $("hub-to-fc").href = `#forecast/${encodeURIComponent(loc.name)}`;
    $("page-title").textContent = loc.name;
    const { a, b } = UI.period, [pa, pb] = prevRange();
    const s = hubStats(loc.id, a, b), p = hubStats(loc.id, pa, pb);
    const firstDay = D.first[loc.id];
    $("page-lead").textContent = firstDay > 0 && firstDay < D.n ? `Дані з ${fmtDate(dateAt(firstDay))}.` : "Профіль Google Business хабу.";
    renderKpis($("hub-kpis"), [
      { label: "Перегляди профілю", icon: "ph-eye", value: fmtInt(s.views), delta: deltaHtml(s.views, p.views), spark: weeklyValues([loc], VIEWS, a, b) },
      { label: "Дзвінки", icon: "ph-phone", value: fmtInt(s.calls), delta: deltaHtml(s.calls, p.calls), spark: weeklyValues([loc], ["calls"], a, b) },
      { label: "Маршрути", icon: "ph-navigation-arrow", value: fmtInt(s.dir), delta: deltaHtml(s.dir, p.dir), spark: weeklyValues([loc], ["dir"], a, b) },
      { label: "Переходи на сайт", icon: "ph-globe", value: fmtInt(s.web), delta: deltaHtml(s.web, p.web), spark: weeklyValues([loc], ["web"], a, b) },
      { label: "Коефіцієнт взаємодії", icon: "ph-hand-tap", value: fmtPct(s.rate), delta: p.rate ? deltaHtml(s.rate, p.rate) : "" },
      (() => {
        const rs = D.reviewSummary[loc.id] || {}, mine = (D.reviews || []).filter(r => r.locId === loc.id), open = mine.filter(r => !r.reply).length;
        return { label: "Оцінка в Google", icon: "ph-star", value: rs.avg != null ? rs.avg.toFixed(1).replace(".", ",") : "—",
          delta: `<span>${fmtInt(rs.total || 0)} відгуків</span>${open ? `<a class="down" href="#reviews/${encodeURIComponent(loc.name)}">${open} без відповіді</a>` : ""}` };
      })(),
    ]);
    const MS = monthlySeries([loc], a, b);
    legend($("hub-monthly-legend"), ACTION_SERIES);
    C.columns($("hub-monthly"), { categories: MS.ms.map(m => m.label), series: MS.series, partial: MS.partial, fmt: fmtInt,
      tipTitle: i => `${MON_FULL[MS.ms[i].m]} ${MS.ms[i].y}`, ariaLabel: `Активність ${loc.name} за місяцями` });

    const v = k => sum(loc.id, [k], a, b);
    C.segmented($("hub-sources"), [
      { name: "Карти, мобільні", value: v("mmaps"), color: "--s1" },
      { name: "Пошук, мобільні", value: v("msearch"), color: "--s2" },
      { name: "Карти, комп’ютер", value: v("dmaps"), color: "--s3" },
      { name: "Пошук, комп’ютер", value: v("dsearch"), color: "--s4" },
    ], { valueLabel: "Перегляди" });

    const kp = kwPeriod(a, b, loc.id), mix = intentMix(kp.rows);
    const latentBuyer = kp.rows.filter(r => r.thr && r.grp === "buyer").length;
    $("hub-intent-note").textContent = `Враховані пошуки (Google показує запити з 15 і більше): ${fmtInt(mix.counted)}. Ще купівельних запитів нижче порогу 15: ${latentBuyer}. ${kp.note}`;
    if (mix.counted) C.segmented($("hub-intent"), window.Intent.GROUPS.map(g => ({ name: g.label, value: mix.g[g.key], color: g.color })), { valueLabel: "Пошуки" });
    else $("hub-intent").innerHTML = empty("Жоден запит цього хабу не досяг порогу Google у 15 пошуків.");

    // weekly views
    const weeks = []; for (let e = b; e - 6 >= a; e -= 7) weeks.unshift(e);
    const wSeries = [
      { name: "Карти", color: "--s1", values: weeks.map(e => sum(loc.id, MAPS, e - 6, e)) },
      { name: "Пошук", color: "--s2", values: weeks.map(e => sum(loc.id, ["dsearch", "msearch"], e - 6, e)) },
    ];
    legend($("hub-weekly-legend"), wSeries);
    C.line($("hub-weekly"), { labels: weeks.map(e => fmtDay(dateAt(e - 6))), series: wSeries, fmt: fmtInt, height: 220,
      tipTitle: i => `${fmtDay(dateAt(weeks[i] - 6))} – ${fmtDay(dateAt(weeks[i]))}`, ariaLabel: "Перегляди профілю за тижнями" });

    // terms
    const agg = new Map();
    for (const r of kp.rows) {
      const e = agg.get(r.kw) || { kw: r.kw, v: 0, thr: false, cat: r.cat };
      e.v += r.v; e.thr = e.thr || r.thr; agg.set(r.kw, e);
    }
    const terms = Array.from(agg.values()).sort((x, y) => y.v - x.v).slice(0, 60);
    $("hub-terms").innerHTML = terms.length ? `<thead><tr><th>#</th><th>Запит</th><th class="num">Пошуки</th><th>Намір</th></tr></thead><tbody>` +
      terms.map((t, i) => `<tr><td class="muted num">${i + 1}</td><td>${esc(t.kw)}</td><td class="num">${t.thr ? `<span class="badge outline" title="Google приховав точне число">≤${fmtInt(t.v)}</span>` : fmtInt(t.v)}</td><td>${intentBadge(t.cat)}</td></tr>`).join("") + "</tbody>"
      : `<tbody><tr><td>${empty("Google не повернув запитів за цей період.")}</td></tr></tbody>`;

    // posts
    const posts = D.posts.filter(x => x.locId === loc.id).sort((x, y) => (y.t || 0) - (x.t || 0));
    const live = posts.filter(x => x.state === "LIVE");
    $("hub-posts-note").textContent = live.length ? `Остання публікація: ${fmtDate(live[0].t)} (${daysAgo(live[0].t)}).` : "Опублікованих дописів немає.";
    $("hub-to-posts").href = `#posts/${encodeURIComponent(loc.name)}`;
    $("hub-posts").innerHTML = posts.length ? `<thead><tr><th>Дата</th><th>Текст</th><th>Статус</th></tr></thead><tbody>` +
      posts.slice(0, 12).map(x => `<tr><td class="nowrap">${x.t ? fmtDate(x.t) : "—"}</td><td class="wrap">${esc(trim(x.summary, 140))}<div class="sub">${ctaLabel(x.cta_type)}${x.media_format ? " · " + mediaLabel(x.media_format) : ""}</div></td><td>${stateBadge(x.state)}</td></tr>`).join("") + "</tbody>"
      : `<tbody><tr><td>${empty("На цьому профілі ще немає дописів.", "ph-megaphone")}</td></tr></tbody>`;
  }

  const trim = (s, n) => { s = String(s || "").replace(/\s+/g, " ").trim(); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  function daysAgo(t) { const d = Math.floor((Date.now() - t) / DAY); return d <= 0 ? "сьогодні" : d === 1 ? "учора" : `${d} дн. тому`; }
  function intentBadge(cat) {
    const c = window.Intent.CAT[cat] || window.Intent.CAT.consumer;
    const cls = c.group === "buyer" ? "accent" : c.group === "brand" ? "ok" : c.group === "noise" ? "" : "";
    return `<span class="badge ${cls}">${esc(c.label)}</span>`;
  }
  const STATE = { LIVE: ["Опубліковано", "ok"], SCHEDULED: ["Заплановано", "accent"], REJECTED: ["Відхилено", "bad"], PROCESSING: ["Обробляється", "warn"] };
  const stateBadge = s => { const [l, c] = STATE[s] || [s || "—", ""]; return `<span class="badge ${c}">${esc(l)}</span>`; };
  const CTA = { CALL: "Зателефонувати", BOOK: "Забронювати", LEARN_MORE: "Докладніше", ORDER: "Замовити", SHOP: "Купити", SIGN_UP: "Зареєструватися", GET_OFFER: "Отримати пропозицію" };
  const ctaLabel = c => (c ? CTA[c] || c : "Без кнопки");
  const mediaLabel = m => ({ PHOTO: "Фото", VIDEO: "Відео" }[m] || "Без медіа");

  // =====================================================================
  // SEARCH
  // =====================================================================
  const SE = { hub: "all", intent: "all", q: "", sort: { col: "v", asc: false } };
  function renderSearch() {
    const { a, b } = UI.period;
    const all = kwPeriod(a, b).rows, mixAll = intentMix(all);
    const perHub = D.locs.map(l => {
      const rows = all.filter(r => r.loc === l.id), mix = intentMix(rows);
      return { l, rows, mix, latent: new Set(rows.filter(r => r.thr && r.grp === "buyer").map(r => r.kw)).size };
    });
    const best = perHub.filter(h => h.mix.counted >= 50).sort((x, y) => (y.mix.buyerShare || 0) - (x.mix.buyerShare || 0))[0];
    const yms = Array.from(new Set(all.map(r => r.ym))).sort((x, y) => x - y);
    const span = yms.length ? `${MON_FULL[yms[0] % 12]} ${Math.floor(yms[0] / 12)} – ${MON_FULL[yms[yms.length - 1] % 12]} ${Math.floor(yms[yms.length - 1] / 12)}` : "—";
    renderKpis($("se-kpis"), [
      { label: "Враховані пошуки", icon: "ph-magnifying-glass", value: fmtInt(mixAll.counted), delta: `<span>${esc(span)}</span>` },
      { label: "Купівельний намір", icon: "ph-target", value: fmtPct(mixAll.buyerShare), delta: `<span>${fmtInt(mixAll.g.buyer)} пошуків</span>` },
      { label: "Бренд або адреса", icon: "ph-seal-check", value: fmtPct(mixAll.counted ? mixAll.g.brand / mixAll.counted : null), delta: `<span>люди, які вже знають Freitty</span>` },
      { label: "Найвища частка купівельних", icon: "ph-trophy", value: best ? esc(best.l.name) : "—", delta: best ? `<span>${fmtPct(best.mix.buyerShare)} врахованих пошуків</span>` : "" },
    ]);
    legend($("se-mix-legend"), window.Intent.GROUPS.map(g => ({ name: g.label, color: g.color })));
    const mixRows = perHub.filter(h => h.mix.counted > 0).sort((x, y) => (y.mix.buyerShare || 0) - (x.mix.buyerShare || 0));
    if (mixRows.length) C.segRows($("se-mix"), {
      series: window.Intent.GROUPS.map(g => ({ name: g.label, color: g.color })),
      rows: mixRows.map(h => ({ label: h.l.name, key: h.l.name, parts: window.Intent.GROUPS.map(g => h.mix.g[g.key]), right: fmtInt(h.mix.counted) })),
      onClick: r => { location.hash = hubLink(r.key); },
    });
    else $("se-mix").innerHTML = empty("За цей період Google не дав врахованих пошуків.");
    const lat = perHub.filter(h => h.latent > 0).sort((x, y) => y.latent - x.latent);
    if (lat.length) C.hbars($("se-latent"), { rows: lat.map(h => ({ label: h.l.name, value: h.latent, key: h.l.name })), fmt: fmtInt, valueLabel: "Купівельних запитів нижче 15", onClick: r => { location.hash = hubLink(r.key); } });
    else $("se-latent").innerHTML = empty("Жоден хаб не має купівельних запитів нижче 15.");

    // new terms: latest complete month vs 3 before
    const nowYm = new Date().getUTCFullYear() * 12 + new Date().getUTCMonth();
    const allYms = Array.from(new Set(D.kw.map(r => r.ym))).filter(x => x < nowYm).sort((x, y) => x - y);
    const last = allYms[allYms.length - 1];
    if (last != null) {
      const prev = new Set(D.kw.filter(r => r.ym >= last - 3 && r.ym < last).map(r => r.loc + "|" + r.kw));
      const fresh = D.kw.filter(r => r.ym === last && !r.thr && r.v >= 15 && !prev.has(r.loc + "|" + r.kw)).sort((x, y) => y.v - x.v).slice(0, 30);
      $("se-new-note").textContent = `Запити ${MON_FULL[last % 12]} ${Math.floor(last / 12)}, яких хаб не мав у трьох попередніх місяцях (від 15 пошуків).`;
      $("se-new").innerHTML = fresh.length ? `<thead><tr><th>Запит</th><th>Хаб</th><th class="num">Пошуки</th><th>Намір</th></tr></thead><tbody>` +
        fresh.map(r => `<tr><td>${esc(r.kw)}</td><td class="nowrap">${esc(locName(r.loc))}</td><td class="num">${fmtInt(r.v)}</td><td>${intentBadge(r.cat)}</td></tr>`).join("") + "</tbody>"
        : `<tbody><tr><td>${empty("Нових запитів немає.")}</td></tr></tbody>`;
    }

    // filters
    const hs = $("se-hub"), is = $("se-intent");
    if (!hs.options.length) {
      hs.innerHTML = `<option value="all">Усі хаби</option>` + D.locs.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
      is.innerHTML = `<option value="all">Будь-який намір</option>` + window.Intent.CATS.map(c => `<option value="${c.key}">${esc(c.label)}</option>`).join("");
      hs.addEventListener("change", () => { SE.hub = hs.value; renderSearchTable(); });
      is.addEventListener("change", () => { SE.intent = is.value; renderSearchTable(); });
      let t; $("se-q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(() => { SE.q = e.target.value; renderSearchTable(); }, 200); });
    }
    renderSearchTable();
  }
  const locName = id => (D.locs.find(l => l.id === id) || {}).name || id;
  function renderSearchTable() {
    const { a, b } = UI.period;
    let rows = kwPeriod(a, b).rows;
    if (SE.hub !== "all") rows = rows.filter(r => r.loc === SE.hub);
    if (SE.intent !== "all") rows = rows.filter(r => r.cat === SE.intent);
    const q = SE.q.trim().toLowerCase(); if (q) rows = rows.filter(r => r.kw.toLowerCase().includes(q));
    const agg = new Map();
    for (const r of rows) {
      const k = r.loc + "|" + r.kw, e = agg.get(k) || { hub: locName(r.loc), kw: r.kw, v: 0, thr: false, cat: r.cat, catLabel: (window.Intent.CAT[r.cat] || {}).label };
      e.v += r.v; e.thr = e.thr || r.thr; agg.set(k, e);
    }
    const list = sortRows(Array.from(agg.values()), SE.sort);
    const shown = list.slice(0, 400), st = SE.sort, tbl = $("se-table");
    tbl.innerHTML = `<thead><tr>${th("Хаб", "hub", st, { type: "text" })}${th("Запит", "kw", st, { type: "text" })}${th("Пошуки", "v", st, { num: true })}${th("Намір", "catLabel", st, { type: "text" })}</tr></thead><tbody>` +
      (shown.length ? shown.map(r => `<tr><td class="nowrap">${esc(r.hub)}</td><td>${esc(r.kw)}</td><td class="num">${r.thr ? `<span class="badge outline" title="Google приховав точне число">≤${fmtInt(r.v)}</span>` : fmtInt(r.v)}</td><td>${intentBadge(r.cat)}</td></tr>`).join("")
        + (list.length > shown.length ? `<tr><td colspan="4" class="muted caption-5">Показано ${shown.length} з ${fmtInt(list.length)}. Звузьте фільтр, щоб побачити решту.</td></tr>` : "")
        : `<tr><td colspan="4">${empty("Жоден запит не відповідає фільтрам.", "ph-magnifying-glass")}</td></tr>`) + "</tbody>";
    sortable(tbl, st, renderSearchTable);
  }

  // =====================================================================
  // POSTS
  // =====================================================================
  const PO = { hub: "all", state: "all", q: "", sort: { col: "t", asc: false } };
  function renderPosts() {
    const { a, b } = UI.period;
    const t0 = dateAt(a).getTime(), t1 = dateAt(b).getTime() + DAY;
    const inPeriod = D.posts.filter(p => p.t && p.t.getTime() >= t0 && p.t.getTime() < t1);
    const live = D.posts.filter(p => p.state === "LIVE" && p.t);
    const now = Date.now();
    const lastByHub = D.locs.map(l => {
      const ps = live.filter(p => p.locId === l.id);
      const last = ps.reduce((m, p) => (p.t > m ? p.t : m), null);
      return { l, last, days: last ? Math.floor((now - last) / DAY) : null };
    });
    const stale = lastByHub.filter(h => h.days == null || h.days > 30).length;
    const sched = D.posts.filter(p => p.state === "SCHEDULED").length;
    const rejected = D.posts.filter(p => p.state === "REJECTED").length;
    const pubPeriod = inPeriod.filter(p => p.state === "LIVE").length;
    renderKpis($("po-kpis"), [
      { label: "Опубліковано за період", icon: "ph-megaphone", value: fmtInt(pubPeriod), delta: `<span>на ${new Set(inPeriod.filter(p => p.state === "LIVE").map(p => p.locId)).size} профілях</span>` },
      { label: "Профілів без дописів 30+ днів", icon: "ph-hourglass", value: fmtInt(stale), delta: `<span>з ${D.locs.length}</span>` },
      { label: "Заплановано", icon: "ph-calendar-check", value: fmtInt(sched), delta: `<span>ще не вийшли</span>` },
      { label: "Відхилено Google", icon: "ph-prohibit", value: fmtInt(rejected), delta: rejected ? `<span class="down">перевірте текст і медіа</span>` : `<span>немає</span>` },
    ]);
    const gaps = lastByHub.slice().sort((x, y) => (y.days ?? 1e9) - (x.days ?? 1e9));
    const maxGap = Math.max(30, ...gaps.map(g => g.days ?? 0));   // 30-day scale: a short pause stays a short bar
    C.hbars($("po-gap"), {
      rows: gaps.map(g => ({ label: g.l.name, key: g.l.name, value: g.days ?? maxGap, valueText: g.days == null ? "немає дописів" : g.days === 0 ? "сьогодні" : `${g.days} дн.`, color: g.days == null || g.days > 30 ? "--s2" : "--s1",
        tip: C.tipRows(g.l.name, [{ label: "Остання публікація", value: g.last ? fmtDate(g.last) : "немає" }]) })),
      max: maxGap, onClick: r => { location.hash = `#posts/${encodeURIComponent(r.key)}`; },
    });

    // weeks heat (last 12 weeks, Monday-based)
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY);
    const weeks = []; for (let k = 11; k >= 0; k--) weeks.push(monday.getTime() - k * 7 * DAY);
    const cnt = (lid, w) => live.filter(p => p.locId === lid && p.t.getTime() >= w && p.t.getTime() < w + 7 * DAY).length;
    const grid = D.locs.map(l => ({ l, c: weeks.map(w => cnt(l.id, w)) })).sort((x, y) => y.c.reduce((s, v) => s + v, 0) - x.c.reduce((s, v) => s + v, 0));
    const mx = Math.max(1, ...grid.flatMap(g => g.c));
    const seq = ["--seq-100", "--seq-200", "--seq-300", "--seq-400", "--seq-500", "--seq-600"];
    $("po-weeks").innerHTML = `<thead><tr><th></th>${weeks.map(w => `<th>${fmtDay(new Date(w))}</th>`).join("")}</tr></thead><tbody>` +
      grid.map(g => `<tr><th><a href="${hubLink(g.l.name)}">${esc(g.l.name)}</a></th>${g.c.map((v, k) => {
        const step = v ? seq[Math.min(seq.length - 1, Math.ceil((v / mx) * seq.length) - 1)] : null;
        const bg = step ? C.color(step) : "var(--surface-2)", fg = step && seq.indexOf(step) >= 3 ? "#fff" : "var(--text-2)";
        return `<td class="cell" style="background:${bg};color:${fg}" title="${esc(g.l.name)}, тиждень з ${fmtDay(new Date(weeks[k]))}: ${v}">${v || ""}</td>`;
      }).join("")}</tr>`).join("") + "</tbody>";

    // CTA + media
    const ctaCount = {}; inPeriod.forEach(p => { const k = ctaLabel(p.cta_type); ctaCount[k] = (ctaCount[k] || 0) + 1; });
    const ctaKeys = Object.keys(ctaCount).sort((x, y) => ctaCount[y] - ctaCount[x]);
    const ctaColors = ["--s1", "--s2", "--s3", "--s4", "--s5"];
    if (ctaKeys.length) C.segmented($("po-cta"), ctaKeys.slice(0, 5).map((k, i) => ({ name: k, value: ctaCount[k], color: k === "Без кнопки" ? "--neutral-series" : ctaColors[i] })), { valueLabel: "Дописів" });
    else $("po-cta").innerHTML = empty("За обраний період дописів немає.", "ph-megaphone");
    const md = {}; inPeriod.forEach(p => { const k = mediaLabel(p.media_format); md[k] = (md[k] || 0) + 1; });
    const mdKeys = Object.keys(md).sort((x, y) => md[y] - md[x]);
    if (mdKeys.length) C.segmented($("po-media"), mdKeys.map((k, i) => ({ name: k, value: md[k], color: k === "Без медіа" ? "--neutral-series" : ["--s1", "--s2"][i] || "--s3" })), { valueLabel: "Дописів" });
    else $("po-media").innerHTML = "";

    // duplicates
    const groups = new Map();
    inPeriod.forEach(p => { const k = trim(p.summary, 200).toLowerCase(); if (!k) return; const g = groups.get(k) || { text: p.summary, hubs: new Set(), first: p.t, last: p.t, cta: p.cta_type }; g.hubs.add(p.hub); if (p.t < g.first) g.first = p.t; if (p.t > g.last) g.last = p.t; groups.set(k, g); });
    const dup = Array.from(groups.values()).filter(g => g.hubs.size > 1).sort((x, y) => y.hubs.size - x.hubs.size);
    $("po-dupes").innerHTML = dup.length ? `<thead><tr><th>Текст</th><th class="num">Профілів</th><th>Вийшов</th></tr></thead><tbody>` +
      dup.slice(0, 40).map(g => `<tr><td class="wrap" title="${esc(Array.from(g.hubs).join(", "))}">${esc(trim(g.text, 120))}<div class="sub">${esc(ctaLabel(g.cta))}</div></td><td class="num">${g.hubs.size}</td><td class="nowrap">${fmtDay(g.first)}${g.last - g.first > DAY ? ` – ${fmtDay(g.last)}` : ""}</td></tr>`).join("") + "</tbody>"
      : `<tbody><tr><td>${empty("Кожен допис обраного періоду унікальний.", "ph-check-circle")}</td></tr></tbody>`;

    // filters + table
    const hs = $("po-hub"), ss = $("po-state");
    if (!hs.options.length) {
      hs.innerHTML = `<option value="all">Усі хаби</option>` + D.locs.map(l => `<option value="${esc(l.id)}">${esc(l.name)}</option>`).join("");
      ss.innerHTML = `<option value="all">Будь-який статус</option>` + Object.entries(STATE).map(([k, [l]]) => `<option value="${k}">${l}</option>`).join("");
      hs.addEventListener("change", () => { PO.hub = hs.value; renderPostsTable(); });
      ss.addEventListener("change", () => { PO.state = ss.value; renderPostsTable(); });
      let t; $("po-q").addEventListener("input", e => { clearTimeout(t); t = setTimeout(() => { PO.q = e.target.value; renderPostsTable(); }, 200); });
    }
    if (UI.postsHub) { const l = D.byName[UI.postsHub]; if (l) { PO.hub = l.id; hs.value = l.id; } UI.postsHub = null; }
    renderPostsTable();
  }
  function renderPostsTable() {
    const { a, b } = UI.period;
    const t0 = dateAt(a).getTime(), t1 = dateAt(b).getTime() + DAY;
    let rows = D.posts.filter(p => p.state === "SCHEDULED" || (p.t && p.t.getTime() >= t0 && p.t.getTime() < t1));
    if (PO.hub !== "all") rows = rows.filter(p => p.locId === PO.hub);
    if (PO.state !== "all") rows = rows.filter(p => p.state === PO.state);
    const q = PO.q.trim().toLowerCase(); if (q) rows = rows.filter(p => (p.summary || "").toLowerCase().includes(q));
    rows = rows.map(p => ({ ...p, ts: p.t ? p.t.getTime() : 0, cta: ctaLabel(p.cta_type) }));
    const st = PO.sort.col === "t" ? { ...PO.sort, col: "ts" } : PO.sort;
    const list = sortRows(rows, st).slice(0, 300), tbl = $("po-table");
    tbl.innerHTML = `<thead><tr>${th("Дата", "t", PO.sort)}${th("Хаб", "hub", PO.sort, { type: "text" })}<th>Текст</th>${th("Кнопка", "cta", PO.sort, { type: "text" })}<th>Медіа</th>${th("Статус", "state", PO.sort, { type: "text" })}<th></th></tr></thead><tbody>` +
      (list.length ? list.map(p => `<tr><td class="nowrap">${p.t ? fmtDate(p.t) : "—"}</td><td class="nowrap">${esc(p.hub)}</td><td class="wrap post-text" title="${esc(p.summary)}">${esc(trim(p.summary, 180))}</td><td class="nowrap">${esc(p.cta)}</td><td class="nowrap">${p.media_format ? `${mediaLabel(p.media_format)}${p.media_count > 1 ? ` × ${p.media_count}` : ""}` : "—"}</td><td>${stateBadge(p.state)}</td><td>${p.search_url ? `<a href="${esc(p.search_url)}" target="_blank" rel="noopener" aria-label="Відкрити в Google"><i class="ph ph-arrow-square-out" aria-hidden="true"></i></a>` : ""}</td></tr>`).join("")
        : `<tr><td colspan="7">${empty("Жодна публікація не відповідає фільтрам.", "ph-megaphone")}</td></tr>`) + "</tbody>";
    sortable(tbl, PO.sort, renderPostsTable);
  }

  // =====================================================================
  // ROUTER + SHELL
  // =====================================================================
  const PAGES = ["overview", "matrix", "hub", "reviews", "search", "posts", "forecast", "calls"];
  const TITLES = { overview: "Профілі Google Business", matrix: "Матриці", reviews: "Відгуки", search: "Пошуковий попит", posts: "Публікації", forecast: "Прогноз", calls: "Дзвінки з CallRail" };
  const LEADS = {
    overview: "Усі хаби Freitty. Дані оновлюються щодня; Google звітує з затримкою близько двох днів.",
    matrix: "Кожна метрика як теплова таблиця: період × хаб. Темніше означає більше.",
    reviews: "Відгуки Google на профілях усіх хабів: оцінки, тексти й відповіді власника. Оновлюється щодня.",
    search: "Що люди шукали в Google, перш ніж побачити профіль хабу. Google дає запити помісячно.",
    posts: "Дописи на профілях Google Business: що, де і коли вийшло. Оновлюється щодня.",
    forecast: "Три наступні місяці за вісьмома моделями, зважено за точністю на історії.",
    calls: "Журнал дзвінків CallRail наживо: канали, пропущені, повторні абоненти.",
  };
  function route() {
    const h = decodeURIComponent(location.hash.replace(/^#/, ""));
    const [page, arg] = h.split("/");
    UI.page = PAGES.includes(page) ? page : "overview";
    if (UI.page === "hub" && arg) UI.hub = arg;
    if (UI.page === "posts" && arg) UI.postsHub = arg;
    if (UI.page === "reviews" && arg) UI.reviewsHub = arg;
    if (UI.page === "forecast") UI.fcScope = arg || UI.fcScope || "network";
    document.querySelectorAll(".page").forEach(s => s.classList.toggle("active", s.id === "page-" + UI.page));
    document.querySelectorAll(".nav-link").forEach(a => { if (a.dataset.page === UI.page) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current"); });
    $("period-bar").style.display = ["forecast", "calls"].includes(UI.page) ? "none" : "";
    if (UI.page !== "hub") { $("page-title").textContent = TITLES[UI.page]; $("page-lead").textContent = LEADS[UI.page]; }
    closeMenu();
    if (UI.lastPage !== UI.page || UI.page === "hub") scrollTo(0, 0);
    UI.lastPage = UI.page;
    renderPage();
  }
  function renderPage() {
    if (!D.ready) return;
    C.hideTip();
    try {
      if (UI.page === "overview") renderOverview();
      else if (UI.page === "hub") renderHub();
      else if (UI.page === "search") renderSearch();
      else if (UI.page === "matrix") window.Matrix && window.Matrix.render();
      else if (UI.page === "reviews") window.Reviews && window.Reviews.render();
      else if (UI.page === "posts") renderPosts();
      else if (UI.page === "forecast") window.Forecast && window.Forecast.render();
      else if (UI.page === "calls") window.CallsTab && window.CallsTab.show();
    } catch (e) {
      console.error(e);
      $("banner").innerHTML = `<div class="banner err"><i class="ph ph-warning-circle" aria-hidden="true"></i><span class="body-5">Не вдалося показати розділ: ${esc(e.message)}. Оновіть сторінку; якщо не допоможе, напишіть Владу.</span></div>`;
    }
  }

  // mobile menu
  function closeMenu() { document.body.classList.remove("nav-open"); $("nav-toggle").setAttribute("aria-expanded", "false"); }
  function initShell() {
    const mm = $("mobile-menu");
    mm.innerHTML = $("nav-links").innerHTML;
    mm.querySelectorAll(".nav-link").forEach((a, i) => { a.style.transitionDelay = `${Math.min(i * 60, 400)}ms`; });
    $("nav-toggle").addEventListener("click", () => {
      const open = !document.body.classList.contains("nav-open");
      document.body.classList.toggle("nav-open", open);
      $("nav-toggle").setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closeMenu(); });
    // theme: system -> light -> dark
    const themeBtn = $("theme-btn");
    const icon = () => { const t = document.documentElement.dataset.theme; themeBtn.innerHTML = `<i class="ph ${t === "light" ? "ph-sun" : t === "dark" ? "ph-moon" : "ph-circle-half"}" aria-hidden="true"></i>`; themeBtn.setAttribute("aria-label", `Тема: ${t === "light" ? "світла" : t === "dark" ? "темна" : "як у системі"}`); };
    icon();
    themeBtn.addEventListener("click", () => {
      const t = document.documentElement.dataset.theme, next = !t ? "light" : t === "light" ? "dark" : "";
      if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme;
      store.set("gbp-theme", next); icon(); renderPage();
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderPage());
    // period
    document.querySelectorAll("#period-presets button").forEach(btn => btn.addEventListener("click", () => { setPreset(btn.dataset.p); renderPage(); }));
    const onDate = () => {
      const f = new Date($("period-from").value + "T00:00:00Z"), t = new Date($("period-to").value + "T00:00:00Z");
      if (isNaN(f) || isNaN(t) || f > t) return;
      UI.period = { preset: "custom", a: Math.max(0, idxOf(f)), b: Math.min(D.n - 1, idxOf(t)) };
      syncPeriodUI(); renderPage();
    };
    $("period-from").addEventListener("change", onDate); $("period-to").addEventListener("change", onDate);
    let t; $("ov-search").addEventListener("input", e => { clearTimeout(t); t = setTimeout(() => { UI.ovQ = e.target.value; renderPage(); }, 150); });
    window.addEventListener("hashchange", route);
  }

  function renderFreshness() {
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const lag = Math.round((today - D.end) / DAY);
    const gen = new Date(D.meta.generated_at);
    $("freshness-text").textContent = `Дані по ${fmtDate(D.end)} · оновлено ${gen.toLocaleString("uk-UA", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
    const stale = lag > 6;
    $("freshness").classList.toggle("stale", stale);
    if (stale) $("banner").innerHTML = `<div class="banner warn"><i class="ph ph-warning" aria-hidden="true"></i><span class="body-5">Останні дані ${lag} дн. тому (норма 2–3). Щоденне оновлення, ймовірно, не спрацювало: перевірте GitHub → Actions.</span></div>`;
    else if (D.meta.last_pull && D.meta.last_pull.status === "partial") $("banner").innerHTML = `<div class="banner warn"><i class="ph ph-warning" aria-hidden="true"></i><span class="body-5">Останнє оновлення пройшло частково, деякі хаби не завантажились. Наступне оновлення спробує знову.</span></div>`;
  }

  async function boot() {
    initShell();
    route();
    try {
      await load();
    } catch (e) {
      $("banner").innerHTML = `<div class="banner err"><i class="ph ph-warning-circle" aria-hidden="true"></i><span class="body-5">Не вдалося завантажити дані: ${esc(e.message)}. Оновіть сторінку за хвилину.</span></div>`;
      $("freshness-text").textContent = "Немає даних";
      return;
    }
    const saved = store.get("gbp-period");
    setPreset(["30", "90", "180", "365", "all"].includes(saved) ? saved : "180");
    renderFreshness();
    renderPage();
  }

  // shared with forecast.js / calls.js
  window.GBP = { D, UI, sum, sumAll, hubStats, months, dateAt, idxOf, fmtInt, fmtPct, fmtDelta, fmtDate, fmtDay, MON, MON_FULL, METRIC_SETS, METRIC_LABEL, renderKpis, legend, empty, sortable, th, sortRows, hubLink, esc, store, DAY };
  boot();
})();
