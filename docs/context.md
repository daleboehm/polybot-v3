# Polybot V3 — Architecture Context

**Updated: 2026-04-23 11:55 CDT** (new data feeds, new skills, kill-list discipline, autonomous monitoring)

## 2026-04-23 capability state — read this before any Polybot session

### Engines (both running latest commit 69442a4)

- **Prod** (`polybot-v3`): live mode, $373.62 balance, HALTED via `kill_switch_state` (operator_sigusr1 since 2026-04-15). max_position_usd=$25, daily_loss_lockout=$10, fractional_kelly=0.20, exchange_version=v1.
- **R&D** (`polybot-v3-rd`): paper mode, $10,000 equity (recapitalized 2026-04-23), 114 clean-book positions. max_position_usd=$75, fractional_kelly=0.25, exchange_version=v2 (V2 shakedown in progress).

### Active sub-strategies (post 2026-04-23 kill-list)

**Survivors** (both engines, with Kelly-positive edge at n≥50):
- `favorites/compounding` (f_q=0.073)
- `longshot/news_overreaction_fade` (f_q=0.109 — best Sharpe)
- `longshot/bucketed_fade` (f_q=0.070)
- `negrisk_arbitrage/buy_the_set` (f_q=0.164, tail-risk-capped)
- `weather_forecast/{ensemble_spread_fade, next_day_horizon}` (small-n positive)
- `crypto_price/*` — latency_arb, target_proximity, volatility_premium_fade, ta_momentum (Chainlink-arb focus)
- `rtds_forecast/{equity, commodity}` — high-velocity workhorse, 10× sizing active
- `maker_rebate` — sports/esports post-only maker flow
- `cross_market`, `macro_forecast`, `whale_copy`

**Killed** (do not re-enable without new evidence):
- favorites/fan_fade, favorites/stratified_bias
- longshot/systematic_fade
- weather_forecast/single_forecast (payout asymmetry 4:1)
- convergence (entire)
- sportsbook_fade (entire)

### Data feeds (stack as of 2026-04-23)

- **Binance WS** + **Coinbase** + **Chainlink proxy** — exchange-divergence-scout (threshold 0.5% for Chainlink-latency arb)
- **Pyth Hermes** — secondary oracle (9 feeds: BTC/ETH/SOL/XRP/XAU/XAG/EUR/GBP/SPY)
- **Polymarket RTDS WebSocket** — 28 symbols streaming (commodity/FX/equity)
- **Open-Meteo ECMWF AIFS ensemble** — weather (20% more accurate than IFS)
- **NOAA HRRR** — short-range weather blend for <48h
- **Meteostat / Open-Meteo archive** — historical weather (backtest ground truth)
- **FRED API** — macro (CPI, unemployment, yield curves)
- **Parlay API** (parlay-api.com/v1) — sports odds, drop-in Odds-API replacement
- **Goldsky Polymarket subgraph** — pnl/positions/activity/orderbook (via GOLDSKY_TOKEN)
- **Dune Analytics** — whale PnL/volume community dashboards
- **Polymarket Gamma /markets/keyset** — migrated from deprecated /markets (May 1 deadline)
- **Polymarket CLOB** — primary execution venue (v1 now, v2 on 2026-04-28)
- **Polymarket Data API** — whale position-state polling (position-intel-scout)

### Scouts (12 active on R&D, 11 on Prod)

volume-spike, price-jump, new-listing, llm-news, leaderboard-poller, exchange-divergence, kl-divergence, cross-market-arb, complete-set-arb, position-intel, dune-whale, subgraph-whale (+11 from prod)

### Skills loaded for Polybot sessions

Mandatory first reads (enforced by PreToolUse hook on polybot-v3/Polymarket edits):
- `polybot-pnl-triage` — canonical leaderboard, Kelly verdict, decision tree
- `polybot-unhalt-gate` — 5 quantitative gates before Prod unhalt
- `polymarket-official-agent` — CLOB v1/v2 signing, EIP-712 schemas, neg-risk accounting
- `polymarket-markov-empirical-edges` — Becker 72.1M-trade study (longshot bias, optimism tax)
- `polymarket-x-watcher` — curated 25-account tier list + 4-point vetting gate
- `agi-kelly-criterion` — sizing math (fractional Kelly 0.25×)
- `agi-portfolio-analytics` — Sharpe/Sortino/drawdown
- `agi-walk-forward-validation` — purged-CPCV for edge verification
- `agi-regime-detection` — route strategies by vol/trend regime
- `polymarket-ecmwf-aifs-ensemble` — weather forecast model (already live)
- `polymarket-directional-inversion-audit` — bug-class audit (clean 04-12)

### Autonomous monitoring

