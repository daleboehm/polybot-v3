# Polybot V3 --- Live Status

**Updated: 2026-04-17** (R&D back online after 2-day outage; CTF V2 hard blocker confirmed; GitHub-only deploy)

## TL;DR for a fresh Claude session

**PROD IS HALTED.** Kill-switch has been active since 2026-04-13 (43.8% daily drawdown). Two hard blockers before any live redeploy:
1. **CTF Exchange V2 migration** --- new order struct + Polymarket USD stablecoin (replaces USDC.e). All open orders cancelled at cutover. CLOB client must be updated first. See `docs/ctf-exchange-v2-migration-plan-2026-04-16.md`.
2. **NULL strategy root cause** --- 5 trades, 0% WR, -$18.12 in unattributed positions (no kill-switch coverage). Query `positions WHERE strategy_id IS NULL`, find the code path, add guard.

**R&D was down 2026-04-15 to 2026-04-17.** Root causes fixed 2026-04-17:
- `max_portfolio_exposure_pct` was inheriting 0.15 from prod config. R&D had $2,351 deployed vs $1,227 cap. Fixed: explicit `1.0` override in `config/rd-default.yaml` (commit `0746c93`).
- `min_edge_threshold: 0.02` was rejecting all signals (observed edges 0.003-0.004). Lowered to `0.005`.
- Backfill/UMA-watch services were failing: `/opt/polybot-v3-rd/config/` did not exist after archive rename. Fixed: symlinks created pointing to `/opt/polybot-v3/config/`.
- First cycle post-fix: 1,440 signals, 392 orders placed.

**Deploy workflow changed 2026-04-17:** GitHub is the only edit path. No workstation clone. VPS pushes via SSH deploy key `~/.ssh/github_polybot_deploy`.

**Research pipeline:** Nightly task `polybot-strategy-research` fires at 8:17 PM daily. Prior run (2026-04-17 03:47 UTC) generated a hallucinated report with fabricated P&L numbers --- replaced with vetted version. Vetting gate now in Claude memory. All 5 queued tweets processed and discarded (4 engagement bait / 1 paid ad / 1 unverifiable). Jua/EPT-2 weather adversary confirmed real.

**Upcoming P0 actions (before prod redeploy):**
- CTF Exchange V2 CLOB client update
- NULL strategy diagnosis and guard
- Disable weather_forecast permanently (move from protected to disabled in config)
- Fix kill-switch schema (`halted_by` column missing from query)

## TL;DR for a fresh Claude session

**R1 through R3c rebuild is DONE.** Don't start work on reconciler rewrites, phantom fee fixes, Wilson LB gates, walk-forward validators, or strategy quarantine — those are all implemented and deployed. Check the actual code state with the Explore agent before starting any "rebuild" task.

**Both engines are live and healthy.** Prod on port 9100, R&D on port 9200. Whale subscriber polling Polygon every 60s, 21 whales whitelisted.

**Next work areas**: R4 scale items (AWS KMS signing, blue/green deploy, Kalshi atomic arb, market-making), or consensus-driven execution (the `polybot whale-consensus --execute` command is ready to enter the 10 actionable consensus markets).

## Engines (as of 2026-04-14 04:00 UTC)

| Engine | Service | Port | Mode | Status | DB |
|---|---|---|---|---|---|
| Prod | `polybot-v3` | 9100 (internal) | live | active | `/opt/polybot-v3/data/polybot.db` |
| R&D | `polybot-v3-rd` | 9200 (path `/rd`) | paper | active | `/opt/polybot-v3-rd/data/rd.db` |

- Both share `/opt/polybot-v3/dist/index.js` binary
- Both enabled for `WHALE_COPY_ENABLED=true`
- Both have 21 whitelisted whales in their respective `whitelisted_whales` tables
- Health endpoints (before auth): `http://localhost:9100/api/health` and `http://localhost:9200/rd/api/health`
- External dashboards: https://sageadvisors.ai (prod), https://rd.sageadvisors.ai/rd (R&D)

## R1 — Defensive hardening (COMPLETE)

