#!/usr/bin/env python3
"""
FREITTY · GBP data puller

Pulls Google Business Profile performance metrics into a local SQLite database
and exports a CSV for the dashboard.

Usage:
    python pull_gbp.py                # normal run: fetches recent days, upserts, exports CSV
    python pull_gbp.py --backfill     # initial run: pulls full history per config
    python pull_gbp.py --list-locations   # prints account locations (helper for setup)
    python pull_gbp.py --export-only      # just re-export CSV from existing DB
    python pull_gbp.py --days 30      # override lookback for this run
    python pull_gbp.py --auth         # re-authorize, write token.json (for GitHub secret)

In GitHub Actions the token comes from the GBP_TOKEN_JSON env var and the DB is
rebuilt from / written back to site/data.json by data_io.py.

Files created in the working directory:
    gbp.db                  SQLite database (incremental, deduplicated)
    gbp_export.csv          CSV in the same shape as the Make sheet (for the dashboard)
    token.json              OAuth token cache (auto-refreshes)
    run.log                 Per-run log
"""
from __future__ import annotations

import argparse
import csv
import datetime as dt
import logging
import os
import sqlite3
import sys
from pathlib import Path

import yaml

# Google libs imported lazily inside auth/API functions so the
# DB / CSV / config path can be exercised without them installed.

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
HERE = Path(__file__).parent.resolve()
CREDENTIALS_FILE = HERE / "credentials.json"
TOKEN_FILE = HERE / "token.json"
CONFIG_FILE = HERE / "locations.yaml"
DB_FILE = HERE / "gbp.db"
CSV_FILE = HERE / "gbp_export.csv"
CSV_KEYWORDS_FILE = HERE / "gbp_keywords.csv"
CSV_DAYOFWEEK_FILE = HERE / "gbp_dayofweek.csv"
LOG_FILE = HERE / "run.log"

# Performance API has a separate scope from the Business Information API
SCOPES = ["https://www.googleapis.com/auth/business.manage"]

PERF_API_BASE = "https://businessprofileperformance.googleapis.com/v1"
ACCOUNTS_API_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1"
BUSINESS_INFO_API_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1"

# GBP usually has a 1–2 day reporting lag
REPORTING_LAG_DAYS = 2

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    handlers=[logging.FileHandler(LOG_FILE, encoding="utf-8"), logging.StreamHandler(sys.stdout)],
)
log = logging.getLogger("freitty-gbp")


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------
def get_credentials():
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    # Headless mode (GitHub Actions): the whole token.json is passed in the
    # GBP_TOKEN_JSON env var / secret. It carries client_id + client_secret +
    # refresh_token, so credentials.json is not needed and nothing is written.
    env_token = os.environ.get("GBP_TOKEN_JSON", "").strip()
    if env_token:
        import json
        creds = Credentials.from_authorized_user_info(json.loads(env_token), SCOPES)
        try:
            creds.refresh(Request())
        except Exception as e:
            log.error("GBP_TOKEN_JSON refresh failed (%s). Re-run `python pull_gbp.py --auth` "
                      "locally and paste the new token.json into the GitHub secret.", e)
            sys.exit(1)
        log.info("Using token from GBP_TOKEN_JSON.")
        return creds

    from google_auth_oauthlib.flow import InstalledAppFlow

    if not CREDENTIALS_FILE.exists():
        log.error("credentials.json not found. See README for setup instructions.")
        sys.exit(1)

    creds: Credentials | None = None
    if TOKEN_FILE.exists():
        try:
            creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
        except Exception as e:
            log.warning("Could not load token.json (%s). Re-authorizing.", e)
            creds = None

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                log.info("Refreshed OAuth token.")
            except Exception as e:
                log.warning("Token refresh failed (%s). Re-authorizing interactively.", e)
                creds = None
        if not creds:
            if os.environ.get("CI"):
                log.error("No valid token in CI — set the GBP_TOKEN_JSON secret.")
                sys.exit(1)
            flow = InstalledAppFlow.from_client_secrets_file(str(CREDENTIALS_FILE), SCOPES)
            creds = flow.run_local_server(port=0, prompt="consent")
            log.info("Authorized successfully.")
        TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")

    return creds


