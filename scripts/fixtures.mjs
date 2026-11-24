// Fake CallRail + Microsoft endpoints for local testing. Phone numbers are 555-01xx (fictional).

const TZ = { "Chicago": "America/Chicago", "Dallas": "America/Chicago", "Newark": "America/New_York" };
const LOCS = Object.keys(TZ);

export const TRACKERS = [
  { id: "TRK1", name: "GBP Chicago", type: "source", status: "active", source: { type: "google_my_business" } },
  { id: "TRK2", name: "GBP Dallas", type: "source", status: "active", source: { type: "google_my_business" } },
  { id: "TRK3", name: "GBP Newark", type: "source", status: "active", source: { type: "google_my_business" } },
  { id: "TRK4", name: "Google Ads call asset", type: "source", status: "active", source: { type: "google_ad_extension" } },
  { id: "TRK5", name: "Website - Google Paid", type: "source", status: "active", source: { type: "search", search_engine: "google", search_type: "paid" } },
  { id: "TRK6", name: "Website - Google Organic", type: "source", status: "active", source: { type: "search", search_engine: "google", search_type: "organic" } },
];

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296); }

function offsetFor(tz, d) {
  const s = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" }).formatToParts(d).find(p => p.type === "timeZoneName").value;
  return s === "GMT" ? "+00:00" : s.replace("GMT", "");
}

export function makeCalls(days = 400) {
  const r = rng(42);
  const pool = Array.from({ length: 160 }, (_, i) => `+1${["312", "214", "973", "773"][i % 4]}5550${String(100 + i).slice(-3)}`);
  const calls = [];
  const now = Date.now();
  for (let i = 0; i < days * 3; i++) {
    const loc = LOCS[Math.floor(r() * 3)];
    const tz = TZ[loc];
    const pick = r();
    let trk, gclid = null, medium = "organic", source = "Google My Business", campaign = null, keywords = null;
    if (pick < 0.45) trk = TRACKERS[LOCS.indexOf(loc)];
    else if (pick < 0.55) { trk = TRACKERS[LOCS.indexOf(loc)]; gclid = "Cj0K" + i; medium = "cpc"; campaign = "Maps - " + loc; }
    else if (pick < 0.8) { trk = TRACKERS[3]; gclid = "Cj0K" + i; medium = "cpc"; source = "Google Ads"; campaign = `Search - ${loc} warehouse`; keywords = ["warehouse near me", "cross dock " + loc.toLowerCase(), "transloading"][i % 3]; }
    else if (pick < 0.9) { trk = TRACKERS[4]; gclid = "Cj0K" + i; medium = "cpc"; source = "Google Paid"; campaign = "Search - brand"; keywords = "freitty"; }
    else { trk = TRACKERS[5]; source = "Google Organic"; }
    const t = new Date(now - r() * days * 86400000);
    // shift into business-ish hours in the location's zone
    const hourLocal = Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(t));
    t.setUTCHours(t.getUTCHours() + (hourLocal < 7 ? 9 : hourLocal > 19 ? -6 : 0));
    const answered = r() > 0.22;
    const off = offsetFor(tz, t);
    const local = new Date(t.getTime() + (Number(off.slice(0, 3)) * 60 + Math.sign(Number(off.slice(0, 3)) || 1) * Number(off.slice(4))) * 60000);
    const num = pool[Math.floor(Math.pow(r(), 1.6) * pool.length)];
    calls.push({
      id: "CAL" + i, start_time: local.toISOString().slice(0, 19) + ".000" + off, direction: "inbound",
      customer_phone_number: num, customer_name: r() > 0.5 ? ["ACME LOGISTICS", "J SMITH", "WIRELESS CALLER", "RIVERA TRUCKING"][i % 4] : "",
      customer_city: ["Chicago", "Dallas", "Newark", "Gary"][i % 4], customer_state: ["IL", "TX", "NJ", "IN"][i % 4],
      tracking_phone_number: "+1800555010" + (i % 6), business_phone_number: "+18005550199",
      answered, voicemail: !answered && r() > 0.5, duration: answered ? Math.round(20 + r() * 400) : Math.round(r() * 30),
      first_call: false, recording_player: answered ? "https://app.callrail.com/calls/CAL" + i + "/recording" : null,
      company_id: "COM" + LOCS.indexOf(loc), company_name: "FREITTY " + loc, company_time_zone: tz,
      tracker_id: trk.id, source, source_name: trk.name, medium, campaign, keywords, gclid,
      lead_status: null, value: null, tags: [], device_type: null, landing_page_url: null,
    });
  }
  calls.sort((a, b) => (new Date(a.start_time) - new Date(b.start_time)));
  const seen = new Set();
  for (const c of calls) { c.first_call = !seen.has(c.customer_phone_number); seen.add(c.customer_phone_number); }
  // a few callbacks
  for (const c of calls.filter(c => !c.answered).slice(0, 40)) {
    calls.push({ ...c, id: c.id + "OUT", direction: "outbound", answered: true, duration: 90, first_call: false,
      start_time: new Date(new Date(c.start_time).getTime() + 3600000).toISOString().replace("Z", "+00:00") });
  }
  return calls;
}

const ALL = makeCalls();

/** Handles a fetch to api.callrail.com; returns a Response, or null if not a CallRail URL. */
export function callrailMock(url, init) {
  const u = new URL(url);
  if (u.hostname !== "api.callrail.com") return null;
  const auth = (init && init.headers && (init.headers.Authorization || init.headers.authorization)) || "";
  if (!/^Token token="test-key"$/.test(auth)) return Response.json({ error: "HTTP Token: Access denied." }, { status: 401 });
  if (u.pathname === "/v3/a.json") return Response.json({ accounts: [{ id: "ACC123", name: "FREITTY" }] });
  if (u.pathname === "/v3/a/ACC123/trackers.json") return Response.json({ page: 1, per_page: 250, total_pages: 1, total_records: TRACKERS.length, trackers: TRACKERS });
  if (u.pathname === "/v3/a/ACC123/calls.json") {
    const from = u.searchParams.get("start_date"), to = u.searchParams.get("end_date");
    const per = Number(u.searchParams.get("per_page") || 100), off = Number(u.searchParams.get("offset") || 0);
    const rows = ALL.filter(c => c.start_time.slice(0, 10) >= from && c.start_time.slice(0, 10) <= to);
    const slice = rows.slice(off * per, off * per + per);
    const has = (off + 1) * per < rows.length;
    const next = new URL(u); next.searchParams.set("offset", String(off + 1));
    return Response.json({ per_page: per, has_next_page: has, next_page: has ? next.toString() : null, calls: slice });
  }
  return Response.json({ error: "not found" }, { status: 404 });
}
