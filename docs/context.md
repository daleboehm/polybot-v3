# Polymarket V2 Trading Engine — Context

> Last updated: 2026-04-11 (maker/taker + Markov calibration + research-capture pipeline session)

## 2026-04-11 SESSION SUMMARY (for quick resume)

- **Maker/taker hybrid shipped** — entries post as makers (1 tick better), exits remain takers. Expected capture: +1.12% / -1.12% = 2.24pp swing per trade vs prior all-taker pricing. Paper simulator enforces fill gating so R&D learns real fill-rate cost. Commit `db687ca`.
- **Markov empirical calibration shipped** — `src/market/markov-calibration.ts` with Becker 72.1M-trade empirical YES-resolution grid. Longshot strategy consumes it as the second step in probability fallback (own data → Markov grid → naive). Base size multiplied by `longshotBiasMultiplier(price, side)` to shrink YES / grow NO in <20¢ longshot zone. Commits `031d734` + `3ab1825`.
- **Research-capture pipeline shipped** — `scripts/skills/capture-research.sh` wrapper + `SKILL-template.md`. Good articles now flow: WebFetch → evaluate → scaffold via `capture-research.sh <name>` → fill sections → `install-skills.sh --execute --source research-captured` → risk-filtered auto-deploy. Retroactively captured Becker findings. Active skills: 1050.
- **R&D dist drift was a non-issue** — `/opt/polybot-v3-rd/dist/` was orphaned artifacts from a prior layout; R&D's systemd always pointed at prod's binary. Deleted the orphan. Documented in todo.md deploy-discipline section.
- **Two ghost repos + one scope memo** — `dylanpersonguy/Polymarket-Trading-Bot` doesn't exist. `echandsome/Polymarket-betting-bot` has no market-making; one useful pattern (WebSocket block-subscription for whale tracker) noted for future. `evan-kolberg/prediction-market-backtesting` scoped as Option B (Python sidecar), deferred until R2 clears. Memo: `docs/backtesting-scoping-2026-04-11.md`.
- **Standing rule captured:** No patches. Only code updates. Git-first deploy flow. R&D shares prod binary — no rsync step needed.

## ⚠️ CURRENT STATE — READ FIRST

**Both engines PAUSED on the VPS — but rebuild is ENTIRELY code-complete on the workstation.** R1, R2, R3 (all phases including R3b observability and R3c fleet subsystems), and R4 scaffolds are in `Polymarket/polybot-v3/`. Both engines are configured for LIVE mode per Dale 2026-04-10. Status.md has the full commit list and deploy steps.

**179-finding audit complete**: `Polymarket/docs/audit-2026-04-09.md` — 50 P0, 62 P1, 47 P2, 20 P3. Audit drove the rebuild plan at `C:\Users\dboehm\.claude\plans\spicy-puzzling-robin.md`.

**Prod-blocking root cause FIXED in code**: `OnChainReconciler` (`src/market/on-chain-reconciler.ts`) replaces the broken Gamma-polling resolution checker. Queries Data API `/positions?user=` directly, closes absent-from-API positions, inserts crash-window orphans, calls `NegRiskRedeemer` for live redemption. First boot of v3 will auto-close the 40 stuck prod positions.

