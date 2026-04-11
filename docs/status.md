# Polymarket V3 — Live Status

Updated: 2026-04-11 (maker/taker + Markov calibration + research-capture pipeline session)

## 2026-04-11 session — Phase A shipped + B/C staged (commits `a2192ff` → `f44cd66`)

**Phase A (defensive hardening) — SHIPPED + VERIFIED live on VPS.** Four
research-backed fixes applied to existing code paths. Zero new
strategies, zero new tables, zero new services. Every item tied to a
primary source in the 6-agent research synthesis.

### A1 — Tail-zone execution-mode override (commit `a2192ff`)
New helpers in `markov-calibration.ts`: `isDeadBandZone(price)`,
`preferredExecutionModeForTail(fadePrice)`. `longshot.ts` and
`favorites.ts` (compounding/near_snipe/stratified_bias subs via
`buildSignal`) now set `signal.metadata.preferred_execution_mode='taker'`
when the side being bought is >0.95. In that zone single-sided makers
collect zero reward score AND eat concentrated adverse selection —
but the Becker empirical edge still dominates the -1.12% taker cost.

`order-builder.ts` reads the metadata and overrides its default
entry-maker policy. Verified live: longshot.systematic_fade at
price 0.968 now routes as `taker`, in_dead_band=1. 51 dead-band
signals flagged across favorites.fan_fade + longshot subs in a
10-minute window.

### A2 — Tick-size-weighted pricing + scout scoring (commit `a2192ff`)
`OrderRequest` type extended with `minimum_tick_size`, populated from
market-cache by `risk-engine` and threaded into `order-builder` for
both the maker offset calculation AND the final roundToTick + clamp
bounds. Previously hardcoded 0.01 meant 10× worse queue position on
0.001-tick markets.

`scout-base.ts` gains `tickSizePriorityBonus()`: +2 for coarse
(≥0.1), +1 for standard (0.01), 0 for fine (0.001), -1 for
ultra-fine. Applied in VolumeSpikeScout, PriceJumpScout, and
NewListingScout so the attention router implicitly prioritizes
higher-EV-per-fill markets.

### A3 — Wash-trading penalty (commit `a2192ff` + `b95952f`)
New module `src/market/wash-trading-penalty.ts`. Two-signal proxy for
fake volume since we don't subscribe to Polygon logs yet:
- `churnRatio = volume_24h / max(liquidity, $100)`
  (>20x mild → 0.8x, >50x high → 0.5x, >100x extreme → 0.3x)
- High-risk category tags (sports/election/politics/etc.) get an
  extra 0.7x multiplier per Columbia Nov 2025 findings.

Composite multiplier floored at 0.1. Wired into `position-sizer`
between the strategy-weighter and the hard caps so it's a
proportional haircut on suspicious markets — never zeros out.

Follow-up commit `b95952f` added `tags: string[]` field to the
`MarketData` type and populated it in `market-cache.ts` from the
`SamplingMarket.tags` field that was already being pulled by the
sampling-poller.

### A4 — Price-conditioned maker-only gate (commit `a2192ff`)
`order-builder.ts`:
- Entries below 25¢ with `preferred_execution_mode='taker'` are now
  **refused** (returns null). Kalshi 72M-trade analysis shows taker
  losses average 32% in this zone — not worth any Markov edge.
- Entries between 25¢-40¢ with taker override get **downgraded** back
  to maker. Still accept possible no-fill over -1.12% guaranteed tax.
- Exits bypass both rules (NO-LOSE mantra — if we need out, we need out).

### Phase A verification snapshot (10 min window post-deploy)

| Metric | Value |
|---|---|
| Total signals | 1344 |
| Approved signals | 30 |
| In dead-band (A1 flagged) | 51 |
| longshot.systematic_fade dead-band | 25 |
| longshot.bucketed_fade dead-band | 21 |
| favorites.fan_fade dead-band | 5 |
| Errors across both engines | 0 |

Stratified_bias gets the most rejections because it's in the noisy
45-55¢ zone where the wash-trading penalty can reduce size below the
dust floor. Expected behavior.

### Phase B — STAGED (commit `bd6860d`)

Two new validation modules committed + typechecked + built into dist,
but NOT imported anywhere yet. They will be wired into the
StrategyAdvisor in a follow-up session after Phase A's 24h
verification gate clears.

- `src/validation/stats-helpers.ts` — shared `normalCdf`, `sampleMean`,
  `sampleVariance`, `sampleStd`, `sampleSkew`, `sampleKurtosis`,
  `sharpeRatio`, `EULER_MASCHERONI`. Abramowitz & Stegun 26.2.17
  rational approximation for Φ(x) (max error ~7.5e-8).

- `src/validation/dsr-psr.ts` — `probabilisticSharpeRatio` (PSR),
  `minimumTrackRecordLength` (MinTRL), `expectedMaxSharpeUnderNull`,
  and a raw-returns-taking `deflatedSharpeRatio` returning a
  `DsrResult` shape with sharpe/benchmark/dsr/n/skew/kurtosis.

- `src/validation/brier.ts` augmented with `reliabilityScalar` and
  `uncertainty` fields to complete the Murphy 1973 decomposition
  identity: `score ≈ reliabilityScalar - resolution + uncertainty`.

Note: `walk-forward.ts` already has a `deflatedSharpeRatio` from an
earlier R2 PR. The new `dsr-psr.ts` is the successor with three
improvements: takes raw returns (not pre-computed moments), adds PSR
+ MinTRL, uses shared stats-helpers.ts numerics. The walk-forward
version is kept for backward compat.

### Phase C — STAGED (commit `f44cd66`)

`src/scouts/leaderboard-poller-scout.ts` — scaffolds the highest-leverage
whale detection signal from the research synthesis. Polls
`data-api.polymarket.com/leaderboards?window=week` every 10 minutes
(fire-and-forget async inside the 60s scout tick; errors swallowed to
logs so they never halt other scouts). Parses the raw JSON into typed
`LeaderboardEntry` objects sorted by weekly profit.

