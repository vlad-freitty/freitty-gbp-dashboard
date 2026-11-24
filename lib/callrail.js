// CallRail API v3 → normalized call rows for the Calls tab.
// Docs: https://apidocs.callrail.com/  (calls are kept by CallRail for 25 months)

const BASE = "https://api.callrail.com/v3";
const MAX_PAGES = 60; // 60 × 250 = 15,000 calls per request; beyond that the response says "truncated"

const CALL_FIELDS = [
  "company_id", "company_name", "company_time_zone", "tracker_id",
  "source", "source_name", "medium", "campaign", "keywords", "gclid",
  "first_call", "lead_status", "value", "tags", "device_type", "landing_page_url",
  "utm_source", "utm_medium", "utm_campaign", "utm_term",
].join(",");

// ---------------------------------------------------------------------------
// Channel rules. Checked top to bottom, first match wins.
// `t` = tracker source type from CallRail ("google_my_business", "google_ad_extension",
// "mobile_ad_extension", "search", ...), `txt` = source + tracker name + campaign + medium
// (lower case), `paid` = the call carries a Google click id or a paid medium.
// Adjust here once the real tracker names are visible in the "Sources" table.
// ---------------------------------------------------------------------------
export const CHANNEL_RULES = [
  { channel: "Google Maps Ads",       test: c => c.isGbp && (c.paid || /\b(ads?|ppc|paid|promoted)\b/.test(c.txt)) },
  { channel: "Google Maps (organic)", test: c => c.isGbp },
  { channel: "Google Ads",            test: c => c.t === "google_ad_extension" || c.t === "mobile_ad_extension"
                                               || (c.t === "search" && c.engine !== "bing" && c.searchType === "paid")
                                               || /google ads|adwords/.test(c.txt) || c.paid },
  { channel: "Google organic (site)", test: c => /google/.test(c.txt) && /organic/.test(c.txt) },
];

export function classify(call, tracker) {
  const src = tracker && tracker.source ? tracker.source : {};
  const t = src.type || "";
  const txt = [call.source, call.source_name, tracker && tracker.name, call.campaign, call.medium]
    .filter(Boolean).join(" | ").toLowerCase();
  const ctx = {
    t, txt,
    engine: src.search_engine || "",
    searchType: src.search_type || "",
    paid: !!call.gclid || /\b(ppc|cpc|paid)\b/.test(String(call.medium || "").toLowerCase()),
    isGbp: t === "google_my_business" || /my business|business profile|\bgmb\b|\bgbp\b|google maps/.test(txt),
  };
  for (const r of CHANNEL_RULES) if (r.test(ctx)) return r.channel;
  return call.source ? `Other: ${call.source}` : "Other";
}

// ---------------------------------------------------------------------------

async function cr(path, apiKey, params) {
  const url = path.startsWith("http") ? new URL(path) : new URL(BASE + path);
  if (params) for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Token token="${apiKey}"`, Accept: "application/json" } });
    if (res.status === 429 && attempt < 2) { await new Promise(r => setTimeout(r, 2000 * (attempt + 1))); continue; }
    if (!res.ok) {
      const text = (await res.text()).slice(0, 300);
      const err = new Error(`CallRail ${res.status} on ${url.pathname}: ${text}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }
}

export async function resolveAccountId(apiKey, configured) {
  if (configured) return configured;
  const j = await cr("/a.json", apiKey);
  if (!j.accounts || !j.accounts.length) throw new Error("This CallRail API key has no accounts");
  return j.accounts[0].id;
}

export async function listTrackers(apiKey, accountId) {
  const out = {};
  for (let page = 1; page <= 20; page++) {
    const j = await cr(`/a/${accountId}/trackers.json`, apiKey, { per_page: 250, page });
    for (const t of j.trackers || []) out[t.id] = { name: t.name, type: t.type, status: t.status, source: t.source || {} };
    if (!j.total_pages || page >= j.total_pages) break;
  }
  return out;
}

export async function listCalls(apiKey, accountId, { from, to }) {
  const calls = [];
  let j = await cr(`/a/${accountId}/calls.json`, apiKey, {
    start_date: from, end_date: to, per_page: 250, relative_pagination: "true", fields: CALL_FIELDS, sort: "start_time", order: "asc",
  });
  let pages = 1;
  calls.push(...(j.calls || []));
  while (j.has_next_page && j.next_page && pages < MAX_PAGES) {
    j = await cr(j.next_page, apiKey); // CallRail says: use next_page as-is
    calls.push(...(j.calls || []));
    pages++;
  }
  return { calls, truncated: !!(j.has_next_page && pages >= MAX_PAGES) };
}

/** Compact row shape sent to the browser. */
export function normalize(call, trackers) {
  const tr = trackers[call.tracker_id];
  return {
    id: call.id,
    t: call.start_time,
    tz: call.company_time_zone || null,
    num: call.customer_phone_number || "",
    name: call.customer_name || "",
    city: call.customer_city || "",
    state: call.customer_state || "",
    dir: call.direction || "inbound",
    dur: Number(call.duration) || 0,
    ans: !!call.answered,
    vm: !!call.voicemail,
    first: !!call.first_call,
    loc: call.company_name || "",
    ch: classify(call, tr),
    src: call.source || "",
    trk: (tr && tr.name) || call.source_name || "",
    trkType: (tr && tr.source && tr.source.type) || "",
    tracking: call.tracking_phone_number || "",
    med: call.medium || "",
    camp: call.campaign || call.utm_campaign || "",
    kw: call.keywords || call.utm_term || "",
    gclid: !!call.gclid,
    lead: call.lead_status || "",
    val: call.value ?? null,
    tags: Array.isArray(call.tags) ? call.tags.map(t => (typeof t === "string" ? t : t.name)).filter(Boolean) : [],
    dev: call.device_type || "",
    lp: call.landing_page_url || "",
    rec: call.recording_player || "",
  };
}
