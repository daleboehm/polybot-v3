#!/usr/bin/env python3
"""
Multi-Platform Prediction Market Reference Module
===================================================
Pulls reference data from 6 source categories and matches against Polymarket
to identify cross-platform arbitrage, probability divergence, and pricing edges.

Sources:
  1. Kalshi          — CFTC-regulated prediction market (public API, no auth)
  2. Manifold Markets — Play-money prediction market (public API, wide coverage)
  3. Metaculus        — Community forecasting (API token required)
  4. PredictIt        — Political prediction market (public API, no auth)
  5. Sportsbook Odds  — Traditional betting lines via The Odds API (free tier: 500 req/mo)
  6. CoinGecko        — Crypto prices for cross-ref with crypto direction markets
  7. FRED             — Federal Reserve economic data (free API key required)
  8. Polling Data     — RealClearPolitics / NYT for political markets

Usage:
  python3 kalshi_reference.py --scan          # Full scan: all platforms, match, report
  python3 kalshi_reference.py --scan-fast     # Quick scan: prediction markets only (skip odds/polls)
  python3 kalshi_reference.py --report        # Report on previously matched markets
  python3 kalshi_reference.py --overlap       # Show overlap statistics
  python3 kalshi_reference.py --crypto        # Crypto price reference only

Designed to run on VPS alongside rd_trader_v3.py. Stores matches in rd_ledger.db
(table: cross_platform_ref).
"""
import json
import logging
import os
import re
import sqlite3
import sys
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
from difflib import SequenceMatcher

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("kalshi_ref")

# ═══════════════════════════════════════════════════════════════════════
# CONFIGURATION
# ═══════════════════════════════════════════════════════════════════════

KALSHI_API = "https://api.elections.kalshi.com/trade-api/v2"
POLYMARKET_GAMMA = "https://gamma-api.polymarket.com"
MANIFOLD_API = "https://api.manifold.markets"
METACULUS_API = "https://www.metaculus.com/api2"
ODDS_API = "https://api.the-odds-api.com/v4"
COINGECKO_API = "https://api.coingecko.com/api/v3"
PREDICTIT_API = "https://www.predictit.org/api/marketdata/all/"
FRED_API = "https://api.stlouisfed.org/fred"
RCP_URL = "https://www.realclearpolling.com/polls"

# Rate limiting
KALSHI_RATE_LIMIT = 0.06   # 60ms between requests (~16/sec, under 20/sec limit)
POLY_RATE_LIMIT = 0.10     # 100ms for Polymarket
MANIFOLD_RATE_LIMIT = 0.15 # 150ms (500 req/min limit)
METACULUS_RATE_LIMIT = 0.25 # conservative — rate limits not published
ODDS_RATE_LIMIT = 1.0      # 1 req/sec — free tier is 500 req/month, conserve
COINGECKO_RATE_LIMIT = 2.5  # free tier: 10-30 req/min
PREDICTIT_RATE_LIMIT = 1.0  # 1 req/min documented limit
FRED_RATE_LIMIT = 0.5       # conservative

# Matching thresholds
TITLE_SIMILARITY_THRESHOLD = 0.55  # Minimum fuzzy match score (0-1)
ARB_SPREAD_THRESHOLD = 0.02        # 2 cents minimum spread to flag as opportunity
MIN_KALSHI_VOLUME = 100            # Minimum Kalshi volume to consider

# API keys (optional — set via env vars)
METACULUS_TOKEN = os.environ.get("METACULUS_TOKEN", "")
ODDS_API_KEY = os.environ.get("ODDS_API_KEY", "")
FRED_API_KEY = os.environ.get("FRED_API_KEY", "")

# FRED series relevant to Polymarket economic markets
# Maps FRED series ID -> (description, poly_keywords for matching)
FRED_SERIES = {
    "FEDFUNDS": ("Federal Funds Effective Rate", ["fed", "federal reserve", "interest rate", "rate cut", "rate hike", "fomc"]),
    "UNRATE": ("Unemployment Rate", ["unemployment", "jobs", "labor"]),
    "CPIAUCSL": ("Consumer Price Index (CPI)", ["cpi", "inflation", "consumer price"]),
    "GDP": ("Gross Domestic Product", ["gdp", "recession", "economic growth"]),
    "T10Y2Y": ("10Y-2Y Treasury Spread", ["yield curve", "treasury", "recession indicator"]),
    "DTWEXBGS": ("Trade Weighted US Dollar Index", ["dollar", "usd index", "currency"]),
    "VIXCLS": ("CBOE Volatility Index (VIX)", ["vix", "volatility", "market fear"]),
    "SP500": ("S&P 500", ["s&p", "sp500", "stock market", "s&p 500"]),
}

# Crypto assets to track — mapped to common Polymarket question patterns
CRYPTO_ASSETS = {
    "bitcoin": {"id": "bitcoin", "symbol": "BTC", "poly_patterns": [
        "bitcoin", "btc", "bitcoin price", "btc price",
    ]},
    "ethereum": {"id": "ethereum", "symbol": "ETH", "poly_patterns": [
        "ethereum", "eth", "ethereum price", "eth price",
    ]},
    "solana": {"id": "solana", "symbol": "SOL", "poly_patterns": [
        "solana", "sol price",
    ]},
    "xrp": {"id": "ripple", "symbol": "XRP", "poly_patterns": [
        "xrp", "ripple",
    ]},
    "dogecoin": {"id": "dogecoin", "symbol": "DOGE", "poly_patterns": [
        "dogecoin", "doge",
    ]},
}

# Sports to fetch odds for (The Odds API sport keys)
SPORTS_KEYS = [
    "americanfootball_nfl",
    "basketball_nba",
    "baseball_mlb",
    "icehockey_nhl",
    "soccer_epl",
    "soccer_usa_mls",
    "mma_mixed_martial_arts",
    "boxing_boxing",
]

# Database
DB_PATH = "rd_ledger.db"

# Common headers to avoid 403 errors
COMMON_HEADERS = {
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (compatible; ArmorstackRD/1.0)",
}

# ═══════════════════════════════════════════════════════════════════════
# DATABASE SETUP
# ═══════════════════════════════════════════════════════════════════════

