# Polymarket R&D System Audit Report

**Date:** 2026-04-03
**Auditor:** Claude (Opus 4.6)
**Scope:** R&D engine only — `/opt/polybot/rd/` + unified_dashboard.py (read-only) + nginx config
**VPS:** 178.62.225.235:2222 (DigitalOcean AMS3)

---

## Executive Summary

Audited 5,423 lines of Python across 4 files plus the nginx config. The R&D system is **functional and well-architected for its purpose** (paper trade data collection), but has **significant security and reliability gaps** that must be fixed before any production migration.

### Stats at Time of Audit
- **Trades:** 20,954 (all OPEN, 0 resolved)
- **Unique Markets:** 9,420
- **Market Snapshots:** 85,990
- **DB Size:** rd_ledger.db 21MB, wallet_insights.db 12MB
- **DB Indexes:** 3 (status, condition_id+side+strategy, opened_at) — need more
- **Screen Sessions:** 2 (master_dash, rd_dash) — no systemd

### Finding Summary

| Severity | Count | Breakdown |
|----------|-------|-----------|
| **CRITICAL** | 2 | Hardcoded secret keys, unbound variable crash |
| **HIGH** | 11 | Auth bypass, no DB WAL in dashboard, no API retry, data integrity issues |
| **MEDIUM** | 20 | Open redirects, connection leaks, magic numbers, missing config |
| **LOW** | 18 | Dead code, missing SRI, timezone hardcoding |
| **TOTAL** | **51** | |

---

## CRITICAL FINDINGS (Fix Immediately)

### C-1. Hardcoded Secret Keys in Both Dashboards
**Files:** rd_dashboard.py:33, unified_dashboard.py:40
**Impact:** Anyone with source code can forge Flask session cookies, bypassing authentication entirely.
- rd_dashboard: `app.secret_key = "rd-dashboard-2026-isolated-key"`
- unified_dashboard: `app.secret_key = "gemini-capital-unified-dashboard-2026-stable-key"`
- Both have credential-loading functions that can override, but the fallback is deterministic.

**Fix:** Remove hardcoded keys. Fail-closed on startup if `/dev/shm/polybot-secrets/dashboard_creds.json` is missing. Use `secrets.token_hex(32)` as absolute-last-resort runtime fallback.

### C-2. UnboundLocalError Crash in wallet_scanner.py
**File:** wallet_scanner.py:364-365
**Impact:** In `_request()`, the `except requests.exceptions.HTTPError` block references `response.status_code`, but `response` may not be assigned if the exception fires during connection setup. This crashes the scanner on any non-timeout HTTP error.

**Fix:** Use `e.response.status_code` instead. Guard with `if e.response is not None`.

---

## HIGH FINDINGS (Fix in Phase 1)

### H-1. CSRF Token Generated But Never Validated (rd_dashboard.py)
**File:** rd_dashboard.py:85-109, 348-351
A CSRF token is generated and stored in session but never included in the login form and never checked on POST. The entire CSRF implementation is dead code providing zero protection.

**Fix:** Add hidden CSRF field to form. Validate on POST. Or use Flask-WTF.

### H-2. No WAL Mode / busy_timeout in rd_dashboard.py
**File:** rd_dashboard.py:60-63
The dashboard's `db()` function opens SQLite with no `PRAGMA journal_mode=WAL` and no `PRAGMA busy_timeout`. The trading engine writes to rd_ledger.db every 5 minutes. Dashboard reads will fail with "database is locked" during writes.

**Fix:** Add `conn.execute("PRAGMA journal_mode=WAL")` and `conn.execute("PRAGMA busy_timeout=5000")` to `db()`.

### H-3. No Retry on API Failures in rd_trader_v3.py
**File:** rd_trader_v3.py:277-311
`_fetch_pass()` breaks out of the loop on any single API error. One transient network blip kills the entire scan pass (up to 8,000 markets lost). Same pattern in `check_resolutions()`.

**Fix:** Add 2-3 retry attempts with exponential backoff before breaking.

### H-4. CoinGecko Price Fetched Per-Market, Not Cached
**File:** rd_trader_v3.py:348-432, 596-654
`_est_crypto()` calls CoinGecko for every outcome of every market, across multiple strategies. BTC price could be fetched hundreds of times per 5-minute cycle. CoinGecko free tier: 10-30 calls/minute.