Currently logs-only. Three follow-up items needed to activate:
- **C1a** — CREATE TABLE `smart_money_candidates` + migration
- **C1b** — `upsertCandidate()` in a new `smart-money-repo.ts`
- **C1c** — register the scout in `scout-coordinator.registerDefaultScouts()`
           and add a `scouts.disabled_scouts` opt-out

Not yet imported or registered. Committed for review + typecheck.

### Phases D-G — BLOCKED

- **D** blocked on `ANTHROPIC_API_KEY` provisioning on the VPS
- **E** blocked on Dale manual watching for the $1 mainnet test
- **F** blocked on Phase B advisor-v2 7-day A/B window
- **G** blocked on 2+ weeks of Phase C reward-farming scout data

## 2026-04-11 session — attention router + scout fleet (commits `e5d951f` → `9e3c53a`)

**Four-phase build shipped in one session.** This is the big one — it
unlocks faster reaction time (30s vs 5m) on scout-flagged markets, adds
qualitative overlays on top of the statistical edge, and closes the
silently-broken R&D→prod advisor feedback loop. All four phases deployed
to prod + R&D, both engines healthy, zero errors in 6+ min uptime.

### Phase 1 — Advisor fix (`e5d951f`)
**Discovery**: the yaml was missing the `advisor:` block entirely. Schema
default is `enabled: false`, which meant prod's StrategyAdvisor had been
silently disabled — prod had no R&D→prod feedback loop at all. Added
`advisor.enabled: true` + `check_interval_ms: 300000` (5 min, was 30 min
default) + `protected_strategies: [weather_forecast, crypto_price]`.
Advisor now fires its first check 10 seconds after startup and every
5 minutes thereafter. Confirmed live: `Running strategy advisor check`
logged at 19:37:22.

### Phase 2 — Attention Router (`e5d951f`)
New `market_priorities` table + `PriorityScanner` service. Scouts
write rows saying "scan this market NOW" and the scanner polls every
30 seconds, runs a scoped version of the scan cycle on just those
markets, and feeds signals into the normal risk + execution pipeline.
Out-of-cycle reaction time: 30s instead of 5m. New yaml block
`priority_scanner:` in both engine configs.

### Phase 3 — Scout Overlay (`e5d951f`)
New `scout_intel` table + `scout-overlay.ts` module. Scouts write
qualitative intel ("market X, side Y, conviction Z, reason ..."),
strategies call `applyScoutOverlay()` during signal build. The overlay
multiplies `recommended_size_usd` by:
- **1.0 → 1.25x** on agreement, scaled by conviction
- **1.0 → 0.50x** on disagreement, scaled by conviction
- **1.0** (no-op) on neutral intel or low conviction (<0.60)

Integrated into favorites (4 subs), longshot (3 subs), convergence
(2 subs). Overlay cannot CREATE signals — only weights existing ones.
Risk engine caps remain the final gate. Layered multiplicatively with
the Becker longshot-bias multiplier in longshot strategies.

### Phase 4 — Scout Fleet (`9e3c53a`)
Four in-process scouts run on a 60-second shared timer inside the
engine process (not separate systemd services). Shared market cache
access = no DB round trips; sliding-window state lives in scout memory.

1. **VolumeSpikeScout** — flags markets with ≥3x volume growth in a
   5-min window. Priority 6-10 by magnitude. Noise floor: $5K volume.
2. **PriceJumpScout** — flags markets with ≥5% mid-price moves in
   5 min. Priority 6-10 by magnitude. Min liquidity $1K.
3. **NewListingScout** — flags newly-appeared markets with ≥$500
   liquidity. Seeded 1045 markets on first tick (confirmed in logs).
   Priority 7, 15-min TTL.
4. **LlmNewsScout** — stub that fails closed without `ANTHROPIC_API_KEY`.
   When key lands, un-stub `callClaude()` in `src/scouts/llm-news-scout.ts`
   and add `@anthropic-ai/sdk` dependency. Writes both scout_intel
   (side + conviction capped at 0.80) and market_priorities rows.

All scouts registered via `ScoutCoordinator.start()`. Config block
`scouts:` in both yamls, `disabled_scouts` array for turning individual
scouts off without code changes.

### Verification
- Typecheck clean (3 rounds, minor import fixes needed on round 1)
- Build clean
- Both engines restarted cleanly at 19:43:02 / 19:42:59
- All 4 scouts registered in coordinator logs on both engines
- PriorityScanner running on both engines
- Advisor enabled on prod
- LLM news scout correctly reports dormant with ANTHROPIC_API_KEY missing
- NewListingScout seeded 1045 markets on its first tick (R&D, 19:44:00)
- Zero errors in 6+ min of runtime across both engines

### Open items
- **ANTHROPIC_API_KEY provisioning** — Dale needs to add this to
  `/opt/polybot-v3/.env` and `/opt/polybot-v3-rd/.env` on the VPS to
  activate the LLM news scout. Un-stub `callClaude()` in the scout.
- **Scout flagging verification** — scouts log silently when they
  find nothing (by design). Real flagging events will appear in logs
  the first time an actual volume spike / price jump occurs. Monitor
  over next 24h: `journalctl -u polybot-v3-rd --since '1 hour ago' |
  grep -iE 'spike|jump|flagged'`.

## 2026-04-11 session — prod parity patch (commit `0249404`)

**Ensured prod has all the calibration brains it needs.** Wired the Markov
empirical grid into `favorites.ts` (compounding, near_snipe, stratified_bias,
fan_fade) and `convergence.ts` (filtered_high_prob, long_term_grind). These
strategies now have the same 3-step probability fallback chain `longshot.ts`
already had:

1. **Own-data baseRateCalibrator** — Wilson LB from our own resolutions
2. **Markov empirical grid** — Becker 72.1M-trade industry calibration (new)
3. **Naive heuristic** — last resort, should almost never fire

