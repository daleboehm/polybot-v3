# Polybot V3 — Architecture Overview

> Generated: 2026-04-12 | For: Armorstack team briefing

## System Overview

Polybot V3 is a dual-engine automated prediction market trading system on Polymarket (Polygon CLOB). The **Prod Engine** trades real USDC. The **R&D Engine** paper-trades to generate resolution data that drives prod's strategy selection.

```
                    POLYMARKET CLOB
                    (Polygon chain)
                         |
              +----------+----------+
              |                     |
         PROD ENGINE           R&D ENGINE
         (live USDC)           (paper only)
         port 9100             port 9200
         sageadvisors.ai       rd.sageadvisors.ai
              |                     |
              |    StrategyAdvisor   |
              |<--- reads rd.db ----|
              |    every 5 min      |
              |                     |
         polybot.db            rd.db
```

**VPS:** DigitalOcean Amsterdam, 178.62.225.235:2222
**Runtime:** Node.js 22 + TypeScript (ESM) + better-sqlite3 (WAL mode)
**Source of truth:** github.com/daleboehm/polybot-v3

## Engine Lifecycle (per scan cycle)

```
Engine.start()
  |
  1. Wallet sync (read on-chain USDC balance via Polygon RPC)
  2. On-chain reconciliation (Data API getAllPositions → close/insert/update DB)
  3. Paper resolution (paper-sim positions checked against CLOB resolution)
  |
  [Every 5 min (prod) / 2 min (R&D)]
  |
  4. Update position prices (mark-to-market from cache)
  5. Regime detection (basket volatility → calm/choppy/trending/volatile)
  6. Portfolio risk update (per-entity equity + drawdown tracking)
  7. Exit signal scan (stop-loss, profit-target, trailing-lock)
  |
  8. STRATEGY EVALUATION (per entity × per strategy)
  |  +→ Each strategy calls ctx.getActiveMarkets()
  |  +→ Evaluates markets → emits Signal objects
  |  +→ Signal.metadata includes calibration source + scout overlay
  |
  9. Fisher-Yates shuffle all signals (fair budget allocation)
  |
  10. RISK ENGINE evaluates each signal:
  |   +→ min_edge gate (1.5%)
  |   +→ daily loss lockout
  |   +→ strategy envelope cap
  |   +→ cluster correlation cap
  |   +→ position sizer (Kelly → weighter → wash-trading penalty → 5-share floor → caps)
  |
  11. ORDER BUILDER:
  |   +→ Entries: passive maker (1 tick better than market)
  |   +→ Exits: aggressive taker (bid premium)
  |   +→ Tail-zone override: entries >0.95 switch to taker
  |   +→ Price gate: <0.25 refuses taker, 0.25-0.40 downgrades to maker
  |
  12. CLOB ROUTER → Polymarket CLOB API → fill or queue
```

## Scout Fleet (parallel to scan cycle)

```
ScoutCoordinator (60-second tick)
  |
  +→ VolumeSpikeScout      — flags markets with >=3x volume growth in 5 min
  +→ PriceJumpScout         — flags markets with >=5% mid-price move in 5 min
  +→ NewListingScout         — flags brand-new markets with >=500 liquidity
  +→ LlmNewsScout           — Claude Haiku catalyst detection (10-min internal cadence)
  +→ ExchangeDivergenceScout — 3-source BTC price (Binance+Coinbase+Chainlink)
  +→ [DISABLED] LeaderboardPollerScout — polls Data API leaderboards every 10 min
  |
  Scouts write to:
    market_priorities → PriorityScanner (30-sec cadence) → scoped scan cycle
    scout_intel       → scout-overlay.ts → size multiplier (0.5x-1.25x) in strategies
```

## Probability Calibration Chain

Every strategy computes `model_prob` via a 3-step fallback:

```
1. Own-data baseRateCalibrator  — Wilson LB from our own resolved positions
   (best signal when available, n>=10 per bucket required)
       |
       v (returns null if insufficient data)
2. Markov empirical grid        — Becker 72.1M-trade industry calibration
   (always available, grounded in real Polymarket/Kalshi resolution data)
       |
       v (returns value, but check for NaN)
3. Naive heuristic              — strategy-specific fallback (e.g., price + 0.05)
   (last resort, should almost never fire with Markov in place)
```

## Advisor Pipeline

```
R&D Engine                              Prod Engine
  |                                       |
  All 8 strategies fire                   StrategyAdvisor
  Paper-sim resolves cleanly              (every 5 min)
  v_strategy_performance                  |
  ← accurate WR + P&L →                  Reads rd.db (read-only)
                                          |
                                    Wilson LB/UB gating:
                                      Enable: n>=50, LB>=0.50, P&L>$5
                                      Disable: n>=50, UB<0.50, P&L<-$5
                                          |
                                    Phase B Shadow (parallel, non-voting):
                                      DSR/PSR + MinTRL + Brier decomposition
                                      Logs AGREES/DISAGREES classification
                                      7-day A/B window before promotion
```

## Whale Tracking Pipeline (DORMANT)

```
[Gate 1] LeaderboardPollerScout → smart_money_candidates table
                                    |
[Gate 2] smart-money-filter CLI → whitelisted_whales table
         OR whale-seed CLI          |
                                    |
[Gate 3] entities.yaml: whale_copy uncommented
                                    |
[Gate 4] WHALE_COPY_ENABLED=true env var
                                    |
         WhaleEventSubscriber → Polygon getLogs (OrderFilled)
                                → whale_trades table
                                    |
         WhaleCopyStrategy   → reads whale_trades
                             → emits Signal (same pipeline as all strategies)
                             → fair-value gate + dedup + whitelist check
```

## Database Tables

| Table | Purpose |
|---|---|
| entities | Entity config + wallet + cash balances |
| markets | Market metadata from sampling-poller |
| positions | Open/closed positions with cost basis + mark |
| orders | Order lifecycle tracking |
| trades | Fill records |
| resolutions | Closed positions with realized P&L |
| signals | Every signal generated + approval/rejection |
| snapshots | Periodic equity snapshots |
| market_priorities | Scout → attention router |
| scout_intel | Scout → strategy size overlay |
| smart_money_candidates | Leaderboard poller output |
| whitelisted_whales | Copy-trade whitelist |
| whale_trades | Whale trade observation audit log |

## Active Strategies (Prod)

| Strategy | Subs | Status |
|---|---|---|
| weather_forecast | single_forecast, same_day_snipe, next_day_horizon, ensemble_spread_fade | Active, AIFS model |
| crypto_price | latency_arb, target_proximity, volatility_premium_fade | Active, BTC-only |
| favorites | compounding, near_snipe, fan_fade | Active (stratified_bias excluded) |
| longshot | systematic_fade, bucketed_fade, news_overreaction_fade | Active, bucketed_fade protected |
| convergence | filtered_high_prob, long_term_grind | Active |
| cross_market | ensemble_blend | Active |
| macro_forecast | fed_reaction | Active |
| whale_copy | mirror | DORMANT (4-gate activation) |

## Feature Flags

| Flag | Location | Current state |
|---|---|---|
| ADVISOR_V2_ENABLED | systemd drop-in | ON (prod, shadow-only) |
| WHALE_COPY_ENABLED | .env | OFF |
| scouts.disabled_scouts | yaml | leaderboard-poller-scout disabled |
| advisor.protected_strategies | yaml | weather_forecast, crypto_price, longshot.bucketed_fade |
