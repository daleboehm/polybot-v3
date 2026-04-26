#!/usr/bin/env python3
"""
Weather Calibration Service for Polybot V3
6-layer calibration stack: L1 bias | L2 QDM | L3 EMOS | L4 Gaussian | L5 Tail | L6 afCRPS
Uses Open-Meteo ERA5-Land (archive) + GFS (forecast) APIs. Pure stdlib + optional numpy.
"""

import os
import re
import sqlite3
import math
import time
import json
import urllib.request
import urllib.error
from datetime import datetime, timedelta, timezone
from typing import Optional

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
DB_PATH = os.environ.get("POLYBOT_DB", "/opt/polybot-v3/data/polybot.db")

CITY_META = {
    "london":        {"lat": 51.5074,  "lon": -0.1278,   "tz": "Europe/London"},
    "paris":         {"lat": 48.8566,  "lon": 2.3522,    "tz": "Europe/Paris"},
    "tokyo":         {"lat": 35.6762,  "lon": 139.6503,  "tz": "Asia/Tokyo"},
    "sydney":        {"lat": -33.8688, "lon": 151.2093,  "tz": "Australia/Sydney"},
    "hong kong":     {"lat": 22.3193,  "lon": 114.1694,  "tz": "Asia/Hong_Kong"},
    "singapore":     {"lat": 1.3521,   "lon": 103.8198,  "tz": "Asia/Singapore"},
    "dubai":         {"lat": 25.2048,  "lon": 55.2708,   "tz": "Asia/Dubai"},
    "berlin":        {"lat": 52.5200,  "lon": 13.4050,   "tz": "Europe/Berlin"},
    "warsaw":        {"lat": 52.2297,  "lon": 21.0122,   "tz": "Europe/Warsaw"},
    "tel aviv":      {"lat": 32.0853,  "lon": 34.7818,   "tz": "Asia/Jerusalem"},
    "mumbai":        {"lat": 19.0760,  "lon": 72.8777,   "tz": "Asia/Kolkata"},
    "shanghai":      {"lat": 31.2304,  "lon": 121.4737,  "tz": "Asia/Shanghai"},
    "toronto":       {"lat": 43.6532,  "lon": -79.3832,  "tz": "America/Toronto"},
    "vancouver":     {"lat": 49.2827,  "lon": -123.1207, "tz": "America/Vancouver"},
    "mexico city":   {"lat": 19.4326,  "lon": -99.1332,  "tz": "America/Mexico_City"},
    "amsterdam":     {"lat": 52.3676,  "lon": 4.9041,    "tz": "Europe/Amsterdam"},
    "madrid":        {"lat": 40.4168,  "lon": -3.7038,   "tz": "Europe/Madrid"},
    "rome":          {"lat": 41.9028,  "lon": 12.4964,   "tz": "Europe/Rome"},
    "seoul":         {"lat": 37.5665,  "lon": 126.9780,  "tz": "Asia/Seoul"},
    "beijing":       {"lat": 39.9042,  "lon": 116.4074,  "tz": "Asia/Shanghai"},
    "wuhan":         {"lat": 30.5928,  "lon": 114.3055,  "tz": "Asia/Shanghai"},
    "chengdu":       {"lat": 30.5728,  "lon": 104.0668,  "tz": "Asia/Shanghai"},
    "athens":        {"lat": 37.9838,  "lon": 23.7275,   "tz": "Europe/Athens"},
    "new york":      {"lat": 40.7128,  "lon": -74.0060,  "tz": "America/New_York",     "imperial": True},
    "los angeles":   {"lat": 34.0522,  "lon": -118.2437, "tz": "America/Los_Angeles",  "imperial": True},
    "miami":         {"lat": 25.7617,  "lon": -80.1918,  "tz": "America/New_York",     "imperial": True},
    "chicago":       {"lat": 41.8781,  "lon": -87.6298,  "tz": "America/Chicago",      "imperial": True},
    "denver":        {"lat": 39.7392,  "lon": -104.9903, "tz": "America/Denver",       "imperial": True},
    "seattle":       {"lat": 47.6062,  "lon": -122.3321, "tz": "America/Los_Angeles",  "imperial": True},
    "san francisco": {"lat": 37.7749,  "lon": -122.4194, "tz": "America/Los_Angeles",  "imperial": True},
    "boston":        {"lat": 42.3601,  "lon": -71.0589,  "tz": "America/New_York",     "imperial": True},
    "phoenix":       {"lat": 33.4484,  "lon": -112.0740, "tz": "America/Phoenix",      "imperial": True},
    "las vegas":     {"lat": 36.1699,  "lon": -115.1398, "tz": "America/Los_Angeles",  "imperial": True},
    "orlando":       {"lat": 28.5383,  "lon": -81.3792,  "tz": "America/New_York",     "imperial": True},
    "dallas":        {"lat": 32.7767,  "lon": -96.7970,  "tz": "America/Chicago",      "imperial": True},
}

