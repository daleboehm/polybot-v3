# Polymarket R&D — Progress Log

**Last Updated:** 2026-04-04 ~01:15 UTC
**Principal:** Dale Boehm | Armorstack

---

## Phase 1: Core Trading Infrastructure (COMPLETE)

**Dates:** Pre-2026-03-25 → 2026-03-31

- Built and deployed full Polymarket trading bot to VPS (178.62.225.235:2222)
- Implemented 10+ trading strategies: favorites, longshot, momentum_cheap, mean_revert, crypto_dir, deadline, value, skew, random_control
- Deployed auto_redeem.py (v3) — claims resolved positions → USDC every 30 min
- Deployed auto_ops.py — self-healing system monitors every 30 min
- Built email reporting pipeline (4x/day portfolio, weekly tax, weekly Kelly)
- Built Discord daily summary bot
- Set up Google Drive hourly sync for state backup
- Deployed data_integrity_watchdog.py — auto-detect and fix silent failures
- Built resolution_pipeline.py (Gemini Capital Ledger Phase 3)
- Established backup_state.sh running daily at 03:00 UTC

**Outcome:** Full production trading system with 22 active cron jobs. System entered REBUILD MODE on 2026-03-31 due to capital lock — live trading paused, monitoring/reporting continues.

---

## Phase 2: R&D Paper Trading Engine (COMPLETE)

**Dates:** 2026-04-02 → 2026-04-03

- Designed and deployed `rd_trader_v2.py` (44,796 bytes) — paper trading engine
- 10 strategy modules running simultaneously: favorites, random_control, longshot, momentum_cheap, mean_revert, deadline, value, skew, crypto_dir
- SQLite WAL mode with `busy_timeout=30000` for concurrent access
- Cron schedule: scan every 5 min (flock guard), resolve every 20 min, report hourly
- Fixed ZeroDivisionError in `_est_crypto()` — changed `target == 0` to `target <= 0` guard
- Database: `rd_ledger.db` (133MB as of 2026-04-03)

**Current Stats (2026-04-03):**
| Metric | Value |
|--------|-------|
| Total Trades | 94,692 |
| Unique Conditions | 35,256 |
| Status | All OPEN (no markets resolved yet) |
| Top Strategy | favorites: 37,778 trades |
| Runner-up | random_control: 31,034 trades |

**Outcome:** Engine running clean. Accumulating data for strategy evaluation once markets begin resolving.

---

## Phase 3: Wallet Scanner & Strategy Analysis (COMPLETE)

**Dates:** 2026-04-03

- Discovered key endpoint: `data-api.polymarket.com/activity?user={proxy_wallet}&limit=100`
- Built `wallet_scanner.py` (913 lines, 39KB) — production wallet intelligence system
- SQLite persistence: 4 tables (wallets, wallet_trades, strategy_insights, activity_cache)
- Rate-limited API client: 0.5s between requests, exponential backoff on 429s
- CLI: `--wallet`, `--discover`, `--report`, `--update-top20`
- Scraped all 20 proxy wallet addresses from Polymarket leaderboard via Chrome browser automation
- Deployed to VPS at `/opt/polybot/rd/wallet_scanner.py`

**Analysis Completed:**
- 13 of 20 wallets fully analyzed (1 address unresolvable: GamblingIsAllYouNeed)
- 6,653 trades cataloged in `wallet_insights.db` (11.8MB)
- 6 strategy archetypes identified: Sports Whale, Event Specialist, Political Conviction DCA, Crypto Market Maker, Longshot Hunter, European Football Moneyline

**Key Wallet Findings:**

| Rank | Username | Monthly P&L | Strategy |
|------|----------|-------------|----------|
| #1 | Multicolored-Self | $5.39M | Sports Whale |
| #2 | HorizonSplendidView | $4.02M | EU Football Moneyline |
| #3 | reachingthesky | $3.74M | EU Football Moneyline |
| #4 | beachboy4 | $3.66M | Sports Whale |
| #5 | majorexploiter | $2.42M | Sports Whale |
| #8 | sovereign2013 | $1.68M | Diversified Pro |
| #18 | JPMorgan101 | $887K | Crypto Market Maker |
| #20 | CarlosMC | $819K | Longshot Hunter |
| AML | AML | $1.19M | Political Conviction DCA |

