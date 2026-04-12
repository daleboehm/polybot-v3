#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# ARMORSTACK POLYMARKET TRADING BOT — VPS DEPLOYMENT
# Run this once after SSH'ing into a fresh Ubuntu 24.04 droplet
#
# Usage:
#   chmod +x setup_vps.sh && ./setup_vps.sh
# ═══════════════════════════════════════════════════════════════════

set -e

echo "═══════════════════════════════════════════════════════"
echo "  ARMORSTACK POLYMARKET BOT — VPS SETUP"
echo "═══════════════════════════════════════════════════════"

# ─── 1. SYSTEM PACKAGES ─────────────────────────────────────────
echo ""
echo "📦 Installing system packages..."
apt update -qq
apt install -y -qq python3 python3-pip python3-venv ufw curl jq git > /dev/null 2>&1
echo "   ✅ System packages installed"

# ─── 2. FIREWALL ────────────────────────────────────────────────
echo ""
echo "🔒 Configuring firewall..."
ufw default deny incoming > /dev/null 2>&1
ufw default allow outgoing > /dev/null 2>&1
ufw allow 22/tcp > /dev/null 2>&1
echo "y" | ufw enable > /dev/null 2>&1
echo "   ✅ Firewall active — SSH only"

# ─── 3. APPLICATION DIRECTORY ────────────────────────────────────
echo ""
echo "📁 Creating application directory..."
mkdir -p /opt/armorstack/polymarket/state
mkdir -p /opt/armorstack/polymarket/logs
mkdir -p /opt/armorstack/polymarket/dashboard
cd /opt/armorstack/polymarket

# ─── 4. PYTHON VIRTUAL ENVIRONMENT ──────────────────────────────
echo ""
echo "🐍 Setting up Python environment..."
python3 -m venv /opt/armorstack/venv
source /opt/armorstack/venv/bin/activate
pip install --quiet --upgrade pip
pip install --quiet py-clob-client requests
echo "   ✅ Python venv + dependencies installed"

# ─── 5. GEOBLOCK CHECK ──────────────────────────────────────────
echo ""
echo "🌍 Checking Polymarket geoblock status..."
GEOBLOCK=$(curl -s "https://polymarket.com/api/geoblock")
BLOCKED=$(echo "$GEOBLOCK" | jq -r '.blocked')
COUNTRY=$(echo "$GEOBLOCK" | jq -r '.country')
IP=$(echo "$GEOBLOCK" | jq -r '.ip')

if [ "$BLOCKED" = "true" ]; then
    echo "   ❌ BLOCKED — IP: $IP, Country: $COUNTRY"
    echo "   This region cannot place orders. Choose a different droplet region."
    echo "   Recommended: Amsterdam (AMS3), Frankfurt (FRA1), or London (LON1)"
    exit 1
else
    echo "   ✅ NOT BLOCKED — IP: $IP, Country: $COUNTRY"
    echo "   This droplet can place Polymarket orders"
fi

# ─── 6. CREDENTIALS ─────────────────────────────────────────────
echo ""
echo "🔑 Setting up credentials..."

if [ ! -f /opt/armorstack/polymarket/state/api_keys.json ]; then
    echo ""
    echo "   ❌ CREDENTIAL FILE MISSING"
    echo ""
    echo "   This script no longer embeds secrets. Before first run, populate:"
    echo "   /opt/armorstack/polymarket/state/api_keys.json"
    echo ""
    echo "   Required keys:"
    echo "     GITHUB_TOKEN, GITHUB_REPO,"
    echo "     POLY_PRIVATE_KEY, POLY_API_KEY, POLY_SECRET, POLY_PASSPHRASE,"
    echo "     POLY_ACCOUNT_ADDRESS, POLY_PROXY_ADDRESS,"
    echo "     POLY_CHAIN_ID (137), POLY_CLOB_HOST (https://clob.polymarket.com)"
    echo ""
    echo "   Retrieve from the vault, chmod 600, then re-run this script."
    exit 1
else
    chmod 600 /opt/armorstack/polymarket/state/api_keys.json
    echo "   ✅ Credentials already exist (chmod 600 enforced)"
fi

# ─── 7. SPRINT TRADER SCRIPT ────────────────────────────────────
echo ""
echo "📝 Installing sprint trader..."