INF = float("inf")


# ---------------------------------------------------------------------------
# DB Setup
# ---------------------------------------------------------------------------
def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_tables(conn: sqlite3.Connection):
    conn.executescript("""
    CREATE TABLE IF NOT EXISTS weather_bias_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        city TEXT NOT NULL,
        date TEXT NOT NULL,
        gfs_high_c REAL,
        gfs_low_c REAL,
        era5_high_c REAL,
        era5_low_c REAL,
        bias_high_c REAL,
        bias_low_c REAL,
        created_at TEXT DEFAULT (datetime('now')),
        UNIQUE(city, date)
    );

    CREATE TABLE IF NOT EXISTS weather_calibrations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        condition_id TEXT NOT NULL,
        city TEXT NOT NULL,
        forecast_date TEXT NOT NULL,
        bucket_min_c REAL,
        bucket_max_c REAL,
        raw_prob REAL,
        l1_prob REAL,
        l2_prob REAL,
        l3_prob REAL,
        l4_prob REAL,
        l5_prob REAL,
        l6_prob REAL,
        final_prob REAL,
        emos_mu_c REAL,
        emos_sigma_c REAL,
        history_days INTEGER,
        calibrated_at TEXT DEFAULT (datetime('now')),
        UNIQUE(condition_id)
    );
    """)
    conn.commit()
    print("[DB] Tables ready.")


# ---------------------------------------------------------------------------
# HTTP helpers
# ---------------------------------------------------------------------------
def http_get(url: str, retries: int = 3, timeout: int = 30) -> dict:
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "polybot-weather/1.0"})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode())
        except (urllib.error.URLError, urllib.error.HTTPError, Exception) as e:
            if attempt < retries - 1:
                wait = 2 ** attempt
                print(f"  [HTTP] Retry {attempt+1}/{retries} after {wait}s -- {e}")
                time.sleep(wait)
            else:
                raise


# ---------------------------------------------------------------------------
# Open-Meteo calls
# ---------------------------------------------------------------------------
def fetch_era5_history(city: str, start_date: str, end_date: str) -> Optional[dict]:
    """Fetch ERA5-Land daily high/low temps for a city over a date range."""
    meta = CITY_META.get(city)
    if not meta:
        print(f"  [ERA5] Unknown city: {city}")
        return None
    lat, lon = meta["lat"], meta["lon"]
    url = (
        f"https://archive-api.open-meteo.com/v1/archive"
        f"?latitude={lat}&longitude={lon}"
        f"&start_date={start_date}&end_date={end_date}"
        f"&daily=temperature_2m_max,temperature_2m_min"
        f"&temperature_unit=celsius&timezone=UTC"
    )
    try:
        data = http_get(url)
        return data.get("daily", {})
    except Exception as e:
        print(f"  [ERA5] Error for {city}: {e}")
        return None


