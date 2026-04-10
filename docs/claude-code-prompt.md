# Polymarket Trading System — Claude Code Engineering Prompt

**Purpose:** R&D system audit + rebuild. Production is OFF-LIMITS until R&D proves the theory.
**Last Updated:** 2026-04-03
**Principal:** Dale Boehm, CEO — Armorstack

---

## SYSTEM OVERVIEW

You are working on a Polymarket prediction market paper trading system deployed on a DigitalOcean VPS. The system scans thousands of active markets, places paper trades using 10 different strategies, resolves them when markets close, and displays results on authenticated web dashboards.

**Goal:** Audit and rebuild the R&D engine ONLY. The production trading system (`/opt/polybot/` root, excluding `/opt/polybot/rd/`) is OFF-LIMITS — do not modify any production files, cron jobs, or configs. Once R&D proves the strategy theory and we have validated results, we will finalize a version and update production separately.

**CRITICAL SCOPE RULE:** All work is confined to:
- `/opt/polybot/rd/` (R&D engine files and databases)
- `/opt/polybot/rd/rd_trader_v3.py` (trading engine)
- `/opt/polybot/rd/rd_dashboard.py` (R&D dashboard)
- `/opt/polybot/rd/wallet_scanner.py` (wallet intelligence)
- `/opt/polybot/unified_dashboard.py` (master dashboard — read for context, fix bugs only)
- `/etc/nginx/sites-enabled/geminicap` (nginx — read for context, fix routing only)
- Do NOT touch: `/opt/polybot/*.py` (production scripts), production cron jobs, production databases

---

## VPS ACCESS

```
Host: 178.62.225.235
Port: 2222
User: root
SSH Key: /mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key
Region: DigitalOcean AMS3 (Amsterdam)

# Connection command:
ssh -i /mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key -p 2222 -o StrictHostKeyChecking=no -o ConnectTimeout=15 root@178.62.225.235

# SCP upload:
scp -i /mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key -P 2222 -o StrictHostKeyChecking=no <local_file> root@178.62.225.235:<remote_path>

# SCP download:
scp -i /mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key -P 2222 -o StrictHostKeyChecking=no root@178.62.225.235:<remote_path> <local_file>
```

**NOTE:** SSH connections timeout frequently (exit 255/143). Always use `-o ConnectTimeout=15`. For long-running commands, use `screen -dmS <name> bash -c '<command>'` and check results afterward.

---

## DATA REPOSITORIES

### On VPS (`/opt/polybot/`)

| Path | Description | Size |
|------|-------------|------|
| `/opt/polybot/rd/rd_ledger.db` | **Active R&D trades database** — ~19K trades, 8.8K unique markets, SQLite WAL mode | Growing |
| `/opt/polybot/rd/rd_ledger_v2_archive.db` | Archived v2 trades (246K trades, all expired) — reference only | 395MB |
| `/opt/polybot/rd/wallet_insights.db` | Wallet intelligence — 20 wallets, 6,653 trades | 12MB |
| `/opt/polybot/rd/rd_trader_v3.py` | **Active trading engine** — MAX COVERAGE build, 10 strategies, dual-pass market fetch | ~48KB |
| `/opt/polybot/rd/rd_dashboard.py` | R&D web dashboard (Flask, port 8096) — comprehensive analytics | ~40KB |
| `/opt/polybot/rd/wallet_scanner.py` | Wallet intelligence system | 39KB |
| `/opt/polybot/unified_dashboard.py` | Master dashboard (Flask, port 8095) — multi-entity overview | ~100KB |
| `/opt/polybot/rd/rd_cron.log` | R&D scan/resolve logs | Rolling |
| `/opt/polybot/rd/rd_reports.log` | Hourly strategy reports | Rolling |
| `/opt/polybot/venv/` | Python virtual environment | — |
| `/dev/shm/polybot-secrets/dashboard_creds.json` | Dashboard login credentials (hashed) | — |

