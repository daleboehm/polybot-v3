# Polymarket Rebuild — Design Decisions (Claude-made, Dale-reviewable)

> **Date**: 2026-04-10
> **Context**: Companion to `rebuild-plan` (`C:\Users\dboehm\.claude\plans\spicy-puzzling-robin.md`). Dale delegated parameter-level decisions to Claude with instructions to "do what it takes for it to make rational and realistic sense to become as profitable as possible." Every decision below is grounded in a specific loaded skill. Dale can veto any line item — mark "REJECT" next to it and I'll propose an alternative.
> **Skills loaded for these decisions**: `agi-kelly-criterion`, `agi-position-sizing`, `agi-walk-forward-validation`, `agi-exit-strategies`, `agi-risk-management`, `ar-statistical-analyst`, `polymarket-statguy-research`, `polymarket-trading-expert`

---

## Design Philosophy (the frame every decision answers to)

Per `agi-risk-management` hierarchy: **Survival → Capital Preservation → Growth**. Every parameter below is chosen to protect survival first, preserve capital second, and only then pursue profit. "Power trading engine" does not mean "aggressive sizing" — it means *rational* sizing that compounds because it doesn't blow up.

Per `agi-kelly-criterion` asymmetry: **overbetting by 2x produces zero long-term growth**; underbetting by 2x still captures 75% of optimal. When in doubt, smaller is right.

Per `ar-statistical-analyst` discipline: **"statistically significant" and "practically significant" are separate questions**. A sub-strategy that crosses Wilson LB > 0.5 at n=50 has statistical signal, but if its P&L is $0.02, that's not practical signal. Both gates must be passed.

---

## A. R&D Strategy Weighter (R&D engine only)