def fetch_gfs_forecast(city: str, forecast_date: str) -> Optional[dict]:
    """Fetch GFS forecast daily high/low for a specific date."""
    meta = CITY_META.get(city)
    if not meta:
        return None
    lat, lon = meta["lat"], meta["lon"]
    try:
        dt = datetime.strptime(forecast_date, "%Y-%m-%d")
        end_dt = dt + timedelta(days=1)
        end_date = end_dt.strftime("%Y-%m-%d")
    except ValueError:
        end_date = forecast_date

    url = (
        f"https://api.open-meteo.com/v1/forecast"
        f"?latitude={lat}&longitude={lon}"
        f"&daily=temperature_2m_max,temperature_2m_min"
        f"&start_date={forecast_date}&end_date={end_date}"
        f"&temperature_unit=celsius&timezone=UTC"
        f"&models=gfs_seamless"
    )
    try:
        data = http_get(url)
        daily = data.get("daily", {})
        dates = daily.get("time", [])
        highs = daily.get("temperature_2m_max", [])
        lows  = daily.get("temperature_2m_min", [])
        if forecast_date in dates:
            idx = dates.index(forecast_date)
            return {
                "high_c": highs[idx] if idx < len(highs) else None,
                "low_c":  lows[idx]  if idx < len(lows)  else None,
            }
        elif highs:
            return {"high_c": highs[0], "low_c": lows[0] if lows else None}
        return None
    except Exception as e:
        print(f"  [GFS] Error for {city} on {forecast_date}: {e}")
        return None


# ---------------------------------------------------------------------------
# Math helpers
# ---------------------------------------------------------------------------
def normal_cdf(x: float, mu: float, sigma: float) -> float:
    """Standard normal CDF using math.erf -- no scipy needed."""
    if sigma <= 0:
        return 1.0 if x >= mu else 0.0
    z = (x - mu) / (sigma * math.sqrt(2))
    return 0.5 * (1.0 + math.erf(z))


def prob_in_bucket(mu: float, sigma: float, lo: float, hi: float) -> float:
    """P(lo <= X <= hi) for N(mu, sigma)."""
    p_hi = 1.0 if hi == INF else normal_cdf(hi, mu, sigma)
    p_lo = 0.0 if lo == -INF else normal_cdf(lo, mu, sigma)
    return max(0.0, min(1.0, p_hi - p_lo))


def clamp(v: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, v))


def mean_vals(vals: list) -> float:
    return sum(vals) / len(vals) if vals else 0.0


def std_vals(vals: list, ddof: int = 1) -> float:
    if len(vals) < 2:
        return 0.0
    m = mean_vals(vals)
    var = sum((v - m) ** 2 for v in vals) / (len(vals) - ddof)
    return math.sqrt(var)


def ols(x: list, y: list):
    """Simple OLS: returns (a, b) for y = a + b*x."""
    n = len(x)
    if n < 2:
        return (mean_vals(y) if y else 0.0, 1.0)
    xm, ym = mean_vals(x), mean_vals(y)
    denom = sum((xi - xm) ** 2 for xi in x)
    if denom == 0:
        return (ym, 1.0)
    b = sum((x[i] - xm) * (y[i] - ym) for i in range(n)) / denom
    a = ym - b * xm
    return (a, b)


def quantile_map(sorted_hist: list, value: float) -> float:
    """Return empirical quantile of value in sorted_hist (Hazen position)."""
    n = len(sorted_hist)
    if n == 0:
        return 0.5
    lo, hi = 0, n - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if sorted_hist[mid] < value:
            lo = mid + 1
        else:
            hi = mid
    return (lo + 0.5) / n


def inverse_quantile(sorted_vals: list, q: float) -> float:
    """Map quantile q back to value via sorted_vals (linear interp)."""
    n = len(sorted_vals)
    if n == 0:
        return 0.0
    q = clamp(q)
    pos = q * (n - 1)
    lo_idx = int(pos)
    hi_idx = min(lo_idx + 1, n - 1)
    frac = pos - lo_idx
    return sorted_vals[lo_idx] + frac * (sorted_vals[hi_idx] - sorted_vals[lo_idx])


