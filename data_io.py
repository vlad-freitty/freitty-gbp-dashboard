#!/usr/bin/env python3
"""
FREITTY · GBP — move data between gbp.db (SQLite, what pull_gbp.py writes)
and site/data.json (what the dashboard reads and what lives in git).

    python data_io.py import    # site/data.json -> gbp.db   (start of a CI run)
    python data_io.py export    # gbp.db -> site/data.json   (end of a CI run)

site/data.json is the single source of truth in the repo: GitHub Actions runners
are ephemeral, so each run rebuilds gbp.db from it, pulls the last N days on top
(upsert), and writes it back.

data.json layout (compact, ~1 MB):
    start, end            first / last date covered by `daily`
    metrics               metric names, fixed order
    locations             [{id, name}]
    daily[loc_id][metric] dense array, index 0 = `start`; null = no data that day
    keywords.rows         [year, month, location_index, keyword, impressions, is_upper_bound]
    last_pull             the pull run that produced this file
"""
from __future__ import annotations

import datetime as dt
import json
import sqlite3
import sys
from pathlib import Path

HERE = Path(__file__).parent.resolve()
DB_FILE = HERE / "gbp.db"
JSON_FILE = HERE / "site" / "data.json"

# Same tables pull_gbp.py creates (kept in sync by importing its schema).
sys.path.insert(0, str(HERE))
from pull_gbp import SCHEMA  # noqa: E402


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE)
    conn.executescript(SCHEMA)
    return conn


def cmd_import() -> None:
    if not JSON_FILE.exists():
        print(f"{JSON_FILE} not found — starting with an empty DB.")
        _connect().close()
        return
    data = json.loads(JSON_FILE.read_text(encoding="utf-8"))
    if DB_FILE.exists():
        DB_FILE.unlink()
    conn = _connect()
    start = dt.date.fromisoformat(data["start"])
    names = {l["id"]: l["name"] for l in data["locations"]}
    stamp = data.get("generated_at", "")

    rows = []
    for loc_id, per_metric in data["daily"].items():
        for metric, arr in per_metric.items():
            for i, v in enumerate(arr):
                if v is None:
                    continue
                d = (start + dt.timedelta(days=i)).isoformat()
                rows.append((d, loc_id, names[loc_id], metric, int(v), stamp))
    conn.executemany("INSERT INTO gbp_metrics VALUES (?,?,?,?,?,?)", rows)

    locs = data["locations"]
    kw_rows = [
        (y, m, locs[li]["id"], locs[li]["name"], kw, v, thr, stamp)
        for (y, m, li, kw, v, thr) in data["keywords"]["rows"]
    ]
    conn.executemany("INSERT INTO gbp_keywords VALUES (?,?,?,?,?,?,?,?)", kw_rows)
    conn.commit()
    conn.close()
    print(f"Imported {len(rows)} daily + {len(kw_rows)} keyword rows into {DB_FILE.name}")


def cmd_export() -> None:
    conn = _connect()
    cur = conn.cursor()

    metrics = [r[0] for r in cur.execute("SELECT DISTINCT metric FROM gbp_metrics ORDER BY metric")]
    lo, hi = cur.execute("SELECT MIN(date), MAX(date) FROM gbp_metrics").fetchone()
    if not lo:
        print("gbp_metrics is empty — nothing to export.")
        sys.exit(1)
    start, end = dt.date.fromisoformat(lo), dt.date.fromisoformat(hi)
    n_days = (end - start).days + 1

    # latest name per location id
    locations = []
    for loc_id, name in cur.execute(
        """SELECT location_id, location_name FROM gbp_metrics
            WHERE (location_id, date) IN (SELECT location_id, MAX(date) FROM gbp_metrics GROUP BY location_id)
            GROUP BY location_id ORDER BY location_name"""
    ):
        locations.append({"id": loc_id, "name": name})
    loc_index = {l["id"]: i for i, l in enumerate(locations)}

    daily: dict[str, dict[str, list]] = {
        l["id"]: {m: [None] * n_days for m in metrics} for l in locations
    }
    for d, loc_id, metric, v in cur.execute("SELECT date, location_id, metric, value FROM gbp_metrics"):
        daily[loc_id][metric][(dt.date.fromisoformat(d) - start).days] = v

    kw_rows = []
    for y, m, loc_id, kw, v, thr in cur.execute(
        """SELECT year, month, location_id, keyword, value, is_threshold FROM gbp_keywords
            ORDER BY year, month, location_name, value DESC, keyword"""
    ):
        if loc_id not in loc_index:  # keyword-only location (shouldn't happen)
            continue
        kw_rows.append([y, m, loc_index[loc_id], kw, v, thr])

    run = cur.execute(
        "SELECT started_at, finished_at, status, note FROM pull_runs ORDER BY started_at DESC LIMIT 1"
    ).fetchone()
    last_pull = dict(zip(["started_at", "finished_at", "status", "note"], run)) if run else None
    conn.close()

    # Hand-assembled so each location/metric array is one line -> small git diffs.
    j = lambda o: json.dumps(o, ensure_ascii=False, separators=(",", ":"))
    out = ["{"]
    out.append(f'"version":1,')
    out.append(f'"generated_at":{j(dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"))},')
    out.append(f'"last_pull":{j(last_pull)},')
    out.append(f'"start":{j(start.isoformat())},"end":{j(end.isoformat())},')
    out.append(f'"metrics":{j(metrics)},')
    out.append(f'"locations":{j(locations)},')
    out.append('"daily":{')
    loc_lines = []
    for l in locations:
        inner = ",\n".join(f"  {j(m)}:{j(daily[l['id']][m])}" for m in metrics)
        loc_lines.append(f"{j(l['id'])}:{{\n{inner}}}")
    out.append(",\n".join(loc_lines))
    out.append("},")
    out.append('"keywords":{"cols":["year","month","loc","keyword","impressions","upper_bound"],"rows":[')
    out.append(",\n".join(j(r) for r in kw_rows))
    out.append("]}")
    out.append("}")
    JSON_FILE.parent.mkdir(exist_ok=True)
    JSON_FILE.write_text("\n".join(out) + "\n", encoding="utf-8", newline="\n")
    size_kb = JSON_FILE.stat().st_size / 1024
    print(f"Exported {start}..{end} ({n_days} days, {len(locations)} locations) "
          f"+ {len(kw_rows)} keyword rows -> {JSON_FILE.relative_to(HERE)} ({size_kb:.0f} KB)")


if __name__ == "__main__":
    if len(sys.argv) != 2 or sys.argv[1] not in ("import", "export"):
        print(__doc__)
        sys.exit(2)
    cmd_import() if sys.argv[1] == "import" else cmd_export()
