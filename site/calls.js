// Calls tab: live CallRail call log (via /api/calls), stats and CSV export.
// Uses window.Charts (charts.js) for the chart, tooltip and escaping.
(function () {
  "use strict";

  const LONG_CALL_SEC = 60;          // "talked 1 min+" threshold
  const LOG_PAGE = 200;              // rows added per "Show more"
  const Ch = window.Charts, esc = Ch.esc;
  // validated categorical slots (styles.css), fixed per channel so a filter never repaints survivors
  const CHANNEL_COLORS = {
    "Google Ads": "--s1",
    "Google Maps Ads": "--s2",
    "Google Maps (organic)": "--s3",
    "Google organic (site)": "--s4",
  };
  const EXTRA_COLORS = ["--s5", "--s7", "--s8", "--neutral-series"];
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];      // parsing the en-US weekday
  const DOW_UA = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Нд"];
  const CH_UA = { "Google Maps Ads": "Реклама в Картах", "Google Maps (organic)": "Карти (органіка)", "Google organic (site)": "Пошук, сайт (органіка)" };
  const chName = ch => CH_UA[ch] || ch;

  const S = {
    loaded: false, loading: false, data: null,
    from: null, to: null, loc: "all", channels: null, gran: "day",
    heat: "all", logFilter: "all", search: "", logShown: LOG_PAGE, sort: { col: "t", asc: false },
  };
  const $ = id => document.getElementById(id);

  // ---------------- helpers ----------------
  const fmtInt = n => (n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("uk-UA"));
  const pct = (a, b) => (b ? (100 * a) / b : NaN);
  const fmtPct = n => (Number.isFinite(n) ? n.toFixed(0) + "%" : "—");
  function fmtDur(sec) {
    if (!Number.isFinite(sec)) return "—";
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m ? `${m}:${String(s).padStart(2, "0")}` : `${s} с`;
  }
  function fmtPhone(e164) {
    const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164 || "");
    return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164 || "";
  }
  function localDay(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
  function colorFor(ch, idx) { return CHANNEL_COLORS[ch] || EXTRA_COLORS[Math.max(0, idx) % EXTRA_COLORS.length]; }

  // Local time of the call in the location's own time zone (falls back to the offset CallRail sent).
  const fmtCache = {};
  function partsFor(tz) {
    if (!(tz in fmtCache)) {
      try {
        fmtCache[tz] = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23", timeZoneName: "short" });
      } catch { fmtCache[tz] = null; }
    }
    return fmtCache[tz];
  }
  function localTime(c) {
    if (c._lt) return c._lt;
    const f = c.tz && partsFor(c.tz);
    let lt;
    if (f) {
      const p = Object.fromEntries(f.formatToParts(new Date(c.t)).map(x => [x.type, x.value]));
      lt = { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), min: p.minute, dow: DOW.indexOf(p.weekday), tzn: p.timeZoneName };
    } else {
      const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(c.t) || [];
      const d = new Date(m[1] + "T00:00:00Z");
      lt = { date: m[1], hour: Number(m[2]), min: m[3], dow: (d.getUTCDay() + 6) % 7, tzn: "" };
    }
    return (c._lt = lt);
  }
  function periodKey(dateStr, gran) {
    if (gran === "month") return dateStr.slice(0, 7);
    if (gran === "week") {
      const d = new Date(dateStr + "T00:00:00Z");
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); // Monday
      return d.toISOString().slice(0, 10);
    }
    return dateStr;
  }
  function periodLabel(k, gran) {
    if (gran === "month") return new Date(k + "-01T00:00:00Z").toLocaleDateString("uk-UA", { month: "short", year: "2-digit", timeZone: "UTC" });
    const d = new Date(k + "T00:00:00Z").toLocaleDateString("uk-UA", { day: "numeric", month: "short", timeZone: "UTC" });
    return gran === "week" ? "тиж. " + d : d;
  }
  function allPeriods(from, to, gran) {
    const out = [];
    const seen = new Set();
    for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
      const k = periodKey(d.toISOString().slice(0, 10), gran);
      if (!seen.has(k)) { seen.add(k); out.push(k); }
    }
    return out;
  }

  // ---------------- data ----------------
  async function load(fresh) {
    if (S.loading) return;
    S.loading = true;
    $("calls-meta").textContent = "Завантажуємо дзвінки з CallRail…";
    $("calls-msg").innerHTML = "";
    try {
      const qs = new URLSearchParams({ from: S.from, to: S.to });
      if (fresh) qs.set("fresh", "1");
      const res = await fetch("/api/calls?" + qs, { cache: "no-store" });
      if (res.status === 401) { location.reload(); return; }
      const j = await res.json().catch(() => ({ error: "HTTP " + res.status }));
      if (!res.ok) throw new Error(j.error || "HTTP " + res.status);
      prepare(j);
      S.data = j;
      S.loaded = true;
      S.logShown = LOG_PAGE;
      renderFilters();
      render();
    } catch (e) {
      $("calls-msg").innerHTML = `<div class="banner err"><i class="ph ph-warning-circle" aria-hidden="true"></i><span class="body-5">Не вдалося завантажити дзвінки: ${esc(e.message)}. Спробуйте «Оновити» за хвилину.</span></div>`;
      $("calls-body").style.display = "none";
      $("calls-meta").textContent = "";
    } finally {
      S.loading = false;
    }
  }

  // "Missed, not reached later": no later answered inbound call from, and no outbound call to,
  // the same number within the loaded period.
  function prepare(j) {
    const byNum = {};
    for (const c of j.calls) if (c.num) (byNum[c.num] ||= []).push(c);
    for (const list of Object.values(byNum)) list.sort((a, b) => (a.t < b.t ? -1 : 1));
    for (const c of j.calls) {
      c._missed = c.dir === "inbound" && !c.ans;
      if (!c._missed) continue;
      const later = (byNum[c.num] || []).filter(x => x.t > c.t);
      c._reached = later.some(x => (x.dir === "inbound" && x.ans) || x.dir !== "inbound");
    }
  }

  function inbound() {
    return S.data.calls.filter(c => c.dir === "inbound"
      && (S.loc === "all" || c.loc === S.loc)
      && S.channels.has(c.ch));
  }

  function stats(rows) {
    const ans = rows.filter(c => c.ans);
    const missed = rows.filter(c => c._missed);
    return {
      calls: rows.length,
      unique: new Set(rows.map(c => c.num).filter(Boolean)).size,
      first: rows.filter(c => c.first).length,
      ans: ans.length,
      missed: missed.length,
      vm: missed.filter(c => c.vm).length,
      notReached: missed.filter(c => !c._reached).length,
      avgTalk: ans.length ? ans.reduce((s, c) => s + c.dur, 0) / ans.length : NaN,
      long: rows.filter(c => c.ans && c.dur >= LONG_CALL_SEC).length,
    };
  }

  // ---------------- render ----------------
  function renderFilters() {
    const calls = S.data.calls.filter(c => c.dir === "inbound");
    const counts = {};
    for (const c of calls) counts[c.ch] = (counts[c.ch] || 0) + 1;
    const chans = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    S.chanOrder = chans;
    if (!S.channels) S.channels = new Set(chans);
    else for (const ch of chans) if (!S.knownCh || !S.knownCh.has(ch)) S.channels.add(ch);
    S.knownCh = new Set(chans);

    $("calls-ch").innerHTML = chans.map((ch, i) =>
      `<button type="button" class="chip ${S.channels.has(ch) ? "active" : ""}" aria-pressed="${S.channels.has(ch)}" data-ch="${esc(ch)}"><span class="dot" style="background:${Ch.color(colorFor(ch, i))}"></span>${esc(chName(ch))} · ${fmtInt(counts[ch])}</button>`).join("")
      || `<span class="caption-5 muted">За цей період дзвінків немає</span>`;
    $("calls-ch").querySelectorAll(".chip").forEach(el => el.addEventListener("click", () => {
      const ch = el.dataset.ch;
      if (S.channels.has(ch)) S.channels.delete(ch); else S.channels.add(ch);
      el.classList.toggle("active"); el.setAttribute("aria-pressed", String(S.channels.has(ch)));
      S.logShown = LOG_PAGE;
      render();
    }));

    const locs = Array.from(new Set(calls.map(c => c.loc).filter(Boolean))).sort();
    if (S.loc !== "all" && !locs.includes(S.loc)) S.loc = "all";
    $("calls-loc").innerHTML = `<option value="all">Усі локації</option>` +
      locs.map(l => `<option ${l === S.loc ? "selected" : ""}>${esc(l)}</option>`).join("");
  }

  function render() {
    if (!S.loaded) return;
    const d = S.data;
    const gen = new Date(d.generated_at).toLocaleTimeString("uk-UA", { hour: "2-digit", minute: "2-digit" });
    $("calls-meta").textContent = `${fmtInt(d.calls.length)} дзвінків · наживо з CallRail, ${gen}`;
    if (d.truncated) $("calls-msg").innerHTML = `<div class="banner warn"><i class="ph ph-warning" aria-hidden="true"></i><span class="body-5">За цей період дзвінків більше, ніж вміщує один запит; найновіші обрізано. Оберіть коротший період.</span></div>`;
    $("calls-body").style.display = "";

    const rows = inbound();
    renderKPIs(rows);
    renderChart(rows);
    renderBreakdown("calls-by-ch", rows, c => c.ch, "Канал", S.chanOrder, chName);
    renderBreakdown("calls-by-loc", rows, c => c.loc || "—", "Локація");
    renderHeat(rows);
    renderRepeat(rows);
    renderSources();
    renderLog();
  }

  function kpi(label, value, sub) {
    return `<div class="kpi"><div class="kpi-label">${label}</div><div class="kpi-value">${value}</div>${sub ? `<div class="kpi-delta">${sub}</div>` : ""}</div>`;
  }

  function renderKPIs(rows) {
    const s = stats(rows);
    $("calls-kpis").innerHTML = [
      kpi("Дзвінки", fmtInt(s.calls), "вхідні"),
      kpi("Унікальні абоненти", fmtInt(s.unique), `${fmtPct(pct(s.unique, s.calls))} дзвінків`),
      kpi("Нові абоненти", fmtInt(s.first), `${fmtPct(pct(s.first, s.calls))} дзвінків`),
      kpi("Відповіли", fmtPct(pct(s.ans, s.calls)), `${fmtInt(s.ans)} дзвінків`),
      kpi("Пропущені", fmtInt(s.missed), `${fmtInt(s.vm)} залишили голосове`),
      kpi("Не додзвонились", `<span class="${s.notReached ? "neg" : ""}">${fmtInt(s.notReached)}</span>`, "без відповіді й передзвону пізніше"),
      kpi("Середня розмова", fmtDur(s.avgTalk), "дзвінки з відповіддю"),
      kpi(`Розмова від ${LONG_CALL_SEC / 60} хв`, fmtInt(s.long), `${fmtPct(pct(s.long, s.calls))} дзвінків`),
    ].join("");
  }

  function renderChart(rows) {
    const periods = allPeriods(S.from, S.to, S.gran);
    const idx = Object.fromEntries(periods.map((p, i) => [p, i]));
    const chans = S.chanOrder.filter(ch => S.channels.has(ch));
    const series = Object.fromEntries(chans.map(ch => [ch, new Array(periods.length).fill(0)]));
    for (const c of rows) {
      const k = periodKey(localTime(c).date, S.gran);
      if (k in idx && series[c.ch]) series[c.ch][idx[k]]++;
    }
    const ser = chans.map(ch => ({ name: chName(ch), color: colorFor(ch, S.chanOrder.indexOf(ch)), values: series[ch] }));
    $("calls-chart-legend").innerHTML = ser.map(x => `<span><span class="swatch" style="background:${Ch.color(x.color)}"></span>${esc(x.name)}</span>`).join("");
    Ch.columns($("calls-chart"), { categories: periods.map(p => periodLabel(p, S.gran)), series: ser, height: 260, fmt: fmtInt, ariaLabel: "Вхідні дзвінки за періодами, за каналами" });
  }

  function renderBreakdown(id, rows, keyFn, label, order, nameFn = k => k) {
    const groups = {};
    for (const c of rows) (groups[keyFn(c)] ||= []).push(c);
    let keys = Object.keys(groups);
    keys = order ? order.filter(k => groups[k]) : keys.sort((a, b) => groups[b].length - groups[a].length);
    const tot = stats(rows);
    const line = (name, s, cls = "") => `<tr class="${cls}"><td class="body-5">${name}</td><td class="num">${fmtInt(s.calls)}</td><td class="num">${fmtInt(s.unique)}</td><td class="num">${fmtInt(s.first)}</td>
      <td class="num">${fmtPct(pct(s.ans, s.calls))}</td><td class="num">${fmtInt(s.missed)}</td><td class="num ${s.notReached ? "neg" : ""}">${fmtInt(s.notReached)}</td>
      <td class="num">${fmtDur(s.avgTalk)}</td><td class="num">${fmtInt(s.long)}</td></tr>`;
    $(id).innerHTML = `<thead><tr><th>${label}</th><th class="num">Дзвінки</th><th class="num">Унікальні</th><th class="num">Нові</th><th class="num">Відповіли</th><th class="num">Пропущені</th><th class="num" title="Пропущені, без відповіді й передзвону пізніше">Не додзвонились</th><th class="num">Сер. розмова</th><th class="num">Від ${LONG_CALL_SEC / 60} хв</th></tr></thead>
      <tbody>${keys.map(k => line(esc(nameFn(k)), stats(groups[k]))).join("")}${keys.length > 1 ? line("Разом", tot, "total") : ""}</tbody>`;
  }

  function renderHeat(rows) {
    const subset = S.heat === "missed" ? rows.filter(c => c._missed) : rows;
    const m = DOW.map(() => new Array(24).fill(0));
    let lo = 23, hi = 0, max = 0;
    for (const c of subset) {
      const lt = localTime(c);
      if (lt.dow < 0) continue;
      m[lt.dow][lt.hour]++;
    }
    for (const c of rows) { const h = localTime(c).hour; lo = Math.min(lo, h); hi = Math.max(hi, h); }
    if (!rows.length) { lo = 8; hi = 18; }
    for (const r of m) for (let h = lo; h <= hi; h++) max = Math.max(max, r[h]);
    const hours = []; for (let h = lo; h <= hi; h++) hours.push(h);
    const seq = ["--seq-100", "--seq-200", "--seq-300", "--seq-400", "--seq-500", "--seq-600"];
    $("calls-heat").innerHTML = `<thead><tr><th>Година</th>${hours.map(h => `<th>${h}</th>`).join("")}<th>Разом</th></tr></thead><tbody>` +
      DOW.map((d, i) => `<tr><th>${DOW_UA[i]}</th>${hours.map(h => {
        const v = m[i][h];
        const k = v && max ? Math.min(seq.length - 1, Math.ceil((v / max) * seq.length) - 1) : -1;
        return `<td class="cell" style="background:${k >= 0 ? Ch.color(seq[k]) : "var(--surface-2)"};color:${k >= 3 ? "#fff" : "var(--text-2)"}" title="${DOW_UA[i]}, ${h}:00, ${v}">${v || ""}</td>`;
      }).join("")}<td class="cell">${m[i].reduce((a, b) => a + b, 0)}</td></tr>`).join("") + "</tbody>";
  }

  function renderRepeat(rows) {
    const g = {};
    for (const c of rows) if (c.num) (g[c.num] ||= []).push(c);
    const list = Object.entries(g).filter(([, l]) => l.length > 1).sort((a, b) => b[1].length - a[1].length).slice(0, 25);
    $("calls-repeat-meta").textContent = `${fmtInt(Object.values(g).filter(l => l.length > 1).length)} номерів телефонували більше одного разу`;
    $("calls-repeat").innerHTML = list.length ? `<thead><tr><th>Абонент</th><th class="num">Дзвінки</th><th class="num">Відповіли</th><th>Канали</th><th>Останній дзвінок</th></tr></thead><tbody>` +
      list.map(([num, l]) => {
        const last = l.reduce((a, b) => (a.t > b.t ? a : b));
        const name = l.map(c => c.name).find(Boolean) || "";
        const lt = localTime(last);
        return `<tr><td><span class="mono">${esc(fmtPhone(num))}</span>${name ? `<div class="sub">${esc(name)}</div>` : ""}</td><td class="num">${l.length}</td>
          <td class="num">${l.filter(c => c.ans).length}</td><td>${esc(Array.from(new Set(l.map(c => chName(c.ch)))).join(", "))}</td><td>${esc(lt.date)} ${lt.hour}:${lt.min}</td></tr>`;
      }).join("") + "</tbody>" : `<tbody><tr><td class="caption-5 muted">Повторних дзвінків у цій вибірці немає.</td></tr></tbody>`;
  }

  function renderSources() {
    const g = {};
    for (const c of S.data.calls.filter(c => c.dir === "inbound")) {
      const k = [c.trk || "—", c.trkType || "—", c.src || "—", c.ch].join("\u0001");
      g[k] = (g[k] || 0) + 1;
    }
    const keys = Object.keys(g).sort((a, b) => g[b] - g[a]);
    $("calls-sources").innerHTML = `<thead><tr><th>Номер відстеження (CallRail)</th><th>Тип</th><th>Джерело</th><th>Зараховано як</th><th class="num">Дзвінки</th></tr></thead><tbody>` +
      keys.map(k => { const [trk, type, src, ch] = k.split("\u0001"); return `<tr><td class="body-5">${esc(trk)}</td><td>${esc(type)}</td><td>${esc(src)}</td><td>${esc(chName(ch))}</td><td class="num">${fmtInt(g[k])}</td></tr>`; }).join("") + "</tbody>";
  }

  // ---------------- call log ----------------
  function logRows() {
    let rows = S.data.calls.filter(c => (S.loc === "all" || c.loc === S.loc) && S.channels.has(c.ch));
    const f = S.logFilter;
    if (f === "outbound") rows = rows.filter(c => c.dir !== "inbound");
    else {
      rows = rows.filter(c => c.dir === "inbound");
      if (f === "answered") rows = rows.filter(c => c.ans);
      else if (f === "missed") rows = rows.filter(c => c._missed);
      else if (f === "notreached") rows = rows.filter(c => c._missed && !c._reached);
      else if (f === "first") rows = rows.filter(c => c.first);
      else if (f === "long") rows = rows.filter(c => c.ans && c.dur >= LONG_CALL_SEC);
    }
    const q = S.search.trim().toLowerCase();
    if (q) {
      const digits = q.replace(/\D/g, "");
      rows = rows.filter(c => (digits.length >= 3 && c.num.replace(/\D/g, "").includes(digits))
        || [c.name, c.city, c.state, c.camp, c.kw, c.loc, c.trk].some(v => (v || "").toLowerCase().includes(q)));
    }
    const { col, asc } = S.sort;
    const val = c => (col === "t" ? c.t : col === "dur" ? c.dur : String(c[col] || "").toLowerCase());
    rows.sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * (asc ? 1 : -1); });
    return rows;
  }

  function status(c) {
    if (c.dir !== "inbound") return `<span class="badge">Вихідний</span>`;
    if (c.ans) return `<span class="badge ok">Відповіли</span>`;
    const tag = c.vm ? "Голосове" : "Пропущений";
    return `<span class="badge ${c._reached ? "warn" : "bad"}" title="${c._reached ? "Пізніше зв’язались" : "Пізніше не зв’язались"}">${tag}${c._reached ? ", зв’язались" : ""}</span>`;
  }

  function renderLog() {
    const rows = logRows();
    S.logRowsCache = rows;
    const shown = rows.slice(0, S.logShown);
    const th = (col, label, cls = "") => `<th class="sortable ${cls}" data-sort="${col}">${label} <span class="arr">${S.sort.col === col ? (S.sort.asc ? "↑" : "↓") : ""}</span></th>`;
    $("calls-log").innerHTML = `<thead><tr>${th("t", "Час")}${th("num", "Абонент")}${th("loc", "Локація")}${th("ch", "Канал")}<th>Кампанія, ключове слово</th>${th("dur", "Розмова", "num")}<th>Статус</th><th></th></tr></thead><tbody>` +
      shown.map(c => {
        const lt = localTime(c);
        const where = [c.city, c.state].filter(Boolean).join(", ");
        return `<tr>
          <td class="nowrap">${esc(lt.date)} ${lt.hour}:${lt.min}<div class="sub">${esc(lt.tzn)}</div></td>
          <td><span class="mono">${esc(fmtPhone(c.num))}</span>${c.first ? ` <span class="badge accent">новий</span>` : ""}<div class="sub">${esc([c.name, where].filter(Boolean).join(" · "))}</div></td>
          <td>${esc(c.loc)}</td>
          <td>${esc(chName(c.ch))}<div class="sub">${esc(c.trk)}</div></td>
          <td>${esc(c.camp)}${c.kw ? `<div class="sub">${esc(c.kw)}</div>` : ""}</td>
          <td class="num">${c.ans ? fmtDur(c.dur) : "—"}</td>
          <td>${status(c)}</td>
          <td>${c.rec ? `<a href="${esc(c.rec)}" target="_blank" rel="noopener noreferrer">Запис</a>` : ""}</td></tr>`;
      }).join("") + "</tbody>";
    $("calls-log-meta").textContent = `${fmtInt(rows.length)} дзвінків${rows.length > shown.length ? `, показано ${fmtInt(shown.length)}` : ""}`;
    $("calls-more").style.display = rows.length > shown.length ? "" : "none";
    $("calls-log").querySelectorAll("th.sortable").forEach(el => el.addEventListener("click", () => {
      const col = el.dataset.sort;
      if (S.sort.col === col) S.sort.asc = !S.sort.asc; else S.sort = { col, asc: col !== "t" && col !== "dur" };
      renderLog();
    }));
  }

  // CSV: guard against spreadsheet formula injection (cells starting with = + - @).
  function csvCell(v) {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function exportCsv() {
    const rows = S.logRowsCache || [];
    const head = ["date", "time", "time_zone", "phone", "phone_digits", "caller_name", "city", "state", "direction", "location", "channel",
      "tracking_number_name", "tracker_type", "source", "medium", "campaign", "keyword", "google_click", "first_call", "answered",
      "voicemail", "talk_seconds", "missed_not_reached", "lead_status", "value", "tags", "device", "landing_page", "recording", "callrail_id"];
    const lines = [head.join(",")];
    for (const c of rows) {
      const lt = localTime(c);
      lines.push([lt.date, `${lt.hour}:${lt.min}`, c.tz || lt.tzn, fmtPhone(c.num), c.num.replace(/\D/g, ""), c.name, c.city, c.state, c.dir, c.loc, c.ch,
        c.trk, c.trkType, c.src, c.med, c.camp, c.kw, c.gclid ? "yes" : "", c.first ? "yes" : "", c.ans ? "yes" : "no",
        c.vm ? "yes" : "", c.dur, c._missed && !c._reached ? "yes" : "", c.lead, c.val ?? "", c.tags.join("; "), c.dev, c.lp, c.rec, c.id].map(csvCell).join(","));
    }
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `freitty_calls_${S.from}_${S.to}.csv`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // ---------------- wiring ----------------
  function setPreset(days) {
    const to = new Date(), from = new Date();
    from.setDate(from.getDate() - (days - 1));
    S.from = localDay(from); S.to = localDay(to);
    $("calls-from").value = S.from; $("calls-to").value = S.to;
  }

  function wire() {
    document.querySelectorAll("#calls-preset button").forEach(b => b.addEventListener("click", () => {
      document.querySelectorAll("#calls-preset button").forEach(x => x.classList.remove("active"));
      b.classList.add("active");
      setPreset(Number(b.dataset.days));
      load();
    }));
    ["calls-from", "calls-to"].forEach(id => $(id).addEventListener("change", () => {
      const f = $("calls-from").value, t = $("calls-to").value;
      if (!f || !t || f > t) return;
      document.querySelectorAll("#calls-preset button").forEach(x => x.classList.remove("active"));
      S.from = f; S.to = t;
      load();
    }));
    $("calls-refresh").addEventListener("click", () => load(true));
    $("calls-loc").addEventListener("change", e => { S.loc = e.target.value; S.logShown = LOG_PAGE; render(); });
    document.querySelectorAll("#calls-gran button").forEach(b => b.addEventListener("click", () => {
      document.querySelectorAll("#calls-gran button").forEach(x => x.classList.remove("active"));
      b.classList.add("active"); S.gran = b.dataset.val; renderChart(inbound());
    }));
    $("calls-heat-metric").addEventListener("change", e => { S.heat = e.target.value; renderHeat(inbound()); });
    $("calls-log-filter").addEventListener("change", e => { S.logFilter = e.target.value; S.logShown = LOG_PAGE; renderLog(); });
    let t = null;
    $("calls-search").addEventListener("input", e => { clearTimeout(t); t = setTimeout(() => { S.search = e.target.value; S.logShown = LOG_PAGE; renderLog(); }, 200); });
    $("calls-more").addEventListener("click", () => { S.logShown += LOG_PAGE; renderLog(); });
    $("calls-export").addEventListener("click", exportCsv);
  }

  window.CallsTab = {
    show() {
      if (!S.from) { setPreset(30); wire(); }
      if (!S.loaded) load(); else render();
    },
  };
})();