# ---------------------------------------------------------------------------
# GBP API calls
# ---------------------------------------------------------------------------
def http_get(creds, url: str, params: dict | None = None, max_retries: int = 5) -> dict:
    """Authenticated GET with exponential backoff on 429 / 5xx.
    Backoff sequence: 60s, 90s, 120s, 180s, 240s.
    """
    import time
    import requests
    from google.auth.transport.requests import Request

    backoff_seq = [60, 90, 120, 180, 240]

    for attempt in range(max_retries + 1):
        if not creds.valid:
            creds.refresh(Request())
        headers = {"Authorization": f"Bearer {creds.token}"}
        try:
            r = requests.get(url, params=params or {}, headers=headers, timeout=60)
        except requests.RequestException as e:
            if attempt >= max_retries:
                raise
            wait = backoff_seq[min(attempt, len(backoff_seq) - 1)]
            log.warning("network error (attempt %d/%d): %s; retry in %ds",
                        attempt + 1, max_retries + 1, e, wait)
            time.sleep(wait)
            continue

        if r.status_code == 429 or 500 <= r.status_code < 600:
            if attempt >= max_retries:
                r.raise_for_status()
            wait = backoff_seq[min(attempt, len(backoff_seq) - 1)]
            kind = "429 rate limit" if r.status_code == 429 else f"{r.status_code} server"
            log.warning("%s on %s (attempt %d/%d); retry in %ds",
                        kind, url.rsplit("/", 1)[-1], attempt + 1, max_retries + 1, wait)
            time.sleep(wait)
            continue

        r.raise_for_status()
        return r.json()

    raise RuntimeError(f"Exhausted retries for {url}")


def list_accounts(creds) -> list[dict]:
    data = http_get(creds, f"{ACCOUNTS_API_BASE}/accounts")
    return data.get("accounts", [])


def list_locations_for_account(creds, account_name: str) -> list[dict]:
    """account_name = 'accounts/{id}'"""
    locs: list[dict] = []
    page_token = None
    while True:
        params = {"readMask": "name,title,storefrontAddress"}
        if page_token:
            params["pageToken"] = page_token
        data = http_get(creds, f"{BUSINESS_INFO_API_BASE}/{account_name}/locations", params)
        locs.extend(data.get("locations", []))
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return locs


def fetch_daily_metrics(
    creds,
    location_id: str,
    metrics: list[str],
    start: dt.date,
    end: dt.date,
    max_retries: int = 5,
) -> list[tuple[dt.date, str, int]]:
    """Returns list of (date, metric, value) tuples for the given location and date range.

    Implements exponential backoff for 429 (rate limit) and 5xx (server) errors.
    Backoff sequence: 30s, 60s, 120s, 240s, 480s.
    Raises on persistent failure after max_retries.
    """
    import time
    import requests
    from google.auth.transport.requests import Request

    url = f"{PERF_API_BASE}/locations/{location_id}:fetchMultiDailyMetricsTimeSeries"
    params: list[tuple[str, str]] = []
    for m in metrics:
        params.append(("dailyMetrics", m))
    params += [
        ("dailyRange.startDate.year",  str(start.year)),
        ("dailyRange.startDate.month", str(start.month)),
        ("dailyRange.startDate.day",   str(start.day)),
        ("dailyRange.endDate.year",    str(end.year)),
        ("dailyRange.endDate.month",   str(end.month)),
        ("dailyRange.endDate.day",     str(end.day)),
    ]

    if not creds.valid:
        creds.refresh(Request())
    headers = {"Authorization": f"Bearer {creds.token}"}

    backoff_seq = [30, 60, 120, 240, 480]
    last_err = None
    for attempt in range(max_retries + 1):
        try:
            r = requests.get(url, params=params, headers=headers, timeout=60)
        except requests.RequestException as e:
            last_err = e
            if attempt >= max_retries:
                raise
            wait = backoff_seq[min(attempt, len(backoff_seq) - 1)]
            log.warning("  network error on %s (attempt %d/%d): %s; retry in %ds",
                        location_id, attempt + 1, max_retries + 1, e, wait)
            time.sleep(wait)
            continue

        if r.status_code == 429 or 500 <= r.status_code < 600:
            last_err = f"HTTP {r.status_code}: {r.text[:200]}"
            if attempt >= max_retries:
                r.raise_for_status()
            wait = backoff_seq[min(attempt, len(backoff_seq) - 1)]
            kind = "429 rate limit" if r.status_code == 429 else f"{r.status_code} server"
            log.warning("  %s on %s (attempt %d/%d); retry in %ds",
                        kind, location_id, attempt + 1, max_retries + 1, wait)
            time.sleep(wait)
            # token may have expired during long waits
            if not creds.valid:
                creds.refresh(Request())
                headers = {"Authorization": f"Bearer {creds.token}"}
            continue

        r.raise_for_status()
        body = r.json()

        out: list[tuple[dt.date, str, int]] = []
        for series in body.get("multiDailyMetricTimeSeries", []):
            for dmts in series.get("dailyMetricTimeSeries", []):
                metric_name = dmts.get("dailyMetric")
                ts = dmts.get("timeSeries", {})
                for dv in ts.get("datedValues", []):
                    d = dv.get("date", {})
                    y, mo, da = d.get("year"), d.get("month"), d.get("day")
                    if not (y and mo and da):
                        continue
                    value = int(dv.get("value", 0))
                    out.append((dt.date(y, mo, da), metric_name, value))
        return out

    raise RuntimeError(f"All {max_retries + 1} attempts failed for {location_id}: {last_err}")