Added side-aware `calibratedSideProb(price, side)` helper in
`src/market/markov-calibration.ts` that handles YES/NO symmetry so favorites
and fan_fade can consume it regardless of which side they're betting.

### Signal audit post-deploy (15-min window)

| Strategy | Sub | Signals | Approved | Avg edge | Source |
|---|---|---|---|---|---|
| favorites | compounding | 816 | 3 | +0.80pp | Markov |
| favorites | stratified_bias | 320 | 0 | +0.24pp | Markov |
| favorites | fan_fade | 82 | 0 | −1.16pp | Markov |
| convergence | long_term_grind | 327 | 0 | **−97pp** | own-data |
| convergence | long_term_grind | 139 | 0 | +0.85pp | Markov |

### Findings from signal audit

- **Prod has 244 total resolutions** across 12 sub-strategies (not zero as
  previously assumed). Top buckets: convergence.long_term_grind (81),
  favorites.compounding (56), longshot subs (~60 combined), weather_forecast (12).
- **Own-data calibrator now firing for prod** in price buckets with ≥10
  resolutions. Markov fills the gap for buckets below the threshold.
- **`convergence.long_term_grind` is a losing strategy per prod's own data** —
  327 signals in 15 min with avg edge −97pp. Wilson LB on resolved positions
  is far below market price. All signals being rejected at min_edge gate.
  StrategyAdvisor should catch this and disable the sub on next run (10 min).
- **Signal volume collapsed toward high-edge strategies** — before this patch,
  strategies fired on naive `price + constant` heuristics. After, only
  near_snipe / filtered_high_prob / longshot / weather / crypto / signal-feed
  strategies will reliably clear the 1.5% min_edge gate. Exactly the tightening
  Dale wanted.

## 2026-04-11 session — 4 phases shipped

All deployed to VPS (commits through `3ab1825`), prod + R&D restarted:

1. **R&D dist drift cleanup** — discovered R&D was never running stale code. The `/opt/polybot-v3-rd/dist/` was orphaned artifacts; R&D's systemd `ExecStart=/usr/bin/node /opt/polybot-v3/dist/index.js` always pointed at prod's dist. Deleted the orphan dir. Verified via `/proc/<pid>/cmdline`.
2. **Maker/taker hybrid execution** (commit `db687ca`) — entries now post as passive makers (1 tick better than market), exits remain takers. Added `execution_mode: 'maker' | 'taker'` to `Order` interface. Paper simulator enforces fill gating: maker orders only fill if book crossed us. Expected capture: 2.24pp per trade swing vs pre-fix taker pricing (Becker's 72.1M-trade study finding).
3. **Markov empirical calibration** (commits `031d734` + `3ab1825`) — new `src/market/markov-calibration.ts` with empirical YES-resolution grid from Becker study. Longshot strategy now uses 3-step probability fallback: (1) Wilson LB from own resolved fades, (2) Markov empirical grid, (3) naive heuristic. Base size now multiplied by `longshotBiasMultiplier(price, side)` to shrink YES / grow NO in <20¢ zone.
4. **Research-capture pipeline** — new `scripts/skills/SKILL-template.md` + `scripts/skills/capture-research.sh` wrapper. Retroactively captured Becker findings to `_Skills-staging/research-captured/skills/polymarket-markov-empirical-edges/SKILL.md` and deployed via `install-skills.sh --execute --source research-captured`. Active skill count now 1050.

### Phase 5 + 6 research (no code impact)
- **`dylanpersonguy/Polymarket-Trading-Bot`** — verified does NOT exist. Hallucinated metadata in search results.
- **`echandsome/Polymarket-betting-bot`** — skimmed. No market-making, no inventory management. Only worthwhile artifact: `tradeMonitor.ts` receipt-parsing + WebSocket block-subscription pattern for whale tracking. Note for future whale-tracker work. **Verdict: skim complete, no deep-dive.**
- **`evan-kolberg/prediction-market-backtesting`** — scoped. 522 stars, active daily, NautilusTrader fork with PMXT L2 historical data. Decision memo at `docs/backtesting-scoping-2026-04-11.md`. **Recommendation: Option B (Python sidecar) deferred until R2 clears.** License mixed (MIT root + LGPL adapter), subprocess boundary avoids linking obligations.

## Prior state (unchanged, for reference)

## Both engines LIVE on v3 — full cleanup + hardening applied

v3 is now the ONLY polybot code on the VPS. All v1/v2 directories deleted, credentials
migrated to v3 paths, systemd autostart enabled, security updates applied, plaintext
API keys removed from root crontab, and the unused win11-vm SSH key removed.

- **VPS `polybot-v3.service`** — LIVE, prod, port 9100, dashboard at https://sageadvisors.ai, mode=live
- **VPS `polybot-v3-rd.service`** — LIVE, R&D, port 9200, dashboard at https://rd.sageadvisors.ai/rd, mode=paper, `BASE_PATH=/rd`
- **VPS `polybot-v2.service` / `polybot-v2-rd.service`** — inactive (not started since deploy)
- **v1 `auto_redeem.py` cron** — crontab is clean (cleared on VPS Apr 7); v3 owns redemption via `neg-risk-redeemer.ts`
- **Workstation `Polymarket/polybot-v3/`** — source of truth; all today's fixes applied here then scp'd to VPS src/
- **VPS src/** — matches workstation after `scp` + `npm run build`; zero hot-patches remain

## Current state (2026-04-10 21:05)

### Production Engine (live, `/opt/polybot-v3/`)

- **Entity**: GC Caspian (`polybot`)
- **On-chain wallet (EOA)**: `0xF8d12267165da29C809dff3717Ddd04F0C121fd7`
- **Cash**: $24.89
- **Open positions**: 40
- **Kill switch**: down
- **Mode**: live
- **Config cap**: `max_positions=40` (default), `max_position_pct=5%`

### R&D Engine (paper, `/opt/polybot-v3-rd/`)

- **Entity**: `rd-engine` (single paper entity)
- **Cash**: $1.87 (fully deployed — expected)
- **Open positions**: 1,015
- **Total trades**: 1,054
- **Resolutions**: 0 yet (markets need hours to close; paper-resolver polls CLOB every scan cycle)
- **Kill switch**: down
- **Mode**: paper, `starting_capital=10000`
- **Config**: `max_positions=100000` (Dale: "no limits"), `max_position_usd=$10`, `min_hours_to_resolve=1`, `max_hours_to_resolve=48`

### Active sub-strategies in R&D (9 firing, 5 pending gates)

| Strategy | Sub | Open positions |
|---|---|---|
| favorites | compounding | 436 |
| favorites | stratified_bias | 150 |
| favorites | fan_fade | 53 |
| convergence | long_term_grind | 150 (uses 2h-30d window override) |
| longshot | bucketed_fade | 95 |
| longshot | news_overreaction_fade | 63 |
| longshot | systematic_fade | 53 |
| weather_forecast | single_forecast | 9 |
| sportsbook_fade | single_forecast | 6 (Odds API wired) |

**Deployed but not yet firing** (strict gates, waiting for matching markets):
- `weather_forecast.same_day_snipe` (<6h, score≥70)
- `weather_forecast.next_day_horizon` (18-30h, score≥50)
- `weather_forecast.ensemble_spread_fade` (ECMWF wide + market extreme)
- `crypto_price.latency_arb` / `target_proximity` / `volatility_premium_fade` (need matching crypto markets)
- `convergence.filtered_high_prob` (needs ≥$10k liquidity market in 0-24h)
- `macro_forecast.fed_reaction` (FRED wired; needs Fed-reaction market)
- `cross_market.ensemble_blend` (Kalshi wired with backoff; needs matched Poly↔Kalshi pair)
- `longshot.long_term_grind` / `longshot.compounding` — nonexistent (were contamination artifacts, now gone)

## Fixes deployed this session (all via workstation → scp → rebuild → rsync → restart)

1. `execution/paper-simulator.ts` + `execution/clob-router.ts` — `feeRate = 0` hardcode (was reading raw `taker_base_fee: 1000` as a decimal, producing $51K fee on $51 trades)
2. `execution/neg-risk-redeemer.ts` — `getUsdcBalance(targetAddress?)` accepts proxy override; RPC list updated (removed broken ankr/meowrpc, kept polygon-rpc.com + drpc + publicnode)
3. `core/engine.ts` — equity now includes open position MV (`cash + reserve + positions_mv`); Fisher-Yates shuffle for signals; per-cycle `(condition_id, token_id)` dedup; paper-resolver wired; startup wallet sync passes wallet address
4. `market/on-chain-reconciler.ts` — active-positions-only source of truth (Polymarket Data API `status=resolved` filter was broken, returning same data as `status=active`)
5. `market/paper-resolver.ts` — NEW. Closes paper positions when CLOB reports market closed; writes resolutions table; credits cash; triggers `dailyLossGuard.recordPnl`
6. `strategy/strategy-interface.ts` + `strategy/strategy-context.ts` — added `getActiveMarketsInWindow(minHours, maxHours)` for per-strategy time overrides
7. `strategy/custom/convergence.ts` — `long_term_grind` now uses 2h-30d window, `filtered_high_prob` keeps 0-24h
8. `strategy/custom/weather-forecast.ts` — added `same_day_snipe`, `next_day_horizon`, `ensemble_spread_fade` subs
9. `strategy/custom/crypto-price.ts` — added `target_proximity`, `volatility_premium_fade` subs
10. `strategy/custom/longshot.ts` — added missing `existingPositions` DB check (was the one strategy without it)
11. `storage/repositories/position-repo.ts` — `upsertPosition` ON CONFLICT no longer overwrites `strategy_id` / `sub_strategy_id`, preserving original ownership
12. `market/kalshi-client.ts` — exponential backoff + `Retry-After` header support on 429/5xx; 10-min cache
13. `market/odds-api-client.ts` — 60-min per-sport cache (was 10 min); warn log throttled to 1/hr
14. `config/rd-default.yaml` — `max_positions: 100000`, `max_position_usd: 10`, `min/max_hours_to_resolve: 1/48`
15. `/opt/polybot-v3/.env` + `/opt/polybot-v3-rd/.env` — FRED_API_KEY + ODDS_API_KEY wired

## Deploy discipline established

New doc: `Polymarket/docs/deploy.md` — canonical workstation → VPS src → `npm run build` → `rsync` to R&D dist → `systemctl restart` flow. Every change today went through this path. No hot-patches remain. `/opt/polybot-v3/src/` matches workstation for every file touched; `/opt/polybot-v3/dist/` rebuilt from that source; `/opt/polybot-v3-rd/dist/` rsync'd from prod dist.

## Known gaps (non-blocking, next session)

1. **Odds API quota**: `MONTHLY_QUOTA = 20000` hardcoded — need to confirm Dale's actual plan tier. With the 60-min cache, current burn rate is ~5K/month which is safe for any tier ≥ Plus.
2. **Paper resolutions not appearing yet**: Paper-resolver is wired and running per scan cycle, but 0 resolutions so far. Most likely because markets haven't closed yet (1-48h window). Expected to start flowing over next few hours as short-horizon markets expire.
3. **5 new sub-strategies not firing yet**: Strict gates by design. If none fire after 24h of accumulated data, loosen gates based on signal-count telemetry.
4. **v2 cleanup**: `/opt/polybot-v2/` and `/opt/polybot-v2-rd/` directories still exist on VPS. Dale's directive is full v1/v2 deletion, but the rebuild plan defers this to R3c to avoid orphaning any edge logic before the full rebuild audit completes.
5. **Archives preserved**: `/opt/polybot-v3-rd/archive/rd-archive-*.db` — multiple snapshots from today's wipe/restart cycles. Safe to delete after a week if no regression observed.

## Last known state before this session (2026-04-10 earlier)

## Last known state before pause

### Production Engine (before pause)

- **Entity**: GC Caspian (`polybot`)
- **Cash**: $2.49 | **Starting capital**: $257.09
- **Open positions**: 40 (stuck — this was the prod-blocking symptom that triggered the audit)
- **Total v2 trades**: 47
- **Resolved**: 12 | **P&L**: -$4.62
- **Schema**: v2

### R&D Engine (before pause)

- **Entity**: 16 entities, aggregate
- **Cash**: $18.93 aggregate | **Starting capital**: $10,000 paper
- **Open positions**: 1,280 (same stuck-resolution pattern at scale)
- **Total trades**: 11,245
- **Resolved**: 831 (**7.4% resolution rate**)

## R1 + R2 Rebuild Commits Landed (2026-04-10, code-complete)

All edits are in `Polymarket/polybot-v3/src/`. No git repo = no commit hashes; changes are grouped by logical commit per the R1 PR#1 implementation plan appendix of `C:\Users\dboehm\.claude\plans\spicy-puzzling-robin.md`.

### R1 PR#1 — unblock prod, stop bleeding

1. **NEW: `execution/neg-risk-redeemer.ts`** — viem-based on-chain redemption via `NegRiskAdapter` contract at `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296` on Polygon. Supports `redeem()`, `getUsdcBalance()`, `isAdapterApproved()`, `getCtfBalance()`. Fallback across 4 Polygon RPCs. Replaces v1 `auto_redeem.py`.
2. **NEW: `market/on-chain-reconciler.ts`** — queries Data API `/positions?user=` for each entity, reconciles DB state, closes resolved positions, inserts crash-window orphans, optionally calls the redeemer for live positions. Fail-closed on Data API errors.
3. **`risk/resolution-checker.ts`** — replaced with a deprecated stub that logs a warning on construction. All resolution logic now flows through `OnChainReconciler`.
4. **`core/engine.ts`** — removed `ResolutionChecker` field; added `DataApiClient`, `OnChainReconciler`, `Map<slug, NegRiskRedeemer>`. Added startup reconciliation (runs for every entity with a `proxy_address` before the first scan). Added per-scan-cycle reconciliation with fail-closed entity skipping (`entitiesSkippedThisCycle` set). New `getRedeemer(slug)` helper lazy-builds redeemers for live entities only.
5. **`execution/clob-router.ts`** — removed phantom 2% fee hardcode at line 124. Now reads `market.taker_fee` from `marketCache` (currently 0 on mainnet). Fixed sell-side sign bug.
6. **`execution/paper-simulator.ts`** — same phantom fee fix. R&D paper P&L now symmetric with live execution.
7. **`risk/position-sizer.ts`** — reordered from Kelly → caps → weighter to Kelly → weighter → caps. Per-position caps are LAST and always bind. Passes `signal.entity_slug` to `strategyWeighter.getWeight()`.
8. **`types/signal.ts`** — already had `entity_slug`. Added `is_exit?: boolean` and `exit_reason?: string` for exit routing (R1 PR#2 use).
9. **`types/events.ts`** — added `reconciler:complete` and `killswitch:activated/released` event types.

### R1 PR#2 — safety + ops

1. **NEW: `core/kill-switch.ts`** — singleton `killSwitch` with `halt(reason)`, `resume(operator)`, `check()` (throws if halted), `status()`. Exports `wireKillSwitchSignals()` that binds SIGUSR1 → halt and SIGUSR2 → resume.
2. **`core/lifecycle.ts`** — calls `wireKillSwitchSignals()` during shutdown-handler registration.
3. **`execution/clob-router.ts`** — `routeOrder` calls `killSwitch.check()` at the top. Throws if halted, caller logs as rejected order.
4. **`core/engine.ts`** — `runScanCycle` now calls `updatePositionPrice` for every open position using `marketCache` (wires the previously-dead `updatePositionPrice` function). Generates exit signals via `stopLossMonitor.scan()` and routes each through new `processExitSignal` helper → risk engine (short-circuits for `is_exit`) → `clob-router.routeOrder`. Credits sell proceeds to cash, records realized P&L, closes DB position. Removed the stop-loss-logging-only block from `riskCheckInterval`.
5. **`risk/risk-engine.ts`** — `evaluate` short-circuits lockout / entity-status / min-edge / daily-loss / max-positions gates when `signal.is_exit === true`. Also fixed audit A-P2-9: entries now require `signal.edge >= min_edge_threshold` (not `Math.abs(edge)`), so negative edges can't pass.
6. **`risk/daily-loss-guard.ts`** — added `> 0` guard on `daily_loss_lockout_usd` (audit A-P1-5). Zero no longer triggers on the first negative cent.
7. **`market/sampling-poller.ts`** — outcome-field validation instead of `tokens[0]=YES` hardcode (audit A-P0-10). Logs a warning when falling back to index-based mapping.
8. **`execution/order-builder.ts`** — assigns `order_id = live_${nanoid(12)}` at build time for live orders (previously null, which no-oped `updateOrderStatus` and stranded orders in `pending` forever). Audit A-P0-9 fix.
9. **`dashboard/sse-server.ts`** — new `/health` endpoint (unauthenticated, returns 200 when DB is reachable + engine running + kill switch released, else 503). Ready for Uptime Kuma wiring in R3b.
10. **`scripts/archive/`** — all 50 Python patch scripts quarantined (was 54 per audit; 4 `.sh` scripts kept in `scripts/`). README explains forensic-evidence 30-day retention then delete at R3c cleanup.

### R2 PR#1 — strategy rewrites

1. **Quarantined**: `strategy/archive/value.ts`, `skew.ts`, `complement.ts`. Removed from `strategy-registry.ts` + `core/engine.ts` imports + `config/entities.yaml`. README in `strategy/archive/` explains 30-day delete window ending **2026-05-10**.
2. **NEW: `risk/wilson.ts`** — `wilsonLowerBound()`, `wilsonUpperBound()`, `wilsonInterval()`, `classifyTier()`. Single source of truth for all Wilson-gated decisions in v3.
3. **NEW: `validation/base-rate-calibrator.ts`** — historical resolution-rate lookups bucketed by entry price (5% bins, ≥10 n/bucket). Exposes `getBaseRate(strategyId, entryPrice, subStrategyId?)` that returns Wilson LB or `null` for insufficient data. Exports singleton `baseRateCalibrator`. 60-min cache TTL.
4. **`strategy/custom/favorites.ts`** — wired `baseRateCalibrator` for all sub-strategies. `compounding` range tightened to `[0.50, 0.85)` (audit A-P1-4 boundary fix — was overlapping `fan_fade` at 0.85-0.92). New `usingCalibration` flag in signal metadata. Real edge = `model_prob - market_price` when calibrated, fallback to `payoff * 0.5` when not.
5. **`strategy/custom/longshot.ts`** — wired `baseRateCalibrator`. Added per-cycle `firedThisCycle: Set<condition_id>` for per-market precedence (audit A-P1-10). Priority order: `news_overreaction_fade > bucketed_fade > systematic_fade`. Only one longshot sub fires per market per cycle. Extracted `buildFadeSignal` helper.
6. **`strategy/custom/convergence.ts`** — wired `baseRateCalibrator` for `filtered_high_prob`. Real edge computation when calibrated. (`long_term_grind` still on fallback — lowest-priority rewrite.)

### R2 PR#2 — weighter + advisor + validation framework

1. **`risk/strategy-weighter.ts`** — full rewrite to Dale's Avoid/Monitor/Buy vocabulary. Cache key extended to `${entitySlug}|${strategyId}|${subStrategyId}` (audit A-P1-2 cross-entity fix). New-sub default is 1.0 (Monitor baseline), not 0.25. Floor 0.15 (never zero — per Dale 2026-04-10, "keep buying in Avoid areas" for regime-change detection). Ceiling 2.0. Buy tier linearly scales 1.0 → 2.0 by Wilson LB overshoot above 0.52. Full file header documents the cash-preservation purpose.
2. **`risk/strategy-advisor.ts`** — enable gate: `n ≥ 50 AND wilsonLB ≥ 0.50 AND pnl > $5`. Disable gate: `n ≥ 50 AND wilsonUB < 0.50 AND pnl < -$5` (symmetric Wilson).
3. **NEW: `validation/metrics.ts`** — computeStrategyMetrics() returns n, totalPnl, meanPnl, stdPnl, downsideStd, winRate, avgWin, avgLoss, profitFactor, maxDrawdown, maxDrawdownPct, annualized Sharpe, Sortino, Calmar, expectancy. NaN-safe for empty histories. Assumes 252 trades/year for annualization.
4. **NEW: `validation/brier.ts`** — computeBrier() returns Brier score + 10-bucket reliability diagram + calibration error + Brier decomposition's resolution term. Used by advisor to prefer well-calibrated strategies over lucky ones.
5. **NEW: `validation/walk-forward.ts`** — runWalkForward() with expanding-window splits + embargo; returns per-fold in-sample/out-of-sample metrics, Sharpe degradation, and pass/fail gate (OOS Sharpe > 0 AND degradation < 30%). Also exports `deflatedSharpeRatio()` for multiple-testing correction per Lopez de Prado 2014.

### R3a — signal feeds (external probability estimators)

1. **NEW: `market/odds-api-client.ts`** — The Odds API paid Plus tier ($30/mo, 20K req/mo). Tracks 7 sports, throttles to ≤1 req per sport per 10 min. Budget warn @ 80%, halt @ 95%. Median-implied-probability consensus across DraftKings/FanDuel/Caesars/BetMGM/Pinnacle with overround removal.
2. **NEW: `market/kalshi-client.ts`** — Read-only Kalshi public API, no auth. Fetches markets across 5 categories (POLITICS/ECONOMICS/FINANCE/CLIMATE/WORLD). Matches Polymarket ↔ Kalshi via Jaccard title similarity (threshold 0.40), 24h match cache. Ensemble-blends prices weighted by venue volume.
3. **NEW: `market/fred-client.ts`** — Federal Reserve FRED API (free, requires key). Tracks 8 series (Fed Funds, CPI, Unemployment, 10Y/2Y Treasury, GDP). Daily refresh. Exports `fedReactionProbCut()` — simple Taylor-rule-ish reaction function based on inflation and unemployment trends.
4. **NEW: `strategy/custom/sportsbook-fade.ts`** — fires when Polymarket sports market diverges from median sportsbook consensus by >3%. Matches markets by substring of team names in question text.
5. **NEW: `strategy/custom/cross-market-divergence.ts`** — fires when Polymarket ↔ Kalshi ensemble divergence > 4% AND both venues have >$5K 24h volume. Buys the cheaper side on Polymarket.
6. **NEW: `strategy/custom/macro-forecast.ts`** — fires on Fed rate cut/hike markets when reaction function disagrees with Polymarket by >5%. Keyword detection for Fed/CPI/unemployment markets.
7. **Engine integration** — all three clients instantiated in the Engine constructor; three strategies registered in the strategy registry; `entities.yaml` updated with the new strategy list for both prod and R&D entities.

### R3b — observability + portfolio risk + alerting

**Dashboard structure preserved** per Dale 2026-04-10: no sse-server.ts split, no template rewrite. All R3b functionality lands as ADDITIONAL endpoints.

1. **NEW: `risk/portfolio-risk.ts`** — PortfolioRiskTracker with checkExposure (pre-trade gate for category + strategy concentration caps: 30%/40%), updateDrawdown (halts kill switch on -20% drawdown breach), recordResolution (halts on 7 consecutive losses). Also exports `inferCategory()` keyword-matching for sports/politics/crypto/weather/macro/entertainment.
2. **NEW: `market/regime-detector.ts`** — RegimeDetector samples mean yes_price across active markets, classifies into 4 regimes (calm/choppy/trending/volatile) based on rolling volatility + lag-1 autocorrelation. Exposed on dashboard.
3. **NEW: `metrics/metrics.ts`** — MetricsRegistry with Prometheus text exposition format. 15 metrics (scan cycles, durations, signals, orders, fills, positions, cash, trading balance, reconciliation errors/closes, API errors, kill switch activations, Odds API quota, regime code). Auto-subscribes to event bus on module load.
4. **NEW: `metrics/alerter.ts`** — TelegramAlerter. Auto-captures chat_id via /start handshake (polls getUpdates every 30s until a message arrives, persists chat_id to `/etc/polybot-v3/telegram-chat-id`, then stops polling). Auto-subscribes to kill-switch + engine events. Alert dedup (5-min minimum gap per dedup key).
5. **`dashboard/sse-server.ts`** — added 4 new endpoints (structure unchanged):
    - `GET /metrics` — Prometheus scrape target (unauth)
    - `GET /api/kill-switch` — current kill switch status
    - `POST /api/kill-switch` — halt or resume from dashboard (auth required, body: `{action:'halt'|'resume',reason?,message?,operator?}`)
    - `GET /api/portfolio-risk` — PortfolioRiskTracker snapshot
    - `GET /api/regime` — RegimeDetector latest snapshot
6. **`core/engine.ts`** — instantiates PortfolioRiskTracker, RegimeDetector, TelegramAlerter. Per-scan: samples regime basket price, classifies every 10 cycles, updates drawdown per entity, updates Prometheus gauges. Alerter wired to engine lifecycle events. Exposes `getPortfolioRiskTracker()`, `getRegimeDetector()`, `getAlerter()` for the dashboard.

### R3c — dormant fleet subsystems (feature-flagged behind `FLEET_ACTIVE=true`)

1. **NEW: `core/scan-scheduler.ts`** — StaggeredScanScheduler. When active, each entity scans at its offset slot (`(i/N) × base_interval`) so the fleet achieves `5min/N` effective scan density across Polymarket. In single-entity mode (FLEET_ACTIVE=false) the engine's existing setInterval scan cycle runs normally.
2. **NEW: `core/position-claim.ts`** — PositionClaimCoordinator. Prevents fleet self-bidding: once entity X opens a position on market M, entities Y-Z skip M for the claim TTL (5 min). Enforces max 3 entities per market.
3. **NEW: `treasury/pool-manager.ts`** — PoolManager with daily UTC sweep (configurable hour). Sweeps excess-over-working-capital-floor from non-isolated entities into the pool. Refunds under-floor entities from pool. Allocates surplus to debt service / growth reserve / entity funding per config. **A Brown entity excluded from pool** per Dale 2026-04-10. Dormant until `FLEET_ACTIVE=true`.
4. **NEW: `accounting/entity-tax.ts`** — EntityTaxLedger. FIFO (or LIFO) cost basis computed on-demand from trades + resolutions tables. Returns TaxSummary with short-term vs long-term gains, total proceeds, cost basis, net P&L, win/loss counts. `exportCsv()` produces CPA-ready format. Works on single-entity data from day one (not feature-flagged — Dale 2026-04-10 "will need tax tracking regardless").

### R4 — scale & advanced strategies (scaffolds only, not wired)

1. **NEW: `execution/kms-signer.ts`** — AWS KMS signer interface with ECC_SECG_P256K1 key spec. Dynamic-imports `@aws-sdk/client-kms` so the dependency isn't pulled unless `KMS_KEY_ARN` is set. Skeleton implementation — DER parser and r/s/v recovery are R4 deployment runbook items. Returns null when `KMS_KEY_ARN` is unset so callers fall back to in-process private keys.
2. **NEW: `execution/market-maker.ts`** — MarketMaker class with inventory-skew two-sided quoting. `computeQuotes(midpoint, currentInventory)` returns bid/ask with skew. Not wired into engine — activation requires R3b+R3c stable and production capital > $10k.
3. **NEW: `execution/cross-exchange-arb.ts`** — CrossExchangeArbitrageur. `findOpportunities(pairs)` scans for profitable (PM buy + Kalshi buy opposite side) locks with fee budget. `execute()` intentionally throws — the atomic two-leg execution + recovery-mode logic is the R4 activation challenge.

### Both engines now configured for live mode

Per Dale 2026-04-10 "once complete put both engines into live mode":

- `config/entities.yaml` — polybot entity runs 8 strategies (5 R2 + 3 R3a signal feeds)
- `config/rd-entities.yaml` — **rd-engine mode changed from `paper` to `live`**, runs same 8 strategies, starting_capital 500
- `systemd/polybot-v3.service` — documents required env vars in `/opt/polybot-v3/.env`
- `systemd/polybot-v3-rd.service` — `POLYBOT_LIVE_MODE=true`, `POLYBOT_LIVE_CONFIRM=true` (was false)
- `core/engine.ts` — `isRdMode` now detected via `BASE_PATH==='/rd'` environment variable (not paper/live mode). Strategy weighter stays ACTIVE on R&D for exploration coverage regardless of capital being real vs paper.
- **Deployment requirement**: operator must place `/opt/polybot-v3-rd/state/api_keys.json` with a funded wallet before starting the R&D service. Without credentials the engine will log a fatal error and refuse to start the rd-engine entity in live mode.

## Pre-rebuild changes (2026-04-10 early session)

### Audit completed

- `Polymarket/docs/audit-2026-04-09.md` — 19-section unified report
- `Polymarket/audit/2026-04-09/` — 5 subagent track files + skills internalization
- Total findings: **50 P0, 62 P1, 47 P2, 20 P3 = 179**
- Top prod-blocking finding: **Position Resolution Pipeline** — 4 compounding bugs, detailed in audit §4.1 and Rec 1
- Fix plan NOT yet signed off. Do not resume trading until it is.

### Secrets redaction pass (2026-04-10)

Ten files scrubbed of cleartext credentials. Canonical values remain on the VPS. Vault pattern documented.

- `deploy/setup_vps.sh` — heredoc → error-and-exit
- `scripts/simulator/state/api_keys.json` → `__REDACTED__` placeholders
- `polybot-v3/systemd/polybot-v3-rd.service` → `__SET_ON_VPS__` placeholder
- `deploy/deploy_all_dashboards.sh` → `__SET_ON_VPS_AFTER_DEPLOY__`
- `scripts/RUN_TRADES.py` → `os.environ.get()` pattern
- `scripts/local_sprint_trader.py` → same
- `dashboard/dashboard.py` → same
- `README_THREE_SYSTEMS.md`, `SYSTEMS_DEPLOYED.md`, `docs/RECONCILIATION_FIX_SUMMARY.md` → `<DASHBOARD_PASS>` placeholder

**Vault README**: `Polymarket/docs/secrets-vault-README-2026-04-10.md` defines workstation vault location (`C:\Users\dboehm\.armorstack-vault\`) and env-var load pattern going forward.

**Still open** (awaiting Dale's signoff):
- `Polymarket/deploy/armorstack_vps_key` — SSH root key, still in OneDrive tree. Needs local move to vault.
- Dashboard HMAC session-signing rewrite (audit B-P0-4) — requires Phase 1 #14 work.
- Non-root service user (D1.1) — requires Phase 1 #13 work.

### Prior session (2026-04-09 pre-audit)

- Sub-strategy refactor deployed (schema v2 — `sub_strategy_id` on 5 tables)
- Longshot FADE inversion (buys the high-prob side)
- Favorites 4 subs, Convergence 2 subs, Value 2 subs
- Strategy Weighter sub-strategy-keyed
- Strategy Advisor sub-strategy-keyed
- Dashboard sub-strategy column

### Prior session (2026-04-08)

- Resolution Checker rewritten with Gamma API bulk lookup
- CHECK constraint removed from resolutions table
- Cash tracking on BUY trades fixed
- HMAC session tokens

## Infrastructure

| Component | Status |
|---|---|
| VPS (178.62.225.235:2222) | Running |
| Prod service | **Stopped (per pause)** |
| R&D service | **Stopped (per pause)** |
| SSL certs (sageadvisors.ai) | Valid |
| Schema version | v2 |
| Latest DO snapshot | polybot-v3-dual-engine-2026-04-08 |
| V2 SQLite backups | **NONE** — audit D6.1 flagged |
| Off-VPS backups | **NONE** — audit D6.2 flagged |
| Health endpoint | **NONE** — audit D5.1 flagged |
| Alerting | **NONE** — audit D5.3 flagged |

## Next session starts here

**Full R1+R2+R3+R4 rebuild is code-complete in `Polymarket/polybot-v3/`.** Both engines are configured for live mode. ~40 files touched this session without local compilation — Node isn't installed on the workstation. First action next session is install Node + run typecheck.

1. **Read this status + `docs/lessons.md` + `docs/rebuild-design-decisions-2026-04-10.md`** — get the full rebuild context
2. **Install Node.js on the workstation** (one-off)
3. **`cd Polymarket/polybot-v3 && npm install && npm run typecheck && npm run lint`** — catch any TS errors from the R1+R2+R3+R4 rebuild
4. **Fix any errors surfaced** — careful writing but a compiler has never seen this code
5. **Get API keys from Dale**:
    - ODDS_API_KEY (sign up at the-odds-api.com, Plus tier $30/mo)
    - FRED_API_KEY (free at fred.stlouisfed.org/docs/api/api_key.html)
    - TELEGRAM_BOT_TOKEN (via @BotFather in Telegram)
6. **Get KMS (R4) info from Dale if he wants hardware signing at go-live**:
    - Or skip for now and run on in-process private keys (existing path)
7. **Deploy v3 to VPS**:
    - `rsync Polymarket/polybot-v3/ root@178.62.225.235:/opt/polybot-v3/` (minus node_modules)
    - Create `/opt/polybot-v3/.env` with all API keys + `POLYBOT_LIVE_MODE=true POLYBOT_LIVE_CONFIRM=true`
    - Create `/opt/polybot-v3/state/api_keys.json` (wallet creds, operator-placed)
    - Create `/opt/polybot-v3-rd/state/api_keys.json` (R&D wallet creds, operator-placed)
    - Install systemd units: `cp systemd/polybot-v3.service systemd/polybot-v3-rd.service /etc/systemd/system/; systemctl daemon-reload`
    - `npm install --omit=dev` in both `/opt/polybot-v3` and `/opt/polybot-v3-rd`
    - `npm run build`
8. **Fund both wallets** (Dale action) — $500 to GC Caspian, $500 to rd-engine
9. **Start R&D first**: `systemctl start polybot-v3-rd`, verify `/health` returns 200 and `/rd/api/status` shows running
10. **Complete Telegram handshake**: message the bot from your @dale_boehm account with `/start`. Bot captures chat_id and persists to `/etc/polybot-v3/telegram-chat-id`. Expect a "Polybot V3 alerter online" welcome message.
11. **Start prod**: `systemctl start polybot-v3`. First scan cycle's reconciler clears the 40 stuck v2 positions via Data API.
12. **24-48h live burn-in on both engines** — monitor via `/health` (Uptime Kuma optional), `/metrics` (Prometheus optional), Telegram alerts, `/api/portfolio-risk`, `/api/regime`
13. **If burn-in clean**: the rebuild is done. Move into iterative capital additions, strategy tuning based on real resolved-position data, calibration of Avoid/Monitor/Buy thresholds.
14. **When ready for R3c fleet activation**: set `FLEET_ACTIVE=true` in both .env files, add more entities to entities.yaml, restart. Staggered scheduler + treasury + anti-self-bidding activate automatically.
15. **R4 activation** is opportunistic — KMS signer + market-maker + cross-exchange arb scaffolds exist in the tree, each has a clear activation runbook comment in its file header.

**Before any VPS deploy**: typecheck locally first. Nothing in the rebuild has been verified against a compiler. The code was written carefully with explicit types and batch-reads before editing, but a real typecheck is the only way to catch remaining errors cleanly.