# ---------------------------------------------------------------------------
# Market question parser
# ---------------------------------------------------------------------------
def _f_to_c(f: float) -> float:
    """Convert Fahrenheit to Celsius."""
    return (f - 32.0) * 5.0 / 9.0


def parse_question(question: str) -> dict:
    """
    Parse a Polymarket weather question into {city, bucket_min_c, bucket_max_c, forecast_date}.
    Handles both Celsius (°C / c) and Fahrenheit (°F / f) units.
    All returned temperatures are in Celsius.

    Recognises patterns like:
      "Will the highest temperature in Hong Kong be 22°C on April 26?"
      "Will the highest temperature in Miami be between 88-89°F on April 26?"
      "Will the temperature in Denver reach 25°C or higher on May 1?"
      "Will the temperature in Paris be below 5°C on April 30?"
    """
    result = {"city": None, "bucket_min_c": -INF, "bucket_max_c": INF, "forecast_date": None}
    q = question.lower().strip()

    # ---- city detection -------------------------------------------------------
    for city in sorted(CITY_META.keys(), key=len, reverse=True):
        if city in q:
            result["city"] = city
            break

    # ---- date detection -------------------------------------------------------
    month_map = {
        "january": 1, "february": 2, "march": 3, "april": 4,
        "may": 5, "june": 6, "july": 7, "august": 8,
        "september": 9, "october": 10, "november": 11, "december": 12,
    }
    now = datetime.now(timezone.utc)

    m = re.search(r"(\d{4}-\d{2}-\d{2})", q)
    if m:
        result["forecast_date"] = m.group(1)
    else:
        m = re.search(
            r"(january|february|march|april|may|june|july|august|"
            r"september|october|november|december)\s+(\d{1,2})", q
        )
        if m:
            month, day = month_map[m.group(1)], int(m.group(2))
        else:
            m = re.search(
                r"(\d{1,2})\s+(january|february|march|april|may|june|"
                r"july|august|september|october|november|december)", q
            )
            if m:
                day, month = int(m.group(1)), month_map[m.group(2)]
            else:
                month, day = None, None
        if month and day:
            year = now.year
            try:
                candidate = datetime(year, month, day)
                if candidate.date() < now.date():
                    year += 1
                result["forecast_date"] = f"{year}-{month:02d}-{day:02d}"
            except ValueError:
                pass

    # ---- temperature helpers --------------------------------------------------
    # Matches a temperature value followed by an optional degree symbol and C or F.
    # Examples matched: 22°C  22c  88°F  88f  22.5°C  -5°C
    _T = r"([-\d.]+)\s*°?\s*([cfCF])\b"

    def to_c(val_str: str, unit: str) -> float:
        v = float(val_str)
        return _f_to_c(v) if unit.lower() == "f" else v

    # ---- bucket patterns (evaluated in priority order) -----------------------

    # 1. "reach 25°C" or "reach 77°F" → [val, +inf)
    m = re.search(r"reach\s+" + _T, q)
    if m:
        result["bucket_min_c"] = to_c(m.group(1), m.group(2))
        result["bucket_max_c"] = INF
        return result

    # 2. "above/over 30°C" → [val, +inf)
    m = re.search(r"(?:above|over)\s+" + _T, q)
    if m:
        result["bucket_min_c"] = to_c(m.group(1), m.group(2))
        result["bucket_max_c"] = INF
        return result

    # 3. "25°C or higher" / "25°C or above" → [val, +inf)
    m = re.search(_T + r"\s+or\s+(?:higher|above)", q)
    if m:
        result["bucket_min_c"] = to_c(m.group(1), m.group(2))
        result["bucket_max_c"] = INF
        return result

    # 4. "below/under 20°C" → (-inf, val]
    m = re.search(r"(?:below|under)\s+" + _T, q)
    if m:
        result["bucket_min_c"] = -INF
        result["bucket_max_c"] = to_c(m.group(1), m.group(2))
        return result

    # 5. "25°C or lower/below" → (-inf, val]
    m = re.search(_T + r"\s+or\s+(?:lower|below)", q)
    if m:
        result["bucket_min_c"] = -INF
        result["bucket_max_c"] = to_c(m.group(1), m.group(2))
        return result

    # 6. Range "25-26°C" or "88-89°F" or "between 25 and 26°C"
    #    The unit appears after the second number.
    m = re.search(r"([-\d.]+)\s*[-–]\s*([-\d.]+)\s*°?\s*([cfCF])\b", q)
    if m:
        lo = to_c(m.group(1), m.group(3))
        hi = to_c(m.group(2), m.group(3))
        result["bucket_min_c"] = lo
        result["bucket_max_c"] = hi
        return result

    # 7. "between 25 and 26°C" (written-out range)
    m = re.search(r"between\s+([-\d.]+)\s+and\s+" + _T, q)
    if m:
        lo = to_c(m.group(1), m.group(3))
        hi = to_c(m.group(2), m.group(3))
        result["bucket_min_c"] = lo
        result["bucket_max_c"] = hi
        return result

    # 8. "be 22°C" / "be 9°C" / "be 88°F" → exact degree bucket [val-0.5, val+0.5]
    #    Must come AFTER range check so "be between 25-26°C" is already handled.
    m = re.search(r"\bbe\s+" + _T, q)
    if m:
        val = to_c(m.group(1), m.group(2))
        result["bucket_min_c"] = val - 0.5
        result["bucket_max_c"] = val + 0.5
        return result

    # 9. Fallback: bare temperature anywhere in question
    m = re.search(_T, q)
    if m:
        val = to_c(m.group(1), m.group(2))
        result["bucket_min_c"] = val - 0.5
        result["bucket_max_c"] = val + 0.5

    return result


