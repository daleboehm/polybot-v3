# SPRINT TRADER ARCHITECTURE ANALYSIS

## 1. TRADING DECISION PIPELINE

### Entry Point: `main()`
- **Location**: Line 736–852
- **Flow**:
  1. Reconcile portfolio with blockchain (call to `reconcile.reconcile_portfolio()`)
  2. Parse CLI args: `--execute`, `--risk`, `--min-edge`, `--per-trade`
  3. Discover markets via `discover_weather_markets()` + `discover_weather_events()`
  4. For each market, fetch GFS ensemble data and calculate edge
  5. Sort by EV/$ and display top opportunities
  6. Execute trades if `--execute` flag is set

### Signal Evaluation Core: `calculate_edge(market, gfs)`
- **Location**: Line 456–530
- **Purpose**: Compare GFS ensemble probability to market price, quantify the edge
- **Inputs**:
  - `market`: Polymarket market object (question, prices, token IDs)
  - `gfs`: GFS ensemble data (mean, std, members)
- **Outputs**:
  - Dictionary with: `side` (YES/NO), `price`, `gfs_prob`, `edge`, `payout_mult`, `ev_per_dollar`, `token_id`
- **No whale confirmation logic currently**—only GFS ensemble vs. market price

### Position Sizing: Inside `execute_trades()`
- **Location**: Line 650–682
- **Kelly Criterion Application**:
  ```python
  kelly = min(opp["edge"] / (opp["payout_mult"] - 1), 0.25) if opp["payout_mult"] > 1 else 0.1
  size = min(kelly * max_risk, max_per_trade, max_risk - total_risked)
  ```
- **Capping**: Max 25% per trade, respects total risk budget
- **Share Calculation**: `shares = size / bid_price` (dollars → share count)
- **Bid Price**: 15% premium above market or +2¢, whichever is lower (to fill faster)

---

## 2. WHERE TO INJECT WHALE CONFIRMATION SIGNAL

### Option A: Boost Edge Directly (Simplest)
**Location**: Line 530 (right after `calculate_edge()` returns)

```python
# After edge is calculated, fetch whale data
whale_signal = fetch_whale_confirmation(market_id)
if whale_signal["agreement_strength"] > 0.7:
    edge_result["edge"] *= 1.1  # +10% edge boost if whales agree
    edge_result["whale_agreement_score"] = whale_signal["agreement_strength"]
```

### Option B: Create New Signal Function (Modular)
**Add new function**: `evaluate_whale_signal(market_id, side)`

```python
def evaluate_whale_signal(market_id, side):
    """Fetch top wallet positions and compare to our trade direction."""
    top_whales = fetch_top_wallets(market_id)  # Get positions from blockchain
    agreement_count = sum(1 for w in top_whales if w["side"] == side)
    agreement_pct = agreement_count / len(top_whales)
    
    return {
        "agreement_pct": agreement_pct,
        "net_position_usd": sum(w["notional"] for w in top_whales if w["side"] == side),
        "is_confirmed": agreement_pct > 0.6,
    }
```

Then call in `calculate_edge()`:
```python
whale = evaluate_whale_signal(market["id"], side)
if whale["is_confirmed"]:
    edge = edge * 1.08  # 8% edge boost
    market_data["whale_consensus"] = whale
```

### Option C: Filter Trades by Whale Consensus (Gating)
**Location**: Line 810–815 (where trades are sorted)

```python
# Before displaying opportunities, filter by whale confirmation
confirmed_trades = []
for opp in opportunities:
    whale = evaluate_whale_signal(opp["market_id"], opp["side"])
    if whale["agreement_pct"] > config.WHALE_CONFIRMATION_THRESHOLD:
        confirmed_trades.append(opp)

opportunities = confirmed_trades  # Only trade with whale confirmation
```

---

## 3. EXISTING EDGE CALCULATION & POSITION SIZING

### Edge Components Currently Used:
1. **GFS Ensemble Probability** (lines 467–492)
   - Fetches 31-member ensemble mean & std
   - Converts Celsius → Fahrenheit if needed
   - Calculates: P(temp ≤ threshold) or P(temp ≥ threshold)

2. **Market Price** (lines 494–502)
   - Gets YES/NO outcome prices from Polymarket CLOB
   - Compares to GFS probability

3. **Raw Edge** (lines 504–512)
   - `yes_edge = gfs_prob - yes_price`
   - `no_edge = (1 - gfs_prob) - no_price`
   - Picks side with positive edge