- ✅ OnChainReconciler rewritten to use `DataApiClient` (unfiltered `/positions`, `cashPnl` as authoritative)
- ✅ Per-cycle reconciler uses `proxy_address || account_address` fallback (was broken for prod)
- ✅ Phantom fee removed: `feeRate = 0` hardcoded in clob-router.ts and paper-simulator.ts
- ✅ Position sizer ordering: Kelly → strategy weight → wash-trading penalty → caps (A-P1-2 fix)
- ✅ 5-share CLOB minimum floor in sizer
- ✅ Kill switch (`src/core/kill-switch.ts`) with 11 halt reasons, SIGUSR1/SIGUSR2 handlers, dashboard /api/kill-switch endpoint
- ✅ `/api/health` endpoint placed BEFORE auth check (monitors can ping unauthenticated)
- ✅ Watchdog timer alerts via Telegram when scan cycle goes stale (2-min interval)
- ✅ Hourly SQLite backups via `polybot-v3-backup.service` systemd timer (24 copies retained)
- ✅ Systemd hardening: `ProtectSystem=full`, `ProtectHome=true`, `PrivateDevices=true`, `PrivateTmp=true`, `NoNewPrivileges=true`
- ✅ Daily loss guard with `> 0` gate (A-P1-5)
- ✅ Stop-loss monitor produces 4 exit types (profit_target, trailing_lock, hard_stop, stop_loss)
- ✅ Order builder uses market's `minimum_tick_size` (A2) and assigns `order_id` at build time (A-P0-9)
- ✅ Sampling poller validates outcome field (A-P0-10) instead of relying on token index order
- ✅ Session secret derived from DASHBOARD_PASSWORD via HMAC-SHA256 (separate from password)

## R2 — Strategy layer rebuild (COMPLETE)

- ✅ `value.ts`, `skew.ts`, `complement.ts` quarantined to `src/strategy/archive/` (not imported from registry)
- ✅ Wilson LB gates in strategy-advisor.ts: n≥50, LB≥0.50 to enable; Wilson UB<0.50 and P&L<-$5 to disable
- ✅ Walk-forward validator (`src/validation/walk-forward.ts`)
- ✅ Brier score + Murphy decomposition (`src/validation/brier.ts`)
- ✅ DSR/PSR shadow mode via `ADVISOR_V2_ENABLED=true` (observational, A/B vs Wilson)
- ✅ MinTRL calculation for strategy classification
- ✅ 3-tier base-rate calibration chain: own-data calibrator → Markov empirical grid (Becker 72.1M trades) → naive fallback
- ✅ Strategy weighter with per-entity isolation (`${entity}|${strategy}|${sub}` key), [0.15, 2.0] bounds
- ✅ favorites, longshot, convergence all use 3-tier calibration chain

## R3a — Signal feeds (COMPLETE)

- ✅ `src/market/odds-api-client.ts` (276 LOC) — Odds API with quota tracking
- ✅ `src/market/kalshi-client.ts` (238 LOC) — Kalshi CLOB client with backoff
- ✅ `src/market/fred-client.ts` (170 LOC) — FRED economic data
- ✅ `src/strategy/custom/sportsbook-fade.ts` — sportsbook sentiment fade
- ✅ `src/strategy/custom/cross-market-divergence.ts` — Kalshi vs Polymarket divergence
- ✅ `src/strategy/custom/macro-forecast.ts` — macro economic event forecasts

## R3b — Observability (COMPLETE)

- ✅ `src/metrics/alerter.ts` (212 LOC) — Telegram alerter (no-op if TELEGRAM_BOT_TOKEN unset)
- ✅ `src/metrics/metrics.ts` (155 LOC) — Prometheus text-format metrics exposition at /metrics
- ✅ `src/risk/portfolio-risk.ts` (203 LOC) — correlation-aware portfolio heat
- ✅ `src/market/regime-detector.ts` (119 LOC) — market regime classification
- ✅ `src/execution/book-quality-check.ts` (170 LOC) — pre-trade book freshness + depth + spread + ghost detection

## R3c — Fleet coordination (COMPLETE, gated)

- ✅ `src/core/scan-scheduler.ts` (109 LOC) — per-entity scan offsets
- ✅ `src/core/position-claim.ts` (104 LOC) — anti-self-bidding claim mechanism
- ✅ `src/treasury/pool-manager.ts` — shared cash pool across entities
- ✅ `src/accounting/entity-tax.ts` — per-entity weekly tax / profit sharing
- All gated behind `FLEET_ACTIVE=true` flag (currently OFF)

