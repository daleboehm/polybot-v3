# Polymarket Trading System — Executive Summary

> A self-learning prediction market trading system that discovers edges in R&D and auto-deploys them to live trading.

## What It Is

An automated trading system for Polymarket (prediction markets on Polygon blockchain) built as **two engines running in parallel**:

- **R&D Engine** — a paper-trading laboratory that runs 8 strategies with 15+ sub-strategies simultaneously, scales position sizes based on each sub-strategy's performance, and builds a statistical evidence base for which approaches actually make money
- **Prod Engine** — a live-trading engine with real USDC that only trades sub-strategies the R&D engine has validated through statistical evidence

The two engines share the same TypeScript codebase but run as separate Node.js processes with separate databases. They communicate through one mechanism: **the Prod engine reads the R&D engine's database every 10 minutes to decide which sub-strategies to enable**.

## How It Works

### The Strategy Hierarchy

Every trade belongs to a `(strategy, sub_strategy)` pair:

- **8 strategies** (parent categories): favorites, longshot, convergence, value, skew, complement, weather_forecast, crypto_price
- **15+ sub-strategies** (specific approaches): `favorites.near_snipe`, `longshot.systematic_fade`, `convergence.filtered_high_prob`, etc.

Each sub-strategy has its own edge hypothesis drawn from published prediction-market research. For example:
- `favorites.near_snipe` — buy markets <1 hour from close with 92-98% probability (documented 93% win rate)
- `longshot.systematic_fade` — *fade* low-probability tails instead of buying them (longshots resolve 14% vs 10% implied)
- `convergence.filtered_high_prob` — buy 65-96% probability markets with ≥$10k liquidity (documented 93% win rate)

### The Intelligence Loop

```
  ┌─────────────────────────────────────┐
  │  R&D Engine (paper trading)         │
  │  ─────────────────────────────────  │
  │  • Runs ALL sub-strategies          │
  │  • Scales sizing by performance     │
  │  • Builds v_strategy_performance    │
  │  • 2-min scan cycle                 │
  └─────────────┬───────────────────────┘
                │
                │ read-only SQLite
                │ every 10 minutes
                ▼
  ┌─────────────────────────────────────┐
  │  Prod Engine (live trading)         │
  │  ─────────────────────────────────  │
  │  • Strategy Advisor promotes        │
  │    validated sub-strategies         │
  │  • Only trades R&D-proven sub-strats│
  │  • 5-min scan cycle                 │
  └─────────────────────────────────────┘
```

### Auto-Promotion Thresholds

A sub-strategy gets **enabled** on prod when R&D data shows:
- ≥ 5 resolved trades
- ≥ 50% win rate
- Positive P&L

A sub-strategy gets **disabled** on prod when R&D data shows:
- ≥ 10 resolved trades
- < 30% win rate
- Negative P&L

The advisor can rebuild prod's entire strategy allow-list on every 10-minute check, with no human intervention.

### Position Sizing (R&D only)

The R&D engine uses a **Strategy Weighter** that scales position sizes based on each sub-strategy's historical performance:

| Tier | Condition | Multiplier |
|---|---|---|
| Proven | ≥60% WR + positive P&L | 1.0x → 2.0x (boost by WR) |
| Promising | ≥40% WR + breakeven | 0.6x |
| Unproven | <5 resolutions | 0.25x - 0.4x |
| Underperforming | negative P&L | 0.15x (minimum, keeps data flowing) |

This ensures winners get more capital to compound while losers keep running at small sizes to confirm (or falsify) their performance over more samples.

**Prod does not use weighting** — it trusts the advisor's binary enable/disable decisions.

## Why Two Engines

**Separation of concerns**:
- R&D can fail, experiment, run losing strategies freely (paper money)
- Prod only trades what R&D has proven works
- Losses in R&D don't affect real capital
- The advisor provides a principled, data-driven filter between experimentation and live trading

**Dogfooding**:
- Both engines share the same strategy code, so a bug fix to `favorites.ts` applies to both
- The schema is identical, so the advisor can query R&D's performance view using the same types as prod

## Dashboards

Two web dashboards (both hosted on the same VPS, separate ports, separate domains):

- **sageadvisors.ai** — Prod dashboard: shows live entity equity, positions, trades, AND the R&D strategy performance data that drives advisor decisions
- **rd.sageadvisors.ai** — R&D dashboard: shows R&D entity equity, positions, strategy performance per sub-strategy, and live SSE events

Both auto-refresh every 60 seconds and survive session resets via HMAC-signed cookies.

## Key Innovations

1. **Sub-strategy first-class tracking** — every trade carries both `strategy_id` and `sub_strategy_id` through the entire pipeline (signal → order → fill → position → resolution), enabling granular performance analytics
2. **Read-only cross-engine communication** — Prod opens R&D's SQLite database directly as read-only, avoiding RPC/HTTP complexity while getting sub-millisecond lookups
3. **Performance-weighted sizing** — R&D's bad strategies still trade (at 0.15x) so they keep generating data; good strategies compound (up to 2x)
4. **Legacy-compatible config** — Entity strategies can be `string[]` (legacy) or `EntityStrategyConfig[]` (new), with auto-conversion in the engine scan loop
5. **Research-backed inversion** — The `longshot` strategy was INVERTED after research showed buying low-prob tails was the exact opposite of the profitable trade; it now *fades* tails instead

## Current State (2026-04-09)

- **R&D**: $18.93 cash of $10,000 starting, 1,280 open positions, 11,245 total trades, 831 resolutions — deep in learning phase
- **Prod**: $2.49 cash of $257.09 starting, 40 open positions, 47 v2 trades — waiting on advisor to promote validated sub-strategies
- **Both engines**: active on the VPS, schema v2, all 15+ sub-strategies wired, dashboard showing cross-engine data
- **Critical test in progress**: 830+ longshot FADE trades open, validating the inverted hypothesis over the next 24-48 hours

## Risk Management

- **Dual-flag live mode**: `POLYBOT_LIVE_MODE=true` + `POLYBOT_LIVE_CONFIRM=true` required for real trades
- **Protected strategies**: Advisor cannot auto-disable strategies marked as protected (currently none — fully R&D-driven)
- **Capital constraints**: Prod has hard caps (15% max position, $5 absolute cap, $2 hard stop per position)
- **Cash tracking**: Every BUY deducts cash immediately; every resolution credits payout
- **Read-only advisor queries**: Advisor cannot corrupt R&D data even on bugs
- **Schema migration is additive**: ALTER TABLE ADD COLUMN, no data loss on upgrades

## Where To Start (For New Collaborators)

1. Read `docs/context.md` for architecture details
2. Read `docs/application-flow.md` for the scan cycle flow
3. Read `docs/architecture.md` for source code layout
4. Read `docs/status.md` for current live state
5. Read `docs/todo.md` for active priorities
6. SSH into VPS: `ssh -i deploy/armorstack_vps_key -p 2222 root@178.62.225.235`
7. Check sub-strategy performance: `sqlite3 /opt/polybot-v3-rd/data/rd.db "SELECT * FROM v_strategy_performance"`