### On Local Workspace (`/mnt/CLAUDE/Polymarket/`)

| Path | Description |
|------|-------------|
| `docs/context.md` | Architecture, APIs, wallet addresses, bug history |
| `docs/status.md` | Live system state reference |
| `docs/todo.md` | Pending tasks and priorities |
| `docs/progress.md` | Phase completion history |
| `deploy/armorstack_vps_key` | SSH private key for VPS access |

### Key External APIs (NO AUTH REQUIRED)

| API | URL | Purpose |
|-----|-----|---------|
| Gamma API | `https://gamma-api.polymarket.com/markets` | Market metadata, prices, endDates, resolution status |
| Data API | `https://data-api.polymarket.com/activity?user={wallet}` | Wallet trade history (the key discovery — only API that exposes individual wallet trades) |
| CoinGecko | `https://api.coingecko.com/api/v3/simple/price` | Crypto price feeds for crypto_dir strategy |

---

## CURRENT ARCHITECTURE

```
┌─────────────────────────────────────────────────────────┐
│                  VPS: 178.62.225.235:2222                │
├───────────────────────┬─────────────────────────────────┤
│  /opt/polybot/        │  /opt/polybot/rd/               │
│  (Production - PAUSED)│  (R&D Engine - ACTIVE)          │
│                       │                                 │
│  22 cron jobs         │  rd_trader_v3.py                │
│  (monitoring only)    │  ├── Dual-pass market fetch     │
│                       │  │   (volume + endDate sorted)  │
│  unified_dashboard.py │  ├── 10 strategy modules        │
│  (port 8095, nginx)   │  ├── 7-day resolution window    │
│                       │  ├── 8,000 markets/cycle cap    │
│                       │  └── In-memory dedup (30 min)   │
│                       │                                 │
│                       │  rd_dashboard.py                │
│                       │  (port 8096, nginx /rd proxy)   │
│                       │                                 │
│                       │  rd_ledger.db (SQLite WAL)      │
│                       │  ├── 19K+ trades               │
│                       │  ├── 8,800+ unique markets      │
│                       │  ├── 0 resolved (awaiting PM)   │
│                       │  └── 40K+ market snapshots      │
├───────────────────────┴─────────────────────────────────┤
│  Nginx (TLS) → port 8095 (master) + port 8096 (/rd)    │
│  Cron: scan/5min, resolve/10min, report/hourly          │
│  Screen sessions: master_dash, rd_dash                  │
└─────────────────────────────────────────────────────────┘
```

### Process Management
- **Master Dashboard:** `screen -S master_dash` → Flask on port 8095
- **R&D Dashboard:** `screen -S rd_dash` → Flask on port 8096
- **Cron Jobs:** `flock -xn` guards on scan and resolve to prevent overlap
- **No systemd services** — processes managed via screen sessions (survivability risk)

### Trading Engine (rd_trader_v3.py) — 10 Strategies

| # | Strategy | Logic | Price Range | Volume Req |
|---|----------|-------|-------------|------------|
| 1 | **value** | Mispriced markets (edge ≥ 0.04, payoff ≥ 1.3x) | 0.05-0.55 | None |
| 2 | **skew** | Asymmetric payoff (edge ≥ 0.02) | 0.03-0.35 | None |
| 3 | **crypto_dir** | Directional crypto (CoinGecko price vs target) | ≤ 0.65 | None |
| 4 | **deadline** | Expired markets with deadline keywords | ≤ 0.50 | None |
| 5 | **momentum_cheap** | Cheap consensus plays | 0.03-0.22 | > 500 |
| 6 | **mean_revert** | Mean reversion near 0.50 (±0.12) | 0.35-0.65 | > 1000 |
| 7 | **favorites** | Strong consensus (high price) | ≥ 0.88 | None |
| 8 | **longshot** | Low-probability high-payoff | 0.02-0.12 | None |
| 9 | **spread** | Arbitrage when YES+NO < 0.97 | Any | None |
| 10 | **random_control** | Random baseline (1-in-10 markets) | 0.02-0.98 | None |