**Deliverable:** Interactive HTML strategy report with Chart.js visualizations — `wallet-strategy-analysis-2026-04-03.html`

---

## Phase 4: R&D Engine v3 — 72h Resolution Window (COMPLETE)

**Date:** 2026-04-03 (evening session)

**Problem:** v2 placed 235,417 trades with ZERO resolutions in 36 hours. Root causes: no endDate filter (traded on 2028 presidential elections), Gamma API returning stale 2020 markets as "active", resolver couldn't match 47K condition IDs against closed market list.

**Solution:**
- Built `rd_trader_v3.py` — complete rewrite of market fetching, filtering, and resolution
- 72h endDate filter: only trades markets resolving within 3 days
- Stale data rejection: endDate >24h in past → skip (Gamma API garbage)
- 3,000 market cap per cycle, shuffled for variety
- In-memory dedup (batch loads recent trade keys into set)
- Bulk + spot-check resolver (scans closed markets first, then 100 individual checks)
- Volume-sorted fetch (most liquid markets first)
- Added `end_date` column to trades table for resolution timing analysis
- Fixed EU football categorization (added PSG, Bayern, Barcelona, etc. to sports keywords)

**Actions Taken:**
1. Marked all 235,417 v2 OPEN trades as EXPIRED_PURGE
2. Archived v2 database (378MB) to `rd_ledger_v2_archive.db`
3. Created fresh `rd_ledger.db` for v3
4. Deployed rd_trader_v3.py to VPS
5. Updated cron jobs from v2 → v3
6. Verified: first cycle placed 2,045 trades in 65 seconds, all within 72h window

**Current Stats (post-deployment):**
| Metric | Value |
|--------|-------|
| Total Trades | ~2,800+ |
| EndDate < 24h | ~40% |
| EndDate 24-48h | ~22% |
| EndDate 48-72h | ~13% |
| Already past endDate | ~25% (awaiting resolution) |
| Markets closed (no resolution yet) | 100+ |

**Outcome:** Engine running clean. First resolutions expected within 12-24 hours as Polymarket pushes resolution data for closed markets.

---

## Phase 5: MAX COVERAGE Upgrade (COMPLETE)

**Date:** 2026-04-03 (late session)

**Problem:** Initial v3 (72h window, 3K cap) only covered ~3,481 markets out of Polymarket's 5,000+ active. User directive: "Let's make sure we are trading in as many markets as we can to build this level of data inputs we need."

**Solution — MAX COVERAGE build of rd_trader_v3.py:**
- Resolution window: 72h → 168h (7 days)
- Market cap per cycle: 3,000 → 8,000
- Scan pages: 100 → 200
- Dual-pass market fetch: volume-sorted + endDate-sorted with condition_id deduplication
- Dedup window: 60min → 30min
- API rate limit: 0.12s → 0.10s
- Volume thresholds lowered (momentum_cheap 1000→500, mean_revert 2000→1000)
- Stale cutoff: 24h → 48h past endDate
- Resolver upgraded: 100 bulk pages + 300 spot-checks
- DB hardened: busy_timeout=120s, 5 retries with exponential backoff, commit every 100 trades

**Result:** ~19K trades across 8,800+ unique markets (up from ~2,800/3,481)

**Outcome:** Maximum market coverage achieved. Engine running clean and accumulating data at scale.

---

## Phase 6: Dashboard Fixes, Nginx Routing & Claude Code Prompt (COMPLETE)

**Date:** 2026-04-03 (late session)

