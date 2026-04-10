# Polymarket R&D Session Summary
**Timestamp:** 2026-04-06 02:15 UTC
**Session Scope:** Deep analysis, engine tuning, prod promotion, monitoring setup

---

## System State at Session Start

| Metric | Value |
|--------|-------|
| Total trades | 1,339,315 |
| Unique markets | 39,939 |
| Resolved (WON/LOST) | 1,302 (0.1%) |
| Stopped | 462,963 (35%) |
| Open | 875,050 |
| MTM snapshots | 39.1M |
| Trades/day | ~660K |
| DB size | 6.9GB ledger + 8.1GB cache |
| Engine version | rd_trader_v3.py (Data Maximization Build) |

---

## Analysis Performed

### Resolved Trade Deep Dive (1,302 trades)

| Strategy | Won | Lost | Win % | Net P&L | Verdict |
|----------|-----|------|-------|---------|---------|
| favorites | 1,265 | 0 | 100% | +$54.47 | Penny-picking — $0.04 avg profit |
| random_control | 30 | 1 | 96.8% | +$166.21 | Outperforming real strategies (noise) |
| mean_revert | 2 | 0 | 100% | +$25.52 | Too few to evaluate |
| longshot | 0 | 2 | 0% | -$20.00 | Expected losses on binary bets |
| deadline | 0 | 2 | 0% | -$20.00 | Expected losses |

**Key finding:** Strategies with claimed positive unrealized edge (longshot, skew, value) have zero resolved WON trades. Unrealized P&L is market drift, not proven alpha.

### Stop-Loss Analysis (462,963 stopped)

- **98.2% of stopped trades had MAE < 10%** — stops triggering on normal volatility
- **50.2% of stopped trades were profitable at some point** before being shaken out
- **momentum_cheap: 68.6% stop rate** — broken strategy
- **Only 15-19% of stopped trades ever recovered** past entry — stop IS saving from further loss in 80% of cases
- **62% of stops happen within 12 hours** — trades getting churned

### Open Book Position

| Metric | Value |
|--------|-------|
| Open trades | 885,554 |
| Notional volume | $8,855,540 |
| Unrealized P&L | +$1,901,298 (21.5%) |
| Unique open markets | 40,119 |

**By Strategy (Unrealized):**

| Strategy | Open Trades | Volume | Unrealized P&L | Return % |
|----------|------------|--------|---------------|----------|
| random_control | 263,889 | $2.64M | +$503,453 | 19.1% |
| longshot | 86,260 | $863K | +$491,014 | 56.9% |
| skew | 79,783 | $798K | +$416,179 | 52.2% |
| momentum_cheap | 20,454 | $205K | +$189,912 | 92.8% |
| value | 24,697 | $247K | +$169,738 | 68.7% |
| mean_revert | 15,841 | $158K | +$66,054 | 41.7% |
| favorites | 391,572 | $3.92M | +$40,740 | 1.0% |
| crypto_dir | 2,843 | $28K | +$23,303 | 82.0% |

**Warning:** Random control at +$503K unrealized means market-wide drift is inflating all P&L numbers. Resolution data is the only true test.

---

## Changes Implemented

### 1. Tiered Stop-Loss (was flat 30%)
| Entry Price | Stop Threshold | Rationale |
|-------------|---------------|-----------|
| >= $0.50 | 30% | Standard |
| $0.20-$0.50 | 50% | More room for moderate prices |
| $0.10-$0.20 | 60% | Loose — low-price volatility is normal |
| < $0.10 | No stop-loss | Binary bets — run to resolution |

### 2. Minimum Hold Period: 6 Hours
Trades must be open 6+ hours before stop-loss activates. Prevents early shakeouts from normal market volatility.

**First run result:** 139,348 trades protected by hold period, 83,386 exempted as cheap assets. Only 463 actually stopped (vs thousands before).

### 3. momentum_cheap Volume Threshold: 500 → 5,000
Eliminates low-liquidity junk entries. First cycle: zero momentum_cheap trades placed (working as intended).

### 4. Scan Window Tightened for R&D Focus
| Parameter | Before | After |
|-----------|--------|-------|
| MAX_HORIZON_HOURS | 168 (7 days) | 48 (2 days) |
| MAX_MARKETS_PER_CYCLE | 8,000 | 3,000 |
| MAX_SCAN_PAGES | 200 | 100 |
| DEDUP_MINUTES | 30 | 120 (2 hours) |
| Stale cutoff | 48h past | 24h past |

### 5. Favorites Edge Floor
- Before: min_price $0.88 (buying near-certainties for pennies)
- After: min_price $0.50, max_price $0.92 (requires 8%+ upside)

