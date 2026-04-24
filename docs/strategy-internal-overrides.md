# Per-Strategy Internal Constants (GHOSTS CATALOGUE)

**Created 2026-04-24** after full-stack audit surfaced several hardcoded thresholds buried in strategy .ts files that override or supplement global config.

This document is the **single source of truth** for any constant that lives in a strategy's .ts file rather than `config/*.yaml`. Grep this doc before changing any strategy behavior.

## Global config layers (precedence order)

1. **YAML** (`config/rd-default.yaml`, `config/default.yaml`) — canonical sizing, risk, horizons
2. **Per-strategy internal consts** (below) — override/supplement global where strategy needs differ
3. **Env vars** (`.env` per engine) — feature flags + API keys (see `.env.example` for tracked defaults)

When a strategy uses its own constant, the global yaml value does NOT apply to that strategy.

## Per-strategy constants as of 2026-04-24

### crypto_price (`src/strategy/custom/crypto-price.ts`)
- `CONFIG.min_edge: 0.03` (global `min_edge_threshold: 0.005`)
- `CONFIG.min_confidence: 0.30`
- `CONFIG.dedup_minutes: 3` — re-entry cooldown per (sub, condition_id)
- `CONFIG.min_hours_to_resolve: 0.05` (3 min) — internal hint only, effective floor was the global `min_hours_to_resolve`; 2026-04-24 the strategy now calls `getActiveMarketsInWindow(0.08, 12)` explicitly to see 5-min BTC markets

### rtds_forecast (`src/strategy/custom/rtds-forecast.ts`)
- `CONFIG.max_position_usd: 50` (overrides global $75 — raised 5->50 on 2026-04-23 for 10x sizing)
- `CONFIG.min_edge: 0.04`
- `CONFIG.min_confidence: 0.55`

### longshot (`src/strategy/custom/longshot.ts`)
- `DEDUP_TTL_MS: 2h` — per `(sub, condition_id)`; resets on restart
- Tail price range: 0.02-0.20 (bucketed_fade 0.05-0.20, news_overreaction_fade 0.10-0.20)

### favorites (`src/strategy/custom/favorites.ts`) [CURRENTLY DISABLED]
- `DEDUP_TTL_MS: 4h`
- Disabled 2026-04-24 due to WR decay 64.9% -> 51.9%

### negrisk_arbitrage (`src/strategy/custom/negrisk-arbitrage.ts`)
- `MIN_FAMILY_MEMBERS: 3`, `MAX_FAMILY_MEMBERS: 25`
- `MIN_SUM_YES: 0.82`, `MAX_SUM_YES: 0.98`
- `DEFAULT_LEG_SIZE_USD: 4`
- `MAX_LEG_PRICE: 0.30` (raised 0.15->0.30 on 2026-04-24 to unblock qualifying families)
- `DEDUP_TTL_MS: 6h`

### weather_forecast (`src/strategy/custom/weather-forecast.ts`)
- `CONFIG.min_edge: 0.05`
- `CONFIG.allocation_multiplier: 2.0` (2x sizing on directional subs)
- **Hold-to-settlement for directional subs** — `stop-loss-monitor.ts` SUPPRESSES trailing_lock + stop_loss for single_forecast + same_day_snipe + next_day_horizon (per arXiv 2604.07355)

### maker_rebate (`src/strategy/custom/maker-rebate.ts`) [FEATURE-FLAGGED]
- `MAX_CONCURRENT_ORDERS: 3`
- `MAX_POSITION_USD: 2.0`
- `MIN_LIQUIDITY_USD: 5000`
- `MAX_HOURS_TO_RESOLVE: 168`, `MIN_HOURS_TO_RESOLVE: 2`
- Gated by `MAKER_REBATE_ENABLED` env var

### whale_copy (`src/strategy/custom/whale-copy.ts`)
- `FAIR_VALUE_SLIP_PCT: 0.02` — skip if current mid > whale entry + 2%
- `RECENT_WINDOW_MS: 10 min`
- `DEDUP_WINDOW_MS: 10 min`
- Gated by `WHALE_COPY_ENABLED` env var

### whale_fade (`src/strategy/custom/whale-fade.ts`)
- `DEFAULT_SIZE_THRESHOLD: 1000`
- `FADE_DELAY_MS: 3 min`
- `RECENT_WINDOW_MS: 15 min`
- `DEDUP_WINDOW_MS: 10 min`
- Gated by `WHALE_FADE_ENABLED` env var

### cross-market-divergence
- `DEDUP_TTL_MS: 2h`
- `MIN_DIVERGENCE: 0.04`, `MIN_POLY_VOLUME: 5000`, `MIN_KALSHI_VOLUME: 2000`

### macro_forecast
- `DEDUP_TTL_MS: 6h`
- `MIN_DIVERGENCE: 0.05`
- FED/CPI/UNEMP keyword filters

### sportsbook_fade (DISABLED)
- `DEDUP_TTL_MS: 2h`, `MIN_DIVERGENCE: 0.03`, `MAX_HOURS_TO_EVENT: 48`

### convergence (DISABLED)
- `DEDUP_TTL_MS: 4h`, `LTG_OBSERVATION_TTL_MS: 31 days`

## Scout internal constants (`src/scouts/`)

### exchange-divergence-scout
- `MIN_MARKET_DIVERGENCE_PCT: 0.005` (lowered 3% -> 0.5% on 2026-04-23 for Chainlink-arb)
- `MIN_EXCHANGE_DIVERGENCE_PCT: 0.001`, `MAX_EXCHANGE_DIVERGENCE_PCT: 0.02`
- `PRIORITY_LEVEL: 8`, `PRIORITY_TTL_MS: 5 min`

### complete-set-arb-scout
- `MIN_SIDE_PRICE: 0.02`, `MIN_SUM: 0.50`
- `SUM_THRESHOLD: 0.975` (Phase 3 widened)
- `PRIORITY_TTL_MS: 10 min`

### cross-market-arb-scout
- `MIN_INVERSION_PCT: 0.04`, `MAX_INVERSION_PCT: 0.30`

### llm-news-scout
- `MAX_MARKETS_PER_CALL: 20`, `MAX_TOKENS: 1200`
- `MIN_CALL_INTERVAL_MS: 10 min`

### new-listing-scout
- `MIN_LIQUIDITY: 500`, `PRIORITY: 7`

### position-intel-scout
- `POLL_INTERVAL_MS: 5 min`, `MAX_WHALES_PER_TICK: 5`

### price-jump-scout
- `MIN_LIQUIDITY: 1000`

## Exit logic precedence (stop-loss-monitor.ts)

Active exit checks in order:
1. **profit_target** — `pnlPct >= profit_target_pct` (0.75 on R&D, 0.40 on Prod as of 2026-04-24)
2. **trailing_lock** — peak >= 20% AND current < peak*0.70 AND pnlPct > 0 (never on losses)
3. **hard_stop** — `pnlUsd <= -hard_stop_usd` ($25 on R&D)
4. **stop_loss / tiered** — only after `min_hold_hours` (0.5h on R&D) AND pnlPct < 0
5. **Weather directional subs**: trailing_lock + stop_loss SUPPRESSED, profit_target + hard_stop still active

## Maintenance

When you change a strategy's internal constant, update BOTH:
- The strategy .ts file (with inline comment showing date + reason)
- This document

When a new strategy lands, grep the .ts for any top-level `const` with ALL_CAPS or `CONFIG` objects and add to this doc.