## Whale tracking (LIVE as of 2026-04-14)

- **21 whitelisted whales** in `whitelisted_whales` table (both prod and R&D):
  - 1 Fredi9999 (manual seed)
  - 20 from leaderboard scan of 8,439 high-PnL wallets on 2026-04-13
  - Top: denizz (84.7% WR, $152K PnL, mult 1.0), eCash (89.5% WR, mult 1.0), JustaNobody (85.2%, mult 0.9), stupid22 (87.1%, mult 0.9), M2sx92kljs42 (82.3%, mult 0.9)
- **Subscriber polls Polygon every 60s** for OrderFilled events on CTF Exchange (`0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`) + NegRisk CTF Exchange (`0xC5d563A36AE78145C45a50134d48A1215220f80a`)
- **Critical fix (commit `3de4e7c`)**: `max_blocks_per_poll` was 1000, now chunked into 8-block sub-ranges. Fixed the silent "invalid block range" errors on Alchemy free tier and polygon-bor-rpc.publicnode.com
- **275+ whale trades observed** in first hour after the fix
- `WHALE_COPY_ENABLED=true` in both `.env` files
- `whale_copy` strategy (`src/strategy/custom/whale-copy.ts`) active but dormant until a whitelisted whale trade is observed with a resolved condition_id

## Consensus scanner (NEW 2026-04-14)

- CLI: `polybot whale-consensus --entity polybot --min-whales 4 --min-wr 0.75 [--max-entries N] [--execute]` (commit `581326b`)
- Python standalone: `/opt/polybot-v3/scripts/whale-consensus.py`
- **Last scan (2026-04-14 03:52 UTC)**: 23 markets with 4+ whales agreeing, 10 actionable (not already held)
- Heavy Iran/geopolitics cluster — 9-whale unanimous markets:
  - NO "Iranian regime fall by June 30" — avgWR 81%, $336K exposure
  - NO "US invade Iran before 2027" — avgWR 79%, $438K exposure  
  - YES "Iran x Israel conflict ends by April 7" — avgWR 79%, $344K exposure
- **Not yet executed** — Dale reviewing before `--execute`

## Recent commits (2026-04-14)

- `3de4e7c` fix(whale): subscriber RPC chunking + consensus scanner script
- `581326b` feat(cli): whale-consensus command for consensus-driven entries
- `198d98e` harden(systemd): ProtectSystem + ProtectHome + PrivateDevices
- `4c1d5c4` fix(systemd): move .env and state/ to ReadOnlyPaths
- `d507173` fix(systemd): downgrade ProtectSystem strict→full (strict blocked /opt access for dotenvx)

## Research task

- `polybot-strategy-research` recurring daily 8 PM local (20:00)
- `polybot-research-tonight` one-shot fires at 2026-04-14 00:12 local (in ~50 min)
- Both email report summary to dale.boehm@armorstack.ai
- Full .docx saved to `/mnt/CLAUDE/Polymarket/polymarket-strategy-research-YYYY-MM-DD.docx`

## Infrastructure

- **VPS**: 178.62.225.235:2222 (root), SSH key at `~/.armorstack-vault/polymarket/armorstack_vps_key`
- **Workstation repo**: `C:\Users\dboehm\dev\polybot-v3\` (NOT OneDrive — OneDrive sync caused catastrophic git conflicts 2026-04-11/12/13)
- **GitHub**: `github.com/daleboehm/polybot-v3` (private)
- **Deploy flow**: edit → commit → push → VPS `git fetch && git reset --hard origin/main` → `npm run build` → `systemctl restart polybot-v3 polybot-v3-rd`
- **NEVER** hot-patch `/opt/polybot-v3/dist/` directly (see deploy-discipline memory)
- **Polygon RPC**: Alchemy (key in .env), free tier — limits getLogs to 10 blocks

## Port note

External port 3000 does NOT serve prod anymore. Prod dashboard is on internal 9100 (nginx proxies 443→9100 for sageadvisors.ai). If you try `curl localhost:3000` you'll get connection refused — that's expected.