**Fix:** Cache crypto prices per-asset per-cycle in a dict. Fetch once, reuse.

### H-5. Crypto Probability Model Ignores Time-to-Expiry
**File:** rd_trader_v3.py:357-432
The `_est_crypto()` model uses CoinGecko spot price to estimate probability but ignores how long until the market expires. "BTC above $100K by Friday" and "by December" get the same probability estimate. This is the weakest model in the system.

**Fix:** Incorporate time-to-expiry as a factor. Use a simple normal distribution model where variance scales with sqrt(time) to capture the probability that price reaches target within the window.

### H-6. Mean Revert Edge Metric is Inverted
**File:** rd_trader_v3.py:691-704
The `edge_estimate` stored is `dist_from_half` (distance from 0.50). Higher edge = further from center. But mean reversion thesis says you WANT prices close to 0.50. The edge metric is backwards from what the strategy name implies. Also buys BOTH YES and NO on every qualifying market without directional conviction.

**Fix:** If the thesis is "near-50% markets tend to resolve at their current price," the edge should be `0.12 - dist_from_half` (closer to center = higher edge). Consider choosing only one side based on a signal.

### H-7. Hardcoded Wallet Surveillance List (wallet_scanner.py)
**File:** wallet_scanner.py:57-78
Twenty wallet addresses with pseudonyms and PnL figures are hardcoded in source. Exposes the full surveillance target list if source is shared. PnL data is static and will rot.

**Fix:** Move `TOP_WALLETS` to external `wallets.json` config file. Load at runtime.

### H-8. No Circuit Breaker in wallet_scanner.py
**File:** wallet_scanner.py:349-380
When data-api.polymarket.com is down, the scanner grinds through 300 retries (20 wallets x 5 pages x 3 retries) with exponential backoff, taking 30+ minutes to produce empty results.

**Fix:** Track consecutive failures. After 5 consecutive failed requests, abort the scan.

### H-9. Trade Dedup is Fragile (wallet_scanner.py)
**File:** wallet_scanner.py:180-181
`UNIQUE(wallet_address, condition_id, timestamp, side)` — two different-sized trades at the same timestamp on the same condition are deduplicated (second one silently dropped). No transaction ID used.

**Fix:** Include `size` and `price` in the unique constraint, or use a trade ID/hash from the API.

### H-10. Pagination Hard-Caps at 600 Trades (wallet_scanner.py)
**File:** wallet_scanner.py:811, 816
`max_offset=500` means at most 600 trades per wallet. Top wallets have thousands. The scanner silently analyzes incomplete data and presents it as complete.

**Fix:** Remove the cap or paginate until API returns fewer results than requested. Log truncation when it occurs.

### H-11. Zero Testability Across All Files
**Files:** All
No unit tests, no test fixtures, no mocks. `db()` functions hardcode paths to production SQLite files. API calls are embedded with no injection points. Strategies are monolithic and cannot be tested in isolation.

**Fix:** Accept DB path as parameter or env var. Extract HTTP calls behind an interface. Make strategies independently testable. Not blocking for R&D but critical before production.

---

## MEDIUM FINDINGS (Fix in Phase 2)

### M-1. Open Redirect on Login (both dashboards)
**Files:** rd_dashboard.py:99, unified_dashboard.py:517
`redirect(request.args.get("next", ...))` with no validation. Attacker can redirect post-login to external domain.
**Fix:** Validate `next` is a relative path.

### M-2. Rate Limiting Broken Behind Proxy (rd_dashboard.py)
**File:** rd_dashboard.py:39-41, 92
`request.remote_addr` is always `127.0.0.1` behind nginx. All clients share one lockout counter.
**Fix:** Add `ProxyFix(app.wsgi_app, x_for=1)`.

### M-3. Connection Leak on Exception (rd_trader_v3.py)
**File:** rd_trader_v3.py:540-762, 774
If unhandled exception occurs mid-loop, `conn.close()` is never reached.
**Fix:** Use `try/finally` or context managers.

### M-4. No Health Monitoring When API Returns Zero Markets
**File:** rd_trader_v3.py:316-343
If Gamma API is down, `fetch_all_markets()` returns empty list. Scan does nothing silently for hours.
**Fix:** Log WARNING when 0 markets fetched. Write health status file.