4. **EV Per Dollar** (line 527)
   - `edge × payout_multiplier = expected value per dollar risked`

### Position Sizing Logic (Kelly Criterion):
```python
kelly_pct = edge / (payout_mult - 1)  # Fractional Kelly
kelly_pct = min(kelly_pct, 0.25)       # Cap at 25%
position_size = kelly_pct × max_risk   # Dollar allocation
position_size = min(position_size, max_per_trade)
shares = position_size / bid_price
```

**Config Parameters** (from config.py):
- `MAX_RISK_PER_TRADE = 0.15` (15% of capital per trade)
- `MAX_DAILY_RISK = 0.70` (70% total exposure)
- `KELLY_FRACTION = 1.0` (full Kelly, not fractional)
- `MIN_EDGE_THRESHOLD = 0.019` (1.9% minimum edge)

---

## 4. CONFIG & STATE FILES

### Config Files:
1. **`/opt/polybot/config.py`** (17.5 KB)
   - ALL trading parameters (sizing, edge floors, kelly, heat system, etc.)
   - Live trading flag: `LIVE_TRADING = True`
   - Category edge floors: `CATEGORY_EDGE_FLOORS = {...}`
   - Whale settings: `WHALE_TRACKER_ENABLED = True`, `WHALE_AGREEMENT_BOOST = 0.05`

2. **`/opt/polybot/api_keys.json`** (432 bytes)
   - Polymarket private key, API key, secret, passphrase
   - Polygon chain ID (137 = Polygon mainnet)
   - CLOB host URL

### State Files (Read by sprint_trader.py):
1. **`/opt/polybot/state/open_orders.json`**
   - Written by `open_orders_cache.py` every 5 min
   - Read by `cancel_stale_orders()` (line 555–593)
   - Format: List of open orders with `id`, `size_matched`, `locked`, `price`, `side`, `outcome`

2. **`/opt/polybot/wallet.json`**
   - Account balance/wallet state

### Output Files (Written by sprint_trader.py):
1. **`sprint_analysis.json`** (Line 846–848)
   - Saved in working directory
   - Contains: timestamp, opportunities (top 20), trades placed, GFS cache
   - **Use this to debug:** market selection, edge calculations, trade execution

---

## 5. LOGGING & DECISION TRACKING

### Console Output (prints):
- Market discovery: `"📡 {city} Mar {day}: GFS mean=..."`
- Opportunities: Table format with side, price, GFS prob, edge, payout, EV/$
- Trade execution: Each order shows price, shares, cost, edge, order ID
- Results summary: Count of placed/failed trades

### File Logging:
- **`sprint_analysis.json`**: All opportunities and trades (structured data)
- **No dedicated decision log** currently

### How to Add Better Logging:
```python
def log_trade_decision(market_id, signal_data, whale_data, decision):
    """Log all signals and decision to decision.log"""
    with open("/opt/polybot/state/trade_decisions.log", "a") as f:
        f.write(json.dumps({
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "market_id": market_id,
            "gfs_edge": signal_data["edge"],
            "whale_agreement": whale_data["agreement_pct"],
            "combined_edge": signal_data["edge"] * whale_data["boost_factor"],
            "decision": decision,  # "PLACE_TRADE" or "SKIP"
        }) + "\n")
```

Call this in `calculate_edge()` after whale signal evaluation.

---

## SUMMARY FOR WHALE CONFIRMATION INJECTION

**Best approach: Option B (modular signal function)**

1. Add `evaluate_whale_signal()` function that:
   - Fetches top wallets' positions from blockchain
   - Compares side agreement %
   - Returns confidence score + boost factor

2. Call in `calculate_edge()` line 530:
   ```python
   whale = evaluate_whale_signal(market["id"], side)
   if whale["agreement_pct"] > 0.6:
       edge *= (1 + whale["boost_factor"])  # E.g., 1.08x boost
   edge_result["whale_consensus"] = whale
   ```

3. Log decision to state file for audit trail

4. Update config.py with:
   ```python
   WHALE_CONFIRMATION_ENABLED = True
   WHALE_CONFIRMATION_THRESHOLD = 0.60  # 60%+ agreement = confirmed
   WHALE_AGREEMENT_BOOST = 0.08  # 8% edge boost
   ```

5. Test on dry run first: `python3 sprint_trader.py --min-edge 0.02`

---