def fetch_search_keywords_for_month(
    creds,
    location_id: str,
    year: int, month: int,
) -> list[tuple[int, int, str, int, bool]]:
    """Returns list of (year, month, keyword, value, is_threshold) for ONE month.

    Per GBP docs: insightsValue.value is "aggregated for each month requested".
    To get a per-month breakdown, we MUST send start_month == end_month.

    'is_threshold' marks low-volume keywords where Google only discloses
    an upper bound (privacy). value is the threshold in that case.
    Paginated: 100 keywords per page.
    """
    base_url = f"{PERF_API_BASE}/locations/{location_id}/searchkeywords/impressions/monthly"
    params = {
        "monthlyRange.startMonth.year":  str(year),
        "monthlyRange.startMonth.month": str(month),
        "monthlyRange.endMonth.year":    str(year),
        "monthlyRange.endMonth.month":   str(month),
        "pageSize": "100",
    }

    out: list[tuple[int, int, str, int, bool]] = []
    page_token = None
    while True:
        p = dict(params)
        if page_token:
            p["pageToken"] = page_token
        data = http_get(creds, base_url, p)

        for kw_entry in data.get("searchKeywordsCounts", []):
            keyword = kw_entry.get("searchKeyword", "")
            iv = kw_entry.get("insightsValue", {})
            value_str = iv.get("value")
            threshold_str = iv.get("threshold")
            if value_str is not None:
                out.append((year, month, keyword, int(value_str), False))
            elif threshold_str is not None:
                out.append((year, month, keyword, int(threshold_str), True))

        page_token = data.get("nextPageToken")
        if not page_token:
            break

    return out


def fetch_dayofweek(
    creds,
    location_id: str,
    metrics: list[str],
    start: dt.date,
    end: dt.date,
    max_retries: int = 5,
) -> list[tuple[dt.date, str, str, int]]:
    """Returns list of (date, metric, day_of_week, value) tuples.

    Same endpoint as fetch_daily_metrics but with
    DailySubEntityType.dayOfWeek=<day> parameter — Google returns the data
    bucketed by day of the week (MONDAY, TUESDAY, ...).

    NOTE: this endpoint does NOT support `dayOfWeek` for all metrics.
    Phone, website, directions DO support it; impressions usually do too.
    Conversations/bookings may not — we'll catch errors per metric.
    """
    import time
    import requests
    from google.auth.transport.requests import Request

    days_of_week = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"]
    out: list[tuple[dt.date, str, str, int]] = []

    # We send one request per dayOfWeek (the API requires the sub-entity to be a
    # single enum value, not a list). 7 requests per location for full week.
    backoff_seq = [30, 60, 120, 240, 480]

    for dow in days_of_week:
        url = f"{PERF_API_BASE}/locations/{location_id}:fetchMultiDailyMetricsTimeSeries"
        params: list[tuple[str, str]] = []
        for m in metrics:
            params.append(("dailyMetrics", m))
        params += [
            ("dailyRange.startDate.year",  str(start.year)),
            ("dailyRange.startDate.month", str(start.month)),
            ("dailyRange.startDate.day",   str(start.day)),
            ("dailyRange.endDate.year",    str(end.year)),
            ("dailyRange.endDate.month",   str(end.month)),
            ("dailyRange.endDate.day",     str(end.day)),
            ("dailySubEntityType.dayOfWeek", dow),
        ]

        if not creds.valid:
            creds.refresh(Request())
        headers = {"Authorization": f"Bearer {creds.token}"}

        last_err = None
        for attempt in range(max_retries + 1):
            try:
                r = requests.get(url, params=params, headers=headers, timeout=60)
            except requests.RequestException as e:
                last_err = e
                if attempt >= max_retries:
                    raise
                wait = backoff_seq[min(attempt, len(backoff_seq) - 1)]
                log.warning("  network error on %s (DOW %s) attempt %d: %s; retry in %ds",
                            location_id, dow, attempt + 1, e, wait)
                time.sleep(wait)
                continue

            if r.status_code == 429 or 500 <= r.status_code < 600:
                if attempt >= max_retries:
                    r.raise_for_status()
                wait = backoff_seq[min(attempt, len(backoff_seq) - 1)]
                log.warning("  %d on %s (DOW %s) attempt %d; retry in %ds",
                            r.status_code, location_id, dow, attempt + 1, wait)
                time.sleep(wait)
                if not creds.valid:
                    creds.refresh(Request())
                    headers = {"Authorization": f"Bearer {creds.token}"}
                continue

            if r.status_code == 400:
                # Some metrics don't support day-of-week breakdown; that's fine, skip
                log.warning("  %s does not support DOW (HTTP 400) — skipping", location_id)
                last_err = "400"
                break

            r.raise_for_status()
            body = r.json()
            for series in body.get("multiDailyMetricTimeSeries", []):
                for dmts in series.get("dailyMetricTimeSeries", []):
                    metric_name = dmts.get("dailyMetric")
                    ts = dmts.get("timeSeries", {})
                    for dv in ts.get("datedValues", []):
                        d = dv.get("date", {})
                        y, mo, da = d.get("year"), d.get("month"), d.get("day")
                        if not (y and mo and da):
                            continue
                        value = int(dv.get("value", 0))
                        out.append((dt.date(y, mo, da), metric_name, dow, value))
            last_err = None
            break

        if last_err == "400":
            return out  # this location/metric combo doesn't support DOW, return what we have

    return out