cat > /opt/armorstack/polymarket/sprint_trader.py << 'TRADER_EOF'
#!/usr/bin/env python3
"""
ARMORSTACK SPRINT TRADER — VPS Edition
Runs on DigitalOcean (non-US IP) to bypass CLOB API geoblock.
Scans weather temperature markets, runs GFS ensemble analysis,
places trades on highest-edge opportunities.
"""

import argparse
import json
import os
import re
import statistics
import sys
import time
from datetime import datetime, timezone, timedelta
from math import erf, sqrt

import requests

# ─── CONFIG ──────────────────────────────────────────────────────
STATE_DIR = "/opt/armorstack/polymarket/state"
LOG_DIR   = "/opt/armorstack/polymarket/logs"
GAMMA_API = "https://gamma-api.polymarket.com"
ENSEMBLE_API = "https://ensemble-api.open-meteo.com/v1/ensemble"

MIN_EDGE = 0.08
MAX_TOTAL_RISK = 20.0
MAX_PER_TRADE = 5.0

CITY_COORDS = {
    "hong kong": (22.32, 114.17), "taipei": (25.03, 121.57),
    "tel aviv": (32.07, 34.77), "london": (51.51, -0.13),
    "seoul": (37.57, 126.98), "shanghai": (31.23, 121.47),
    "tokyo": (35.68, 139.69), "singapore": (1.35, 103.82),
    "beijing": (39.90, 116.41), "madrid": (40.42, -3.70),
    "buenos aires": (-34.60, -58.38), "mumbai": (19.08, 72.88),
    "bangkok": (13.76, 100.50), "dubai": (25.20, 55.27),
    "sydney": (-33.87, 151.21), "new york": (40.71, -74.01),
    "nyc": (40.71, -74.01), "paris": (48.86, 2.35),
    "istanbul": (41.01, 28.98), "cairo": (30.04, 31.24),
    "toronto": (43.65, -79.38), "chicago": (41.88, -87.63),
    "los angeles": (34.05, -118.24), "berlin": (52.52, 13.41),
    "warsaw": (52.23, 21.01), "rome": (41.90, 12.50),
    "lucknow": (26.85, 80.95), "chongqing": (29.56, 106.55),
    "phoenix": (33.45, -112.07), "dallas": (32.78, -96.80),
    "miami": (25.76, -80.19), "denver": (39.74, -104.99),
    "osaka": (34.69, 135.50), "mexico city": (19.43, -99.13),
    "sao paulo": (-23.55, -46.63), "cape town": (-33.93, 18.42),
    "jakarta": (-6.21, 106.85), "hanoi": (21.03, 105.85),
    "manila": (14.60, 120.98), "kuala lumpur": (3.14, 101.69),
    "athens": (37.98, 23.73), "lisbon": (38.72, -9.14),
    "amsterdam": (52.37, 4.90), "dublin": (53.35, -6.26),
    "riyadh": (24.71, 46.67), "karachi": (24.86, 67.01),
    "dhaka": (23.81, 90.41), "colombo": (6.93, 79.84),
    "nairobi": (-1.29, 36.82), "johannesburg": (-26.20, 28.04),
    "lima": (-12.05, -77.04), "bogota": (4.71, -74.07),
    "santiago": (-33.45, -70.67), "moscow": (55.76, 37.62),
    "melbourne": (-37.81, 144.96), "vancouver": (49.28, -123.12),
    "ho chi minh city": (10.82, 106.63),
}


def log(msg):
    ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
    print(f"  [{ts}] {msg}")


def normal_cdf(x):
    return 0.5 * (1 + erf(x / sqrt(2)))


def prob_exact_temp(target, mean, std):
    if std < 0.01:
        return 1.0 if abs(target - mean) < 0.5 else 0.0
    return normal_cdf((target + 0.5 - mean) / std) - normal_cdf((target - 0.5 - mean) / std)


def load_credentials():
    path = os.path.join(STATE_DIR, "api_keys.json")
    with open(path) as f:
        return json.load(f)


def get_clob_client(keys):
    from py_clob_client.client import ClobClient
    from py_clob_client.clob_types import ApiCreds
    creds = ApiCreds(
        api_key=keys["POLY_API_KEY"],
        api_secret=keys["POLY_SECRET"],
        api_passphrase=keys["POLY_PASSPHRASE"],
    )
    return ClobClient(
        host=keys.get("POLY_CLOB_HOST", "https://clob.polymarket.com"),
        key=keys["POLY_PRIVATE_KEY"],
        chain_id=keys.get("POLY_CHAIN_ID", 137),
        creds=creds,
    )