# ---------------------------------------------------------------------------
# ERA5 backfill
# ---------------------------------------------------------------------------
def backfill_era5(conn: sqlite3.Connection, cities: list, days: int = 30):
    """Fetch ERA5 truth for the last N days for given cities."""
    today = datetime.now(timezone.utc).date()
    # ERA5 has ~5 day lag
    end_date   = (today - timedelta(days=5)).strftime("%Y-%m-%d")
    start_date = (today - timedelta(days=days + 5)).strftime("%Y-%m-%d")

    print(f"[Backfill] ERA5 {start_date} to {end_date} for {len(cities)} cities")

    for city in cities:
        print(f"  [ERA5] Fetching {city}...")
        daily = fetch_era5_history(city, start_date, end_date)
        if not daily:
            continue
        dates = daily.get("time", [])
        highs = daily.get("temperature_2m_max", [])
        lows  = daily.get("temperature_2m_min", [])
        inserted = 0
        for i, d in enumerate(dates):
            high_c = highs[i] if i < len(highs) else None
            low_c  = lows[i]  if i < len(lows)  else None
            if high_c is None:
                continue
            try:
                conn.execute(
                    "INSERT OR IGNORE INTO weather_bias_history "
                    "(city, date, era5_high_c, era5_low_c) VALUES (?, ?, ?, ?)",
                    (city, d, high_c, low_c)
                )
                inserted += 1
            except sqlite3.Error as e:
                print(f"    [DB] Insert error {city}/{d}: {e}")
        conn.commit()
        print(f"    [ERA5] {city}: {inserted} rows stored")
        time.sleep(0.2)


