// GET /api/calls?from=YYYY-MM-DD&to=YYYY-MM-DD
// Live call log from CallRail for the signed-in user. Nothing is stored in git.

import { currentUser } from "../lib/session.js";
import { resolveAccountId, listTrackers, listCalls, normalize } from "../lib/callrail.js";

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map(); // per warm function instance only
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function GET(request) {
  if (!(await currentUser(request))) return json({ error: "signed_out" }, 401);

  const apiKey = process.env.CALLRAIL_API_KEY;
  if (!apiKey) return json({ error: "CALLRAIL_API_KEY is not set in Vercel environment variables" }, 500);

  const q = new URL(request.url).searchParams;
  const from = q.get("from"), to = q.get("to");
  if (!DAY.test(from || "") || !DAY.test(to || "") || from > to) return json({ error: "Use ?from=YYYY-MM-DD&to=YYYY-MM-DD" }, 400);
  const minFrom = new Date(Date.now() - 760 * 86400000).toISOString().slice(0, 10);
  if (from < minFrom) return json({ error: `CallRail keeps calls for 25 months; the earliest date is about ${minFrom}` }, 400);

  const key = `${from}|${to}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS && q.get("fresh") !== "1") return json(hit.body);

  try {
    const accountId = await resolveAccountId(apiKey, process.env.CALLRAIL_ACCOUNT_ID);
    const trackers = await listTrackers(apiKey, accountId);
    const { calls, truncated } = await listCalls(apiKey, accountId, { from, to });
    const body = {
      from, to, truncated,
      generated_at: new Date().toISOString(),
      calls: calls.map(c => normalize(c, trackers)),
      trackers: Object.entries(trackers).map(([id, t]) => ({ id, name: t.name, status: t.status, type: t.source.type || t.type })),
    };
    cache.set(key, { at: Date.now(), body });
    if (cache.size > 20) cache.delete(cache.keys().next().value);
    return json(body);
  } catch (e) {
    return json({ error: e.message }, e.status === 401 || e.status === 403 ? 502 : 500);
  }
}