- **Claude-side 4h cron** (job 3b142219, session-only): top of every 4h CDT — adaptive triage, kill/scale, reports delta to user
- **VPS-side hourly systemd timer** (`polybot-safety-net.timer` + `/root/polybot-safety-net.sh`): mechanical guardrails independent of Claude — catastrophic loser flagging, drawdown alarm, trade-velocity alarm, engine-alive check + auto-restart

### Mission clock

- **2026-04-23 11:55 CDT (now)**: clean-book measurement window open
- **2026-04-24 12:00 PM CDT**: Prod unhalt-gate decision
- **2026-04-26 8:00 PM CDT**: $100/day verdict
- **2026-04-28 6:00 AM CDT**: V2 cutover + Prod V2 unhalt gate

---

# Polybot V3 — Architecture Context

**Updated: 2026-04-17** (CTF V2 blocker; R&D fixed 2026-04-17; GitHub-only deploy; tweet vetting gate)

## Quick resume for any Claude session

1. Read `docs/status.md` first for current state
2. Read `docs/todo.md` for next actionable work
3. Check memory: `polybot_v3_state.md`, `polybot_v3_rebuild_complete.md`, `polybot_v3_deploy_discipline.md`
4. **R1-R3c is DONE.** Don't start "rebuild" tasks without verifying file state first.

## High-level architecture

Polybot V3 is a multi-entity prediction market trading engine for Polymarket (Polygon). It runs two parallel engines on one VPS sharing the same compiled binary:

- **Prod** (`polybot-v3` systemd unit) — live trading, single entity `polybot`, port 9100
- **R&D** (`polybot-v3-rd` systemd unit) — paper trading, single entity `rd-engine`, port 9200

Both engines scan Polymarket markets on a 5-minute cycle (prod) / 2-minute cycle (R&D), evaluate 9 strategies, generate signals, route through risk/sizing/execution, and persist to SQLite. R&D's role is to explore the strategy space and produce Wilson/Brier/DSR validation data that the advisor uses to enable/disable strategies on prod.

## Entity model

An **entity** is a virtual trader with its own wallet, risk limits, strategy allow-list, and P&L tracking. Prod has one entity (`polybot`) running live. R&D has one entity (`rd-engine`) running paper. The architecture supports 16 concurrent entities per engine (scan-scheduler assigns offsets), but fleet coordination is behind `FLEET_ACTIVE=true` flag which is currently off.

## Signal → order pipeline

```
Scan cycle
  ↓
StrategyRegistry.getAll() → each strategy.evaluate(context)
  ↓
Signal[] (with model_prob, edge, market_price, metadata)
  ↓
RiskEngine.validate(signal) — kill switch, cash available, max position, edge floor, daily loss
  ↓
PositionSizer.calculate(signal) — Kelly → strategy weight → wash-trading penalty → caps → 5-share floor
  ↓
OrderBuilder.build(signal, size, orderbook) — maker/taker routing, book quality check, tick alignment
  ↓
ClobRouter.submit(order) — kill switch check, CLOB API, response parsing, DB persist
  ↓
Trade + Position updated
```

## Strategies (9 active)

- **favorites** — bias on high-probability picks (compounding, near_snipe, stratified_bias, fan_fade)
- **longshot** — contrarian fade on tail prices (systematic_fade, bucketed_fade, news_overreaction_fade)
- **convergence** — long-tail long-term grind (filtered_high_prob, long_term_grind)
- **weather_forecast** — ECMWF AIFS 0.25° ensemble (single_forecast, ensemble_spread_fade)
- **crypto_price** — BTC-only, hooked to FastCryptoEvaluator WebSocket for 10s reaction (latency_arb, volatility_premium_fade, target_proximity)
- **sportsbook_fade** — Odds API sentiment fade (allowed but disabled)
- **cross_market_divergence** — Kalshi vs Polymarket arb
- **macro_forecast** — FRED economic event predictions
- **whale_copy** — mirror whitelisted wallets' trades (mirror sub) — NEW 2026-04-11

Quarantined (in `src/strategy/archive/`, not imported): value, skew, complement

## Data sources

- **Polymarket CLOB** (`clob.polymarket.com`) — primary order execution + market data
- **Polymarket Data API** (`data-api.polymarket.com`) — positions, activity, leaderboard, resolved positions
- **Polymarket Gamma** (`gamma-api.polymarket.com`) — market metadata (tick size, minimum_order)
- **Alchemy Polygon RPC** (free tier) — on-chain event polling (whale subscriber), redemption txs
- **Binance WebSocket** — real-time BTC price for crypto_price strategy
- **Odds API** — sportsbook consensus probabilities
- **Kalshi CLOB** — cross-market arbitrage signals
- **FRED** — macro economic data (CPI, unemployment, etc.)
- **ECMWF Open Data** — AIFS weather ensemble forecasts

## Storage