### Market Categories (12)
`weather`, `crypto`, `intl_sports`, `sports`, `politics`, `geopolitics`, `finance`, `entertainment`, `ai_tech`, `other`

### Off-Hours Prioritization
During US off-hours (before 9am / after 9pm ET, weekends): global categories (`crypto`, `intl_sports`, `geopolitics`, `weather`, `finance`, `other`) are sorted to front of scan queue.

---

## PART 1: SYSTEM AUDIT

Perform a thorough code review covering all files listed above. For each finding, provide: **severity** (CRITICAL/HIGH/MEDIUM/LOW), **file:line**, **description**, and **recommended fix**.

### 1A. Security Audit
- SSH key management and access controls
- Database file permissions and WAL mode config
- API key/secret exposure (check for hardcoded credentials in ALL files)
- Dashboard authentication flow (login, session, CSRF, rate limiting, password hashing)
- Nginx TLS config and security headers (CSP, HSTS, etc.)
- Input validation on all Flask routes and API endpoints
- SQL injection vectors (any string-formatted queries vs parameterized)
- Secrets storage (`/dev/shm/polybot-secrets/`)

### 1B. Reliability Audit
- SQLite concurrent access (WAL mode, busy_timeout, lock contention between cron + dashboard)
- Error handling and retry logic in Gamma API calls
- Cron flock guards — are ALL long-running processes protected?
- Screen session management — what happens on VPS reboot? (no systemd units)
- Memory/disk growth: log rotation? DB size growth rate? Snapshot table pruning?
- Gamma API failure modes: rate limiting? Timeouts? Stale data handling?
- What happens when dual-pass fetch takes longer than the 5-minute cron interval?

### 1C. Code Quality
- Dead code (unused functions, unreachable branches, orphaned templates)
- Duplicate logic across unified_dashboard.py, rd_dashboard.py, rd_trader_v3.py
- Template duplication in dashboard HTML (inline templates vs external files)
- Configuration management (hardcoded values vs config file — there IS no config file)
- Naming consistency across modules
- The dead template block in unified_dashboard.py (partially cleaned, verify)

### 1D. Architecture Review
- Data flow: scan → trade → snapshot → resolve → dashboard
- Single points of failure (screen sessions, no process supervisor)
- Scaling bottlenecks for 15-entity expansion
- Database schema optimization (missing indexes, denormalization, snapshot table growth)
- API call efficiency (redundant fetches, missing caching between scan and resolve)

### 1E. Trading Logic Review
- Strategy implementation correctness (each of the 10 strategies)
- Dedup logic completeness (30-min window — is this optimal?)
- Resolution matching accuracy (WON/LOST mapping from Gamma API resolution field)
- Edge estimation calibration (crypto model assumptions)
- P&L calculation correctness (shares = size/price, pnl = (exit-entry)*shares)
- The `is_within_window()` stale cutoff (48h past — is this right?)

---

## PART 2: MULTI-ENTITY PARALLEL ARCHITECTURE (DEFERRED — R&D MUST PROVE THEORY FIRST)

> **NOTE:** This section documents the target architecture for AFTER R&D proves the strategy theory. Do NOT implement any of this until we have validated strategy performance data from resolved trades. Focus all current effort on Part 1 (Audit) and Part 3 (Quick Wins).

### Requirements (Future — After R&D Validation)
Build a system that runs 15 independent trading entities sharing infrastructure:

1. **Shared Market Fetcher** — One process fetches and caches all qualifying markets every 5 minutes. All entity scanners read from this cache instead of each hitting the Gamma API independently. Eliminates 15x API call redundancy.