### M-5. Long-Held DB Connection During Scan (rd_trader_v3.py)
**File:** rd_trader_v3.py:540
Connection opened at start of scan loop, held for minutes processing 8,000 markets. Blocks resolver cron.
**Fix:** Commit frequently (already does every 100 trades — good). Consider shorter connection lifecycle.

### M-6. All Strategy Thresholds Hardcoded (rd_trader_v3.py)
**File:** rd_trader_v3.py:596-756
Every strategy has magic numbers embedded inline (price ranges, edge thresholds, volume floors, confidence levels). Cannot tune without code changes.
**Fix:** Extract to `STRATEGY_CONFIG` dict at top of file. Enable A/B testing.

### M-7. 228-Line Monolithic scan_and_trade() Function
**File:** rd_trader_v3.py:538-767
All 10 strategies inline in one function. Mixes iteration, filtering, probability estimation, dedup, and trade placement.
**Fix:** Extract each strategy into its own function. Use a strategy dispatch loop.

### M-8. "Value" Strategy Only Fires on Crypto/Deadline Markets
**File:** rd_trader_v3.py:596-616
`_est_crypto()` and `_est_deadline()` are the only probability models. For non-crypto, non-deadline markets, `prob` stays None and value/skew never fire. This covers a small fraction of the 9,420 unique markets.
**Fix:** Document this limitation. Consider adding a simple base-rate model for general markets.

### M-9. "Momentum_cheap" Buys Both Sides Indiscriminately
**File:** rd_trader_v3.py:677-689
No directional signal. Buys both YES and NO on qualifying markets. Not really "momentum" — more like "blanket cheap coverage."
**Fix:** Rename to `cheap_coverage` for clarity, or add a directional signal.

### M-10. Spread Strategy Ignores Transaction Costs
**File:** rd_trader_v3.py:732-743
YES+NO < 0.97 "arbitrage" — works in paper trading with no tx costs. In live trading, Polymarket fees eat the spread. Paper P&L will overstate live viability.
**Fix:** Document this. Add a fee-adjusted edge calculation for future live comparison.

### M-11. Hardcoded UTC-4 Timezone Offset (rd_trader_v3.py)
**File:** rd_trader_v3.py:504-510
`et_hour = (now_utc.hour - 4) % 24` — wrong during EST (November-March, UTC-5). Off-hours detection shifts by 1 hour for 5 months/year.
**Fix:** Use `zoneinfo.ZoneInfo("America/New_York")`.

### M-12. Unguarded float() on API Price Data (rd_trader_v3.py)
**File:** rd_trader_v3.py:577-578
`float(prices[i])` can throw ValueError on non-numeric strings from Gamma API.
**Fix:** Wrap in try/except with continue.

### M-13. Win Rate Calculation Wrong (wallet_scanner.py)
**File:** wallet_scanner.py:564-567
`win_rate = wins / total_trades` — denominator includes buys, sells, AND redeems. A wallet with 100 buys and 50 redeems shows 33% win rate (50/150), not 50%.
**Fix:** Compute win rate as redeemed positions / total closed positions (unique by condition_id).

### M-14. `category_distribution` Column Missing from Schema (wallet_scanner.py)
**File:** wallet_scanner.py:742-747
`generate_strategy_report()` reads `wallet.get("category_distribution", "{}")` but the wallets table has no such column. Category data in reports is always empty. Silently broken feature.
**Fix:** Add column to schema and persist in `save_wallet_stats()`, or derive from wallet_trades table.

### M-15. No WAL Mode in wallet_scanner.py
**File:** wallet_scanner.py:132-327
No WAL mode or busy_timeout on wallet_insights.db. Will conflict with concurrent reads.
**Fix:** Add WAL mode and busy_timeout to init_schema().

### M-16. CSP Allows unsafe-inline (nginx)
**File:** geminicap:27
`script-src 'self' 'unsafe-inline'` — negates XSS protection. Necessary because dashboards use inline scripts.
**Fix:** Move JS to external files, use nonce-based CSP. Longer-term fix.