### 6. Random Control Rate: 1-in-10 → 1-in-20
Halved random baseline volume to reduce noise.

---

## Production Promotion

**Old prod stack archived:** sprint_trader.py, edge_trader (v1/v2/v3), auto_trader.py, market_maker.py, grinder.py, orchestrator.py, capital_router.py + all backups → `/opt/polybot/archive_20260406/`

**New prod engine:** `rd_trader_v3.py` + `rd_analytics.py` copied to `/opt/polybot/`. Verified IDENTICAL via `diff`.

**Crontab cleaned:** 13 old disabled trading lines removed. 6 new prod entries added, all **PAUSED** (will activate when capital lock clears).

**Both R&D and Prod now at same revision.**

---

## Monitoring Scheduled

**6-hour automated reviews** at 02:00, 08:00, 14:00, 20:00 UTC.

Each review:
1. Runs `rd_6h_review.py` on VPS
2. Evaluates resolution flow, strategy edge vs random_control, stop-loss health, volume, P&L
3. Auto-adjusts parameters when data clearly supports (e.g., disable underperforming strategies, tighten windows)
4. Reports findings and changes to Dale

**Decision criteria baked into reviews:**
- Resolution target: 500+ per 6h window
- Strategy edge: win rate > random +10% AND positive net P&L = validated
- Strategy underperforming: 50+ resolutions, worse than random = auto-disable
- Volume target: 50K-100K trades/day (auto-increase dedup if exceeded)
- Recovery rate > 30% on stopped trades = stop-loss still too aggressive

---

## Next 24 Hours — What to Watch

1. **Do resolutions start flowing?** The 48h window means trades placed now should resolve within 24-48h. This is the critical test.
2. **Does the stop-loss tuning hold?** New stop rate should be dramatically lower than the 35% historical rate.
3. **Which strategies beat random_control on resolved trades?** Early unrealized signals favor longshot, skew, value — but resolutions are the proof.
4. **Does trade volume stabilize?** Target 50K-100K/day, down from 660K/day.

---

## Additional Changes (2026-04-06 02:20-02:40 UTC)

### 7. Dashboard Performance Fix
**Problem:** Master dashboard and R&D dashboard running extremely slow.
**Root cause:** 8-11 full table scans on 1.35M trades per page load, 30s auto-refresh hammering DB, single gunicorn worker (consumed 1,036 CPU-hours).

| Fix | Before | After |
|-----|--------|-------|
| DB indexes | 6 | 9 (3 new composite) |
| Query caching | None | Background thread, 60s refresh, serve from memory |
| Auto-refresh | 30s (master) | 120s (both) |
| Gunicorn workers | 1 | 3 |
| Page load time | Multi-second | ~0.02s |

### 8. GC A Brown Entity Added (Entity #16)
- **Wallet:** `0xcbCc84a1f4A9e706f6092EA2cEb0680A346D7Bc2` (generated via `eth_account.Account.create()`)
- **CLOB API:** Derived and verified (1 key registered)
- **Config:** Added to `/opt/master-dashboard/entities.json` (port 8097, slug: a-brown)
- **Directory:** `/opt/a-brown/state/api_keys.json` (chmod 600)
- **Status:** Pending (needs USDC funding)
- **Dashboard:** Visible on master dashboard (16 entities loaded)

---

## File Locations

| File | Location | Purpose |
|------|----------|---------|
| rd_trader_v3.py | /opt/polybot/rd/ AND /opt/polybot/ | Trading engine (identical copies) |
| rd_analytics.py | /opt/polybot/rd/ AND /opt/polybot/ | Analytics engine |
| rd_6h_review.py | /opt/polybot/rd/ | 6-hour review script |
| open_book_report.py | /opt/polybot/rd/ | Open position report |
| apply_rd_tuning.py | /opt/polybot/rd/ | Parameter patching tool |
| rd_ledger.db | /opt/polybot/rd/ | R&D trade database (7.1GB) |
| unified_dashboard.py | /opt/polybot/ | Master dashboard (perf-cached, 3 workers) |
| rd_dashboard.py | /opt/polybot/rd/ | R&D dashboard (perf-cached, 3 workers) |
| entities.json | /opt/master-dashboard/ | 16-entity configuration |
| api_keys.json | /opt/a-brown/state/ | GC A Brown wallet + CLOB credentials |
| archive_20260406/ | /opt/polybot/ | Old prod scripts (16 files) |
| fix_dashboard_performance.py | /opt/polybot/ | Dashboard perf patch script |