2. **Per-Entity Strategy Workers** — Each entity gets its own configuration (different risk parameters, position sizes, category preferences, strategy weights). They read from the shared market cache and write to their own SQLite databases.

3. **Shared Resolver** — One process checks resolutions for all entities (Gamma API calls are identical regardless of which entity placed the trade).

4. **Entity Configuration** — YAML or JSON config per entity specifying:
   - Name, slug, color (for dashboard)
   - Strategy whitelist (which of the 10 strategies to use)
   - Strategy parameters (price thresholds, volume floors, edge requirements)
   - Category focus (e.g., entity A = crypto-only, entity B = sports + politics)
   - Position sizing (paper trade size, max concurrent positions)
   - Resolution window (72h vs 168h vs custom)

5. **Unified Dashboard Integration** — Each entity appears as a card on the master dashboard (already has the entity card UI). Entity detail pages show full analytics. R&D Lab becomes one of 15 entities.

6. **Parallel Execution** — Cron or systemd timers that run all entity scans concurrently (not sequentially). Each entity worker takes <10 seconds once markets are cached.

### Proposed Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    SHARED LAYER                          │
│                                                         │
│  market_cache.py (cron: */5)                            │
│  ├── Dual-pass Gamma API fetch                          │
│  ├── Write to /opt/polybot/shared/market_cache.db       │
│  └── Markets table: condition_id, question, prices,     │
│      volume, endDate, category, fetched_at              │
│                                                         │
│  resolver.py (cron: */10)                               │
│  ├── Read ALL entity DBs for open condition_ids         │
│  ├── Bulk + spot-check resolution from Gamma API        │
│  └── Update each entity's DB with WON/LOST status      │
├─────────────────────────────────────────────────────────┤
│                  ENTITY WORKERS                          │
│                                                         │
│  entity_trader.py --entity=alpha (cron: */5)            │
│  entity_trader.py --entity=bravo (cron: */5)            │
│  entity_trader.py --entity=charlie (cron: */5)          │
│  ... (up to 15 entities)                                │
│                                                         │
│  Each reads from market_cache.db                        │
│  Each writes to /opt/polybot/entities/{slug}/ledger.db  │
│  Each has config in /opt/polybot/entities/{slug}/config.yaml │
├─────────────────────────────────────────────────────────┤
│                   DASHBOARD LAYER                        │
│                                                         │
│  unified_dashboard.py (port 8095)                       │
│  ├── Auto-discovers entities from /opt/polybot/entities/ │
│  ├── Master view: card per entity + aggregate totals    │
│  ├── Entity detail: full analytics per entity           │
│  └── R&D Lab = just another entity (migrated)           │
└─────────────────────────────────────────────────────────┘
```

### Entity Config Example (config.yaml)

```yaml
name: "Alpha Fund"
slug: "alpha"
color: "#10B981"
paper_size: 10.0
max_horizon_hours: 168
dedup_minutes: 30
max_markets_per_cycle: 8000

strategies:
  value:
    enabled: true
    edge_threshold: 0.04
    payoff_min: 1.3
    price_range: [0.05, 0.55]
  favorites:
    enabled: true
    price_threshold: 0.88
  longshot:
    enabled: true
    price_range: [0.02, 0.12]
  momentum_cheap:
    enabled: true
    volume_min: 500
    price_range: [0.03, 0.22]
  random_control:
    enabled: false  # Disabled for this entity
  # ... etc

categories:
  whitelist: ["crypto", "finance", "ai_tech"]  # Only trade these
  # OR
  blacklist: ["sports", "entertainment"]  # Trade everything except these

off_hours:
  prioritize_global: true