### M-17. Template Injection via Disk File Read (unified_dashboard.py)
**File:** unified_dashboard.py:847
`open("/opt/polybot/rd/rd_template.html").read()` loaded per-request and passed to `render_template_string`. Write access to that file = arbitrary template injection.
**Fix:** Load at startup or embed in Python file.

### M-18. CSS Injection via Entity Color (unified_dashboard.py)
**File:** unified_dashboard.py:1425
`style="--entity-color: {{ entity.color }}"` — if entities.json is corrupted, color value can break layout.
**Fix:** Validate hex color format at load time.

### M-19. Bare except Clauses (unified_dashboard.py)
**File:** unified_dashboard.py:164, 174, 197
`except: pass` in `read_ledger_db` — swallows all errors including SystemExit, KeyboardInterrupt.
**Fix:** Use `except Exception as e: logger.warning(...)`.

### M-20. Flask Dev Server in Production (rd_dashboard.py)
**File:** rd_dashboard.py:1000
`app.run()` — single-threaded dev server behind nginx.
**Fix:** Deploy with gunicorn: `gunicorn -w 2 -b 127.0.0.1:8096 rd_dashboard:app`.

---

## LOW FINDINGS (Fix Opportunistically)

| # | File | Description |
|---|------|-------------|
| L-1 | rd_trader_v3.py:55 | Dead code: `CLOB_HOST` declared but never used |
| L-2 | rd_trader_v3.py:525 | Field mutation: `m["_precat"]` modifies API dict |
| L-3 | rd_trader_v3.py:66-74 | No log levels (everything same severity) |
| L-4 | rd_trader_v3.py:158-165 | ALTER TABLE catch swallows all OperationalError |
| L-5 | rd_dashboard.py:316-324 | Unauthenticated health endpoint leaks trade count |
| L-6 | rd_dashboard.py:324 | Error message leaks exception details |
| L-7 | rd_dashboard.py:36 | Hardcoded username |
| L-8 | rd_dashboard.py:360 | Chart.js CDN without SRI integrity hash |
| L-9 | rd_dashboard.py:359 | Meta refresh loses scroll position |
| L-10 | wallet_scanner.py:281-303 | activity_cache never pruned, grows without bound |
| L-11 | wallet_scanner.py:487-491 | Magic numbers in price classification |
| L-12 | wallet_scanner.py:856 | Unnecessary class instantiation (all methods are classmethod/staticmethod) |
| L-13 | wallet_scanner.py:694-707 | Dead code: `resolve_pseudonyms` handles only 4 of 20 wallets |
| L-14 | wallet_scanner.py:560-562 | Active hours uses UTC with no documentation |
| L-15 | unified_dashboard.py:53-55 | Dead code: DATA_CACHE/CACHE_LOCK/CACHE_TTL declared but never used |
| L-16 | unified_dashboard.py:846 | Unnecessary `if 'pytz' in dir()` check |
| L-17 | geminicap:10 | IP address in server_name expands attack surface |
| L-18 | geminicap (missing) | No custom error pages for 502/503/504 |

---

## DATABASE FINDINGS

### Current State
- **rd_ledger.db:** 21MB, 20,954 trades, 85,990 snapshots, 3 indexes
- **wallet_insights.db:** 12MB, 0 indexes (beyond autoindex)
- **rd_ledger_v2_archive.db:** 378MB (dead weight, reference only)

### Missing Indexes (Performance)
```sql
-- rd_ledger.db (already has idx_trades_status, idx_trades_cond, idx_trades_opened)
CREATE INDEX idx_snapshots_condition ON market_snapshots(condition_id);
CREATE INDEX idx_snapshots_at ON market_snapshots(snapshot_at);
CREATE INDEX idx_trades_strategy_status ON trades(strategy, status);
CREATE INDEX idx_trades_category ON trades(category);
CREATE INDEX idx_trades_end_date ON trades(end_date);

-- wallet_insights.db
CREATE INDEX idx_wallet_trades_wallet ON wallet_trades(wallet_address);
CREATE INDEX idx_wallet_trades_condition ON wallet_trades(condition_id);
CREATE INDEX idx_wallet_trades_timestamp ON wallet_trades(timestamp);
```

### Snapshot Table Growth
At ~86K snapshots after 1 day, this table will grow to ~2.5M rows/month. Without pruning, it will be the primary disk consumer.