def load_era5_history(conn: sqlite3.Connection, city: str, days: int = 30) -> list:
    """Return sorted list of ERA5 high_c values for city over last N days."""
    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=days)).strftime("%Y-%m-%d")
    rows = conn.execute(
        "SELECT era5_high_c FROM weather_bias_history "
        "WHERE city = ? AND date >= ? AND era5_high_c IS NOT NULL "
        "ORDER BY era5_high_c",
        (city, cutoff)
    ).fetchall()
    return [r["era5_high_c"] for r in rows]


def load_gfs_era5_pairs(conn: sqlite3.Connection, city: str, days: int = 30):
    """Load (gfs_high_c, era5_high_c) pairs where both exist."""
    cutoff = (datetime.now(timezone.utc).date() - timedelta(days=days)).strftime("%Y-%m-%d")
    rows = conn.execute(
        "SELECT gfs_high_c, era5_high_c FROM weather_bias_history "
        "WHERE city = ? AND date >= ? "
        "AND gfs_high_c IS NOT NULL AND era5_high_c IS NOT NULL "
        "ORDER BY date",
        (city, cutoff)
    ).fetchall()
    gfs_vals  = [r["gfs_high_c"]  for r in rows]
    era5_vals = [r["era5_high_c"] for r in rows]
    return gfs_vals, era5_vals


# ---------------------------------------------------------------------------
# 6-Layer Calibration Stack
# ---------------------------------------------------------------------------
def calibrate(
    city: str,
    gfs_high: float,
    era5_sorted: list,
    gfs_era5_pairs: tuple,
    bucket_min: float,
    bucket_max: float,
) -> dict:
    """Apply all 6 calibration layers. All temps in Celsius."""
    gfs_vals, era5_vals = gfs_era5_pairs
    n_hist = len(era5_sorted)

    # Raw -- naive N(gfs_high, 2.0)
    raw_sigma = 2.0
    raw_mu    = gfs_high
    raw_prob  = prob_in_bucket(raw_mu, raw_sigma, bucket_min, bucket_max)

    # L1: Rolling 7-day mean bias correction (ERA5 - GFS)
    biases = [era5_vals[i] - gfs_vals[i] for i in range(len(gfs_vals))]
    recent_bias = mean_vals(biases[-7:]) if biases else 0.0
    l1_mu   = gfs_high + recent_bias
    l1_prob = prob_in_bucket(l1_mu, raw_sigma, bucket_min, bucket_max)

    # L2: QDM -- map GFS quantile to ERA5 distribution
    if len(gfs_vals) >= 3:
        sorted_gfs  = sorted(gfs_vals)
        sorted_era5 = sorted(era5_vals)
        q_gfs  = quantile_map(sorted_gfs, gfs_high)
        qdm_mu = inverse_quantile(sorted_era5, q_gfs)
    else:
        qdm_mu = l1_mu
    l2_prob = prob_in_bucket(qdm_mu, raw_sigma, bucket_min, bucket_max)

    # L3: EMOS -- OLS regression GFS->ERA5, sigma from RMS residual (min 0.8C)
    if len(gfs_vals) >= 3:
        a, b = ols(gfs_vals, era5_vals)
        emos_mu    = a + b * gfs_high
        residuals  = [era5_vals[i] - (a + b * gfs_vals[i]) for i in range(len(gfs_vals))]
        rms_resid  = math.sqrt(mean_vals([r ** 2 for r in residuals])) if residuals else raw_sigma
        emos_sigma = max(0.8, rms_resid)
    else:
        emos_mu    = l1_mu
        emos_sigma = raw_sigma
    l3_prob = prob_in_bucket(emos_mu, emos_sigma, bucket_min, bucket_max)

    # L4: Gaussian dressing -- inflate if climatological spread > model sigma
    if len(era5_sorted) >= 5:
        era5_spread = std_vals(era5_sorted, ddof=1)
        if era5_spread > emos_sigma:
            dress_sigma = math.sqrt(emos_sigma ** 2 + 0.3 * (era5_spread - emos_sigma) ** 2)
        else:
            dress_sigma = emos_sigma
    else:
        dress_sigma = emos_sigma
    l4_prob = prob_in_bucket(emos_mu, dress_sigma, bucket_min, bucket_max)

    # L5: Tail inflation -- sigma * 1.08 (twCRPS tail emphasis)
    tail_sigma = dress_sigma * 1.08
    l5_prob    = prob_in_bucket(emos_mu, tail_sigma, bucket_min, bucket_max)

    # L6: afCRPS finite-ensemble correction (n=50, alpha=0.95)
    # Slight smoothing toward uniform to correct overconfidence from small ensembles
    n_ens   = 50
    alpha   = 0.95
    if bucket_max != INF and bucket_min != -INF:
        bucket_width  = bucket_max - bucket_min
        uniform_prob  = clamp(bucket_width / 20.0)
    else:
        uniform_prob  = 0.5
    l6_prob = clamp(alpha * l5_prob + (1.0 - alpha) * uniform_prob)

    return {
        "raw_prob":     clamp(raw_prob),
        "l1_prob":      clamp(l1_prob),
        "l2_prob":      clamp(l2_prob),
        "l3_prob":      clamp(l3_prob),
        "l4_prob":      clamp(l4_prob),
        "l5_prob":      clamp(l5_prob),
        "l6_prob":      clamp(l6_prob),
        "final_prob":   clamp(l6_prob),
        "emos_mu_c":    emos_mu,
        "emos_sigma_c": emos_sigma,
        "history_days": n_hist,
    }