# ---------------------------------------------------------------------------
# SQLite
# ---------------------------------------------------------------------------
SCHEMA = """
CREATE TABLE IF NOT EXISTS gbp_metrics (
    date           TEXT    NOT NULL,
    location_id    TEXT    NOT NULL,
    location_name  TEXT    NOT NULL,
    metric         TEXT    NOT NULL,
    value          INTEGER NOT NULL,
    pulled_at      TEXT    NOT NULL,
    PRIMARY KEY (date, location_id, metric)
);
CREATE INDEX IF NOT EXISTS idx_metrics_date     ON gbp_metrics(date);
CREATE INDEX IF NOT EXISTS idx_metrics_location ON gbp_metrics(location_name);
CREATE INDEX IF NOT EXISTS idx_metrics_metric   ON gbp_metrics(metric);

CREATE TABLE IF NOT EXISTS gbp_keywords (
    year           INTEGER NOT NULL,
    month          INTEGER NOT NULL,
    location_id    TEXT    NOT NULL,
    location_name  TEXT    NOT NULL,
    keyword        TEXT    NOT NULL,
    value          INTEGER NOT NULL,
    is_threshold   INTEGER NOT NULL,  -- 1 if value is an upper bound only
    pulled_at      TEXT    NOT NULL,
    PRIMARY KEY (year, month, location_id, keyword)
);
CREATE INDEX IF NOT EXISTS idx_keywords_loc     ON gbp_keywords(location_name);
CREATE INDEX IF NOT EXISTS idx_keywords_keyword ON gbp_keywords(keyword);
CREATE INDEX IF NOT EXISTS idx_keywords_period  ON gbp_keywords(year, month);

CREATE TABLE IF NOT EXISTS gbp_dayofweek (
    date           TEXT    NOT NULL,
    location_id    TEXT    NOT NULL,
    location_name  TEXT    NOT NULL,
    metric         TEXT    NOT NULL,
    day_of_week    TEXT    NOT NULL,
    value          INTEGER NOT NULL,
    pulled_at      TEXT    NOT NULL,
    PRIMARY KEY (date, location_id, metric, day_of_week)
);
CREATE INDEX IF NOT EXISTS idx_dow_loc    ON gbp_dayofweek(location_name);
CREATE INDEX IF NOT EXISTS idx_dow_metric ON gbp_dayofweek(metric);
CREATE INDEX IF NOT EXISTS idx_dow_day    ON gbp_dayofweek(day_of_week);

CREATE TABLE IF NOT EXISTS pull_runs (
    started_at   TEXT NOT NULL,
    finished_at  TEXT,
    locations    INTEGER,
    rows_added   INTEGER,
    rows_updated INTEGER,
    status       TEXT,
    note         TEXT
);
"""


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_FILE)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


def db_upsert(conn: sqlite3.Connection, rows: list[tuple]) -> tuple[int, int]:
    """rows = [(date_iso, location_id, location_name, metric, value, pulled_at_iso)]
       Returns (added, updated)."""
    if not rows:
        return 0, 0
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM gbp_metrics")
    before = cur.fetchone()[0]

    cur.executemany(
        """
        INSERT INTO gbp_metrics (date, location_id, location_name, metric, value, pulled_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, location_id, metric) DO UPDATE SET
            value = excluded.value,
            location_name = excluded.location_name,
            pulled_at = excluded.pulled_at
        """,
        rows,
    )
    conn.commit()
    cur.execute("SELECT COUNT(*) FROM gbp_metrics")
    after = cur.fetchone()[0]
    added = after - before
    updated = len(rows) - added
    return added, updated