**Fix:** Add pruning cron job — keep last 7 days of snapshots:
```sql
DELETE FROM market_snapshots WHERE snapshot_at < datetime('now', '-7 days');
```

---

## INFRASTRUCTURE FINDINGS

### Process Management
Both dashboards run in `screen` sessions — they do NOT survive VPS reboot.
**Fix:** Create systemd units:
```ini
# /etc/systemd/system/polybot-rd-dashboard.service
[Unit]
Description=Polymarket R&D Dashboard
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/polybot/rd
ExecStart=/opt/polybot/venv/bin/python3 rd_dashboard.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

### R&D Cron Jobs
The R&D cron jobs are NOT visible in the crontab output. They may be in a separate crontab or run via a different mechanism. Need to verify.

### Log Rotation
- rd_cron.log: 31K (small, but growing)
- rd_trader.log: 72K
- rd_reports.log: 17K
No logrotate config exists for these files.

**Fix:** Add `/etc/logrotate.d/polybot-rd`:
```
/opt/polybot/rd/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
}
```

### Secrets Storage
`/dev/shm/polybot-secrets/` — tmpfs (RAM-only), won't survive reboot. Contains:
- api_keys.json (524 bytes)
- api_keys_state.json (524 bytes)
- dashboard_creds.json (304 bytes)
- wallet.json (148 bytes)

This is good for security (not on disk) but bad for resilience (lost on reboot). Need a provisioning script to recreate on boot.

---

## PRIORITIZED FIX PLAN

### Phase 1: Critical + Security (Day 1)
1. Fix hardcoded secret keys in both dashboards (C-1)
2. Fix UnboundLocalError crash in wallet_scanner (C-2)
3. Add WAL mode + busy_timeout to rd_dashboard.py (H-2)
4. Add WAL mode + busy_timeout to wallet_scanner.py (M-15)
5. Fix CSRF validation in rd_dashboard.py (H-1)
6. Fix open redirect in both dashboards (M-1)
7. Add ProxyFix to rd_dashboard.py (M-2)
8. Create systemd units for both dashboards (replace screen)
9. Add logrotate config
10. Add missing DB indexes

### Phase 2: Reliability (Day 2)
11. Add API retry logic in rd_trader_v3.py (H-3)
12. Cache CoinGecko prices per-cycle (H-4)
13. Add connection leak protection (try/finally) across all files (M-3)
14. Add health monitoring for zero-market fetches (M-4)
15. Fix bare except clauses (M-19)
16. Add snapshot table pruning cron (7-day retention)
17. Add circuit breaker to wallet_scanner (H-8)
18. Fix wallet pagination cap (H-10)
19. Fix trade dedup in wallet_scanner (H-9)
20. Fix win rate calculation (M-13)
21. Fix timezone hardcoding (M-11)

### Phase 3: Code Quality + Trading Logic (Day 3)
22. Extract strategy thresholds to config dict (M-6)
23. Refactor scan_and_trade() into per-strategy functions (M-7)
24. Add time-to-expiry to crypto model (H-5)
25. Fix mean_revert edge metric (H-6)
26. Document strategy limitations (M-8, M-9, M-10)
27. Move wallet list to external config (H-7)
28. Fix category_distribution column (M-14)
29. Move inline templates to external files (longer-term)
30. Schedule wallet_scanner on daily cron

---

## POSITIVE FINDINGS (Things Done Right)

1. **SQL injection protection** — All queries parameterized across all files
2. **Session cookie flags** — httponly, secure, samesite=lax correctly set
3. **Nginx TLS config** — TLS 1.2/1.3 only, modern ciphers, HSTS with preload
4. **Nginx exploit blocking** — PHP, WordPress, traversal attacks blocked with 444
5. **No secrets in code** — No API keys or wallet private keys in source
6. **WAL mode in trading engine** — rd_trader_v3.py correctly uses WAL + high busy_timeout
7. **In-memory dedup** — Batch-loads recent trades into set instead of per-trade SQL
8. **Dual-pass market fetch** — Volume + endDate sorted passes maximize coverage
9. **Read-only dashboard** — No mutation endpoints, correct separation
10. **flock guards on cron** — Prevents overlapping scan/resolve cycles

---

*End of Audit Report*