def init_db():
    """Create cross-platform reference table if it doesn't exist."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")

    # Expanded table for all reference platforms
    conn.execute("""
        CREATE TABLE IF NOT EXISTS cross_platform_ref (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT NOT NULL,
            source_id TEXT NOT NULL,
            source_title TEXT,
            source_category TEXT,
            source_yes_price REAL,
            source_volume REAL,
            source_close_time TEXT,
            poly_condition_id TEXT,
            poly_question TEXT,
            poly_yes_price REAL,
            match_score REAL,
            spread REAL,
            arb_direction TEXT,
            scanned_at TEXT,
            UNIQUE(source, source_id, poly_condition_id)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_xref_spread ON cross_platform_ref(spread DESC)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_xref_source ON cross_platform_ref(source)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_xref_scanned ON cross_platform_ref(scanned_at)")

    # Keep legacy table name as view for backwards compat
    try:
        conn.execute("CREATE VIEW IF NOT EXISTS kalshi_reference AS SELECT * FROM cross_platform_ref WHERE source='kalshi'")
    except Exception:
        pass

    conn.commit()
    conn.close()
    log.info("Database initialized")


# ═══════════════════════════════════════════════════════════════════════
# KALSHI API
# ═══════════════════════════════════════════════════════════════════════

def kalshi_get(endpoint, params=None):
    """GET request to Kalshi public API (no auth required for market data)."""
    url = f"{KALSHI_API}{endpoint}"
    if params:
        query = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
        if query:
            url += f"?{query}"

    req = urllib.request.Request(url)
    req.add_header("Accept", "application/json")
    req.add_header("User-Agent", "ArmorstackRD/1.0")

    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        log.error(f"Kalshi API error {e.code}: {e.read().decode()[:200]}")
        return None
    except Exception as e:
        log.error(f"Kalshi API request failed: {e}")
        return None


def fetch_kalshi_markets(status="open", limit=1000, max_pages=10):
    """Fetch all open Kalshi markets with pagination."""
    all_markets = []
    cursor = None

    for page in range(max_pages):
        params = {"status": status, "limit": str(limit)}
        if cursor:
            params["cursor"] = cursor

        data = kalshi_get("/markets", params)
        if not data or "markets" not in data:
            log.warning(f"Kalshi page {page}: no data returned")
            break

        markets = data["markets"]
        all_markets.extend(markets)
        log.info(f"Kalshi page {page}: {len(markets)} markets (total: {len(all_markets)})")

        cursor = data.get("cursor")
        if not cursor or len(markets) < limit:
            break

        time.sleep(KALSHI_RATE_LIMIT)

    return all_markets


def get_kalshi_orderbook(ticker):
    """Get current orderbook for a Kalshi market."""
    data = kalshi_get(f"/markets/{ticker}/orderbook")
    if not data or "orderbook" not in data:
        return None, None

    ob = data["orderbook"]
    # Best yes bid and no bid
    yes_price = None
    no_price = None

    yes_bids = ob.get("yes", [])
    no_bids = ob.get("no", [])

    if yes_bids:
        # Highest yes bid = best yes price
        yes_price = max(float(b[0]) / 100 for b in yes_bids) if yes_bids else None
    if no_bids:
        no_price = max(float(b[0]) / 100 for b in no_bids) if no_bids else None

    return yes_price, no_price


# ═══════════════════════════════════════════════════════════════════════
# POLYMARKET API
# ═══════════════════════════════════════════════════════════════════════

def _api_get(url, extra_headers=None, timeout=15):
    """Generic GET request with proper headers."""
    req = urllib.request.Request(url)
    for k, v in COMMON_HEADERS.items():
        req.add_header(k, v)
    if extra_headers:
        for k, v in extra_headers.items():
            req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode()[:200]
        except Exception:
            pass
        log.error(f"HTTP {e.code} for {url[:80]}: {body}")
        return None
    except Exception as e:
        log.error(f"Request failed for {url[:80]}: {e}")
        return None


def fetch_poly_markets(limit=100, max_pages=20):
    """Fetch active Polymarket markets via Gamma API."""
    all_markets = []
    for page in range(max_pages):
        offset = page * limit
        url = f"{POLYMARKET_GAMMA}/markets?limit={limit}&offset={offset}&active=true&closed=false"
        data = _api_get(url)
        if not data or not isinstance(data, list):
            break

        # Filter to markets with recent activity
        active = [m for m in data if m.get("volumeNum", 0) > 0]
        all_markets.extend(active)
        log.info(f"Polymarket page {page}: {len(active)} active markets (total: {len(all_markets)})")

        if len(data) < limit:
            break
        time.sleep(POLY_RATE_LIMIT)

    return all_markets


# ═══════════════════════════════════════════════════════════════════════
# MANIFOLD MARKETS API
# ═══════════════════════════════════════════════════════════════════════

def fetch_manifold_markets(limit=1000, max_pages=5):
    """Fetch active Manifold Markets (play money but wide coverage)."""
    all_markets = []
    last_id = None

    for page in range(max_pages):
        url = f"{MANIFOLD_API}/v0/markets?limit={limit}&sort=last-bet-time"
        if last_id:
            url += f"&before={last_id}"

        data = _api_get(url)
        if not data or not isinstance(data, list):
            break

        # Filter to open binary markets with probability
        binary = [m for m in data
                  if m.get("outcomeType") == "BINARY"
                  and m.get("isResolved") is False
                  and m.get("probability") is not None]

        all_markets.extend(binary)
        log.info(f"Manifold page {page}: {len(binary)} binary markets (total: {len(all_markets)})")

        if len(data) < limit:
            break
        last_id = data[-1].get("id") if data else None
        time.sleep(MANIFOLD_RATE_LIMIT)

    return all_markets


# ═══════════════════════════════════════════════════════════════════════
# METACULUS API
# ═══════════════════════════════════════════════════════════════════════

def fetch_metaculus_questions(limit=100, max_pages=5):
    """Fetch open Metaculus questions with community predictions."""
    if not METACULUS_TOKEN:
        log.info("Metaculus: no API token configured (set METACULUS_TOKEN env var). Skipping.")
        return []

    all_questions = []
    for page in range(max_pages):
        offset = page * limit
        url = f"{METACULUS_API}/questions/?limit={limit}&offset={offset}&status=open&type=binary&include_description=false"
        headers = {"Authorization": f"Token {METACULUS_TOKEN}"}
        data = _api_get(url, extra_headers=headers)

        if not data or "results" not in data:
            break

        results = data["results"]
        all_questions.extend(results)
        log.info(f"Metaculus page {page}: {len(results)} questions (total: {len(all_questions)})")

        if not data.get("next"):
            break
        time.sleep(METACULUS_RATE_LIMIT)

    return all_questions


# ═══════════════════════════════════════════════════════════════════════
# SPORTSBOOK ODDS (The Odds API)
# ═══════════════════════════════════════════════════════════════════════

def american_to_probability(american_odds):
    """Convert American odds (+150, -200) to implied probability (0-1)."""
    if american_odds > 0:
        return 100 / (american_odds + 100)
    else:
        return abs(american_odds) / (abs(american_odds) + 100)


def fetch_sportsbook_odds():
    """Fetch current sportsbook odds from The Odds API, convert to market-like format."""
    if not ODDS_API_KEY:
        log.info("Sportsbook: no API key configured (set ODDS_API_KEY env var). Skipping.")
        return []

    all_events = []

    for sport_key in SPORTS_KEYS:
        url = (f"{ODDS_API}/sports/{sport_key}/odds"
               f"?apiKey={ODDS_API_KEY}&regions=us&markets=h2h&oddsFormat=american")
        data = _api_get(url, timeout=20)
        if not data or not isinstance(data, list):
            log.warning(f"Odds API: no data for {sport_key}")
            time.sleep(ODDS_RATE_LIMIT)
            continue

        for event in data:
            home = event.get("home_team", "")
            away = event.get("away_team", "")
            commence = event.get("commence_time", "")
            sport = event.get("sport_title", sport_key)

            # Average odds across bookmakers for consensus line
            home_probs = []
            away_probs = []
            for bm in event.get("bookmakers", []):
                for market in bm.get("markets", []):
                    if market.get("key") != "h2h":
                        continue
                    for outcome in market.get("outcomes", []):
                        price = outcome.get("price")
                        if price is None:
                            continue
                        if outcome.get("name") == home:
                            home_probs.append(american_to_probability(price))
                        elif outcome.get("name") == away:
                            away_probs.append(american_to_probability(price))

            if not home_probs:
                continue

            avg_home_prob = sum(home_probs) / len(home_probs)
            avg_away_prob = sum(away_probs) / len(away_probs) if away_probs else (1 - avg_home_prob)

            # Create two "markets" — one for each team winning
            event_id = event.get("id", "")
            all_events.append({
                "question": f"{home} to win vs {away}",
                "id": f"{event_id}_home",
                "probability": round(avg_home_prob, 4),
                "volume": len(home_probs),  # number of bookmakers as proxy
                "category": sport,
                "close_time": commence,
            })
            all_events.append({
                "question": f"{away} to win vs {home}",
                "id": f"{event_id}_away",
                "probability": round(avg_away_prob, 4),
                "volume": len(away_probs),
                "category": sport,
                "close_time": commence,
            })

        log.info(f"Odds API: {sport_key} — {len(data)} events → {len(all_events)} markets so far")
        time.sleep(ODDS_RATE_LIMIT)

    log.info(f"Sportsbook: fetched {len(all_events)} total market lines")
    return all_events


# ═══════════════════════════════════════════════════════════════════════
# PREDICTIT API
# ═══════════════════════════════════════════════════════════════════════

def fetch_predictit_markets():
    """Fetch all open PredictIt markets. Public API, no auth required."""
    data = _api_get(PREDICTIT_API, timeout=30)
    if not data or "markets" not in data:
        log.warning("PredictIt: no data returned")
        return []

    all_contracts = []
    for market in data["markets"]:
        if market.get("status") != "Open":
            continue
        market_name = market.get("name", "")
        for contract in market.get("contracts", []):
            if contract.get("status") != "Open":
                continue
            # Build a question from market name + contract name
            contract_name = contract.get("name", "")
            if contract_name and contract_name != market_name:
                question = f"{market_name}: {contract_name}"
            else:
                question = market_name

            yes_price = contract.get("lastTradePrice") or contract.get("bestBuyYesCost")
            all_contracts.append({
                "question": question,
                "id": f"pi_{contract.get('id', '')}",
                "probability": yes_price,
                "volume": 0,  # PredictIt doesn't expose volume in this endpoint
                "category": "politics",
                "close_time": contract.get("dateEnd", ""),
            })

    log.info(f"PredictIt: fetched {len(all_contracts)} open contracts from {len(data['markets'])} markets")
    return all_contracts


# ═══════════════════════════════════════════════════════════════════════
# FRED ECONOMIC DATA
# ═══════════════════════════════════════════════════════════════════════

def fetch_fred_data():
    """Fetch latest values from FRED for economic series relevant to Polymarket.

    Returns dict of series_id -> {value, date, description, keywords}.
    Requires FRED_API_KEY env var (free at https://fred.stlouisfed.org/docs/api/api_key.html).
    """
    if not FRED_API_KEY:
        log.info("FRED: no API key configured (set FRED_API_KEY env var). Skipping.")
        return {}

    results = {}
    for series_id, (description, keywords) in FRED_SERIES.items():
        url = (f"{FRED_API}/series/observations"
               f"?series_id={series_id}&api_key={FRED_API_KEY}"
               f"&file_type=json&sort_order=desc&limit=1")
        data = _api_get(url)
        if not data or "observations" not in data:
            log.warning(f"FRED: no data for {series_id}")
            time.sleep(FRED_RATE_LIMIT)
            continue

        obs = data["observations"]
        if obs:
            latest = obs[0]
            try:
                value = float(latest.get("value", 0))
            except (ValueError, TypeError):
                value = None
            results[series_id] = {
                "value": value,
                "date": latest.get("date", ""),
                "description": description,
                "keywords": keywords,
            }
            log.info(f"  FRED {series_id}: {value} ({latest.get('date', '')})")

        time.sleep(FRED_RATE_LIMIT)

    return results


def match_fred_to_poly(fred_data, poly_lookup):
    """Match FRED economic data against Polymarket markets using keyword matching.

    Unlike prediction market matching, FRED provides reference values (rates, indexes)
    not probabilities. We identify which Poly markets are about these economic indicators
    and attach the current value as context for the trader.
    """
    matches = []

    for series_id, info in fred_data.items():
        if info["value"] is None:
            continue

        keywords = info["keywords"]
        for pm in poly_lookup:
            q_lower = pm["question"].lower()
            if not any(kw in q_lower for kw in keywords):
                continue

            # Try to extract a threshold from the Polymarket question
            # e.g., "Will unemployment rate exceed 5% in 2026?"
            threshold = None
            pct_match = re.search(r'(\d+(?:\.\d+)?)\s*%', pm["question"])
            if pct_match:
                try:
                    threshold = float(pct_match.group(1))
                except ValueError:
                    pass

            # Build reference probability based on current value vs threshold
            ref_prob = None
            if threshold is not None and info["value"] is not None:
                current = info["value"]
                # Heuristic: if question asks "above X%" and current is already above, higher prob
                above_words = ["above", "exceed", "over", "higher", "rise above", "reach"]
                below_words = ["below", "under", "fall below", "drop below"]
                if any(w in q_lower for w in above_words):
                    ratio = current / threshold if threshold > 0 else 1
                    ref_prob = min(0.95, max(0.05, 0.5 + (ratio - 1) * 2))
                elif any(w in q_lower for w in below_words):
                    ratio = current / threshold if threshold > 0 else 1
                    ref_prob = min(0.95, max(0.05, 0.5 - (ratio - 1) * 2))

            spread = None
            arb_dir = None
            if ref_prob is not None and pm["yes_price"] is not None:
                spread = abs(ref_prob - pm["yes_price"])
                if ref_prob < pm["yes_price"]:
                    arb_dir = "POLY_OVERPRICED"
                elif ref_prob > pm["yes_price"]:
                    arb_dir = "POLY_UNDERPRICED"

            source_title = f"{info['description']}: {info['value']}"
            if threshold:
                source_title += f" (threshold: {threshold}%)"

            matches.append({
                "source": "fred",
                "source_id": f"{series_id}_{threshold or 'general'}",
                "source_title": source_title,
                "source_category": "economics",
                "source_yes_price": ref_prob,
                "source_volume": 0,
                "source_close_time": "",
                "poly_condition_id": pm["condition_id"],
                "poly_question": pm["question"],
                "poly_yes_price": pm["yes_price"],
                "match_score": 0.90,  # keyword match, not fuzzy
                "spread": spread,
                "arb_direction": arb_dir,
            })

    log.info(f"[fred] Matched {len(matches)} economic-related Polymarket markets")
    return matches


# ═══════════════════════════════════════════════════════════════════════
# COINGECKO CRYPTO REFERENCE
# ═══════════════════════════════════════════════════════════════════════

def fetch_crypto_prices():
    """Fetch current crypto prices and build reference signals for Polymarket crypto markets.

    Tries /coins/markets first (rich data), falls back to /simple/price (lighter endpoint).
    Retries once on 429 with backoff.
    """
    coin_ids = ",".join(c["id"] for c in CRYPTO_ASSETS.values())

    # Try rich endpoint first
    url = (f"{COINGECKO_API}/coins/markets"
           f"?vs_currency=usd&ids={coin_ids}&order=market_cap_desc"
           f"&per_page=20&page=1&sparkline=false"
           f"&price_change_percentage=1h,24h,7d")

    data = _api_get(url)

    # Retry once on rate limit
    if not data:
        log.info("CoinGecko: retrying after 5s backoff...")
        time.sleep(5)
        data = _api_get(url)

    if data and isinstance(data, list):
        prices = {}
        for coin in data:
            cid = coin.get("id", "")
            prices[cid] = {
                "symbol": coin.get("symbol", "").upper(),
                "price": coin.get("current_price"),
                "market_cap": coin.get("market_cap"),
                "volume_24h": coin.get("total_volume"),
                "change_1h": coin.get("price_change_percentage_1h_in_currency"),
                "change_24h": coin.get("price_change_percentage_24h_in_currency"),
                "change_7d": coin.get("price_change_percentage_7d_in_currency"),
                "ath": coin.get("ath"),
                "ath_change_pct": coin.get("ath_change_percentage"),
            }
            log.info(f"  {prices[cid]['symbol']}: ${coin.get('current_price', 0):,.2f} "
                     f"(24h: {coin.get('price_change_percentage_24h_in_currency', 0):+.1f}%)")
        return prices

    # Fallback: simpler /simple/price endpoint (less data but lower rate limit hit)
    log.info("CoinGecko: falling back to /simple/price endpoint")
    time.sleep(3)
    simple_url = (f"{COINGECKO_API}/simple/price"
                  f"?ids={coin_ids}&vs_currencies=usd"
                  f"&include_24hr_change=true&include_24hr_vol=true")
    simple_data = _api_get(simple_url)
    if not simple_data or not isinstance(simple_data, dict):
        log.warning("CoinGecko: both endpoints failed. Skipping crypto reference.")
        return {}

    prices = {}
    for cid, pdata in simple_data.items():
        asset = next((a for a in CRYPTO_ASSETS.values() if a["id"] == cid), None)
        sym = asset["symbol"] if asset else cid.upper()
        price = pdata.get("usd", 0)
        change_24h = pdata.get("usd_24h_change", 0)
        vol_24h = pdata.get("usd_24h_vol", 0)
        prices[cid] = {
            "symbol": sym,
            "price": price,
            "market_cap": None,
            "volume_24h": vol_24h,
            "change_1h": None,
            "change_24h": change_24h,
            "change_7d": None,
            "ath": None,
            "ath_change_pct": None,
        }
        log.info(f"  {sym}: ${price:,.2f} (24h: {change_24h:+.1f}%)")

    return prices


def match_crypto_to_poly(crypto_prices, poly_lookup):
    """Match crypto price data against Polymarket crypto-related markets.

    Unlike fuzzy title matching, this uses keyword matching to find crypto markets
    and then attaches the current price data as reference context.
    """
    matches = []

    for asset_name, asset_info in CRYPTO_ASSETS.items():
        price_data = crypto_prices.get(asset_info["id"])
        if not price_data:
            continue

        patterns = asset_info["poly_patterns"]

        for pm in poly_lookup:
            q_lower = pm["question"].lower()
            # Check if this Polymarket question is about this crypto asset
            if not any(p in q_lower for p in patterns):
                continue

            # Try to extract a price target from the question
            # e.g., "Will Bitcoin reach $100,000 by end of 2026?"
            price_target = None
            price_match = re.search(r'\$([0-9,]+(?:\.\d+)?)', pm["question"])
            if price_match:
                try:
                    price_target = float(price_match.group(1).replace(",", ""))
                except ValueError:
                    pass

            # Build reference probability from price data
            ref_prob = None
            current_price = price_data["price"]
            if price_target and current_price:
                # Simple heuristic: probability based on distance to target
                ratio = current_price / price_target
                if ratio >= 1.0:
                    # Already above target
                    ref_prob = min(0.95, 0.5 + (ratio - 1.0) * 2)
                else:
                    # Below target — use 7d momentum to estimate
                    change_7d = price_data.get("change_7d") or 0
                    # Rough: if price is within 10% and trending up, higher prob
                    if ratio > 0.9 and change_7d > 0:
                        ref_prob = 0.4 + ratio * 0.3
                    elif ratio > 0.7:
                        ref_prob = 0.2 + ratio * 0.2
                    else:
                        ref_prob = max(0.05, ratio * 0.3)

            spread = None
            arb_dir = None
            if ref_prob is not None and pm["yes_price"] is not None:
                spread = abs(ref_prob - pm["yes_price"])
                if ref_prob < pm["yes_price"]:
                    arb_dir = "POLY_OVERPRICED"
                elif ref_prob > pm["yes_price"]:
                    arb_dir = "POLY_UNDERPRICED"

            matches.append({
                "source": "coingecko",
                "source_id": f"{asset_info['symbol']}_{price_target or 'general'}",
                "source_title": f"{asset_info['symbol']} ${current_price:,.2f} (24h:{price_data.get('change_24h', 0):+.1f}%)",
                "source_category": "crypto",
                "source_yes_price": ref_prob,
                "source_volume": price_data.get("volume_24h", 0),
                "source_close_time": "",
                "poly_condition_id": pm["condition_id"],
                "poly_question": pm["question"],
                "poly_yes_price": pm["yes_price"],
                "match_score": 0.95,  # keyword match, not fuzzy
                "spread": spread,
                "arb_direction": arb_dir,
            })

    log.info(f"[coingecko] Matched {len(matches)} crypto-related Polymarket markets")
    return matches


def print_crypto_report(crypto_prices):
    """Print a standalone crypto price reference report."""
    print("=" * 70)
    print("  CRYPTO PRICE REFERENCE")
    print(f"  {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print("=" * 70)

    if not crypto_prices:
        print("  No crypto data available.")
        return

    print(f"\n  {'Asset':8s} | {'Price':>12s} | {'1h':>7s} | {'24h':>7s} | {'7d':>7s} | {'ATH Dist':>8s} | {'Vol 24h':>14s}")
    print(f"  {'-'*8}-+-{'-'*12}-+-{'-'*7}-+-{'-'*7}-+-{'-'*7}-+-{'-'*8}-+-{'-'*14}")
    for cid, p in sorted(crypto_prices.items(), key=lambda x: x[1].get("market_cap", 0) or 0, reverse=True):
        sym = p.get("symbol", cid.upper())
        price = p.get("price", 0) or 0
        c1h = p.get("change_1h", 0) or 0
        c24h = p.get("change_24h", 0) or 0
        c7d = p.get("change_7d", 0) or 0
        ath_pct = p.get("ath_change_pct", 0) or 0
        vol = p.get("volume_24h", 0) or 0
        print(f"  {sym:8s} | ${price:>11,.2f} | {c1h:>+6.1f}% | {c24h:>+6.1f}% | {c7d:>+6.1f}% | {ath_pct:>+6.1f}% | ${vol:>13,.0f}")
    print()


# ═══════════════════════════════════════════════════════════════════════
# POLLING / POLITICAL REFERENCE
# ═══════════════════════════════════════════════════════════════════════

def fetch_polling_reference():
    """Fetch political polling/approval data from public sources.

    Uses RealClearPolitics internal JSON (poll page IDs), Silver Bulletin
    where available, and NYT/538 successor data.
    Returns normalized market-like entries for matching against Polymarket.
    """
    markets = []

    # --- RealClearPolitics internal JSON ---
    # RCP embeds JSON data at /epolls/json/{poll_id} — known IDs for key polls
    rcp_polls = [
        # (poll_id, description, category)
        ("6179", "President Trump Job Approval", "approval"),
        ("6185", "Direction of Country", "direction"),
        ("6190", "Congressional Job Approval", "congressional"),
    ]
    for poll_id, desc, category in rcp_polls:
        url = f"https://www.realclearpolitics.com/epolls/json/{poll_id}_historical.json"
        data = _api_get(url)
        if not data:
            # Try alternate format
            url = f"https://www.realclearpolitics.com/epolls/json/{poll_id}.json"
            data = _api_get(url)
        if not data:
            log.warning(f"RCP: no data for {desc} (ID {poll_id})")
            continue

        # RCP JSON has either {poll: {rcp_avg: ...}} or list format
        if isinstance(data, dict):
            rcp_avg = data.get("rcp_avg") or data.get("rcp_average")
            if rcp_avg:
                try:
                    prob = float(rcp_avg) / 100 if float(rcp_avg) > 1 else float(rcp_avg)
                except (ValueError, TypeError):
                    prob = None
                markets.append({
                    "question": desc,
                    "id": f"rcp_{poll_id}",
                    "probability": prob,
                    "volume": 0,
                    "category": f"politics_{category}",
                    "close_time": "",
                })
        elif isinstance(data, list) and data:
            # Take the most recent entry
            latest = data[-1] if data else {}
            value = latest.get("value", latest.get("rcp_average"))
            if value is not None:
                try:
                    prob = float(value) / 100 if float(value) > 1 else float(value)
                except (ValueError, TypeError):
                    prob = None
                markets.append({
                    "question": desc,
                    "id": f"rcp_{poll_id}",
                    "probability": prob,
                    "volume": 0,
                    "category": f"politics_{category}",
                    "close_time": "",
                })

    log.info(f"RCP: fetched {len(markets)} polling entries")

    # --- Silver Bulletin / Nate Silver (Substack — no public API) ---
    # Silver Bulletin doesn't expose a JSON API. Skipping programmatic access.
    # When a public endpoint becomes available, add it here.
    log.info("Silver Bulletin: no public API available (Substack-hosted)")

    # --- NYT polling tracker (successor to 538) ---
    # NYT picked up 538's poll tracking in March 2025
    nyt_url = "https://static01.nyt.com/newsgraphics/2024-election-tracker/data/polls.json"
    nyt_data = _api_get(nyt_url)
    if nyt_data and isinstance(nyt_data, list):
        for poll in nyt_data[:30]:
            question = poll.get("question", poll.get("race", ""))
            if not question:
                continue
            candidates = poll.get("candidates", poll.get("answers", []))
            if not candidates:
                continue
            best_pct = 0
            best_name = ""
            for c in candidates:
                pct = float(c.get("pct", c.get("value", 0)))
                if pct > best_pct:
                    best_pct = pct
                    best_name = c.get("name", c.get("choice", ""))
            if best_pct > 0:
                markets.append({
                    "question": f"{question}: {best_name}" if best_name else question,
                    "id": f"nyt_{hash(question) % 100000}",
                    "probability": best_pct / 100 if best_pct > 1 else best_pct,
                    "volume": int(poll.get("sample_size", 0)),
                    "category": "politics_poll",
                    "close_time": "",
                })
        log.info(f"NYT/538: added {min(30, len(nyt_data))} polls (total: {len(markets)})")
    else:
        log.info("NYT/538: no data at known endpoint")

    return markets


# ═══════════════════════════════════════════════════════════════════════
# MARKET MATCHING
# ═══════════════════════════════════════════════════════════════════════

def normalize_title(title):
    """Normalize market title for matching."""
    if not title:
        return ""
    # Lowercase, remove extra whitespace, common noise words
    t = title.lower().strip()
    # Remove date suffixes like "(Jan 15)" or "by January 15, 2026"
    t = re.sub(r'\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2},?\s*\d{0,4}', '', t)
    # Remove parenthetical content
    t = re.sub(r'\([^)]*\)', '', t)
    # Remove "will" "the" "a" etc
    t = re.sub(r'\b(will|the|a|an|be|to|of|in|on|at|by|for|is|are|was|were)\b', '', t)
    # Collapse whitespace
    t = re.sub(r'\s+', ' ', t).strip()
    return t


def build_poly_lookup(poly_markets):
    """Build normalized Polymarket lookup list."""
    poly_lookup = []
    for m in poly_markets:
        question = m.get("question", "")
        condition_id = m.get("conditionId", m.get("condition_id", ""))
        if not question or not condition_id:
            continue

        # Parse prices
        yes_price = None
        # Try outcomePrices first
        prices_str = m.get("outcomePrices", "")
        if prices_str and isinstance(prices_str, str):
            try:
                prices = json.loads(prices_str)
                if len(prices) >= 1 and float(prices[0]) > 0:
                    yes_price = float(prices[0])
            except Exception:
                pass

        # Try tokens
        if yes_price is None:
            tokens = m.get("tokens", [])
            if isinstance(tokens, str):
                try:
                    tokens = json.loads(tokens)
                except Exception:
                    tokens = []
            for tok in tokens:
                outcome = tok.get("outcome", "")
                price = tok.get("price")
                if price is not None and outcome.upper() == "YES":
                    yes_price = float(price)

        # Try bestBid/bestAsk midpoint
        if yes_price is None:
            bid = m.get("bestBid", 0)
            ask = m.get("bestAsk", 0)
            if bid > 0 and ask > 0:
                yes_price = (bid + ask) / 2

        poly_lookup.append({
            "condition_id": condition_id,
            "question": question,
            "normalized": normalize_title(question),
            "yes_price": yes_price,
        })
    return poly_lookup


def _extract_keywords(text):
    """Extract significant keywords (3+ chars) from normalized text for pre-filtering."""
    stop = {"will", "the", "and", "for", "with", "that", "this", "from", "have", "been",
            "not", "but", "what", "who", "how", "when", "where", "which", "than", "more",
            "before", "after", "above", "below", "between", "does", "has", "had", "its",
            "over", "under", "into", "out", "can", "could", "would", "should", "may",
            "might", "must", "yes", "price", "market"}
    return {w for w in text.split() if len(w) >= 3 and w not in stop}


def match_against_poly(ref_markets, poly_lookup, source_name):
    """Match reference platform markets against Polymarket using keyword pre-filter + fuzzy matching.

    Optimization: only run expensive SequenceMatcher on pairs that share at least one keyword.
    Reduces O(n*m) to O(n * k) where k << m.
    """
    log.info(f"Matching {len(ref_markets)} {source_name} markets against {len(poly_lookup)} Polymarket markets")

    # Build keyword index for Polymarket markets
    poly_keyword_index = {}  # keyword -> list of poly_lookup indices
    for i, pm in enumerate(poly_lookup):
        for kw in _extract_keywords(pm["normalized"]):
            poly_keyword_index.setdefault(kw, []).append(i)

    matches = []
    checked = 0
    comparisons = 0

    for rm in ref_markets:
      try:
        # Extract title and price based on source
        if source_name == "kalshi":
            title = rm.get("title", rm.get("subtitle", ""))
            ref_id = rm.get("ticker", "")
            ref_yes = rm.get("yes_ask", rm.get("last_price"))
            if ref_yes is not None and ref_yes > 1:
                ref_yes = ref_yes / 100  # cents to dollars
            ref_volume = rm.get("volume", 0)
            ref_category = rm.get("category", "")
            ref_close = rm.get("close_time", "")
        elif source_name == "manifold":
            title = rm.get("question", "")
            ref_id = rm.get("id", "")
            ref_yes = rm.get("probability")
            ref_volume = rm.get("totalLiquidity", rm.get("volume", 0))
            ref_category = rm.get("groupSlugs", [""])[0] if rm.get("groupSlugs") else ""
            ref_close = rm.get("closeTime", "")
            if ref_close and isinstance(ref_close, (int, float)):
                try:
                    ref_close = datetime.fromtimestamp(ref_close / 1000, tz=timezone.utc).isoformat()
                except (ValueError, OSError):
                    ref_close = ""
        elif source_name == "metaculus":
            title = rm.get("title", "")
            ref_id = str(rm.get("id", ""))
            agg = rm.get("aggregations", {})
            community = agg.get("recency_weighted", {})
            history = community.get("history", [])
            ref_yes = history[-1].get("centers", [None])[0] if history else None
            ref_volume = rm.get("number_of_forecasters", 0)
            ref_category = rm.get("category", "")
            ref_close = rm.get("resolve_time", "")
        elif source_name in ("sportsbook", "polling", "predictit"):
            title = rm.get("question", "")
            ref_id = rm.get("id", "")
            ref_yes = rm.get("probability")
            ref_volume = rm.get("volume", 0)
            ref_category = rm.get("category", "")
            ref_close = rm.get("close_time", "")
        else:
            continue

        norm = normalize_title(title)
        if not norm or len(norm) < 8:
            continue

        # Keyword pre-filter: only compare against Poly markets sharing keywords
        ref_keywords = _extract_keywords(norm)
        candidate_indices = set()
        for kw in ref_keywords:
            for idx in poly_keyword_index.get(kw, []):
                candidate_indices.add(idx)

        # If no keyword overlap at all, skip (no chance of matching)
        if not candidate_indices:
            checked += 1
            continue

        # Find best match among candidates only
        best_score = 0
        best_match = None

        for idx in candidate_indices:
            pm = poly_lookup[idx]
            score = SequenceMatcher(None, norm, pm["normalized"]).ratio()
            comparisons += 1
            if score > best_score:
                best_score = score
                best_match = pm

        if best_score >= TITLE_SIMILARITY_THRESHOLD and best_match:
            spread = None
            arb_dir = None
            if ref_yes is not None and best_match["yes_price"] is not None:
                spread = abs(ref_yes - best_match["yes_price"])
                if ref_yes < best_match["yes_price"]:
                    arb_dir = f"BUY_{source_name.upper()}_YES"
                elif ref_yes > best_match["yes_price"]:
                    arb_dir = "BUY_POLY_YES"

            matches.append({
                "source": source_name,
                "source_id": ref_id,
                "source_title": title,
                "source_category": ref_category,
                "source_yes_price": ref_yes,
                "source_volume": ref_volume,
                "source_close_time": ref_close,
                "poly_condition_id": best_match["condition_id"],
                "poly_question": best_match["question"],
                "poly_yes_price": best_match["yes_price"],
                "match_score": best_score,
                "spread": spread,
                "arb_direction": arb_dir,
            })

        checked += 1
        if checked % 1000 == 0:
            log.info(f"  [{source_name}] Checked {checked}/{len(ref_markets)}, "
                     f"{len(matches)} matches, {comparisons} comparisons")
      except (ValueError, OSError, TypeError) as e:
        checked += 1
        log.debug(f"  [{source_name}] Skipped market: {e}")
        continue

    log.info(f"[{source_name}] Found {len(matches)} matches (>= {TITLE_SIMILARITY_THRESHOLD} similarity) "
             f"from {comparisons} comparisons (vs {len(ref_markets)*len(poly_lookup)} brute force)")
    return matches


# ═══════════════════════════════════════════════════════════════════════
# STORAGE & REPORTING
# ═══════════════════════════════════════════════════════════════════════

def save_matches(matches):
    """Save matched markets to database."""
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=10000")
    now = datetime.now(timezone.utc).isoformat()

    saved = 0
    for m in matches:
        try:
            conn.execute("""
                INSERT OR REPLACE INTO cross_platform_ref
                (source, source_id, source_title, source_category,
                 source_yes_price, source_volume, source_close_time,
                 poly_condition_id, poly_question, poly_yes_price,
                 match_score, spread, arb_direction, scanned_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                m["source"], m["source_id"], m["source_title"], m["source_category"],
                m["source_yes_price"], m["source_volume"], m["source_close_time"],
                m["poly_condition_id"], m["poly_question"], m["poly_yes_price"],
                m["match_score"], m["spread"], m["arb_direction"], now
            ))
            saved += 1
        except Exception as e:
            log.warning(f"Save error for {m.get('source_id', '?')}: {e}")

    conn.commit()
    conn.close()
    log.info(f"Saved {saved}/{len(matches)} matches to database")
    return saved


def print_report():
    """Print report of matched markets and arbitrage opportunities."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    print("=" * 80)
    print("  MULTI-PLATFORM CROSS-REFERENCE REPORT")
    print(f"  {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M UTC')}")
    print("=" * 80)

    total = conn.execute("SELECT COUNT(*) FROM cross_platform_ref").fetchone()[0]
    if total == 0:
        print("\n  No matches found yet. Run --scan first.")
        conn.close()
        return

    arb_count = conn.execute(
        "SELECT COUNT(*) FROM cross_platform_ref WHERE spread >= ?", (ARB_SPREAD_THRESHOLD,)
    ).fetchone()[0]

    print(f"\n  Total matched markets:     {total:>8,}")
    print(f"  Arbitrage opportunities:   {arb_count:>8,} (>= {ARB_SPREAD_THRESHOLD*100:.1f}c spread)")

    # By source
    print(f"\n  BY SOURCE PLATFORM:")
    print(f"  {'Source':15s} | {'Matches':>8s} | {'Avg Spread':>10s} | {'Max Spread':>10s} | {'Arb (>2c)':>9s}")
    print(f"  {'-'*15}-+-{'-'*8}-+-{'-'*10}-+-{'-'*10}-+-{'-'*9}")
    for r in conn.execute("""
        SELECT source, COUNT(*) as cnt,
               ROUND(AVG(spread), 4) as avg_spread,
               ROUND(MAX(spread), 4) as max_spread,
               SUM(CASE WHEN spread >= 0.02 THEN 1 ELSE 0 END) as arb_count
        FROM cross_platform_ref
        WHERE spread IS NOT NULL
        GROUP BY source ORDER BY cnt DESC
    """).fetchall():
        print(f"  {r['source']:15s} | {r['cnt']:>8,} | {(r['avg_spread'] or 0)*100:>9.2f}c | {(r['max_spread'] or 0)*100:>9.2f}c | {r['arb_count']:>9,}")

    # Top arbitrage opportunities
    print(f"\n  TOP ARBITRAGE OPPORTUNITIES (spread >= {ARB_SPREAD_THRESHOLD*100:.1f}c):")
    print(f"  {'Source':10s} | {'ID/Ticker':20s} | {'Src':>5s} | {'Poly':>5s} | {'Spread':>7s} | {'Dir':20s} | {'Match':>5s}")
    print(f"  {'-'*10}-+-{'-'*20}-+-{'-'*5}-+-{'-'*5}-+-{'-'*7}-+-{'-'*20}-+-{'-'*5}")
    for r in conn.execute("""
        SELECT * FROM cross_platform_ref
        WHERE spread >= ?
        ORDER BY spread DESC LIMIT 30
    """, (ARB_SPREAD_THRESHOLD,)).fetchall():
        src_p = r["source_yes_price"] or 0
        poly_p = r["poly_yes_price"] or 0
        sid = (r["source_id"] or "")[:20]
        print(f"  {r['source']:10s} | {sid:20s} | {src_p:>.2f} | {poly_p:>.2f} | {(r['spread'] or 0)*100:>6.1f}c | {r['arb_direction'] or '':20s} | {r['match_score']*100:>4.0f}%")

    # Match quality distribution
    print(f"\n  MATCH QUALITY:")
    for r in conn.execute("""
        SELECT
            CASE
                WHEN match_score >= 0.90 THEN 'A: 90-100% (strong)'
                WHEN match_score >= 0.75 THEN 'B: 75-90% (good)'
                WHEN match_score >= 0.55 THEN 'C: 55-75% (fuzzy)'
                ELSE 'D: <55%'
            END as bucket,
            COUNT(*) as cnt
        FROM cross_platform_ref
        GROUP BY bucket ORDER BY bucket
    """).fetchall():
        print(f"    {r['bucket']:25s} — {r['cnt']:>6,} markets")

    print("\n" + "=" * 80)
    conn.close()


def print_overlap_stats():
    """Quick overlap statistics."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row

    total = conn.execute("SELECT COUNT(*) FROM cross_platform_ref").fetchone()[0]
    if total == 0:
        print("No matches found yet. Run --scan first.")
        conn.close()
        return

    print(f"Cross-Platform Overlap Statistics:")
    for r in conn.execute("""
        SELECT source, COUNT(*) as total,
               SUM(CASE WHEN match_score >= 0.85 THEN 1 ELSE 0 END) as high_quality,
               SUM(CASE WHEN spread >= 0.02 THEN 1 ELSE 0 END) as arb_2c,
               SUM(CASE WHEN spread >= 0.05 THEN 1 ELSE 0 END) as arb_5c,
               SUM(CASE WHEN spread >= 0.10 THEN 1 ELSE 0 END) as arb_10c
        FROM cross_platform_ref GROUP BY source
    """).fetchall():
        print(f"\n  {r['source'].upper()}:")
        print(f"    Total matched:         {r['total']:>6,}")
        print(f"    High-quality (>85%):   {r['high_quality']:>6,}")
        print(f"    Spread >= 2c:          {r['arb_2c']:>6,}")
        print(f"    Spread >= 5c:          {r['arb_5c']:>6,}")
        print(f"    Spread >= 10c:         {r['arb_10c']:>6,}")

    conn.close()


# ═══════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════

def run_scan(fast=False):
    """Full scan: fetch all platforms, match against Polymarket, store, report.

    Args:
        fast: If True, only scan prediction market platforms (skip odds/polls/crypto).
    """
    init_db()

    # --- Polymarket (common denominator) ---
    log.info("=== POLYMARKET FETCH ===")
    poly_markets = fetch_poly_markets(max_pages=10)
    log.info(f"Fetched {len(poly_markets)} Polymarket markets")
    poly_lookup = build_poly_lookup(poly_markets)
    log.info(f"Built lookup with {len(poly_lookup)} Polymarket entries")

    all_matches = []

    # --- Kalshi ---
    log.info("=== KALSHI MARKET FETCH ===")
    kalshi_markets = fetch_kalshi_markets(max_pages=10)
    log.info(f"Fetched {len(kalshi_markets)} Kalshi markets")
    if kalshi_markets:
        kalshi_matches = match_against_poly(kalshi_markets, poly_lookup, "kalshi")
        all_matches.extend(kalshi_matches)

    # --- Manifold Markets ---
    log.info("=== MANIFOLD MARKETS FETCH ===")
    manifold_markets = fetch_manifold_markets(max_pages=5)
    log.info(f"Fetched {len(manifold_markets)} Manifold markets")
    if manifold_markets:
        manifold_matches = match_against_poly(manifold_markets, poly_lookup, "manifold")
        all_matches.extend(manifold_matches)

    # --- Metaculus (optional — requires token) ---
    log.info("=== METACULUS FETCH ===")
    metaculus_questions = fetch_metaculus_questions(max_pages=5)
    if metaculus_questions:
        log.info(f"Fetched {len(metaculus_questions)} Metaculus questions")
        metaculus_matches = match_against_poly(metaculus_questions, poly_lookup, "metaculus")
        all_matches.extend(metaculus_matches)

    # --- PredictIt ---
    log.info("=== PREDICTIT FETCH ===")
    predictit_markets = fetch_predictit_markets()
    if predictit_markets:
        predictit_matches = match_against_poly(predictit_markets, poly_lookup, "predictit")
        all_matches.extend(predictit_matches)

    if not fast:
        # --- Sportsbook Odds (The Odds API) ---
        log.info("=== SPORTSBOOK ODDS FETCH ===")
        sports_markets = fetch_sportsbook_odds()
        if sports_markets:
            sports_matches = match_against_poly(sports_markets, poly_lookup, "sportsbook")
            all_matches.extend(sports_matches)

        # --- CoinGecko Crypto Reference ---
        log.info("=== COINGECKO CRYPTO FETCH ===")
        crypto_prices = fetch_crypto_prices()
        if crypto_prices:
            print_crypto_report(crypto_prices)
            crypto_matches = match_crypto_to_poly(crypto_prices, poly_lookup)
            all_matches.extend(crypto_matches)

        # --- FRED Economic Data ---
        log.info("=== FRED ECONOMIC DATA FETCH ===")
        fred_data = fetch_fred_data()
        if fred_data:
            fred_matches = match_fred_to_poly(fred_data, poly_lookup)
            all_matches.extend(fred_matches)

        # --- Polling / Political Reference ---
        log.info("=== POLLING DATA FETCH ===")
        poll_markets = fetch_polling_reference()
        if poll_markets:
            poll_matches = match_against_poly(poll_markets, poly_lookup, "polling")
            all_matches.extend(poll_matches)

    # --- Save & Report ---
    log.info(f"=== SAVING {len(all_matches)} TOTAL MATCHES ===")
    save_matches(all_matches)
    print_report()

    # Summary for integration with rd_trader_v3
    arb_opportunities = [m for m in all_matches if m.get("spread") and m["spread"] >= ARB_SPREAD_THRESHOLD]
    log.info(f"\nActionable arbitrage signals: {len(arb_opportunities)}")
    for m in sorted(arb_opportunities, key=lambda x: x.get("spread") or 0, reverse=True)[:10]:
        src_p = m.get("source_yes_price") or 0
        poly_p = m.get("poly_yes_price") or 0
        log.info(f"  [{m['source']}] {m['source_id']}: Src={src_p:.2f} Poly={poly_p:.2f} "
                 f"spread={m['spread']*100:.1f}c dir={m['arb_direction']} match={m['match_score']:.0%}")

    return all_matches


if __name__ == "__main__":
    if "--scan" in sys.argv:
        run_scan(fast=False)
    elif "--scan-fast" in sys.argv:
        run_scan(fast=True)
    elif "--crypto" in sys.argv:
        prices = fetch_crypto_prices()
        print_crypto_report(prices)
    elif "--report" in sys.argv:
        init_db()
        print_report()
    elif "--overlap" in sys.argv:
        init_db()
        print_overlap_stats()
    else:
        print("Usage:")
        print("  python3 kalshi_reference.py --scan       # Full scan: all 8 sources + match + report")
        print("  python3 kalshi_reference.py --scan-fast  # Quick: prediction markets only (Kalshi/Manifold/Metaculus/PredictIt)")
        print("  python3 kalshi_reference.py --crypto     # Crypto price reference only")
        print("  python3 kalshi_reference.py --report     # Report on existing matches")
        print("  python3 kalshi_reference.py --overlap    # Quick overlap stats")
        print()
        print("Environment variables:")
        print("  ODDS_API_KEY     — The Odds API key (free at https://the-odds-api.com)")
        print("  METACULUS_TOKEN  — Metaculus API token")
        print("  FRED_API_KEY     — FRED API key (free at https://fred.stlouisfed.org/docs/api/api_key.html)")