# ---------------------------------------------------------------------------
# Active weather market detection
# ---------------------------------------------------------------------------
def get_active_weather_markets(conn: sqlite3.Connection) -> list:
    """Return active markets whose question contains a known weather city + temp keyword."""
    # Try multiple schema variants
    # Only calibrate markets with future end_date (Python string avoids shell quoting issues)
    _now_filter = "AND end_date > datetime('now', '-2 hours')"
    query_candidates = [
        f"SELECT condition_id, question, end_date FROM markets WHERE active = 1 AND closed = 0 {_now_filter}",
        f"SELECT condition_id, question, end_date FROM markets WHERE active = 1 {_now_filter}",
        f"SELECT condition_id, question, end_date FROM markets WHERE closed = 0 {_now_filter}",
        "SELECT condition_id, question, end_date FROM markets WHERE active = 1",
    ]
    rows = []
    for q in query_candidates:
        try:
            rows = conn.execute(q).fetchall()
            break
        except sqlite3.OperationalError:
            continue

    if not rows:
        print("[Markets] No rows found in markets table")
        return []

    temp_keywords = {"temperature", "high", "celsius", "fahrenheit", "warm", "hot", "cold",
                     "reach", "above", "below", "between", "degree"}
    weather_markets = []
    seen_ids = set()

    for row in rows:
        q_text = (row["question"] or "").lower()
        if not any(kw in q_text for kw in temp_keywords):
            continue
        for city in sorted(CITY_META.keys(), key=len, reverse=True):
            if city in q_text:
                parsed = parse_question(row["question"])
                if parsed["city"] and row["condition_id"] not in seen_ids:
                    market = dict(row)
                    market.update(parsed)
                    weather_markets.append(market)
                    seen_ids.add(row["condition_id"])
                break

    return weather_markets