**Cleartext secrets redacted from workstation tree** (2026-04-10). Vault pattern: `Polymarket/docs/secrets-vault-README-2026-04-10.md`. Target workstation vault: `C:\Users\dboehm\.armorstack-vault\` (outside OneDrive sync).

**Do NOT resume trading** until the fix plan for the audit is signed off in a separate session and Phase 1 #1-11 have landed.

## System Overview

Dual-engine automated prediction market trading system on Polymarket (Polygon CLOB). The **Prod Engine** trades real USDC using only R&D-validated sub-strategies. The **R&D Engine** paper-trades all 8 strategies (with 15+ sub-strategies) and uses a performance-weighted position sizer to build a data model that drives prod's strategy selection.

**Audit caveat**: Track E found that the "R&D validation" signal is statistically meaningless at current thresholds (Wilson 95% CI at n=10 is [0.237, 0.763]) AND 13 of 15 sub-strategies have tautological probability models that cannot in principle generate alpha. The "R&D validates, Prod trusts" mental model is correct in structure but broken in current parameters. See audit §6.

## Infrastructure

| Component | Detail |
|---|---|
| VPS | DigitalOcean, 178.62.225.235:2222 (root, SSH key in `deploy/armorstack_vps_key` — **audit P0: still in OneDrive tree, move to vault pending Dale's signoff**) |
| Droplet ID | 560035247 |
| OS | Ubuntu 24.04, Node.js 22.22 |
| Runtime | TypeScript (ESM), better-sqlite3 (WAL mode) |
| Domains | sageadvisors.ai (prod), rd.sageadvisors.ai (R&D) — Let's Encrypt SSL |
| Schema version | v2 (sub-strategy tracking) |

## Architecture — Two-Engine Model

### Prod Engine (`polybot-v3.service`)
- **Port**: 9100 | **Dashboard**: sageadvisors.ai
- **Database**: `/opt/polybot-v3/data/polybot.db`
- **Mode**: LIVE (dual-flag: `POLYBOT_LIVE_MODE=true` + `POLYBOT_LIVE_CONFIRM=true`)
- **Strategy Weighter**: DISABLED (prod trusts R&D's validation, no auto-scaling)
- **Strategy Advisor**: ACTIVE — polls R&D every 10 min, auto-enables validated sub-strategies
- **Scan interval**: 5 minutes
- **Risk**: 15% position cap, $5 max per trade, 0% reserve, $2 hard stop, 40 max positions

### R&D Engine (`polybot-v3-rd.service`)
- **Port**: 9200 | **Dashboard**: rd.sageadvisors.ai
- **Database**: `/opt/polybot-v3-rd/data/rd.db`
- **Mode**: PAPER ONLY (no wallet, no live trades)
- **Strategy Weighter**: ACTIVE — scales position sizes by each sub-strategy's performance tier
- **Strategy Advisor**: DISABLED (R&D is the source of truth)
- **Scan interval**: 2 minutes
- **Risk**: 2% position cap, 2000 max positions, 0% reserve

### Cross-Engine Intelligence Loop

```
R&D Engine (paper)                    Prod Engine (live)
  All 8 strategies × sub-strategies     Strategy Advisor (every 10 min)
  Strategy Weighter scales sizing       Opens R&D rd.db read-only
  (5-min refresh by (strategy|sub))     Evaluates each (strategy, sub_strategy) pair
  Grinds data → resolutions             Per-pair promotion logic
  v_strategy_performance view     →     Auto-enables validated sub-strategies on polybot