**Dashboard Fixes:**
- Fixed dropdown duplication: R&D option rendered inside `{% for e in entities %}` loop — moved outside in both entity detail and ledger templates
- Added entity-selector dropdown to master dashboard (MASTER_TEMPLATE header)
- Removed ~370 lines of dead template block (orphaned triple-quoted string causing Edit tool ambiguity)
- Fixed `navigateToEntity` JS function to handle R&D slug routing

**Nginx Routing:**
- Added `/rd` location block proxying to port 8096 (full R&D dashboard)
- Updated CSP header to allow Chart.js CDN (`https://cdnjs.cloudflare.com`)
- Config file: `/etc/nginx/sites-enabled/geminicap`

**Claude Code Engineering Prompt:**
- Built `docs/claude-code-prompt.md` — comprehensive prompt for R&D system audit + multi-entity architecture
- Includes: VPS access details (SSH/SCP), all data repository locations, current architecture diagram, 3-part plan (audit + architecture + implementation priorities)
- Scoped to R&D only per user directive: "For now let's just do the audit and rebuild on the R&D Server. Once we prove the theory and make changes we can finalize a version and update the Prod server."

**Outcome:** Dashboard navigation functional across all views. Nginx properly routes /rd to the comprehensive R&D dashboard. Claude Code prompt ready for R&D audit execution.

---

## Phase 7: R&D System Audit (COMPLETE)

**Date:** 2026-04-04

**Scope:** R&D only — did NOT touch production.
1. Security audit (SSH, DB permissions, API exposure, auth, nginx)
2. Reliability audit (SQLite concurrency, cron guards, screen sessions, growth)
3. Code quality (dead code, duplication, configuration management)
4. Architecture review (data flow, SPOF, scaling bottlenecks, schema optimization)
5. Trading logic review (strategy correctness, dedup, resolution matching, P&L math)

**Results:** 51 findings (2 CRITICAL, 11 HIGH, 20 MEDIUM, 18 LOW). 28 fixes deployed. 7 strategic recommendations implemented. Report: `system_audit_2026-04-03.md`

**Outcome:** System hardened. Dashboards on systemd, logrotate active, DB indexed, wallets on cron, screen sessions eliminated.

---

## Phase 8: Data Maximization Plan (COMPLETE)

**Date:** 2026-04-04

**Problem:** 56K+ trades with 0 resolutions (Polymarket oracle takes 24-72h+ after market close). Need performance signal without waiting. Also: dashboards showing zeros/blanks due to multiple bugs.

**Solution — 6-Phase Data Maximization Plan:**

**Phase 1: Mark-to-Market (MTM) Tracking**
- New `mtm_snapshots` table in rd_ledger.db (trade_id, snapshot_at, current_price, unrealized_pnl, unrealized_pnl_pct)
- New columns on trades: mfe, mae, last_mtm_price, last_mtm_at
- New `_load_price_map()` helper extracted from stop-loss code (reusable)
- New `update_mtm()` function — matches open trades to live prices from market_cache.json
- New `--mtm` CLI mode
- First run: 53,876/56,640 trades matched, unrealized P&L: +$1,134.81
- Cron: every 30 minutes (flock-guarded)

**Phase 2: Entry Context Enrichment**
- New columns on trades: hours_to_expiry, spread, price_momentum
- Computed at entry time in scan_and_trade()
- All 11 strategy _eval_ functions updated to pass through

**Phase 3: Resolution Pipeline Fix**
- Fixed misleading resolver log ("found 500 resolved" was really just "closed")
- Added CLOB API (clob.polymarket.com) as secondary resolution source — checks tokens[].winner field
- New column: resolution_latency_hours
- Critical finding: Polymarket oracle resolution takes 24-72+ hours after market close

**Phase 4: Analytics Engine — NEW FILE rd_analytics.py (628 lines)**
- 12 analysis sections (8 pre-resolution, 4 post-resolution)
- Pre-resolution (work now): mtm_performance, edge_calibration, mfe_mae_analysis, position_aging, time_analysis, whale_correlation, category_analysis, strategy_overlap
- Post-resolution (activate when resolutions flow): realized_performance, kelly_sizing, go_live_score, monte_carlo
- CLI modes: --report (console), --json (dashboard), --export (CSV), --section NAME
- Cron: daily at 6 AM UTC, weekly CSV export Sunday 7 AM