def discover_markets():
    """Find all open temperature markets."""
    log("Scanning Polymarket for temperature markets...")
    markets = []
    offset = 0
    while offset < 500:
        url = f"{GAMMA_API}/markets?closed=false&active=true&limit=100&offset={offset}"
        try:
            resp = requests.get(url, timeout=15)
            data = resp.json()
        except Exception as e:
            log(f"API error at offset {offset}: {e}")
            break
        if not data:
            break
        for m in data:
            q = (m.get("question") or "").lower()
            if "highest temperature" in q or "lowest temperature" in q:
                markets.append(m)
        if len(data) < 100:
            break
        offset += 100
        time.sleep(0.25)
    log(f"Found {len(markets)} temperature markets")
    return markets


def get_gfs_ensemble(city, date_str):
    """Fetch GFS 31-member ensemble for a city on a date."""
    coords = CITY_COORDS.get(city)
    if not coords:
        return None
    lat, lon = coords
    url = (f"{ENSEMBLE_API}?latitude={lat}&longitude={lon}"
           f"&daily=temperature_2m_max&start_date={date_str}&end_date={date_str}"
           f"&timezone=auto&models=gfs_seamless")
    try:
        resp = requests.get(url, timeout=15)
        data = resp.json()
        temps = []
        for key, val in data.get("daily", {}).items():
            if key.startswith("temperature_2m_max"):
                if isinstance(val, list):
                    temps.extend([v for v in val if v is not None])
                elif val is not None:
                    temps.append(val)
        if not temps:
            return None
        return {
            "mean": statistics.mean(temps),
            "std": max(statistics.stdev(temps) if len(temps) > 1 else 1.5, 0.5),
            "min": min(temps),
            "max": max(temps),
            "n": len(temps),
        }
    except Exception:
        return None


def parse_market(m):
    """Extract city, date, threshold from market question."""
    q = (m.get("question") or "").lower()
    city = None
    for c in sorted(CITY_COORDS.keys(), key=len, reverse=True):
        if c in q:
            city = c
            break
    day_match = re.search(r'(?:march|april|may|june)\s+(\d+)', q)
    month_match = re.search(r'(march|april|may|june)', q)
    day = int(day_match.group(1)) if day_match else None
    month = {"march": 3, "april": 4, "may": 5, "june": 6}.get(
        month_match.group(1) if month_match else "", 3)
    temp_match = re.search(r'(\d+)\s*°[cf]', q)
    threshold = int(temp_match.group(1)) if temp_match else None
    is_below = "or below" in q
    is_above = "or higher" in q or "or above" in q
    is_fahrenheit = "°f" in q
    return city, day, month, threshold, is_below, is_above, is_fahrenheit


def analyze_edge(m, gfs):
    """Calculate edge between GFS probability and market price."""
    city, day, month, threshold, is_below, is_above, is_fahrenheit = parse_market(m)
    if not threshold or not gfs:
        return None

    mean, std = gfs["mean"], gfs["std"]
    if is_fahrenheit:
        mean = mean * 9/5 + 32
        std = std * 9/5

    if is_below:
        gfs_prob = normal_cdf((threshold + 0.5 - mean) / std)
    elif is_above:
        gfs_prob = 1 - normal_cdf((threshold - 0.5 - mean) / std)
    else:
        gfs_prob = prob_exact_temp(threshold, mean, std)

    prices_raw = m.get("outcomePrices", "")
    if isinstance(prices_raw, str):
        try:
            prices = json.loads(prices_raw)
        except:
            return None
    else:
        prices = prices_raw
    if len(prices) < 2:
        return None

    yes_p = float(prices[0])
    no_p = float(prices[1])

    tid_raw = m.get("clobTokenIds", "")
    if isinstance(tid_raw, str):
        try:
            tids = json.loads(tid_raw)
        except:
            tids = [t.strip() for t in tid_raw.split(",")]
    else:
        tids = [str(t) for t in tid_raw]

    yes_edge = gfs_prob - yes_p
    no_edge = (1 - gfs_prob) - no_p

    if yes_edge > no_edge and yes_edge > 0:
        side, edge, price, prob = "YES", yes_edge, yes_p, gfs_prob
        tid = str(tids[0]) if len(tids) >= 2 else None
    elif no_edge > 0:
        side, edge, price, prob = "NO", no_edge, no_p, 1 - gfs_prob
        tid = str(tids[1]) if len(tids) >= 2 else None
    else:
        return None

    if price <= 0.001 or price >= 0.999:
        return None

    payout = 1 / price
    return {
        "market_id": m.get("id"),
        "question": m.get("question"),
        "token_id": tid,
        "side": side,
        "price": price,
        "gfs_prob": prob,
        "edge": edge,
        "payout": payout,
        "ev": edge * payout,
        "city": city,
        "day": day,
        "month": month,
        "threshold": threshold,
        "gfs_mean": mean,
        "gfs_std": std,
    }