```

## Sub-Strategy Architecture (v3.0)

The strategy layer is now **hierarchical**: each top-level strategy contains 1-4 sub-strategies, each independently tracked in the database. Every signal, order, trade, position, and resolution carries both `strategy_id` and `sub_strategy_id`, enabling per-sub-strategy performance analytics.

### 8 Strategies × 15+ Sub-Strategies

| Parent | Sub-Strategies | Description |
|---|---|---|
| **favorites** | compounding, near_snipe, stratified_bias, fan_fade | Buy consensus favorites by price regime |
| **longshot** | systematic_fade, bucketed_fade, news_overreaction_fade | **FADE** low-prob tails (research: longshots resolve 14% vs 10% implied) |
| **convergence** | filtered_high_prob, long_term_grind | Buy drift to fair value; 93% WR variant requires ≥$10k liquidity |
| **value** | statistical_model, positive_ev_grind | Positive EV with payoff ratio ≥ 1 or ≥ 2 |
| **skew** | probability_skew | Fade extreme consensus (>85% favorite) |
| **complement** | intra_market_arb | YES+NO < $0.96 = guaranteed arb |
| **weather_forecast** | single_forecast | Open-Meteo GFS/ECMWF forecasts vs market |
| **crypto_price** | latency_arb | Binance spot + volatility model |

### Sub-Strategy Promotion Flow

1. R&D engine runs all sub-strategies with weighted sizing
2. Each sub accumulates its own `v_strategy_performance` row, grouped by `(strategy_id, sub_strategy_id)`
3. Strategy Advisor reads R&D's view every 10 minutes (read-only SQLite)
4. For each `(strategy_id, sub_strategy_id)` pair:
   - **Enable** if: ≥5 resolutions, ≥50% WR, positive P&L
   - **Disable** if: ≥10 resolutions, <30% WR, negative P&L
   - **Keep** otherwise
5. Prod entity config is rebuilt as `EntityStrategyConfig[]` with validated sub-strategy allow-lists
6. Engine scan cycle passes `enabled_sub_strategies` to each strategy's evaluate() via context

## Key Components (src/)

| Component | File | Engine | Function |
|---|---|---|---|
| Strategy Advisor | `risk/strategy-advisor.ts` | Prod only | Per-sub-strategy promotion from R&D data |
| Strategy Weighter | `risk/strategy-weighter.ts` | R&D only | Per-sub-strategy position sizing multiplier |
| Resolution Checker | `risk/resolution-checker.ts` | Both | Gamma API bulk resolution; credits payouts |
| Risk Engine | `risk/risk-engine.ts` | Both | Pre-trade gates + position sizing |
| Position Sizer | `risk/position-sizer.ts` | Both | Fractional Kelly + caps + weighter lookup |
| Engine | `core/engine.ts` | Both | Main orchestrator, normalizes strategy configs, passes sub_strategy allow-list |
| Entity Manager | `entity/entity-manager.ts` | Both | Entity lifecycle, balances, `updateStrategies()` |
| BaseStrategy | `strategy/strategy-interface.ts` | Both | `getSubStrategies()`, `isSubStrategyEnabled(ctx, sub)` |
| Strategy Registry | `strategy/strategy-registry.ts` | Both | `getAllSubStrategyKeys()` for advisor |
| Dashboard | `dashboard/sse-server.ts` | Both | `/api/rd-strategies` endpoint, sub-strategy columns |

## Dashboard Features

- **Main dashboard** shows prod stats AND R&D sub-strategy performance side-by-side
- **Sub-Strategy column** in Strategy Performance table (both prod and R&D)
- **Recommended Trading Strategy** section on prod uses R&D data (what the advisor sees)
- **R&D dashboard** shows its own sub-strategy performance in the main table
- HMAC-signed cookie auth (survives restarts, 8-hour TTL)
- Auto-refresh every 60 seconds
- Dynamic title: "Gemini Capital" (prod) / "Gemini Capital R&D Engine" (R&D)

## Databases

Both engines use identical schema (`src/storage/schema.ts`) at **schema version 2**.

**Tables**: entities, markets, orders, trades, positions, resolutions, signals, snapshots, transfers, audit_log, schema_version

All trading tables (orders, trades, positions, resolutions, signals) have both `strategy_id` and `sub_strategy_id` columns (nullable for backward compat).

**Views**:
- `v_entity_pnl` — per-entity equity, cash, deployed, upside
- `v_strategy_performance` — per `(strategy_id, sub_strategy_id)` pair: trades, positions, resolutions, P&L, win rate
- `v_daily_volume` — daily trade volume
- `v_weekly_tax` — weekly realized P&L

## Entity Configuration (v2)

Entity `strategies` field accepts either legacy `string[]` or new `EntityStrategyConfig[]`:

```yaml
# Legacy (still works)
strategies:
  - favorites

# New sub-strategy aware
strategies:
  - strategy_id: favorites
    sub_strategy_ids: [compounding, near_snipe]
  - strategy_id: convergence
    sub_strategy_ids: [filtered_high_prob]
```

When `sub_strategy_ids` is omitted, all sub-strategies of that parent run.

## Data Feeds

| Source | Purpose | Status |
|---|---|---|
| Polymarket CLOB Sampling | Market prices (5,400+) | Working |
| Polymarket Gamma API | Market metadata + bulk resolution lookup | Working (fixed earlier 403) |
| Polymarket WebSocket | Real-time orderbook | Prod only |
| Open-Meteo Ensemble | Weather forecasts | Working |
| Binance / CoinGecko | Crypto prices | Working |

## Wallet & On-Chain

- Address: `0xF8d12267...` on Polygon
- On-chain USDC: variable (changes with every resolution credit)
- Auto-redeem: v1 `auto_redeem.py` cron every 30 min

## Session Resumption

1. SSH: `ssh -i deploy/armorstack_vps_key -p 2222 root@178.62.225.235`
2. Services: `systemctl status polybot-v3.service polybot-v3-rd.service`
3. Sub-strategy performance: `sqlite3 /opt/polybot-v3-rd/data/rd.db "SELECT * FROM v_strategy_performance ORDER BY total_trades DESC"`
4. Advisor activity: `journalctl -u polybot-v3.service | grep advisor`
5. Dashboards: sageadvisors.ai / rd.sageadvisors.ai