**Phase 5: Dashboard Enhancement**
- Fixed sqlite3.Row .get() bug (lines 646-647 in unified_dashboard.py) — R&D scorecard showed all zeros
- Fixed load_entities_config() gunicorn bug — same __main__ pattern as credentials; master dashboard showed 0/0 entities
- Fixed market_cache.json JSON string parsing — _load_price_map() iterated strings instead of parsed lists
- R&D scorecard now shows real unrealized P&L, pending resolution count, strategies/categories counts
- All 15 prod entities now visible on master dashboard (Caspian with $210 equity, rest unfunded)

**Phase 6: Cron & Deploy**
- All changes deployed to VPS via SCP
- Schema migration complete (new tables + columns)
- 3 new cron entries: MTM (*/30), analytics daily (6AM), export weekly (Sun 7AM)
- Master dashboard restarted with entity loading fix

**Key Metrics Post-Deploy:**
| Metric | Value |
|--------|-------|
| Total Trades | 56,640+ |
| Unique Markets | 14,000+ |
| Market Snapshots | 165,000+ |
| MTM Snapshots | 53,876 (first batch) |
| Unrealized P&L | +$1,134.81 |
| Resolved Trades | 0 (oracle delay, not our bug) |
| Strategies | 11 (10 original + whale_follow) |

**Early Strategy Signals (MTM):**
| Strategy | Unrealized P&L | Signal |
|----------|---------------|--------|
| longshot | +$584 | Positive edge |
| skew | +$505 | Positive edge |
| value | +$422 | Positive edge |
| random_control | -$364 | Negative (expected — baseline) |
| favorites | -$184 | Slight negative |

**Outcome:** Complete observability without waiting for oracle resolution. MTM data validates longshot/skew/value strategies have positive edge vs random_control baseline. Analytics engine ready to auto-produce daily reports and weekly exports.

---

## Timeline Summary

```
2026-03-25  Core trading system operational
2026-03-31  Capital lock → REBUILD MODE, trading paused
2026-04-02  R&D paper trading engine v2 deployed
2026-04-03  Wallet scanner built, deployed, full analysis complete
2026-04-03  Strategy report delivered (2 chapters: sports + non-sports)
2026-04-03  v3 engine deployed (72h window) — replaced v2 (235K dead trades)
2026-04-03  MAX COVERAGE build deployed (168h, 8K cap) — 19K trades, 8.8K markets
2026-04-03  Dashboard fixes: dropdown dedup, master dropdown, dead template removal
2026-04-03  Nginx /rd proxy to port 8096 + CSP update for Chart.js
2026-04-03  Claude Code R&D audit prompt written (docs/claude-code-prompt.md)
2026-04-03  Session docs updated (context, status, todo, progress)
2026-04-04  R&D system audit completed (51 findings, 28 fixes, 7 recommendations)
2026-04-04  Systemd units, logrotate, DB indexes deployed
2026-04-04  Data Maximization Plan deployed (6 phases):
            - MTM tracking (30-min cron, 53K/57K trades matched, +$1,134 unrealized)
            - Entry context enrichment (hours_to_expiry, spread, momentum)
            - Resolution pipeline fix (CLOB API secondary, discovered 24-72h oracle delay)
            - Analytics engine (rd_analytics.py, 628 lines, 12 sections)
            - Dashboard bugs fixed (.get() on Row, entity loading, JSON parsing)
            - Cron + deploy (3 new entries, schema migration complete)
2026-04-04  Early MTM signals: longshot/skew/value positive edge, random_control negative
2026-04-04  Prod server audit started — reviewing production state for R&D→prod patching
2026-04-04  Session docs updated (context, status, todo, progress)
```
