# Strategy Symmetry Audit — 2026-04-15

**Scope**: All 9 strategies in `src/strategy/custom/` + the kill-switch pipeline.

**Trigger**: (a) Grok research flagged "strategy symmetry" as the #1 cross-cutting bug class in prediction-market bots; (b) recap-day gate G1 ("weather_forecast kill-switch bypass") needed root-cause analysis before fix.

**Method**: Read each strategy's `evaluate()` loop, trace the Signal → risk engine → order router path, verify that (i) the side-flip preserves book semantics, (ii) the model probability is computed against the correct side, (iii) the market price written into the Signal matches the actual CLOB book price for the chosen token.

## TL;DR

- **1 real bug** (favorites.fan_fade computes its own `market_price` instead of reading the book).
- **1 semantic nit** (longshot uses `calibratedYesProb` where `calibratedSideProb` would be more correct; numerical error <0.4% at tested prices).
- **1 edge-case** (crypto-price / weather-forecast / macro / sportsbook / cross-market all flip side on yes-edge sign only, which under-selects NO when both sides have positive edge — only possible when `yes_price + no_price < 1`, rare on a liquid CLOB).
- **G1 hypothesis revision**: the weather_forecast "kill-switch bypass" is almost certainly NOT a strategy-level bypass. `clob-router.routeOrder()` calls `killSwitch.check()` unconditionally at line 30, and `check()` throws for every halt reason. The weather_forecast path goes through the same risk-engine → order-router pipeline as every other strategy. The real root cause is the kill switch's non-persistence: if the prod process restarted between the 4/13 halt and trades 1347/1348, the halt state cleared and live trading auto-resumed. That matches the warning already in `docs/todo.md` start-of-session checklist item 5.

## Audit results by strategy

### favorites.ts — 1 real bug

**Line 138, `fan_fade` sub-strategy:**
```ts
const underdogPrice = 1 - favoritePrice;
```

The strategy computes the underdog price as `1 - favoritePrice` rather than reading the actual book side. This value then flows into `signal.market_price` (line 166) and becomes the limit price on the order request (`risk-engine.ts:224`).

**Why it matters**: Polymarket CLOB books frequently have `yes_price + no_price ≠ 1` due to spread. Example: `yes_price = 0.87`, `no_price = 0.14` → `1 - 0.87 = 0.13`, but the actual underdog is listed at `0.14`. Placing a maker buy at `0.13` either (a) sits a tick below the book and never fills, or (b) if the book moves, fills at a stale price the strategy didn't intend. In the worst case, a deep spread inverts the expected-value calculation.

**Fix**: Read `market.no_price` when `favoriteSide === 'YES'`, else `market.yes_price`:
```ts
const underdogPrice = favoriteSide === 'YES' ? market.no_price : market.yes_price;
```

**Impact**: fan_fade is already auto-disabled by the advisor (4.8% WR per R&D data). The bug may explain WHY it has such a low win rate — the wrong limit price would cause fills at adverse ticks. Fix is 1-line.

**Status**: documented here; fix can land as part of a clean-up PR. Not blocking recap-day release because the sub-strategy is disabled.

### longshot.ts — 1 semantic nit

**Line 80:**
```ts
const markovCalibration = calibratedYesProb(fadePrice);
```

Longshot fades the tail by buying the high-prob (fade) side. When `tailIsYes === true`, the fade side is NO, `fadePrice = market.no_price`, and the correct Markov lookup is "what is the empirical probability that a NO token priced at `fadePrice` resolves to 1?" — i.e. `calibratedSideProb(fadePrice, fadeSide)`.

Using `calibratedYesProb(fadePrice)` instead asks "what is the empirical YES rate for a token priced at `fadePrice`", which is the wrong semantic. The Becker 72.1M-trade grid is NEAR-symmetric (mirror error: 0.06% at 0.85/0.15, 0.33% at 0.95/0.05), so the numerical impact is under half a percent at every price point we actually trade. It's a correctness nit, not a P&L bug.

**Fix**:
```ts
const markovCalibration = calibratedSideProb(fadePrice, fadeSide);
```

**Status**: documented here; fix can land as part of a clean-up PR.

### favorites.ts (other subs) — clean ✓
### longshot.ts (sub-strategy dispatch) — clean ✓
### convergence.ts — clean ✓
### whale-copy.ts — clean ✓

All four read `market.yes_price` / `market.no_price` directly based on the chosen buy side and use `calibratedSideProb(price, side)` or model-native probabilities correctly.

### crypto-price.ts, weather-forecast.ts, macro-forecast.ts, sportsbook-fade.ts, cross-market-divergence.ts — edge-case caveat

All five strategies follow the same pattern: produce a YES-side probability estimate, compute `yesEdge = estimate.yesProbability - yesPrice`, flip to NO if negative. When flipped:

```ts
const buyPrice = buySide === 'YES' ? market.yes_price : market.no_price;
const modelProb = buySide === 'YES' ? yesProb : (1 - yesProb);
const edge = modelProb - buyPrice;
```

**This is mathematically correct** for binary-exhaustive models: `P(YES) + P(NO) = 1` by definition, so `(1 - yesProb)` IS the correct model probability for NO. The edge is then recomputed against the actual `noPrice`, which is the correct book price. All five strategies are sound in the normal case where `yes_price + no_price ≥ 1` (the typical Polymarket CLOB state).