```

### Migration Path
1. Extract market fetching from rd_trader_v3.py into standalone `market_cache.py`
2. Extract resolution logic into standalone `resolver.py`
3. Refactor strategy logic into configurable `entity_trader.py`
4. Migrate existing rd_ledger.db as the "rd-lab" entity
5. Create 14 additional entity configs
6. Update unified_dashboard.py to auto-discover entities
7. Replace screen sessions with systemd services
8. Add log rotation and DB pruning

### Process Supervision (Replace Screen)
```ini
# /etc/systemd/system/polybot-dashboard.service
[Unit]
Description=Polymarket Master Dashboard
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/polybot
ExecStart=/opt/polybot/venv/bin/python3 unified_dashboard.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Similar units for rd_dashboard. Cron jobs already handle the trading engine.

---

## PART 3: IMPLEMENTATION PRIORITIES (R&D SCOPE ONLY)

Execute in this order. ALL work confined to R&D files — production is off-limits.

### Phase 1: Audit + Quick Wins (Day 1)
- Run full audit per Part 1 — R&D files only
- Fix all CRITICAL and HIGH findings in rd_trader_v3.py, rd_dashboard.py, wallet_scanner.py
- Add systemd units for R&D dashboard (replace screen session `rd_dash`)
- Add log rotation for rd_cron.log and rd_reports.log
- Add market_snapshots pruning (keep last 7 days)
- Schedule wallet_scanner.py on cron (daily refresh)

### Phase 2: R&D Engine Hardening (Day 2)
- Fix any issues found in audit
- Optimize resolution matching (this is THE bottleneck — 19K trades, 0 resolved)
- Add DB indexes for common query patterns (strategy+status, condition_id+status)
- Improve error handling and logging quality
- Add configuration file (extract hardcoded values from rd_trader_v3.py)

### Phase 3: Strategy Validation Framework (Day 3 — After Resolutions Start)
- Build automated strategy ranking (Sharpe, win rate, profit factor, edge accuracy)
- Build P&L attribution report per strategy
- Compare R&D strategy performance vs. wallet scanner archetype performance
- Identify which strategies to keep, tune, or discard

### DEFERRED: Multi-Entity Architecture (After R&D Proves Theory)
- See Part 2 above — only start after we have validated strategy performance
- Phases: shared market cache → entity framework → scale to 15 → production migration

---

## CONVENTIONS

- **Python version:** 3.x (whatever's in `/opt/polybot/venv/`)
- **Database:** SQLite with WAL mode, `busy_timeout=30000`+
- **API rate limit:** 0.10-0.12 seconds between Gamma API calls
- **Pip installs:** Always use `--break-system-packages` flag
- **File naming:** lowercase-hyphenated for scripts, snake_case for Python modules
- **Backup before overwrite:** Always `cp file.py file_backup.py` before replacing
- **SSH timeout handling:** Commands that take >2 minutes should use screen sessions
- **Testing remote changes:** SCP file to VPS, then execute (don't run Python over heredoc/SSH — escaping issues)

---

## IMPORTANT NOTES

1. **Zero resolved trades yet.** All 19K trades are OPEN. Polymarket hasn't posted resolution data for closed markets within our window. This is THE milestone we're waiting for — once resolutions flow, we can evaluate strategy performance.

2. **The production trading system is PAUSED and OFF-LIMITS** (capital lock since 2026-03-31). 22 cron jobs run for monitoring only. Do NOT modify ANY production files. All work scoped to `/opt/polybot/rd/` until R&D proves the strategy theory.

3. **Nginx routes:** Everything goes through port 8095 except `/rd` which proxies to 8096. Both require authentication.

4. **Database locking:** The biggest operational issue. Cron scan (every 5 min) and cron resolve (every 10 min) both write to rd_ledger.db. The dashboard reads from it. Use WAL mode, high busy_timeout, and retry logic everywhere.

5. **Gamma API quirks:** Returns "active" markets from 2020. endDate field is unreliable — some markets have no endDate, some have dates years in the future. The `is_within_window()` function handles this.

6. **Session continuity:** After completing work, update all 4 docs files in `/mnt/CLAUDE/Polymarket/docs/` (context.md, status.md, todo.md, progress.md) per the continuity protocol.