def place_orders(opportunities, client, max_risk, max_per_trade):
    """Place GTC limit orders on the CLOB."""
    from py_clob_client.clob_types import OrderArgs, OrderType
    from py_clob_client.order_builder.constants import BUY

    results = []
    total_risked = 0.0

    for opp in opportunities:
        if total_risked >= max_risk:
            break
        if not opp.get("token_id"):
            continue

        kelly = min(opp["edge"] / max(opp["payout"] - 1, 0.01), 0.25)
        size = min(kelly * max_risk, max_per_trade, max_risk - total_risked)
        if size < 0.50:
            continue

        bid = min(round(opp["price"] * 1.15, 4), opp["price"] + 0.02)
        bid = round(max(bid, 0.01), 2)

        log(f"ORDER: {opp['side']} {opp['question'][:60]}")
        log(f"  Price: {bid:.3f} | Size: ${size:.2f} | Edge: {opp['edge']:.1%}")

        try:
            order_args = OrderArgs(
                token_id=opp["token_id"],
                price=bid,
                size=round(size, 2),
                side=BUY,
            )
            signed = client.create_order(order_args)
            resp = client.post_order(signed, OrderType.GTC)
            oid = resp.get("orderID", resp.get("id", "?"))
            log(f"  ✅ PLACED — {oid}")
            results.append({"q": opp["question"], "side": opp["side"],
                          "price": bid, "size": size, "order_id": oid,
                          "status": "placed"})
            total_risked += size
        except Exception as e:
            log(f"  ❌ FAILED — {e}")
            results.append({"q": opp["question"], "side": opp["side"],
                          "error": str(e), "status": "failed"})
        time.sleep(0.5)

    return results