**Edge case**: when `yes_price + no_price < 1` (rare but possible in thin/new books), BOTH sides can have positive edge vs any model probability in the middle. The current logic picks the side with the larger `|yesEdge|`, which is not necessarily the side with the larger actual edge. Example:

- yesPrice = 0.45, noPrice = 0.40, model yesProb = 0.50
- yesEdge = +0.05 → flip=NO not triggered, buy YES
- BUT noEdge would have been = +0.10 — the better pick

**Why it's not fixed right now**: the edge case requires `sum < 1`, which is normally arbitraged away by the AMM + other makers within seconds. The standard CLOB state on mature markets has `sum ≈ 1` or slightly over. Fixing it cleanly requires computing BOTH edges and picking the larger, which is a structural refactor across 5 files.

**Status**: documented here; fix deferred to a later clean-up PR. Impact is "leave a small amount of EV on the table on thin books", not "misfire in the wrong direction".

## G1 root cause revision

The original G1 entry in `docs/todo.md` reads: "trades 1347 + 1348 placed AFTER the 4/13 halt via `weather_forecast` strategy path. ... `src/execution/clob-router.ts` order path for weather_forecast isn't checking `killSwitch.isHalted()` before submission."

**This hypothesis is almost certainly wrong.** Audit findings:

1. `src/execution/clob-router.ts:30` — `killSwitch.check()` is called at the top of `routeOrder()`, BEFORE `insertOrder`, unconditionally on every submission path.
2. `src/core/kill-switch.ts:85-89` — `check()` throws for every halt state, no reason-specific logic, no bypass:
   ```ts
   check(): void {
     if (this.halted) {
       throw new Error(`kill_switch_halted: ${this.reason ?? 'unknown'}...`);
     }
   }
   ```
3. `src/core/lifecycle.ts:38` — `wireKillSwitchSignals()` is called during engine registration; SIGUSR1/2 are correctly wired.
4. `src/strategy/custom/weather-forecast.ts` — does NOT submit orders directly. Returns `Signal[]` through the normal engine pipeline, same as every other strategy. There is no out-of-band order submission path.

**If the kill switch had been halted when trades 1347/1348 were attempted, `routeOrder` would have thrown.** Since the trades were recorded as fills, `routeOrder` did not throw, so the kill switch was NOT halted at that moment.

**The real root cause**: the kill switch is NOT persisted across process restarts (by design per the comment in `kill-switch.ts` lines 14-17 — "intentional, per obra-defense-in-depth, so a halt caused by a runtime anomaly shouldn't permanently lock the engine out of recovery"). If the prod process restarted between the 4/13 13:36 UTC halt and trades 1347/1348 — via OOM-kill, systemctl restart, or an `uncaughtException` triggering graceful shutdown — the halt state cleared and the engine resumed live trading immediately on restart. This matches the `docs/todo.md` start-of-session checklist warning item 5 exactly.

**Real G1 fix**: persist the kill-switch state to SQLite. On engine startup, read the last persisted state; if `halted === true`, halt on boot with the original reason. Require explicit operator SIGUSR2 (or dashboard API call) to clear. This matches the "halt should survive restart" semantics Dale assumed was already in place.

**Rewrite of G1** (for `docs/todo.md`):

> ### G1. Persist kill-switch state to SQLite
>
> Evidence: trades 1347 + 1348 recorded AFTER the 4/13 halt. Audit confirms `clob-router.routeOrder()` calls `killSwitch.check()` on every order submission and `check()` throws unconditionally when halted. The only explanation for trades-through-halt is that the kill switch was cleared — which happens automatically when the process restarts, since `kill-switch.ts` explicitly holds state in-memory only.
>
> Fix: persist the halt state to a `kill_switch_state` table. On engine startup in `lifecycle.ts`, read the last row; if `halted === true`, call `killSwitch.halt(reason, message)` before any strategy or order-router code runs. `resume()` clears the row. Operator SIGUSR2 or the dashboard API call are the only paths that can clear it.
>
> The comment in `kill-switch.ts` lines 14-17 argues against persistence on the grounds that a bad halt could lock the engine out of recovery — but the recovery path is manual operator intervention (SIGUSR2 or dashboard), not auto-clear-on-restart. Persistence makes the halt survive a restart; operator action is still the only way to resume.

## Recommended follow-ups

Phased, commit-by-commit, lowest-risk first:

1. **G2 portfolio exposure cap** (this audit's companion work). Clean additive change. Implemented next.
2. **G1 kill-switch persistence** (revised root cause). Ships with a new `kill_switch_state` table migration and a 20-line change to `kill-switch.ts` + `lifecycle.ts`.
3. **fan_fade limit-price bug** (1-line fix to `favorites.ts:138`). Low-risk since sub-strategy is currently disabled.
4. **longshot calibratedSideProb nit** (1-line fix to `longshot.ts:80`). Neutral P&L impact but removes a correctness nit.
5. **Both-sides-positive-edge refactor** (5-file structural change). Deferred pending a design note on whether to compute both edges in the strategy or push the decision into the risk engine.

All five land on R&D first (72h paper run per R1 verification gate) before any are considered for live.
