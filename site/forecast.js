// Forecast tab: 8 simple models on complete months, rolling 1-step backtest,
// weights ∝ 1/MAE², ensemble for the next 3 months with an ~80% band.
(function () {
  "use strict";
  const G = window.GBP, C = window.Charts, esc = C.esc;
  const $ = id => document.getElementById(id);
  const H = 3, MIN_TRAIN = 6;
  const FC = { metric: "calls", sort: { col: "chg", asc: true } };

  // ---------- models: (y) -> [f1, f2, f3] | null ----------
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  function ses(y, alpha) { let l = y[0], sse = 0; for (let i = 1; i < y.length; i++) { sse += (y[i] - l) ** 2; l = alpha * y[i] + (1 - alpha) * l; } return { l, sse }; }
  function holt(y, a, b) {
    let l = y[0], t = y.length > 1 ? y[1] - y[0] : 0, sse = 0;
    for (let i = 1; i < y.length; i++) { const f = l + t; sse += (y[i] - f) ** 2; const nl = a * y[i] + (1 - a) * (l + t); t = b * (nl - l) + (1 - b) * t; l = nl; }
    return { l, t, sse };
  }
  const GRID = [0.1, 0.3, 0.5, 0.7, 0.9];
  const MODELS = [
    { key: "naive", name: "Наївна: як минулого місяця", f: y => Array(H).fill(y[y.length - 1]) },
    { key: "snaive", name: "Сезонна: як рік тому", f: y => (y.length >= 12 ? [1, 2, 3].map(h => y[y.length - 12 + h - 1]) : null) },
    { key: "mean3", name: "Середнє за 3 місяці", f: y => (y.length >= 3 ? Array(H).fill(mean(y.slice(-3))) : null) },
    { key: "mean6", name: "Середнє за 6 місяців", f: y => (y.length >= 6 ? Array(H).fill(mean(y.slice(-6))) : null) },
    { key: "drift", name: "Дрейф: середній приріст", f: y => { const n = y.length, d = (y[n - 1] - y[0]) / (n - 1); return [1, 2, 3].map(h => y[n - 1] + h * d); } },
    { key: "trend", name: "Лінійний тренд, 12 місяців", f: y => {
      const s = y.slice(-12), n = s.length; if (n < 4) return null;
      const xm = (n - 1) / 2, ym = mean(s); let num = 0, den = 0;
      s.forEach((v, i) => { num += (i - xm) * (v - ym); den += (i - xm) ** 2; });
      const b = den ? num / den : 0; return [1, 2, 3].map(h => ym + b * (n - 1 + h - xm));
    } },
    { key: "ses", name: "Експоненційне згладжування", f: y => { let best = null; for (const a of GRID) { const r = ses(y, a); if (!best || r.sse < best.sse) best = r; } return Array(H).fill(best.l); } },
    { key: "holt", name: "Holt: рівень і тренд", f: y => { if (y.length < 4) return null; let best = null; for (const a of GRID) for (const b of [0.1, 0.3, 0.5]) { const r = holt(y, a, b); if (!best || r.sse < best.sse) best = r; } return [1, 2, 3].map(h => best.l + h * best.t); } },
  ];
  const clamp = f => (f ? f.map(v => Math.max(0, v)) : null);

  function run(y) {
    const n = y.length;
    if (n < 4) return { thin: true, n };
    // backtest origins: normally from month 6, earlier for short histories so there are >= 2-3 checks
    const tStart = Math.max(3, Math.min(MIN_TRAIN, n - 3));
    const minBack = Math.max(1, Math.min(3, n - tStart));
    const res = MODELS.map(m => {
      const errs = [], apes = [], preds = {};
      for (let t = tStart; t < n; t++) {
        const f = clamp(m.f(y.slice(0, t)));
        if (!f) continue;
        preds[t] = f[0];
        errs.push(Math.abs(f[0] - y[t]));
        if (y[t] > 0) apes.push(Math.abs(f[0] - y[t]) / y[t]);
      }
      const mae = errs.length ? mean(errs) : null;
      return { ...m, fc: clamp(m.f(y)), mae, mape: apes.length ? mean(apes) : null, nBack: errs.length, preds };
    });
    const usable = res.filter(r => r.fc && r.mae != null && r.nBack >= minBack);
    if (!usable.length) return { thin: true, n };
    const ws = usable.map(r => 1 / Math.max(r.mae, 0.5) ** 2), wsum = ws.reduce((a, b) => a + b, 0);
    usable.forEach((r, i) => { r.w = ws[i] / wsum; });
    res.forEach(r => { if (r.w == null) r.w = 0; });
    const ens = [0, 1, 2].map(h => usable.reduce((s, r) => s + r.w * r.fc[h], 0));
    // ensemble backtest with the final weights
    const eErr = [], eApe = [];
    for (let t = 0; t < n; t++) {
      const ok = usable.filter(r => r.preds[t] != null); if (ok.length !== usable.length || !ok.length) continue;
      const p = ok.reduce((s, r) => s + r.w * r.preds[t], 0);
      eErr.push((p - y[t]) ** 2); if (y[t] > 0) eApe.push(Math.abs(p - y[t]) / y[t]);
    }
    const rmse = eErr.length ? Math.sqrt(mean(eErr)) : null, mape = eApe.length ? mean(eApe) : null;
    const last = y[n - 1], chg = last > 0 ? (ens[2] - last) / last : null;
    const dir = chg == null ? 0 : chg > 0.05 ? 1 : chg < -0.05 ? -1 : 0;
    const agree = usable.filter(r => { const c = last > 0 ? (r.fc[2] - last) / last : 0; const d = c > 0.05 ? 1 : c < -0.05 ? -1 : 0; return d === dir; }).length;
    return { n, res, usable, ens, rmse, mape, last, chg, dir, agree,
      band: rmse != null ? ens.map((v, h) => [Math.max(0, v - 1.28 * rmse * Math.sqrt(h + 1)), v + 1.28 * rmse * Math.sqrt(h + 1)]) : null };
  }

  // ---------- series ----------
  function completeMonths() {
    const D = G.D, ms = G.months(0, D.n - 1);
    return ms.filter(m => !m.partial && m.days === m.dim);         // full calendar months only
  }
  // Comparable base: hubs active for at least 12 full months; the network series starts with the
  // first full month in which all of them were already active (so openings never read as growth).
  function comparableBase() {
    const ms = completeMonths(); if (!ms.length) return { locs: [], from: 0 };
    const cutoff = ms[ms.length - 1].a - 365;
    const locs = G.D.locs.filter(l => G.D.first[l.id] <= cutoff);
    const lastFirst = Math.max(...locs.map(l => G.D.first[l.id]));
    const from = ms.findIndex(m => m.a >= lastFirst);
    return { locs, from: Math.max(0, from) };
  }
  function seriesFor(base, keys) {
    const ms = completeMonths().slice(base.from);
    return { ms, y: ms.map(m => G.sumAll(keys, m.a, m.b, base.locs)) };
  }
  function hubSeries(loc, keys) {
    const ms = completeMonths().filter(m => G.D.first[loc.id] <= m.a + 3);   // from the first full month with data
    return { ms, y: ms.map(m => G.sum(loc.id, keys, m.a, m.b)) };
  }
  function currentPace(locs, keys) {
    const D = G.D, all = G.months(0, D.n - 1), cur = all[all.length - 1];
    if (!cur || !cur.partial || !cur.days) return null;
    return { value: (G.sumAll(keys, cur.a, cur.b, locs) / cur.days) * cur.dim, m: cur };
  }

  const confLabel = mape => (mape == null ? ["—", ""] : mape < 0.15 ? ["Висока", "ok"] : mape < 0.3 ? ["Середня", "warn"] : ["Низька", "bad"]);
  const trendBadge = r => (r.dir > 0 ? `<span class="badge ok"><i class="ph ph-trend-up" aria-hidden="true"></i>Зростання</span>` : r.dir < 0 ? `<span class="badge bad"><i class="ph ph-trend-down" aria-hidden="true"></i>Спад</span>` : `<span class="badge"><i class="ph ph-minus" aria-hidden="true"></i>Стабільно</span>`);
  const mlabel = m => `${G.MON[m.m]} ${String(m.y).slice(2)}`;
  const futureMonths = last => [1, 2, 3].map(h => { const y = last.y + Math.floor((last.m + h) / 12), m = (last.m + h) % 12; return { y, m }; });

  function render() {
    const D = G.D, keys = G.METRIC_SETS[FC.metric], fmt = G.fmtInt;
    // controls
    const sel = $("fc-scope");
    if (!sel.options.length) {
      sel.innerHTML = `<option value="network">Мережа (хаби, що працюють понад рік)</option>` + D.locs.map(l => `<option value="${esc(l.name)}">${esc(l.name)}</option>`).join("");
      sel.addEventListener("change", () => { location.hash = sel.value === "network" ? "#forecast" : `#forecast/${encodeURIComponent(sel.value)}`; });
      document.querySelectorAll("#fc-metric button").forEach(b => b.addEventListener("click", () => { FC.metric = b.dataset.m; G.store.set("gbp-fc-metric", FC.metric); render(); }));
      const saved = G.store.get("gbp-fc-metric"); if (saved && G.METRIC_SETS[saved]) FC.metric = saved;
      return render();
    }
    document.querySelectorAll("#fc-metric button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.m === FC.metric)));
    const scope = G.UI.fcScope && G.UI.fcScope !== "network" && D.byName[G.UI.fcScope] ? G.UI.fcScope : "network";
    sel.value = scope;
    const base = comparableBase();
    const locs = scope === "network" ? base.locs : [D.byName[scope]];
    const { ms, y } = scope === "network" ? seriesFor(base, keys) : hubSeries(locs[0], keys);
    const R = run(y), pace = currentPace(locs, keys);
    const label = G.METRIC_LABEL[FC.metric];
    $("page-title").textContent = `Прогноз: ${scope === "network" ? "мережа" : scope}`;

    if (R.thin) {
      G.renderKpis($("fc-kpis"), []);
      $("fc-chart-note").textContent = "";
      $("fc-chart").innerHTML = G.empty(`Для прогнозу потрібно щонайменше чотири повні місяці історії, а є ${R.n}.`, "ph-hourglass");
      $("fc-models").innerHTML = ""; $("fc-legend").innerHTML = "";
    } else {
      const fm = futureMonths(ms[ms.length - 1]);
      const [cl, cc] = confLabel(R.mape);
      G.renderKpis($("fc-kpis"), [
        { label: `Останній повний місяць · ${G.MON_FULL[ms[ms.length - 1].m]}`, icon: "ph-calendar-blank", value: fmt(R.last) },
        { label: `Прогноз · ${G.MON_FULL[fm[0].m]}`, icon: "ph-chart-line-up", value: fmt(R.ens[0]), delta: R.last > 0 ? `<span class="${R.ens[0] >= R.last ? "up" : "down"}">${G.fmtDelta((R.ens[0] - R.last) / R.last)}</span><span>до останнього місяця</span>` : "" },
        { label: `Прогноз · ${G.MON_FULL[fm[2].m]}`, icon: "ph-flag", value: fmt(R.ens[2]), delta: R.chg != null ? `<span class="${R.chg >= 0 ? "up" : "down"}">${G.fmtDelta(R.chg)}</span><span>${R.agree} з ${R.usable.length} моделей згодні</span>` : "" },
        { label: pace ? `Поточний місяць, темп · ${pace.m.days} з ${pace.m.dim} дн.` : "Поточний місяць", icon: "ph-speedometer", value: pace ? fmt(pace.value) : "—", delta: pace && R.ens[0] ? `<span>${pace.value >= R.ens[0] ? "вище" : "нижче"} прогнозу на ${G.fmtDelta(Math.abs(pace.value - R.ens[0]) / R.ens[0]).replace(/^[+−]/, "")}</span>` : "" },
        { label: "Впевненість", icon: "ph-gauge", value: `<span class="badge ${cc}" style="font-size:14px;line-height:20px">${cl}</span>`, delta: R.mape != null ? `<span>середня похибка на історії ${Math.round(R.mape * 100)}%</span>` : "" },
      ]);
      const labels = ms.map(mlabel).concat(fm.map(m => `${G.MON[m.m]} ${String(m.y).slice(2)}`));
      const n = ms.length;
      const fact = y.concat([null, null, null]);
      const fc = Array(n - 1).fill(null).concat([R.last, ...R.ens]);
      const band = R.band ? { lo: Array(n - 1).fill(null).concat([R.last, ...R.band.map(b => b[0])]), hi: Array(n - 1).fill(null).concat([R.last, ...R.band.map(b => b[1])]), color: "--s1" } : null;
      const series = [{ name: "Факт", color: "--s1", values: fact }, { name: "Прогноз", color: "--s1", values: fc, dash: true }];
      $("fc-legend").innerHTML = `<span><span class="key-line" style="background:${C.color("--s1")}"></span>Факт</span><span><span class="key-dash" style="border-color:${C.color("--s1")}"></span>Прогноз</span><span><span class="swatch" style="background:${C.color("--s1")};opacity:.2"></span>Діапазон ~80%</span>`;
      C.line($("fc-chart"), { labels, series, band, splitIndex: n - 1, fmt, height: 300, markLast: false,
        tipTitle: i => (i < n ? `${G.MON_FULL[ms[i].m]} ${ms[i].y}` : `${G.MON_FULL[fm[i - n].m]} ${fm[i - n].y} · прогноз`), ariaLabel: `${label}: історія і прогноз` });
      $("fc-chart-note").textContent = scope === "network"
        ? `${label}, повні місяці. Мережева лінія: ${base.locs.length} хабів, що працюють понад рік (${base.locs.map(l => l.name.split(",")[0]).join(", ")}), від ${G.MON_FULL[ms[0].m]} ${ms[0].y}. Новіші хаби (${D.locs.length - base.locs.length}) не входять, щоб відкриття не виглядало як зростання; їх прогноз є в таблиці нижче.`
        : `${label}, повні місяці від першого місяця з даними.`;
      // models table
      const rows = R.res.slice().sort((a, b) => b.w - a.w);
      $("fc-models").innerHTML = `<thead><tr><th>Модель</th><th class="num">${G.MON[fm[0].m]}</th><th class="num">${G.MON[fm[1].m]}</th><th class="num">${G.MON[fm[2].m]}</th><th>Напрям</th><th class="num">Похибка бектесту</th><th class="num">Похибка, %</th><th class="num">Вага</th></tr></thead><tbody>` +
        rows.map(r => {
          if (!r.fc) return `<tr><td>${esc(r.name)}</td><td colspan="7" class="muted caption-5">Замало історії для цієї моделі.</td></tr>`;
          const c = R.last > 0 ? (r.fc[2] - R.last) / R.last : 0, d = c > 0.05 ? 1 : c < -0.05 ? -1 : 0;
          return `<tr><td class="body-5">${esc(r.name)}</td>${r.fc.map(v => `<td class="num">${fmt(v)}</td>`).join("")}<td>${trendBadge({ dir: d })}</td><td class="num">${r.mae != null ? "±" + fmt(r.mae) : "—"}</td><td class="num">${r.mape != null ? Math.round(r.mape * 100) + "%" : "—"}</td>
            <td class="num"><span class="inline-bar"><span class="bar" style="width:${Math.max(2, 64 * r.w)}px"></span>${Math.round(r.w * 100)}%</span></td></tr>`;
        }).join("") + `<tr><td class="body-4">Зважений прогноз</td>${R.ens.map(v => `<td class="num body-4">${fmt(v)}</td>`).join("")}<td>${trendBadge(R)}</td><td class="num">${R.rmse != null ? "±" + fmt(R.rmse) : "—"}</td><td class="num">${R.mape != null ? Math.round(R.mape * 100) + "%" : "—"}</td><td class="num">100%</td></tr></tbody>`;
    }

    // per-hub table (selected metric)
    const hubRows = D.locs.map(l => {
      const s = hubSeries(l, keys), r = run(s.y), p = currentPace([l], keys);
      if (r.thin) return { hub: l.name, last: s.y[s.y.length - 1] ?? null, f1: null, f3: null, chg: null, dir: 0, agree: null, n: 0, pace: p ? p.value : null, mape: null, thin: true };
      return { hub: l.name, last: r.last, f1: r.ens[0], f3: r.ens[2], chg: r.chg, dir: r.dir, agree: r.agree, n: r.usable.length, pace: p ? p.value : null, mape: r.mape };
    });
    const st = FC.sort, list = G.sortRows(hubRows, st), tbl = $("fc-hubs");
    tbl.innerHTML = `<thead><tr>${G.th("Хаб", "hub", st, { type: "text" })}${G.th("Останній повний місяць", "last", st, { num: true })}${G.th("Наступний місяць", "f1", st, { num: true })}${G.th("Місяць 3", "f3", st, { num: true })}${G.th("Зміна до місяця 3", "chg", st, { num: true })}${G.th("Тренд", "dir", st)}${G.th("Узгоджених моделей", "agree", st, { num: true })}${G.th("Поточний місяць, темп", "pace", st, { num: true })}${G.th("Впевненість", "mape", st)}</tr></thead><tbody>` +
      list.map(r => { const [cl, cc] = confLabel(r.mape); return `<tr class="clickable" tabindex="0" data-hub="${esc(r.hub)}"><td class="body-5">${esc(r.hub)}</td><td class="num">${fmt(r.last)}</td><td class="num">${fmt(r.f1)}</td><td class="num">${fmt(r.f3)}</td>
        <td class="num ${r.chg == null ? "zero" : r.chg > 0.05 ? "pos" : r.chg < -0.05 ? "neg" : "zero"}">${G.fmtDelta(r.chg)}</td><td>${r.thin ? `<span class="badge outline">Мало історії</span>` : trendBadge(r)}</td><td class="num">${r.agree != null ? `${r.agree} з ${r.n}` : "—"}</td><td class="num">${fmt(r.pace)}</td><td>${r.mape != null ? `<span class="badge ${cc}">${cl}</span>` : "—"}</td></tr>`; }).join("") + "</tbody>";
    G.sortable(tbl, st, render);
    tbl.querySelectorAll("tr.clickable").forEach(tr => { const go = () => { location.hash = `#forecast/${encodeURIComponent(tr.dataset.hub)}`; scrollTo({ top: 0, behavior: "smooth" }); }; tr.addEventListener("click", go); tr.addEventListener("keydown", e => { if (e.key === "Enter") go(); }); });
  }

  window.Forecast = { render, run, MODELS };
})();