SQLite database with WAL mode + `busy_timeout` for concurrent access. Schema includes:
- `markets`, `positions`, `orders`, `trades`, `signals`, `resolutions` — core trading tables
- `entities`, `snapshots` — entity state + daily snapshots
- `audit_log`, `transfers` — audit trail
- `scout_intel`, `market_priorities` — scout fleet outputs
- `smart_money_candidates`, `whitelisted_whales`, `whale_trades` — whale tracking
- `v_strategy_performance`, `v_entity_pnl`, `v_weekly_tax`, `v_daily_volume` — performance views

## Deployment

```
Workstation (C:\Users\dboehm\dev\polybot-v3\)
  ↓ git commit + push
GitHub (github.com/daleboehm/polybot-v3)
  ↓ SSH to VPS
VPS (/opt/polybot-v3/)
  ↓ git fetch origin && git reset --hard origin/main
  ↓ npm run build
  ↓ systemctl restart polybot-v3 polybot-v3-rd
Live
```

**NEVER** hot-patch `/opt/polybot-v3/dist/` directly. OneDrive sync caused catastrophic git conflicts on 2026-04-11/12/13 — repo is NOT on OneDrive.

## Key files

- `src/core/engine.ts` — main engine loop, scan cycle orchestration
- `src/core/kill-switch.ts` — global halt mechanism (SIGUSR1 + dashboard)
- `src/market/data-api-client.ts` — Polymarket Data API client with `getAllPositions()` for reconciliation
- `src/market/on-chain-reconciler.ts` — position lifecycle reconciliation via Data API
- `src/market/whale-event-subscriber.ts` — 60s Polygon log poller for whale OrderFilled events (chunked 8 blocks)
- `src/market/sampling-poller.ts` — Polymarket market list polling with outcome field validation
- `src/market/markov-calibration.ts` — Becker 72.1M-trade empirical YES-resolution grid
- `src/strategy/strategy-registry.ts` — strategy registration and sub-strategy key enumeration
- `src/strategy/custom/whale-copy.ts` — whale trade mirror strategy
- `src/risk/strategy-advisor.ts` — Wilson LB gate (n≥50, LB≥0.50) + DSR/PSR shadow mode
- `src/risk/strategy-weighter.ts` — tier classification with entity isolation + [0.15, 2.0] bounds
- `src/risk/position-sizer.ts` — Kelly → weight → wash penalty → caps
- `src/execution/clob-router.ts` — CLOB order submission with kill switch check, phantom fee=0
- `src/execution/order-builder.ts` — maker/taker hybrid + book quality check
- `src/execution/book-quality-check.ts` — pre-trade book freshness + depth + spread + ghost detection
- `src/execution/neg-risk-redeemer.ts` — NegRiskAdapter + CTF Exchange redemption paths
- `src/validation/walk-forward.ts` — expanding-window walk-forward validator
- `src/validation/brier.ts` — Brier score + Murphy decomposition (reliability, resolution, uncertainty)
- `src/validation/dsr-psr.ts` — Deflated / Probabilistic Sharpe Ratio
- `src/validation/base-rate-calibrator.ts` — own-data Wilson LB calibration
- `src/storage/repositories/smart-money-repo.ts` — whale CRUD + dedup
- `src/dashboard/sse-server.ts` — /api/health (before auth) + SSE + HMAC-session auth
- `src/metrics/alerter.ts` — Telegram alerter via event bus
- `src/metrics/metrics.ts` — Prometheus text-format metrics
- `src/cli/index.ts` — management CLI (start, redeem-all, sell-position, smart-money-filter, whale-seed, whale-consensus, etc.)
- `scripts/whale-consensus.py` — standalone Python consensus scanner

## Environment flags

- `WHALE_COPY_ENABLED=true` — activates whale_copy strategy + subscriber
- `ADVISOR_V2_ENABLED=true` — DSR/PSR/Brier shadow mode (observational only)
- `FLEET_ACTIVE=false` (default) — fleet coordination off
- `POLYBOT_LIVE_MODE=true` (prod) / `false` (R&D) — live trading gate
- `POLYBOT_LIVE_CONFIRM=true` (prod) — second gate
- `POLYGON_RPC_URL` — Alchemy RPC with key
- `TELEGRAM_BOT_TOKEN` — optional, alerter no-op if unset
- `DASHBOARD_PASSWORD` — dashboard basic auth + session secret derivation
- `BASE_PATH=/rd` — R&D path prefix

## Critical workstation paths

- `C:\Users\dboehm\dev\polybot-v3\` — dev repo (NOT OneDrive)
- `~/.armorstack-vault/polymarket/armorstack_vps_key` — SSH key
- `C:\Users\dboehm\.claude\projects\C--Users-dboehm-OneDrive---thinkcaspian-com-1-Working-Files-CLAUDE\memory\` — Claude memory files
- `C:\Users\dboehm\.claude\scheduled-tasks\` — scheduled task definitions