def db_upsert_keywords(conn: sqlite3.Connection, rows: list[tuple]) -> tuple[int, int]:
    """rows = [(year, month, location_id, location_name, keyword, value, is_threshold, pulled_at)]
       Returns (added, updated)."""
    if not rows:
        return 0, 0
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM gbp_keywords")
    before = cur.fetchone()[0]
    cur.executemany(
        """
        INSERT INTO gbp_keywords (year, month, location_id, location_name, keyword, value, is_threshold, pulled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(year, month, location_id, keyword) DO UPDATE SET
            value = excluded.value,
            is_threshold = excluded.is_threshold,
            location_name = excluded.location_name,
            pulled_at = excluded.pulled_at
        """,
        rows,
    )
    conn.commit()
    cur.execute("SELECT COUNT(*) FROM gbp_keywords")
    after = cur.fetchone()[0]
    added = after - before
    updated = len(rows) - added
    return added, updated


def db_upsert_dayofweek(conn: sqlite3.Connection, rows: list[tuple]) -> tuple[int, int]:
    """rows = [(date_iso, location_id, location_name, metric, day_of_week, value, pulled_at)]
       Returns (added, updated)."""
    if not rows:
        return 0, 0
    cur = conn.cursor()
    cur.execute("SELECT COUNT(*) FROM gbp_dayofweek")
    before = cur.fetchone()[0]
    cur.executemany(
        """
        INSERT INTO gbp_dayofweek (date, location_id, location_name, metric, day_of_week, value, pulled_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, location_id, metric, day_of_week) DO UPDATE SET
            value = excluded.value,
            location_name = excluded.location_name,
            pulled_at = excluded.pulled_at
        """,
        rows,
    )
    conn.commit()
    cur.execute("SELECT COUNT(*) FROM gbp_dayofweek")
    after = cur.fetchone()[0]
    added = after - before
    updated = len(rows) - added
    return added, updated


def db_record_run(conn: sqlite3.Connection, started: str, finished: str,
                  locations: int, added: int, updated: int, status: str, note: str = "") -> None:
    conn.execute(
        "INSERT INTO pull_runs VALUES (?, ?, ?, ?, ?, ?, ?)",
        (started, finished, locations, added, updated, status, note),
    )
    conn.commit()


# ---------------------------------------------------------------------------
# CSV export — same shape as the Make sheet, so the dashboard works unchanged
# ---------------------------------------------------------------------------
def export_csv(conn: sqlite3.Connection, out_path: Path) -> int:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT date, location_name, metric, value
          FROM gbp_metrics
         ORDER BY date, location_name, metric
        """
    )
    n = 0
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Year", "Month", "Day", "Metric", "Value", "Location", "Date", "isoweeknum"])
        for date_iso, loc, metric, value in cur:
            y, m, d = (int(x) for x in date_iso.split("-"))
            dd = dt.date(y, m, d)
            w.writerow([y, m, d, metric, value, loc, dd.strftime("%d.%m.%Y"), dd.isocalendar().week])
            n += 1
    return n


def export_keywords_csv(conn: sqlite3.Connection, out_path: Path) -> int:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT year, month, location_name, keyword, value, is_threshold
          FROM gbp_keywords
         ORDER BY year, month, location_name, value DESC
        """
    )
    n = 0
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Year", "Month", "Location", "Keyword", "Impressions", "IsUpperBound"])
        for y, m, loc, kw, v, is_thr in cur:
            w.writerow([y, m, loc, kw, v, "Yes" if is_thr else "No"])
            n += 1
    return n


def export_dayofweek_csv(conn: sqlite3.Connection, out_path: Path) -> int:
    cur = conn.cursor()
    cur.execute(
        """
        SELECT date, location_name, metric, day_of_week, value
          FROM gbp_dayofweek
         ORDER BY date, location_name, metric, day_of_week
        """
    )
    n = 0
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Year", "Month", "Day", "Metric", "DayOfWeek", "Value", "Location", "Date", "isoweeknum"])
        for date_iso, loc, metric, dow, value in cur:
            y, m, d = (int(x) for x in date_iso.split("-"))
            dd = dt.date(y, m, d)
            w.writerow([y, m, d, metric, dow, value, loc, dd.strftime("%d.%m.%Y"), dd.isocalendar().week])
            n += 1
    return n


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def load_config() -> dict:
    if not CONFIG_FILE.exists():
        log.error("locations.yaml not found at %s", CONFIG_FILE)
        sys.exit(1)
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return yaml.safe_load(f)


