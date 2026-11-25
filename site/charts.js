// Minimal SVG/HTML chart kit, built to the data-viz mark specs:
// bars <= 24px with a 4px rounded data end (square at the baseline), 2px surface gaps,
// 2px lines, >= 8px markers with a 2px surface ring, hairline grid, hover tooltip on every mark.
(function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const color = c => (c && c.startsWith("--") ? css(c) : c);

  // ---------- tooltip ----------
  let tipEl = null;
  function tip() {
    if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "tip"; tipEl.setAttribute("role", "status"); document.body.appendChild(tipEl); }
    return tipEl;
  }
  function showTip(evt, html) {
    const t = tip(); t.innerHTML = html; t.classList.add("on");
    const pad = 16, w = t.offsetWidth, h = t.offsetHeight;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    if (x + w > innerWidth - 8) x = evt.clientX - w - pad;
    if (y + h > innerHeight - 8) y = evt.clientY - h - pad;
    t.style.left = Math.max(8, x) + "px"; t.style.top = Math.max(8, y) + "px";
  }
  function hideTip() { if (tipEl) tipEl.classList.remove("on"); }
  function tipRows(title, rows) {
    return `<div class="tt">${esc(title)}</div>` + rows.map(r =>
      `<div class="tr"><span class="tk">${r.color ? `<span class="swatch" style="background:${color(r.color)}"></span>` : ""}${esc(r.label)}</span><b>${esc(r.value)}</b></div>`).join("");
  }

  // ---------- scales ----------
  function niceMax(v) {
    if (!(v > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(v))), n = v / p;
    const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return step * p;
  }
  // clean steps: 5000 -> 0/1000/…, 2000 -> 0/500/…, 2500 -> 0/500/…
  function ticks(max) {
    const p = Math.pow(10, Math.floor(Math.log10(max))), n = Math.round((max / p) * 10) / 10;
    const count = n === 2 ? 4 : n === 1 || n === 10 ? 5 : 5;
    const out = []; for (let i = 0; i <= count; i++) out.push((max / count) * i); return out;
  }
  function compact(n) {
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace(/\.0$/, "") + "M";
    if (a >= 1e4) return (n / 1e3).toFixed(0) + "K";
    return Math.round(n).toLocaleString("uk-UA");
  }
  function el(tag, attrs = {}, parent) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, v);
    if (parent) parent.appendChild(e);
    return e;
  }
  // bar path: rounded data end (top for columns), square baseline
  function colPath(x, y, w, h, r) {
    r = Math.min(r, h, w / 2);
    if (h <= 0) return "";
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  function mount(container, height) {
    container.innerHTML = "";
    container.classList.add("chart");
    const w = Math.max(240, container.clientWidth || 600);
    const svg = el("svg", { viewBox: `0 0 ${w} ${height}`, height, role: "img" }, container);
    return { svg, w, h: height };
  }

  // Re-render on width change (one observer per container)
  function responsive(container, draw) {
    draw();
    if (container._ro) container._ro.disconnect();
    let last = container.clientWidth, t = null;
    container._ro = new ResizeObserver(() => {
      if (Math.abs(container.clientWidth - last) < 8) return;
      last = container.clientWidth; clearTimeout(t); t = setTimeout(draw, 120);
    });
    container._ro.observe(container);
  }

  // ---------- columns (stacked) ----------
  // opts: {categories, series:[{name,color,values}], height, fmt, partial:{index,label,totals:[...]}, ariaLabel, onClick(i)}
  function columns(container, opts) {
    responsive(container, () => {
      const H = opts.height || 260, fmt = opts.fmt || compact;
      const { svg, w } = mount(container, H);
      svg.setAttribute("aria-label", opts.ariaLabel || "");
      const m = { t: 8, r: 8, b: 28, l: 44 };
      const n = opts.categories.length;
      const totals = opts.categories.map((_, i) => opts.series.reduce((s, se) => s + (se.values[i] || 0), 0));
      const paceTot = opts.partial ? opts.partial.total : 0;
      const max = niceMax(Math.max(1, ...totals, paceTot));
      const iw = w - m.l - m.r, ih = H - m.t - m.b;
      const y = v => m.t + ih - (v / max) * ih;
      ticks(max).forEach(tv => {
        el("line", { x1: m.l, x2: w - m.r, y1: y(tv), y2: y(tv), class: tv === 0 ? "baseline" : "gridline" }, svg);
        el("text", { x: m.l - 8, y: y(tv) + 4, "text-anchor": "end" }, svg).textContent = compact(tv);
      });
      const band = iw / n, bw = Math.min(24, band * 0.6);
      const labelEvery = Math.ceil(n / Math.max(1, Math.floor(iw / 56)));
      opts.categories.forEach((cat, i) => {
        const cx = m.l + band * i + band / 2, x = cx - bw / 2;
        let acc = 0;
        const visible = opts.series.map((se, si) => ({ se, si, v: se.values[i] || 0 })).filter(o => o.v > 0);
        visible.forEach((o, k) => {
          const y0 = y(acc), y1 = y(acc + o.v);
          const gap = k > 0 ? 2 : 0;                       // 2px surface gap between stacked segments
          const top = k === visible.length - 1;
          const hgt = Math.max(0, y0 - y1 - gap);
          if (top) el("path", { d: colPath(x, y1, bw, hgt, 4), fill: color(o.se.color) }, svg);
          else el("rect", { x, y: y1, width: bw, height: hgt, fill: color(o.se.color) }, svg);
          acc += o.v;
        });
        if (opts.partial && opts.partial.index === i && paceTot > totals[i]) {
          el("path", { d: colPath(x, y(paceTot), bw, y(totals[i]) - y(paceTot) - 2, 4), fill: "none", stroke: css("--muted"), "stroke-width": 1.5, "stroke-dasharray": "3 3" }, svg);
        }
        if (i % labelEvery === 0 || i === n - 1) el("text", { x: cx, y: H - 8, "text-anchor": "middle" }, svg).textContent = cat;
        const hit = el("rect", { x: m.l + band * i, y: m.t, width: band, height: ih, fill: "transparent", style: opts.onClick ? "cursor:pointer" : null }, svg);
        hit.addEventListener("mousemove", e => {
          const rows = opts.series.map(se => ({ label: se.name, value: fmt(se.values[i] || 0), color: se.color })).reverse();
          if (opts.series.length > 1) rows.push({ label: "Разом", value: fmt(totals[i]) });
          if (opts.partial && opts.partial.index === i) rows.push({ label: opts.partial.label || "Темп на повний місяць", value: fmt(paceTot) });
          showTip(e, tipRows(opts.tipTitle ? opts.tipTitle(i) : cat, rows));
        });
        hit.addEventListener("mouseleave", hideTip);
        if (opts.onClick) hit.addEventListener("click", () => opts.onClick(i));
      });
    });
  }

  // ---------- line (with optional forecast segment + band) ----------
  // opts: {labels, series:[{name,color,values,dash:boolean}], band:{lo,hi,color}, height, fmt, markLast, splitIndex}
  function line(container, opts) {
    responsive(container, () => {
      const H = opts.height || 260, fmt = opts.fmt || compact;
      const { svg, w } = mount(container, H);
      svg.setAttribute("aria-label", opts.ariaLabel || "");
      const m = { t: 12, r: 16, b: 28, l: 44 };
      const n = opts.labels.length;
      const all = opts.series.flatMap(s => s.values).concat(opts.band ? opts.band.hi : []).filter(v => v != null && Number.isFinite(v));
      const max = niceMax(Math.max(1, ...all));
      const iw = w - m.l - m.r, ih = H - m.t - m.b;
      const x = i => m.l + (n <= 1 ? iw / 2 : (iw * i) / (n - 1));
      const y = v => m.t + ih - (v / max) * ih;
      ticks(max).forEach(tv => {
        el("line", { x1: m.l, x2: w - m.r, y1: y(tv), y2: y(tv), class: tv === 0 ? "baseline" : "gridline" }, svg);
        el("text", { x: m.l - 8, y: y(tv) + 4, "text-anchor": "end" }, svg).textContent = compact(tv);
      });
      if (opts.splitIndex != null) {
        const sx = x(opts.splitIndex);
        el("rect", { x: sx, y: m.t, width: w - m.r - sx, height: ih, fill: css("--surface-2"), opacity: 0.6 }, svg);
      }
      const labelEvery = Math.ceil(n / Math.max(1, Math.floor(iw / 64)));
      opts.labels.forEach((l, i) => { if (i % labelEvery === 0 || i === n - 1) el("text", { x: x(i), y: H - 8, "text-anchor": "middle" }, svg).textContent = l; });
      if (opts.band) {
        const idx = opts.band.lo.map((v, i) => (v != null ? i : null)).filter(i => i != null);
        if (idx.length) {
          const d = idx.map((i, k) => `${k ? "L" : "M"}${x(i)},${y(opts.band.hi[i])}`).join("") +
            idx.slice().reverse().map(i => `L${x(i)},${y(opts.band.lo[i])}`).join("") + "Z";
          el("path", { d, fill: color(opts.band.color || "--s1"), opacity: 0.12 }, svg);
        }
      }
      opts.series.forEach(se => {
        let d = "", pen = false;
        se.values.forEach((v, i) => {
          if (v == null || !Number.isFinite(v)) { pen = false; return; }
          d += `${pen ? "L" : "M"}${x(i)},${y(v)}`; pen = true;
        });
        el("path", { d, fill: "none", stroke: color(se.color), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round", "stroke-dasharray": se.dash ? "6 4" : null }, svg);
        const lastI = se.values.map((v, i) => (v != null ? i : -1)).filter(i => i >= 0).pop();
        if (opts.markLast !== false && lastI != null) el("circle", { cx: x(lastI), cy: y(se.values[lastI]), r: 4, fill: color(se.color), stroke: css("--surface"), "stroke-width": 2 }, svg);
      });
      // crosshair
      const cross = el("line", { y1: m.t, y2: m.t + ih, stroke: css("--axis"), "stroke-width": 1, visibility: "hidden" }, svg);
      const dots = opts.series.map(se => el("circle", { r: 4, fill: color(se.color), stroke: css("--surface"), "stroke-width": 2, visibility: "hidden" }, svg));
      const hit = el("rect", { x: m.l, y: m.t, width: iw, height: ih, fill: "transparent" }, svg);
      hit.addEventListener("mousemove", e => {
        const r = svg.getBoundingClientRect(), px = ((e.clientX - r.left) / r.width) * w;
        const i = Math.max(0, Math.min(n - 1, Math.round(((px - m.l) / iw) * (n - 1))));
        cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.setAttribute("visibility", "visible");
        const rows = [];
        opts.series.forEach((se, k) => {
          const v = se.values[i];
          if (v == null || !Number.isFinite(v)) { dots[k].setAttribute("visibility", "hidden"); return; }
          dots[k].setAttribute("cx", x(i)); dots[k].setAttribute("cy", y(v)); dots[k].setAttribute("visibility", "visible");
          rows.push({ label: se.name, value: fmt(v), color: se.color });
        });
        if (opts.band && opts.band.lo[i] != null) rows.push({ label: "Діапазон", value: `${fmt(opts.band.lo[i])} – ${fmt(opts.band.hi[i])}` });
        showTip(e, tipRows(opts.tipTitle ? opts.tipTitle(i) : opts.labels[i], rows));
      });
      hit.addEventListener("mouseleave", () => { hideTip(); cross.setAttribute("visibility", "hidden"); dots.forEach(d => d.setAttribute("visibility", "hidden")); });
    });
  }

  // ---------- scatter / bubble ----------
  // opts: {points:[{x,y,size,label,key}], xFmt, yFmt, xLabel, yLabel, xMin, xMax, refX, refLabel, onClick, tip(p)}
  function scatter(container, opts) {
    responsive(container, () => {
      const H = opts.height || 320;
      const { svg, w } = mount(container, H);
      svg.setAttribute("aria-label", opts.ariaLabel || "");
      const m = { t: 16, r: 16, b: 44, l: 52 };
      const iw = w - m.l - m.r, ih = H - m.t - m.b;
      const pts = opts.points.filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
      const xMin = opts.xMin ?? Math.min(...pts.map(p => p.x)), xMax = opts.xMax ?? Math.max(...pts.map(p => p.x));
      const yMax = niceMax(Math.max(...pts.map(p => p.y), 0.01));
      const sx = v => m.l + ((v - xMin) / (xMax - xMin || 1)) * iw;
      const sy = v => m.t + ih - (v / yMax) * ih;
      const sMax = Math.max(...pts.map(p => p.size || 1), 1);
      const rad = s => 4 + 12 * Math.sqrt((s || 0) / sMax);
      ticks(yMax).forEach(tv => {
        el("line", { x1: m.l, x2: w - m.r, y1: sy(tv), y2: sy(tv), class: tv === 0 ? "baseline" : "gridline" }, svg);
        el("text", { x: m.l - 8, y: sy(tv) + 4, "text-anchor": "end" }, svg).textContent = opts.yFmt(tv);
      });
      for (let k = 0; k <= 5; k++) {
        const v = xMin + ((xMax - xMin) * k) / 5;
        el("text", { x: sx(v), y: m.t + ih + 20, "text-anchor": "middle" }, svg).textContent = opts.xFmt(v);
      }
      el("text", { x: m.l + iw / 2, y: H - 4, "text-anchor": "middle" }, svg).textContent = opts.xLabel || "";
      el("text", { x: m.l, y: m.t - 4 }, svg).textContent = "";
      if (opts.refX != null && opts.refX > xMin && opts.refX < xMax) {
        el("line", { x1: sx(opts.refX), x2: sx(opts.refX), y1: m.t, y2: m.t + ih, stroke: css("--axis"), "stroke-width": 1, "stroke-dasharray": "4 4" }, svg);
        el("text", { x: sx(opts.refX) - 4, y: m.t + 12, "text-anchor": "end" }, svg).textContent = opts.refLabel || "";
      }
      pts.slice().sort((a, b) => (b.size || 0) - (a.size || 0)).forEach(p => {
        const c = el("circle", { cx: sx(p.x), cy: sy(p.y), r: rad(p.size), fill: color(p.color || "--s1"), "fill-opacity": 0.85, stroke: css("--surface"), "stroke-width": 2, style: opts.onClick ? "cursor:pointer" : null }, svg);
        c.addEventListener("mousemove", e => showTip(e, opts.tip(p)));
        c.addEventListener("mouseleave", hideTip);
        if (opts.onClick) c.addEventListener("click", () => opts.onClick(p));
      });
      // selective direct labels; skip any that would collide with one already placed
      const placed = [];
      (opts.labelKeys || []).forEach(key => {
        const p = pts.find(q => q.key === key); if (!p) return;
        const wTxt = p.label.length * 6.5, cx = sx(p.x), cy = sy(p.y), r = rad(p.size);
        const left = cx + r + 4 + wTxt > w - m.r;
        const x0 = left ? cx - r - 4 - wTxt : cx + r + 4, y0 = cy - 8;
        if (placed.some(b => x0 < b.x + b.w + 4 && x0 + wTxt + 4 > b.x && y0 < b.y + 16 && y0 + 16 > b.y)) return;
        placed.push({ x: x0, y: y0, w: wTxt });
        el("text", { x: left ? cx - r - 4 : cx + r + 4, y: cy + 4, "text-anchor": left ? "end" : "start", style: "fill:var(--text-2)" }, svg).textContent = p.label;
      });
    });
  }

  // ---------- horizontal bars (HTML) ----------
  // opts: {rows:[{label,value,key,color,valueText,tip}], fmt, onClick, max}
  function hbars(container, opts) {
    const fmt = opts.fmt || compact;
    const max = opts.max || Math.max(1, ...opts.rows.map(r => r.value || 0));
    container.className = "hbars";
    container.innerHTML = opts.rows.map((r, i) => `
      <div class="row${opts.onClick ? " clickable" : ""}" data-i="${i}">
        <div class="lab" title="${esc(r.label)}">${esc(r.label)}</div>
        <div class="track"><div class="fill" style="width:${Math.max(0.4, (100 * (r.value || 0)) / max)}%;background:${color(r.color || "--s1")}"></div><span class="val">${esc(r.valueText ?? fmt(r.value || 0))}</span></div>
      </div>`).join("");
    container.querySelectorAll(".row").forEach(rowEl => {
      const r = opts.rows[+rowEl.dataset.i];
      [rowEl.querySelector(".lab"), rowEl.querySelector(".track")].forEach(node => {
        node.addEventListener("mousemove", e => showTip(e, r.tip || tipRows(r.label, [{ label: opts.valueLabel || "Значення", value: r.valueText ?? fmt(r.value || 0) }])));
        node.addEventListener("mouseleave", hideTip);
        if (opts.onClick) node.addEventListener("click", () => { hideTip(); opts.onClick(r); });
      });
    });
  }

  // ---------- segmented rows (100% stacked, thin) ----------
  // opts: {series:[{name,color}], rows:[{label,key,parts:[v...],right}], onClick}
  function segRows(container, opts) {
    container.className = "seg-row";
    container.innerHTML = opts.rows.map((r, i) => {
      const tot = r.parts.reduce((a, b) => a + b, 0) || 1;
      return `<div class="row${opts.onClick ? " clickable" : ""}" data-i="${i}">
        <div class="lab">${esc(r.label)}</div>
        <div class="segbar">${r.parts.map((v, k) => v > 0 ? `<div data-k="${k}" style="flex:${v / tot};background:${color(opts.series[k].color)}"></div>` : "").join("")}</div>
        <div class="val">${esc(r.right ?? "")}</div></div>`;
    }).join("");
    container.querySelectorAll(".row").forEach(rowEl => {
      const r = opts.rows[+rowEl.dataset.i], tot = r.parts.reduce((a, b) => a + b, 0) || 1;
      const html = tipRows(r.label, opts.series.map((s, k) => ({ label: s.name, value: `${Math.round((100 * r.parts[k]) / tot)}% · ${compact(r.parts[k])}`, color: s.color })));
      rowEl.querySelectorAll(".lab, .segbar").forEach(node => {
        node.addEventListener("mousemove", e => showTip(e, html));
        node.addEventListener("mouseleave", hideTip);
        if (opts.onClick) node.addEventListener("click", () => { hideTip(); opts.onClick(r); });
      });
    });
  }

  // ---------- one tall segmented bar ----------
  function segmented(container, parts, opts = {}) {
    const tot = parts.reduce((a, p) => a + p.value, 0) || 1;
    const lum = hex => { const h = color(hex).replace("#", ""); const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
    container.innerHTML = `<div class="legend">${parts.map(p => `<span><span class="swatch" style="background:${color(p.color)}"></span>${esc(p.name)}</span>`).join("")}</div>
      <div class="segbar tall">${parts.map((p, k) => p.value > 0 ? `<div data-k="${k}" style="flex:${p.value / tot};background:${color(p.color)};color:${lum(p.color) > 0.6 ? "#0b0b0b" : "#fff"}">${(100 * p.value) / tot >= 9 ? Math.round((100 * p.value) / tot) + "%" : ""}</div>` : "").join("")}</div>`;
    container.querySelectorAll(".segbar > div").forEach(d => {
      const p = parts[+d.dataset.k];
      d.addEventListener("mousemove", e => showTip(e, tipRows(p.name, [{ label: opts.valueLabel || "Значення", value: compact(p.value) }, { label: "Частка", value: Math.round((100 * p.value) / tot) + "%" }])));
      d.addEventListener("mouseleave", hideTip);
    });
  }

  // ---------- sparkline ----------
  function spark(container, values) {
    const H = 32;
    responsive(container, () => {
      const { svg, w } = mount(container, H);
      const vals = values.filter(v => v != null);
      if (vals.length < 2) return;
      const max = Math.max(...vals, 1), min = Math.min(...vals, 0);
      const x = i => 2 + ((w - 8) * i) / (values.length - 1), y = v => 2 + (H - 6) - ((v - min) / (max - min || 1)) * (H - 6);
      let d = ""; values.forEach((v, i) => { if (v != null) d += `${d ? "L" : "M"}${x(i)},${y(v)}`; });
      el("path", { d, fill: "none", stroke: css("--neutral-series"), "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }, svg);
      const li = values.length - 1;
      el("circle", { cx: x(li), cy: y(values[li]), r: 4, fill: css("--accent"), stroke: css("--surface"), "stroke-width": 2 }, svg);
    });
  }

  window.Charts = { columns, line, scatter, hbars, segRows, segmented, spark, showTip, hideTip, tipRows, compact, esc, color };
})();