**Purpose** (Dale's framing, confirmed in code at `strategy-weighter.ts:2`): cash-preservation rationing device. Keep all subs buying for exploration coverage; reduce bet size on known losers so cash isn't burned on dead ends. **Never zero a sub's weight** — that creates blind spots in the exploration map.

### A1. Tier vocabulary → 3 tiers matching Dale's language

Decision: **Avoid / Monitor / Buy** (drop the code's 4-tier `proven/promising/unproven/underperforming` nomenclature; rename in code + dashboard).

Rationale: Dale's vocabulary is trader-intuitive. The current 4 tiers are redundant (unproven and promising overlap semantically).

### A2. Tier gates (Wilson Lower Bound, not raw win rate)

| Tier | Gate | Weight | Reasoning |
|---|---|---|---|
| **Buy** | Wilson LB(wins, n) ≥ 0.52 AND total_pnl > 0 AND n ≥ 30 | 1.0 → 2.0, scaled by LB overshoot | Real statistical + practical signal. Sizing boost earned through sustained evidence. |
| **Monitor** | n < 30, OR Wilson LB between 0.45 and 0.52, OR total_pnl between -$2 and +$2 | **1.0 (neutral baseline)** | Includes brand-new subs and genuinely ambiguous subs. Neutral sizing = don't starve, don't amplify. |
| **Avoid** | Wilson LB < 0.45 AND n ≥ 30, OR total_pnl < -$2 AND n ≥ 30 | **0.15 (floor, never zero)** | Evidence of losing — but keep one-data-point-per-cycle flowing for regime-change detection. |

**Why Wilson LB instead of raw WR**: per `agi-kelly-criterion`: "use the lower bound of a Wilson confidence interval for win rate rather than the point estimate ... automatically builds in conservatism." Raw WR at n=10 has a ±25% confidence band — worthless as a gate.

**Why n=30 threshold**: at n=30 with Wilson LB ≥ 0.52, observed WR must be ≥ ~70% — stringent but achievable in R&D's trade volume. Waiting for n=100 starves the feedback loop. 30 is the minimum statistical-analyst skill recommends for "any hypothesis testing."

**Why $2 P&L floor for Monitor**: practical significance. A sub that's $0.50 up after 30 trades is noise, not signal.

### A3. Brand-new sub default (n=0 resolutions)

Decision: **1.0 (Monitor tier baseline)**. Current 0.25 is wrong.

Rationale: The position sizer already applies `fractional_kelly: 0.25` globally (from `default.yaml:12`). Stacking a 0.25 weighter multiplier on top means brand-new subs get `0.25 × 0.25 = 0.0625x` of theoretical Kelly — which, per the `agi-kelly-criterion` skill's own fraction table, is below the 0.10x floor they recommend for even the most uncertain strategies. That's double-punishment. Kelly handles edge uncertainty; the weighter should handle performance-tracking only.

### A4. Ceiling

Decision: **2.0x max**. Matches current code and skill guidance.

Rationale: `agi-kelly-criterion` Table at line 68: "0.5x Kelly ~= high confidence, 100+ trades." With global `fractional_kelly: 0.25` and a 2.0 weighter boost, effective sizing on Buy tier = 0.5x Kelly, which is the recommended high-confidence fraction.

### A5. Boost function (Buy tier)

Decision: linear interpolation from Wilson LB.

```ts
function buyWeight(wilsonLB: number): number {
  // LB 0.52 → 1.0
  // LB 0.70 → 2.0 (capped)
  const normalized = Math.max(0, Math.min(1, (wilsonLB - 0.52) / 0.18));
  return 1.0 + normalized * 1.0;
}
```

Rationale: smooth scaling, no cliff effects, cap at 2.0x ties to Kelly's 0.5x max.

### A6. Floor behavior (Avoid tier)

Decision: **hard-coded 0.15**. Cash-preservation, not signal promotion — per Dale's framing and the existing file comment at `strategy-weighter.ts:102`.

Rationale: any lower and the sub effectively stops producing resolutions. 0.15 × $5 min trade = $0.75 positions, which is enough to still resolve but small enough to not burn the research budget.

### A7. Cache key

Decision: `${entity_slug}|${strategy_id}|${sub_strategy_id}` (was `${strategy_id}|${sub_strategy_id}`).

Rationale: audit A-P1-2 — cross-entity contamination in R&D's 16 entities. Each entity must have its own weighter memory; different entities see different sub-strategy performance.

### A8. Sibling fallback

Decision: **REMOVE**. Replace with Monitor-tier default (1.0).

Rationale: audit A-P1-1 data leakage. A brand-new sub inheriting sibling averages is a form of in-sample training — that sub hasn't been tested on anything yet. Default to 1.0 (neutral) and let data accumulate.

### A9. Refresh interval

Decision: **5 minutes (current)**. No change.

### A10. Exploration coverage metric (Dale's soft-gate decision, confirmed)

Decision: surface on dashboard as informational only. No automatic weight adjustment. Track "days since last resolution" per sub-strategy; flag red if > 14 days in any category. The advisor sees this and can trigger a manual review.

Rationale: Dale 2026-04-10: "Soft. We are then still getting data constantly especially if that changes for some reason which it could."

---

## B. Prod Strategy Advisor (Prod engine only)

**Purpose**: read R&D's `v_strategy_performance`, decide which (strategy_id, sub_strategy_id) pairs are ready for prod trading. Applies ENABLE/DISABLE/KEEP decisions to the prod entity's config every N minutes.

### B1. ENABLE gate

Decision: **n ≥ 50 AND Wilson LB(wins, n) ≥ 0.50 AND total_pnl > $5** (per sub-strategy, not per strategy).

| Parameter | Current | New | Why |
|---|---|---|---|
| `min_resolutions_to_enable` | 10 | **50** | At n=10 Wilson LB is [0.24, 0.76] — useless. At n=50 with LB ≥ 0.50, observed WR must be ≥ ~62%, which is real signal per `ar-statistical-analyst`. |
| `min_win_rate_to_enable` | 50% (raw) | replaced with **Wilson LB ≥ 0.50** | Raw WR at small n is noise. Wilson LB is the conservative statistic. |
| `min_pnl_to_enable` | $0 | **$5** | Practical significance gate. Sub that's +$0.02 after 50 resolutions is not worth promoting. |

Rationale: `ar-statistical-analyst` Decision Framework: "p-value < α AND effect size large AND meaningful → ship." All three gates together = statistically significant (Wilson) + practically significant ($5 P&L) + sample size (n=50). One gate alone is insufficient.

### B2. DISABLE gate

Decision: **n ≥ 50 AND Wilson UPPER bound(wins, n) < 0.50 AND total_pnl < -$5**.

| Parameter | Current | New | Why |
|---|---|---|---|
| `min_resolutions_to_disable` | 20 | **50** | Current threshold could kill a real 45-48% strategy (which might still have positive EV at the right payoff ratio). |
| `max_win_rate_to_disable` | 30% (raw) | replaced with **Wilson UPPER bound < 0.50** | 95% confident the strategy is a loser, not just unlucky at small n. |
| P&L floor | $0 | **-$5** | Prevent disabling on statistical noise near zero. |

Rationale: symmetric to ENABLE — both gates require n ≥ 50 and use Wilson bounds. Kills strategies that are demonstrably bad, preserves ones that are merely unlucky.

### B3. Protected strategies list

Decision: keep the current mechanism (strategies in `protected_strategies` array cannot be auto-disabled). Add `weather_forecast.single_forecast` and `crypto_price.latency_arb` to the protected list — they have real data feeds and should survive a bad-luck week.

### B4. Check interval

Decision: **10 minutes on prod VPS (600,000 ms), 30-min schema default as safety**.

Rationale: Dale's memory of "every 10 min" matches the VPS runtime config (per `context.md`); the 30-min schema default is a safer fallback if config is missing. 10 minutes is plenty — R&D weighter refreshes every 5 min, so the advisor can act on at-most-one-refresh-stale data, which is fine.

### B5. First-check delay after restart

Decision: **60 seconds (was 10)**. Gives the engine time to reconcile positions via the DataApiClient (R1 #1) before the advisor starts mutating config.

---

## C. Position Sizer (Both engines)

### C1. Kelly fraction

Decision: **0.25x fractional Kelly (current `fractional_kelly: 0.25`)**. No change.

Rationale: `agi-kelly-criterion` recommended fractions table: "0.25x Kelly: moderate confidence, 30-100 trades, reasonable Sharpe." We're at the low-confidence end of the strategy lifecycle. 0.5x waits for 100+ trades per sub (future R3+ upgrade).

### C2. Sizer order of operations (audit A-P0-6 — critical bug)

Decision: **Kelly → weighter multiply → caps → liquidity cap**. Caps must be LAST.

```ts
// BEFORE (broken):
let size = kellySize(...);
size = Math.min(size, pctCap, absoluteCap);  // caps
size = size * weighter.getWeight(...);       // multiply AFTER cap = bypass

// AFTER (fixed):
let size = kellySize(...);
size = size * weighter.getWeight(entity_slug, strategy_id, sub_strategy_id);
size = Math.min(size, pctCap, absoluteCap);  // caps are binding
size = Math.min(size, liquidityCap(orderbook, 0.10));  // R3: 10% of top-3 depth
```

### C3. Per-position cap (% of trading balance)

Decision: **10% (current `max_position_pct: 0.10`)**. No change.

Rationale: `agi-risk-management` concentration limits table: "Single token (blue chip): 10%, mid-cap: 5%". Polymarket markets are effectively "mid-cap" in that they're illiquid compared to crypto majors, but prediction-market resolution risk is bounded (unlike a crypto asset that can go to zero). 10% is defensible.

### C4. Absolute per-position cap (USD)

Decision: **scale with trading capital**. Formula: `max_position_usd = max(2.00, min(20.00, trading_balance * 0.10))`.

Rationale: current hardcoded $20 is absurd against $2.49 starting cash (makes every trade a single-position bet). Scaling with balance means at $257 starting cash the cap is $20 (equal to current), at $2500 the cap is $20 (still), at $25,000 the cap lifts to $2,500 (new ceiling needed then but that's a future decision). **Dale can override** via config YAML as capital grows.

### C5. Liquidity-aware cap (R3 feature)

Decision: **10% of combined depth across top-3 orderbook levels**, ignoring the spread.

Rationale: `agi-position-sizing` liquidity rules for AMMs say 2%, but Polymarket is a CLOB with explicit depth at each level. 10% of top-3 is aggressive but defensible — any more and slippage per `agi-slippage-modeling` exceeds 2%. This becomes the binding constraint on thin markets.

### C6. Minimum position size (dust floor)

Decision: **$2.00 minimum**. Below this, skip the trade (cannot fill and tracking overhead exceeds expected P&L).

Rationale: current code has a similar dust floor; confirming at $2 to align with `max_position_usd` scaling floor.

---

## D. Exit Strategy (R1 wiring + R2 tuning)

### D1. Stop-loss policy (tiered, entry-price-dependent)

Decision: **keep current tiered stops from `default.yaml:21-33`, add time stops**.

| Entry Price | Stop | Why |
|---|---|---|
| 0.50 – 1.00 | -30% | Mid-range favorites; 30% gives volatility room |
| 0.20 – 0.50 | -50% | Mid-range longshots; wider band for larger swings |
| 0.10 – 0.20 | -60% | Deep longshots; mostly hold-to-resolution |
| 0.00 – 0.10 | **no stop** | Cheap binaries; stop would trigger on noise |

Rationale: Polymarket has no minute-bars for ATR calculation. The current tiered approach is pragmatic. `agi-exit-strategies` recommends 2x ATR as "standard" — these fixed percentages are wider than 2x ATR would produce, which is correct for binary markets where price moves are regime-like, not random-walk.

### D2. Take-profit target

Decision: **+40% (current `profit_target_pct: 0.40`) for favorites/convergence, +100% for longshot FADE, resolution-hold for weather/crypto**.

Rationale per `agi-exit-strategies`:
- Favorites/convergence: short-horizon drift trades. 40% is a full realization of most edge.
- Longshot FADE: betting on the high-prob side of a mispriced tail. Needs 2x+ R:R to justify the win rate.
- Weather/crypto: resolution-driven (no mid-market exit), hold to close.

### D3. Time stop (NEW)

Decision: **add `max_hold_hours` per strategy** with sane defaults:
- `crypto_price.latency_arb`: 4 hours (short-horizon)
- `favorites.*`: 72 hours
- `longshot.*`: market close
- `convergence.*`: market close
- `weather_forecast.single_forecast`: market close
- `value/skew/complement`: N/A (quarantined in R2)

Rationale: `agi-exit-strategies`: "Time stops prevent capital from sitting in dead trades." Polymarket positions can sit for weeks in the current stuck state; even without a stop-loss trigger, a position that hasn't moved in 72 hours is tying up capital that could be redeployed.

### D4. Exit routing (audit A-P0-2 fix)

Decision: **exits route through `clob-router.routeOrder` with `is_exit: true` flag**; risk engine short-circuits edge check and daily-loss gate for exits.

```ts
// risk-engine.ts
if (signal.is_exit) {
  // Exits bypass: min_edge_threshold, daily_loss_lockout, max_open_positions
  // Exits still check: kill switch, cash available, order idempotency
  return { approved: true, reason: 'exit' };
}
```

Rationale: `agi-exit-strategies` priority hierarchy line 259: "Hard stop > ATR trailing > Take profit > Time stop. The hard stop is always active and never overridden." Gating exits on the same constraints as entries = exits don't fire when you need them most (during drawdown, which is when the daily-loss gate trips).

### D5. Scaled exits

Decision: **defer to R3**. R2 exits full position at stop or target. Scaled exits add complexity that's not worth it at current capital scale.

---

## E. Strategy Layer Rewrites (R2)

### E1. Quarantine (Week 2, delete Day 31)

- `value.ts` — no thesis, `model_prob = price + 0.05`
- `skew.ts` — `model_prob = up * 1.5`, systematically opposed to longshot
- `complement.ts` — directional not arbitrage, `model_prob = 0.95` hardcoded

### E2. Rewrite `convergence.ts` — historical base-rate calibration

Decision: replace arithmetic model with **empirical resolution rate per 5% price bucket**.

```ts
// On strategy init (or weekly refresh):
// Query all resolved positions in the last 90 days
// Bucket by entry price: 0.50-0.55, 0.55-0.60, ..., 0.90-0.95
// For each bucket: base_rate = resolved_yes / total_resolutions
// Store in-memory

// On evaluate():
const bucket = Math.floor(market.price * 20) / 20;
const base_rate = this.baseRates.get(bucket);
if (!base_rate || base_rate.n < 20) return null; // not enough data
model_prob = base_rate.rate;
edge = model_prob - market.price;
// Only fire if edge > min_edge_threshold AND market.liquidity > 10000
```

Rationale: walk-forward-safe (always backward-looking), data-driven (not arithmetic), respects minimum-sample-size discipline. Matches `polymarket-statguy-research` pattern.

### E3. Rewrite `favorites.ts` (4 subs) and `longshot.ts` (3 subs)

Decision: same base-rate method per sub-strategy, but split the price ranges so sub-strategies don't overlap (audit A-P1-4: favorites 0.85-0.92 boundary collision).

| Sub-strategy | Price range | Target |
|---|---|---|
| `favorites.compounding` | 0.50-0.75 | Drift-to-resolution on moderate favorites |
| `favorites.near_snipe` | 0.75-0.85 | Near-certain outcomes, high volume only |
| `favorites.stratified_bias` | 0.60-0.80 (disjoint from compounding via volume filter) | High-volume variant with stricter entry |
| `favorites.fan_fade` | 0.85-0.95 | Very-high-prob, contrarian fade |
| `longshot.systematic_fade` | 0.05-0.12 | Buy the complementary high-prob side |
| `longshot.bucketed_fade` | 0.12-0.18 | Same, wider band |
| `longshot.news_overreaction_fade` | 0.05-0.15 AND recent news flag | Dispatched only when news_event flag set |

Per-market precedence (de-duplicate): on any given market scan cycle, only ONE longshot sub fires. Priority: `news_overreaction_fade` > `systematic_fade` > `bucketed_fade`. Prevents audit A-P1-10.

### E4. Keep `weather_forecast.single_forecast` and `crypto_price.latency_arb` as-is

Verified in Phase 1 exploration to use real data feeds (Open-Meteo, Binance). No rewrites needed in R2.

---

## F. Validation Framework (R2)

### F1. Walk-forward config

Decision: **rolling window, 60-day train / 14-day test / 3-day embargo**, per `agi-walk-forward-validation` crypto swing table (line 175).

Rationale: Polymarket positions resolve in 1-14 days. 60-day train window captures regime effects. 3-day embargo > 2x the typical label horizon.

### F2. Overfit detection

Decision: **Deflated Sharpe Ratio (DSR) gate at 0.95**, with `num_trials = 13` (accounts for the 13 sub-strategies tested, per `agi-walk-forward-validation` overfit_detection).

```python
# On strategy promotion evaluation:
dsr = deflated_sharpe_ratio(
    observed_sr=rd_stats.sharpe,
    num_trials=13,
    backtest_length=rd_stats.n_resolutions,
    skewness=rd_stats.skew,
    kurtosis=rd_stats.kurtosis,
)
if dsr < 0.95:
    reason = f"Overfit risk: DSR {dsr:.2f} < 0.95"
    action = "keep"  # don't promote
```

### F3. Risk-adjusted metrics in `v_strategy_performance`

Decision: extend view with:
- `sharpe_ratio` (annualized, daily-bar returns)
- `sortino_ratio` (downside-only volatility)
- `calmar_ratio` (annual return / max drawdown)
- `max_drawdown`
- `brier_score` (calibration of model_prob vs realized outcome)
- `reliability_p_0_05` through `reliability_p_0_95` — 10 buckets of realized rate vs predicted rate
- `wilson_lb_wr` — conservative win rate estimate

Rationale: `ar-statistical-analyst` + `agi-portfolio-analytics` — without risk-adjusted metrics, can't distinguish a 60% WR strategy with variance 0.50 from a 55% WR strategy with variance 0.15. Latter is better; former wins the raw-WR race.

---

## G. Portfolio-Level Risk (R3)

### G1. Max drawdown halt

Decision: **-20% from peak → full halt + manual review**. Moderate tier per `agi-risk-management`.

Rationale: -20% requires +25% recovery. Survivable but disciplined. Conservative -15% is too tight for prediction markets where 2-3 losing resolutions in a week can hit that.

### G2. Daily loss limit

Decision: **dynamic based on trading capital**:
- `daily_loss_lockout_usd = max(2.00, min(trading_balance * 0.03, 20.00))`
- Current hardcoded $20 = 7.8% of $257 starting = too loose
- 3% matches `agi-risk-management` conservative tier

### G3. Weekly loss limit (NEW)

Decision: **-7% weekly → minimum size only; -10% weekly → full halt for 48 hours**.

### G4. Concentration limits

| Dimension | Max % of trading balance |
|---|---|
| Single market | 10% (existing per-position cap) |
| Single strategy | 40% |
| Single sub-strategy | 20% |
| Single market category (sports/politics/crypto/weather) | 30% |
| Correlated cluster (same league/season) | 25% |

Rationale: `agi-risk-management` exposure limits + treats correlated markets the way meme tokens are treated (single bucket).

### G5. Circuit breakers (loss-based)

Decision:
- 3 consecutive losing resolutions → reduce all new position sizes 50% for 24 hours
- 5 consecutive losing resolutions → minimum-size mode (hit the dust floor) for 48 hours
- 7 consecutive losing resolutions → halt 24 hours + dashboard alert

---

## H. Kill Switch & Safety Halts (R1)

### H1. Runtime kill switch

Decision: singleton in-memory, checked at `clob-router.routeOrder` top of function. Per Rec 7 in audit §12.

### H2. SIGUSR1 + dashboard POST `/api/kill`

Decision: both halt + set reason + log. `SIGUSR2` releases.

### H3. Automatic halts (new, tied to circuit breakers)

Decision: halt on ANY of:
- Reconciliation drift > 5% between DataApiClient and DB
- 3 consecutive failures on Gamma / CLOB / Polygon RPC
- Open position count > 2x expected (catches runaway scan)
- Prod cash < $5 (prevents stuck-forever repeat of current state)
- Daily drawdown > 3%
- Weekly drawdown > 7%
- Any unrecognized exception in `runScanCycle`
- Wallet on-chain USDC balance < entity DB cash balance - $1 (catches silent drainage)

All halts log + emit event bus + surface on dashboard + trigger Uptime Kuma alert (R3).

---

## I. Operational Parameters

### I1. Scan interval

Prod: 5 min (current) ✓
R&D: 2 min (current) ✓

### I2. Advisor interval

Prod: 10 min (VPS config) ✓
Schema default: 30 min (safety fallback) — change from current 30 min default to keep as-is

### I3. Risk check interval

Current: 60 sec ✓ — no change

### I4. Min edge threshold

Decision: raise from **2% to 3%** (current `min_edge_threshold: 0.02` → new 0.03).

Rationale: `agi-kelly-criterion` edge classification (line 134): "0 - 0.02: no meaningful edge, transaction costs likely exceed edge." 2% is right at that boundary. 3% puts us safely into "marginal edge" territory where Kelly math stops being noise.

### I5. Reserve ratio

Decision: keep current `reserve_ratio: 0.60` (60% cash reserve, 40% trading balance) on prod. Matches `agi-risk-management` "Normal conditions: 50-80% deployed" — we're on the conservative end.

---

## J. What I Explicitly Did NOT Decide (Still Dale-only)

1. **Capital target for prod after R2 clears** — how much USDC to fund back after R1+R2 complete? Still waiting on Dale's capital allocation call.
2. **Kalshi R4 priority** — still deferring to "R4 but low priority."
3. **Hardware signing vendor (R4)** — AWS KMS / Fireblocks / dedicated signer.
4. **SSH key move authorization** — authorized but deferred to the R1 PR (bundled with deploy script updates).
5. **R1 redemption test scope** — Dale confirmed mainnet $1 test with kill switch armed, logged in plan.
6. **Alerting channel (R3)** — Pushover / Telegram / email? What endpoint/phone?
7. **Entity scaling prod (R3)** — single entity through R3, confirmed, but post-R3 the multi-entity decision is still open.

---

## K. Decision Audit Trail

Every numerical parameter above is grounded in at least one skill. If Dale rejects a value, the responder should cite which skill's frame it's coming from and propose a replacement.

| Area | Grounding skill |
|---|---|
| Kelly fraction (0.25x) | `agi-kelly-criterion` Table line 68, Recommended Fractions table |
| Weighter tier thresholds (Wilson LB ≥ 0.52) | `ar-statistical-analyst` + `agi-kelly-criterion` conservative estimation |
| Advisor n=50 gate | `ar-statistical-analyst` minimum sample size + Wilson LB math |
| Walk-forward 60/14/3 | `agi-walk-forward-validation` crypto swing table line 175 |
| DSR 0.95 gate | `agi-walk-forward-validation` overfit_detection |
| Exit hierarchy | `agi-exit-strategies` priority line 259 |
| Stop-loss tiers (entry-price-dependent) | Current code + `agi-exit-strategies` "keep tight stops for scalps, wide for swings" |
| Daily loss limit 3% | `agi-risk-management` conservative tier line 38 |
| Max drawdown 20% halt | `agi-risk-management` moderate tier line 31 |
| Concentration 10%/40%/25% | `agi-risk-management` concentration limits line 54 |
| Circuit breakers (3/5/7 streak) | `agi-risk-management` loss-based line 120 |
| Min edge 3% | `agi-kelly-criterion` edge classification line 134 |
| Reserve ratio 60% | `agi-risk-management` exposure limits line 68 |

---

## L. What Changes in the Plan File

The plan file (`spicy-puzzling-robin.md`) needs these edits to reflect the design decisions:

1. **§3 rebuild-targets table** — update weighter row with 3-tier vocabulary, Wilson gates
2. **§4 R2 item 3** — replace the weighter detail section with the 3-tier framing + reference this doc
3. **§4 R2 item 2** — validation framework now has specific walk-forward config (60/14/3, DSR 0.95)
4. **§4 R3** — portfolio risk section gets specific gate values
5. **§9 open questions** — close out the 3 answered questions; the 7 deferred items stay
6. **NEW appendix C** — "See `Polymarket/docs/rebuild-design-decisions-2026-04-10.md` for parameter-level grounding"

I'll land those edits in a follow-up pass before starting R1 implementation.

---

## M. Review Instructions for Dale

Read §A through §I. Anywhere you disagree, mark "REJECT §X.Y" and I'll propose an alternative with a different skill-grounded rationale. Silence = acceptance, and R1 PR #1 will be built against these parameters.

Expected per-section review time: ~2-3 minutes each (all numbers have a one-line rationale). Total ~30 minutes if you read everything.

If all green: respond "approved" and I'll enter plan mode for the first R1 PR (resolution reconciliation + phantom fee removal + sizer reorder).

---

## N. Signal Feeds (R3a) — Parameters and Blending Logic

**Added 2026-04-10 after the 7-item walk.** These decisions land with R3a PRs and drive the external-probability-estimator architecture.

### N1. The Odds API — sportsbook line ingestion

- **Tier**: Paid Plus at $30/mo (20K req/mo). Rationale: free tier's 500/mo is unusable at fleet scale; paid is rounding error against target revenue.
- **Refresh cadence**: 1 request per sport-category per 5 min (NFL, NBA, MLB, NHL, soccer_epl, soccer_uefa, tennis_atp). 7 sports × 12/hr × 24hr × 30d = ~60K/mo. Over quota — need to throttle.
- **Throttle strategy**: 1 request per category per 10 min during peak (game-day), per 30 min otherwise. ~15K/mo, safely under quota.
- **Budget alert**: Warn at 80% (16K req), halt at 95% (19K req) until next month. Halt mode = serve cached probabilities, don't refresh.
- **Implied probability conversion**: for American odds format, `prob = 100 / (odds + 100)` for positive lines, `prob = |odds| / (|odds| + 100)` for negative. For decimal odds: `prob = 1 / decimal_odds`. Strip the overround by normalizing to sum-to-1 across all outcomes.
- **Consensus calculation**: fetch odds from multiple books (DraftKings, FanDuel, Caesars, BetMGM), compute median implied prob as the consensus.
- **Signal fire rule**: `|polymarket_yes_price - sportsbook_consensus| > 0.03` fires signal; direction = buy the cheaper side on Polymarket.

### N2. Kalshi — read-only price divergence

- **Tier**: Free, public API, no auth. `https://api.elections.kalshi.com/trade-api/v2/markets`.
- **Refresh cadence**: 1 request per category per 10 min. Categories: POLITICS, ECONOMICS, FINANCE, CLIMATE, WORLD. ~7K/mo. Well under any realistic rate limit.
- **Market matching**: Jaccard similarity on title tokens + category match + close-date within 7 days. Threshold: Jaccard > 0.40. Cache matches in 24h TTL table.
- **Ensemble blend weight**: 50/50 Polymarket/Kalshi when both have >$5K daily volume. Kalshi-only weight drops to 0.3 when Kalshi volume < $2K (low-confidence venue). Polymarket never below 0.5.
- **Signal fire rule**: `|polymarket_yes_price - ensemble_blend| > 0.04` fires signal; direction = buy the cheaper side on Polymarket.
- **Volume gate**: Only fire when BOTH markets have >$5K trailing 24h volume — eliminates noise from thin markets.

### N3. FRED — Federal Reserve data

- **Tier**: Free, requires API key. `https://api.stlouisfed.org/fred`.
- **Series tracked** (initial set, extensible):
  - `FEDFUNDS` (Federal Funds Rate)
  - `DFF` (Effective Fed Funds Rate)
  - `CPIAUCSL` (CPI All Urban Consumers)
  - `UNRATE` (Unemployment Rate)
  - `DGS10` (10-Year Treasury Yield)
  - `DGS2` (2-Year Treasury Yield — for yield curve inversion signal)
  - `GDP` (Gross Domestic Product)
- **Refresh cadence**: Daily at 08:30 ET (after CPI/NFP release windows). ~30 req/month. Trivial.
- **Reaction function (v1, simple)**:
  ```
  If (Fed Funds > Taylor Rule target + 50bp) AND (trailing 3mo CPI < 3%) → P(cut) = 0.65
  If (Fed Funds < Taylor Rule target - 50bp) AND (trailing 3mo CPI > 4%) → P(hike) = 0.65
  Else → P(hold) = 0.60
  ```
- **Market targets**: Fed rate decision markets, CPI print markets, unemployment markets, GDP prints.
- **Signal fire rule**: `|polymarket_yes_price - reaction_function_prob| > 0.05` fires signal.

### N4. Ensemble blending across feeds

When multiple feeds have opinions on the same Polymarket market, weighted ensemble:

```typescript
interface FeedEstimate {
  source: 'odds_api' | 'kalshi' | 'fred' | 'weather' | 'crypto';
  probability: number;
  confidence: number; // 0-1, feed-specific
  volume_weight: number; // 0-1, based on venue volume
}

function ensembleBlend(
  polymarket_price: number,
  estimates: FeedEstimate[],
): { blended_prob: number; divergence: number; confidence: number } {
  if (estimates.length === 0) return { blended_prob: polymarket_price, divergence: 0, confidence: 0 };

  const weights = estimates.map(e => e.confidence * e.volume_weight);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) return { blended_prob: polymarket_price, divergence: 0, confidence: 0 };

  const externalBlend = estimates.reduce((sum, e, i) => sum + e.probability * (weights[i] / totalWeight), 0);
  // Blend external estimate 60/40 with Polymarket (Polymarket still gets weight because it's the trading venue and its price reflects flow information)
  const blended = 0.6 * externalBlend + 0.4 * polymarket_price;

  return {
    blended_prob: blended,
    divergence: Math.abs(polymarket_price - blended),
    confidence: Math.min(1, totalWeight / estimates.length),
  };
}
```

### N5. Drop list — NOT porting

- **Manifold Markets** — deferred to R4 as a research exercise. Play-money prices are too noisy for direct signal use. Value is as an emerging-market discovery scout, which is a meta-strategy that needs longer observation cycles.
- **Metaculus** — dropped. Slow cadence, niche, token required, low volume.
- **PredictIt** — dropped. CFTC-shuttered early 2023; API state unreliable.
- **RealClearPolitics** — dropped. Scraped data, brittle, redundant with Polymarket's own political market prices.

### N6. R3a budget line items

| Item | Monthly cost | Justification |
|---|---|---|
| The Odds API Plus tier | $30 | Sports probability ground truth — single highest ROI external feed |
| Kalshi | $0 | Free public API |
| FRED | $0 | Free with API key |
| **Total R3a recurring** | **$30/mo** | |

Approve at R3a PR #1 time; Dale signs up for The Odds API account and provides API key via the vault pattern (`C:\Users\dboehm\.armorstack-vault\polymarket\api_keys.json`).

---

## O. Hardware Signing (R4) — AWS KMS Details

**Decision**: AWS KMS asymmetric keys with `ECC_SECG_P256K1` key spec. Confirmed in AWS KMS docs that this curve is supported (it's the Bitcoin/Ethereum/Polygon curve).

### O1. Architecture

- **Key creation**: KMS-managed asymmetric key, purpose `SIGN_VERIFY`, spec `ECC_SECG_P256K1`. Key is created in AWS region that has the lowest latency to the Amsterdam VPS — `eu-west-1` (Ireland) or `eu-central-1` (Frankfurt).
- **IAM role**: Amsterdam VPS assumes an IAM role with permission to `kms:Sign` on specific key ARNs ONLY. No `kms:CreateKey`, no `kms:ScheduleKeyDeletion`, no cross-key access.
- **Public key**: on first boot, service calls `kms:GetPublicKey` once, derives Polygon address from the compressed public key, caches the mapping.
- **Signing flow**:
  ```typescript
  async function signTransaction(tx: TransactionRequest, keyArn: string): Promise<string> {
    const serialized = serializeTransaction(tx); // from ethers/viem
    const hash = keccak256(serialized);
    const { Signature } = await kmsClient.send(new SignCommand({
      KeyId: keyArn,
      Message: Buffer.from(hash.slice(2), 'hex'),
      MessageType: 'DIGEST',
      SigningAlgorithm: 'ECDSA_SHA_256',
    }));
    // KMS returns DER-encoded signature; parse to r, s and recover v
    const { r, s, v } = parseKmsSignature(Signature!, hash, publicKey);
    return serializeTransaction(tx, { r, s, v });
  }
  ```
- **CloudTrail**: all `kms:Sign` calls logged with source IP, IAM role, and request ID. Feeds into R3b alerting — any unexpected signing event (wrong source IP, wrong key) pages Dale via Telegram.

### O2. Cost

- AWS KMS asymmetric signing: $1/mo per key + $0.03 per 10K sign requests. At ~1000 signs/mo (fleet scale), ~$1.003/mo per entity. Negligible.

### O3. Migration from in-process key to KMS

1. Generate KMS key, note ARN.
2. Export public key, derive Polygon address.
3. Transfer USDC from old wallet to new KMS-backed address.
4. Update config to point at KMS key ARN.
5. Verify first signed transaction on mainnet.
6. Decommission old private-key file (delete from vault, delete from process env).

### O4. Per-entity key management

Each entity gets its own KMS key. Entity provisioning (R3c) creates the key as part of the `provisioning → active` state transition. Key ARN stored in `entities.yaml` (not a secret — it's just an identifier).

### O5. Failure mode

If KMS becomes unreachable (AWS outage, network partition, IAM permission change), signing fails → engine kill-switch fires → no trades placed. Safer than a silent key leak via in-process memory dump. Recovery: restore IAM permissions, resume trading.

---

## P. Telegram Alerting (R3b) — Setup Details

**Decision**: Telegram bot for all R3b operator alerts. @dale_boehm is the recipient; numeric chat_id captured via one-time `/start` handshake.

### P1. Bot creation (one-time, R3b PR #2 deployment)

1. Dale visits `@BotFather` in Telegram, sends `/newbot`
2. BotFather prompts for display name and username — Dale picks (e.g., "Gemini Capital Alerts", `@gemini_capital_alerts_bot`)
3. BotFather returns a bot token (format: `NNNNNNNNNN:AAA...`)
4. Dale copies the token into `C:\Users\dboehm\.armorstack-vault\polymarket\telegram.env`:
   ```
   TELEGRAM_BOT_TOKEN=NNNNNNNNNN:AAA...
   ```
5. Vault file is SCP'd to the VPS at `/etc/polybot-v3/telegram.env` (chmod 600, owned by `polybot` service user)
6. Systemd unit file loads via `EnvironmentFile=/etc/polybot-v3/telegram.env`

### P2. Chat ID capture (one-time, at first alert send)

1. Dale messages the bot in Telegram with `/start` from his @dale_boehm account
2. The alerter service (via a `getUpdates` poll) sees the message, extracts `message.from.id` (a numeric value like `123456789`)
3. Service writes the chat_id to `/etc/polybot-v3/telegram-chat-id` (chmod 600)
4. Subsequent alerts use the captured chat_id

### P3. Alert payload format

```
🚨 [SEVERITY] [COMPONENT]: Short description

Details:
- Metric: value
- Context: ...

Action: what to do
Time: 2026-MM-DD HH:MM UTC
Runbook: https://...
```

### P4. Severity gating

All alerts go to the same chat for R3b. If alert volume becomes annoying, R3b follow-up PR can add severity routing (P0 → instant, P1 → hourly digest, P2 → daily digest).

### P5. Alert categories (triggered by R3b monitoring)

- **Engine**: scan stall >10 min, crash, restart
- **Reconciliation**: drift >5%, data API unreachable
- **Capital**: cash <$5 (prod), daily drawdown >3%, weekly drawdown >7%
- **Safety**: kill switch activated, circuit breaker tripped, 3+ consecutive losses
- **Infrastructure**: `/health` endpoint down, VPS unreachable, disk >80% full
- **Budget**: Odds API quota >80% / >95%
- **Weekly digest**: Sunday 09:00 UTC — weekly P&L, positions, strategies enabled/disabled, pool status