CACHE_FILE = HERE / "locations_cache.json"


def _load_cache() -> dict | None:
    if not CACHE_FILE.exists():
        return None
    try:
        import json
        with open(CACHE_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        log.warning("Could not read cache (%s); ignoring.", e)
        return None


def _save_cache(items: list[dict]) -> None:
    import json
    payload = {
        "saved_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "locations": items,
    }
    CACHE_FILE.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")


def resolve_locations(cfg: dict, creds, force_refresh: bool = False) -> list[dict]:
    """
    Returns the final list of locations [{name, location_id}, ...] based on config mode:
      - mode: include   -> use only manual_locations (no API calls). DEFAULT.
      - mode: auto      -> fetch every location visible to the account (with cache).
      - mode: exclude   -> auto - manual_locations ids.
    """
    mode = (cfg.get("mode") or "include").lower().strip()
    manual = cfg.get("manual_locations") or cfg.get("locations") or []

    if mode == "include":
        if not manual:
            log.error("mode=include but no manual_locations are listed.")
            sys.exit(1)
        return [{"name": l["name"], "location_id": str(l["location_id"])} for l in manual]

    # auto / exclude: try the cache first to avoid hitting the strict
    # Account Management API quota on every run.
    cache_hours = float(cfg.get("auto_cache_hours") or 0)
    if not force_refresh and cache_hours > 0:
        cache = _load_cache()
        if cache:
            try:
                saved_at = dt.datetime.fromisoformat(cache["saved_at"])
                age_h = (dt.datetime.now(dt.timezone.utc) - saved_at).total_seconds() / 3600
                if age_h < cache_hours:
                    found = cache["locations"]
                    log.info("Using cached location list (age %.1fh, %d locations).", age_h, len(found))
                    if mode == "exclude":
                        excluded = {str(l["location_id"]) for l in manual}
                        return [l for l in found if l["location_id"] not in excluded]
                    return found
                else:
                    log.info("Cache stale (%.1fh > %.1fh); refreshing.", age_h, cache_hours)
            except Exception as e:
                log.warning("Cache invalid (%s); refreshing.", e)

    # Fetch from API
    log.info("mode=%s -> fetching location list from GBP API (this may take a few minutes due to API quotas)...", mode)
    accounts = list_accounts(creds)
    if not accounts:
        log.error("No GBP accounts visible to this Google identity.")
        sys.exit(1)

    found: list[dict] = []
    for acc in accounts:
        acc_name = acc.get("name", "")
        try:
            locs = list_locations_for_account(creds, acc_name)
        except Exception as e:
            log.warning("  could not list locations for %s: %s", acc_name, e)
            continue
        for loc in locs:
            loc_path = loc.get("name", "")
            title = loc.get("title", "")
            loc_id = loc_path.split("/")[-1] if loc_path else ""
            if not loc_id:
                continue
            found.append({"name": title or loc_id, "location_id": loc_id})

    log.info("Discovered %d location(s) across %d account(s).", len(found), len(accounts))

    if cache_hours > 0:
        _save_cache(found)
        log.info("Cached location list -> %s", CACHE_FILE.name)

    if mode == "exclude":
        excluded_ids = {str(l["location_id"]) for l in manual}
        kept = [l for l in found if l["location_id"] not in excluded_ids]
        log.info("Excluding %d location(s); %d remain.", len(found) - len(kept), len(kept))
        return kept

    return found


def cmd_list_locations() -> None:
    creds = get_credentials()
    accounts = list_accounts(creds)
    if not accounts:
        log.warning("No accounts visible to this Google identity.")
        return
    for acc in accounts:
        name = acc.get("name", "")
        acc_name = acc.get("accountName", "(no name)")
        print(f"\nAccount: {acc_name}  [{name}]")
        try:
            locs = list_locations_for_account(creds, name)
        except Exception as e:
            print(f"  Could not list locations: {e}")
            continue
        for loc in locs:
            loc_name = loc.get("name", "")  # "locations/{id}"
            title = loc.get("title", "(no title)")
            addr = loc.get("storefrontAddress", {})
            city = (addr.get("locality") or "").strip()
            state = (addr.get("administrativeArea") or "").strip()
            loc_id = loc_name.split("/")[-1] if loc_name else ""
            print(f"  {title:<40} {city}, {state:<5}   id={loc_id}")


def _month_range(start: dt.date, end: dt.date) -> list[tuple[int, int]]:
    """Return [(year, month), ...] for every month between start and end inclusive."""
    out = []
    y, m = start.year, start.month
    while (y, m) <= (end.year, end.month):
        out.append((y, m))
        m += 1
        if m > 12:
            m = 1; y += 1
    return out


def cmd_pull(backfill: bool, days_override: int | None, export_only: bool,
             refresh_locations: bool = False) -> int:
    import time as _time
    cfg = load_config()
    metrics = cfg["metrics"]
    lookback = days_override or (cfg["initial_backfill_days"] if backfill else cfg["lookback_days"])
    pause_between = float(cfg.get("pause_between_locations_sec", 2))
    enable_keywords = bool(cfg.get("enable_keywords", True))
    enable_dayofweek = bool(cfg.get("enable_dayofweek", True))
    dow_metrics = cfg.get("dayofweek_metrics") or ["CALL_CLICKS", "WEBSITE_CLICKS", "BUSINESS_DIRECTION_REQUESTS"]

    conn = db_connect()

    if export_only:
        n1 = export_csv(conn, CSV_FILE)
        n2 = export_keywords_csv(conn, CSV_KEYWORDS_FILE)
        n3 = export_dayofweek_csv(conn, CSV_DAYOFWEEK_FILE)
        log.info("CSV re-export: %d daily rows, %d keyword rows, %d DOW rows", n1, n2, n3)
        return 0

    creds = get_credentials()
    locations = resolve_locations(cfg, creds, force_refresh=refresh_locations)
    if not locations:
        log.error("No locations to pull. Check locations.yaml.")
        return 1

    today = dt.date.today()
    end = today - dt.timedelta(days=REPORTING_LAG_DAYS)
    start = end - dt.timedelta(days=lookback - 1)

    started = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    pulled_at = started
    total_added = 0
    total_updated = 0
    all_failures: list[str] = []

    # =====================================================================
    # PHASE 1 — daily metrics
    # =====================================================================
    log.info("")
    log.info("=== PHASE 1: daily metrics ===")
    log.info("Pulling %s .. %s (%d days) for %d locations, %d metrics",
             start, end, lookback, len(locations), len(metrics))

    daily_rows: list[tuple] = []
    failures: list[dict] = []
    for i, loc in enumerate(locations):
        name = loc["name"]
        loc_id = str(loc["location_id"])
        try:
            data = fetch_daily_metrics(creds, loc_id, metrics, start, end)
            for d, m, v in data:
                daily_rows.append((d.isoformat(), loc_id, name, m, v, pulled_at))
            log.info("  [%d/%d] %-30s OK  %d datapoints", i + 1, len(locations), name, len(data))
        except Exception as e:
            log.error("  [%d/%d] %-30s error: %s", i + 1, len(locations), name, e)
            failures.append({"name": name, "id": loc_id, "error": str(e)})
        if pause_between > 0 and i < len(locations) - 1:
            _time.sleep(pause_between)

    if failures:
        log.info("Retrying %d failed location(s) after 60s...", len(failures))
        _time.sleep(60)
        still_failed = []
        for f in failures:
            try:
                data = fetch_daily_metrics(creds, f["id"], metrics, start, end)
                for d, m, v in data:
                    daily_rows.append((d.isoformat(), f["id"], f["name"], m, v, pulled_at))
                log.info("  retry %-30s OK  %d datapoints", f["name"], len(data))
            except Exception as e:
                log.error("  retry %-30s still failing: %s", f["name"], e)
                still_failed.append(f)
            _time.sleep(pause_between)
        failures = still_failed
    all_failures.extend(f"Phase1/{f['name']}: {f['error']}" for f in failures)

    added, updated = db_upsert(conn, daily_rows)
    total_added += added; total_updated += updated
    log.info("Phase 1 done: %d new + %d updated daily rows", added, updated)

    # =====================================================================
    # PHASE 2 — search keywords (monthly)
    # =====================================================================
    if enable_keywords:
        log.info("")
        log.info("=== PHASE 2: search keywords (monthly) ===")
        months = _month_range(start, end)
        log.info("Months to pull: %d (from %d-%02d to %d-%02d) × %d locations = %d requests",
                 len(months), months[0][0], months[0][1], months[-1][0], months[-1][1],
                 len(locations), len(months) * len(locations))

        kw_rows: list[tuple] = []
        kw_failures: list[dict] = []
        for i, loc in enumerate(locations):
            name = loc["name"]
            loc_id = str(loc["location_id"])
            n_for_loc = 0
            for (y, m) in months:
                try:
                    data = fetch_search_keywords_for_month(creds, loc_id, y, m)
                    for (yy, mm, kw, v, is_thr) in data:
                        kw_rows.append((yy, mm, loc_id, name, kw, v, 1 if is_thr else 0, pulled_at))
                    n_for_loc += len(data)
                except Exception as e:
                    log.warning("  [%d/%d] %s %d-%02d keyword fetch error: %s",
                                i + 1, len(locations), name, y, m, e)
                    kw_failures.append({"name": f"{name} {y}-{m:02d}", "id": loc_id, "error": str(e)})
                if pause_between > 0:
                    _time.sleep(pause_between)
            log.info("  [%d/%d] %-30s OK  %d keyword rows across %d months",
                     i + 1, len(locations), name, n_for_loc, len(months))

        added_kw, updated_kw = db_upsert_keywords(conn, kw_rows)
        total_added += added_kw; total_updated += updated_kw
        log.info("Phase 2 done: %d new + %d updated keyword rows", added_kw, updated_kw)
        all_failures.extend(f"Phase2/{f['name']}: {f['error']}" for f in kw_failures)
    else:
        log.info("Phase 2 (keywords) disabled in config; skipping.")

    # =====================================================================
    # PHASE 3 — day-of-week breakdown
    # =====================================================================
    if enable_dayofweek:
        log.info("")
        log.info("=== PHASE 3: day-of-week breakdown ===")
        log.info("Pulling %d locations × 7 weekdays × %d metrics = %d requests",
                 len(locations), len(dow_metrics), len(locations) * 7)

        dow_rows: list[tuple] = []
        dow_failures: list[dict] = []
        for i, loc in enumerate(locations):
            name = loc["name"]
            loc_id = str(loc["location_id"])
            try:
                data = fetch_dayofweek(creds, loc_id, dow_metrics, start, end)
                for d, m, dow, v in data:
                    dow_rows.append((d.isoformat(), loc_id, name, m, dow, v, pulled_at))
                log.info("  [%d/%d] %-30s OK  %d DOW rows", i + 1, len(locations), name, len(data))
            except Exception as e:
                log.error("  [%d/%d] %-30s error: %s", i + 1, len(locations), name, e)
                dow_failures.append({"name": name, "id": loc_id, "error": str(e)})
            if pause_between > 0 and i < len(locations) - 1:
                _time.sleep(pause_between)

        added_d, updated_d = db_upsert_dayofweek(conn, dow_rows)
        total_added += added_d; total_updated += updated_d
        log.info("Phase 3 done: %d new + %d updated DOW rows", added_d, updated_d)
        all_failures.extend(f"Phase3/{f['name']}: {f['error']}" for f in dow_failures)
    else:
        log.info("Phase 3 (day-of-week) disabled in config; skipping.")

    # =====================================================================
    # CSV exports
    # =====================================================================
    log.info("")
    log.info("=== Exporting CSV ===")
    n1 = export_csv(conn, CSV_FILE)
    log.info("  %s  %d rows", CSV_FILE.name, n1)
    if enable_keywords:
        n2 = export_keywords_csv(conn, CSV_KEYWORDS_FILE)
        log.info("  %s  %d rows", CSV_KEYWORDS_FILE.name, n2)
    if enable_dayofweek:
        n3 = export_dayofweek_csv(conn, CSV_DAYOFWEEK_FILE)
        log.info("  %s  %d rows", CSV_DAYOFWEEK_FILE.name, n3)

    finished = dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")
    status = "ok" if not all_failures else "partial"
    note = " | ".join(all_failures) if all_failures else ""
    db_record_run(conn, started, finished, len(locations), total_added, total_updated, status, note)

    conn.close()
    if all_failures:
        log.warning("Completed with %d failure(s) across phases. See run.log for details.", len(all_failures))
        return 2
    log.info("")
    log.info("All done.")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="FREITTY GBP data puller")
    p.add_argument("--backfill", action="store_true", help="Initial backfill using initial_backfill_days")
    p.add_argument("--days", type=int, default=None, help="Override lookback days for this run")
    p.add_argument("--export-only", action="store_true", help="Skip API, just re-export CSV from DB")
    p.add_argument("--list-locations", action="store_true", help="List all GBP locations visible to your account")
    p.add_argument("--refresh-locations", action="store_true", help="Force-refresh the auto-mode location cache before pulling")
    p.add_argument("--auth", action="store_true", help="Only (re)authorize and write token.json (for the GitHub secret)")
    args = p.parse_args()

    if args.auth:
        if TOKEN_FILE.exists():
            TOKEN_FILE.unlink()
        get_credentials()
        log.info("token.json written. Copy its full contents into the GitHub secret GBP_TOKEN_JSON.")
        return 0
    if args.list_locations:
        cmd_list_locations()
        return 0
    return cmd_pull(
        backfill=args.backfill,
        days_override=args.days,
        export_only=args.export_only,
        refresh_locations=args.refresh_locations,
    )


if __name__ == "__main__":
    sys.exit(main())