def main():
    parser = argparse.ArgumentParser(description="Armorstack Sprint Trader")
    parser.add_argument("--execute", action="store_true")
    parser.add_argument("--risk", type=float, default=MAX_TOTAL_RISK)
    parser.add_argument("--min-edge", type=float, default=MIN_EDGE)
    parser.add_argument("--per-trade", type=float, default=MAX_PER_TRADE)
    args = parser.parse_args()

    now = datetime.now(timezone.utc)
    print("═" * 65)
    print("  ARMORSTACK SPRINT TRADER")
    print(f"  {now.strftime('%Y-%m-%d %H:%M UTC')}")
    print(f"  Mode: {'🔴 LIVE' if args.execute else '🟡 DRY RUN'}")
    print(f"  Risk: ${args.risk:.0f} | Edge: {args.min_edge:.0%} | Per-Trade: ${args.per_trade:.0f}")
    print("═" * 65)

    # Discover markets
    markets = discover_markets()
    if not markets:
        log("No temperature markets found.")
        return

    # GFS ensemble analysis
    gfs_cache = {}
    opportunities = []
    year = now.year

    for m in markets:
        city, day, month, threshold, _, _, _ = parse_market(m)
        if not city or not day:
            continue
        cache_key = f"{city}_{month}_{day}"
        if cache_key not in gfs_cache:
            date_str = f"{year}-{month:02d}-{day:02d}"
            gfs = get_gfs_ensemble(city, date_str)
            gfs_cache[cache_key] = gfs
            if gfs:
                log(f"GFS {city.title()} {month}/{day}: {gfs['mean']:.1f}°C ±{gfs['std']:.1f} [{gfs['min']:.1f}–{gfs['max']:.1f}] ({gfs['n']}m)")
            time.sleep(0.2)

        gfs = gfs_cache.get(cache_key)
        if not gfs:
            continue

        result = analyze_edge(m, gfs)
        if result and result["edge"] >= args.min_edge:
            opportunities.append(result)

    opportunities.sort(key=lambda x: x["ev"], reverse=True)

    # Display
    print(f"\n  {'Market':<50} {'Side':>4} {'Price':>6} {'GFS':>6} {'Edge':>7} {'EV/$':>6}")
    print(f"  {'-'*50} {'-'*4} {'-'*6} {'-'*6} {'-'*7} {'-'*6}")
    for o in opportunities[:15]:
        q = o["question"][:49]
        print(f"  {q:<50} {o['side']:>4} {o['price']:>5.3f} {o['gfs_prob']:>5.1%} {o['edge']:>+6.1%} ${o['ev']:>5.2f}")

    log(f"Found {len(opportunities)} opportunities above {args.min_edge:.0%} edge")

    # Execute
    if args.execute and opportunities:
        keys = load_credentials()
        client = get_clob_client(keys)
        results = place_orders(opportunities[:10], client, args.risk, args.per_trade)

        placed = [r for r in results if r["status"] == "placed"]
        failed = [r for r in results if r["status"] == "failed"]
        log(f"RESULTS: {len(placed)} placed (${sum(r['size'] for r in placed):.2f}), {len(failed)} failed")

        # Save log
        logfile = os.path.join(LOG_DIR, f"sprint_{now.strftime('%Y%m%d_%H%M%S')}.json")
        with open(logfile, "w") as f:
            json.dump({"ts": now.isoformat(), "results": results,
                       "opportunities": len(opportunities)}, f, indent=2, default=str)
    elif not args.execute:
        print(f"\n  💡 Add --execute to place trades")

    # Save analysis
    analysis_file = os.path.join(STATE_DIR, "latest_analysis.json")
    with open(analysis_file, "w") as f:
        json.dump({"ts": now.isoformat(), "opportunities": opportunities[:20],
                    "gfs": {k: v for k, v in gfs_cache.items() if v}},
                  f, indent=2, default=str)


if __name__ == "__main__":
    main()
TRADER_EOF

chmod +x /opt/armorstack/polymarket/sprint_trader.py
echo "   ✅ Sprint trader installed"

# ─── 8. CRON JOBS ───────────────────────────────────────────────
echo ""
echo "⏰ Setting up scheduled runs..."

# Sprint cycle: every 15 minutes
CRON_SPRINT="*/15 * * * * /opt/armorstack/venv/bin/python3 /opt/armorstack/polymarket/sprint_trader.py --execute --risk 20 --min-edge 0.08 >> /opt/armorstack/polymarket/logs/cron.log 2>&1"

# Write cron (don't duplicate if re-running setup)
(crontab -l 2>/dev/null | grep -v "sprint_trader" ; echo "$CRON_SPRINT") | crontab -
echo "   ✅ Sprint cycle: every 15 min, \$20 max risk, 8% min edge"
echo "   📋 Scalp cycle: PAUSED (enable when balance reaches \$1,000)"

# ─── 9. SYSTEMD WATCHDOG (optional, keeps it clean) ─────────────
echo ""
echo "🐕 Setting up log rotation..."
cat > /etc/logrotate.d/armorstack << 'LOGROTATE'
/opt/armorstack/polymarket/logs/*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
}
LOGROTATE
echo "   ✅ Log rotation configured (14 days)"

# ─── 10. FIRST RUN (DRY) ────────────────────────────────────────
echo ""
echo "🚀 Running first scan (dry run)..."
echo ""
/opt/armorstack/venv/bin/python3 /opt/armorstack/polymarket/sprint_trader.py --risk 20 --min-edge 0.05

# ─── DONE ────────────────────────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ SETUP COMPLETE"
echo ""
echo "  Sprint trader: /opt/armorstack/polymarket/sprint_trader.py"
echo "  Credentials:   /opt/armorstack/polymarket/state/api_keys.json"
echo "  Logs:          /opt/armorstack/polymarket/logs/"
echo ""
echo "  To run manually:  source /opt/armorstack/venv/bin/activate"
echo "                     python3 /opt/armorstack/polymarket/sprint_trader.py --execute"
echo ""
echo "  Cron is active — sprint trades run every 15 minutes"
echo "═══════════════════════════════════════════════════════"