# ---------------------------------------------------------------------------
# Main calibration loop
# ---------------------------------------------------------------------------
def run_calibration(conn: sqlite3.Connection) -> int:
    """Run full calibration. Returns count calibrated."""
    markets = get_active_weather_markets(conn)
    print(f"[Calibration] Found {len(markets)} active weather markets")

    if not markets:
        print("[Calibration] No weather markets found -- nothing to calibrate.")
        return 0

    cities = list({m["city"] for m in markets if m["city"]})
    print(f"[Calibration] Cities: {cities}")

    # Backfill ERA5 for all relevant cities
    backfill_era5(conn, cities, days=30)

    calibrated = 0
    skipped    = 0

    for market in markets:
        cid   = market.get("condition_id", "unknown")
        city  = market.get("city")
        fdate = market.get("forecast_date")
        bmin  = market.get("bucket_min_c", -INF)
        bmax  = market.get("bucket_max_c",  INF)
        q_txt = market.get("question", "")

        if not city or not fdate:
            print(f"  [SKIP] {str(cid)[:16]}... -- could not parse city/date: {q_txt[:80]}")
            skipped += 1
            continue

        meta = CITY_META.get(city)
        if not meta:
            print(f"  [SKIP] {str(cid)[:16]}... -- city '{city}' not in CITY_META")
            skipped += 1
            continue

        bmin_disp = bmin if bmin != -INF else "-inf"
        bmax_disp = bmax if bmax !=  INF else "+inf"
        print(f"  [CAL] {city} | {fdate} | [{bmin_disp}, {bmax_disp}] | {str(cid)[:16]}...")

        # GFS forecast
        gfs = fetch_gfs_forecast(city, fdate)
        if not gfs or gfs.get("high_c") is None:
            print(f"    [SKIP] No GFS data for {city}/{fdate}")
            skipped += 1
            continue

        gfs_high = gfs["high_c"]
        print(f"    GFS high: {gfs_high:.1f}C")

        # Load history
        era5_sorted    = load_era5_history(conn, city, days=30)
        gfs_era5_pairs = load_gfs_era5_pairs(conn, city, days=30)
        print(f"    ERA5 obs: {len(era5_sorted)}, GFS-ERA5 pairs: {len(gfs_era5_pairs[0])}")

        # 6-layer calibration
        result = calibrate(city, gfs_high, era5_sorted, gfs_era5_pairs, bmin, bmax)

        print(
            f"    raw={result['raw_prob']:.3f} L1={result['l1_prob']:.3f} "
            f"L2={result['l2_prob']:.3f} L3={result['l3_prob']:.3f} "
            f"L4={result['l4_prob']:.3f} L5={result['l5_prob']:.3f} "
            f"L6={result['l6_prob']:.3f} => FINAL={result['final_prob']:.3f}"
        )

        # Write to DB
        try:
            conn.execute(
                "INSERT OR REPLACE INTO weather_calibrations "
                "(condition_id, city, forecast_date, bucket_min_c, bucket_max_c, "
                "raw_prob, l1_prob, l2_prob, l3_prob, l4_prob, l5_prob, l6_prob, "
                "final_prob, emos_mu_c, emos_sigma_c, history_days) "
                "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    cid, city, fdate,
                    None if bmin == -INF else bmin,
                    None if bmax ==  INF else bmax,
                    result["raw_prob"],  result["l1_prob"],  result["l2_prob"],
                    result["l3_prob"],   result["l4_prob"],  result["l5_prob"],
                    result["l6_prob"],   result["final_prob"],
                    result["emos_mu_c"], result["emos_sigma_c"], result["history_days"],
                )
            )
            conn.commit()
            calibrated += 1
        except sqlite3.Error as e:
            print(f"    [DB] Write error: {e}")

        time.sleep(0.3)

    print(f"\n[Summary] Calibrated: {calibrated} | Skipped: {skipped}")
    return calibrated


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
def main():
    print("=" * 60)
    print("Polybot Weather Calibration Service")
    print(f"DB: {DB_PATH}")
    print(f"Started: {datetime.now(timezone.utc).isoformat()}")
    print("=" * 60)

    if not os.path.exists(DB_PATH):
        print(f"[ERROR] DB not found at {DB_PATH}")
        print("Set POLYBOT_DB env var or ensure the database exists.")
        return

    conn = get_conn()
    try:
        init_tables(conn)
        n = run_calibration(conn)
        print("=" * 60)
        print(f"Done. Calibrated {n} weather markets.")
        print(f"Finished: {datetime.now(timezone.utc).isoformat()}")
        print("=" * 60)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
