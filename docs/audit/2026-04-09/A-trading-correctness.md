# Track A — Trading Correctness Audit

> Audit date: 2026-04-09
> Auditor: subagent (read-only)
> Scope: V2 engine trading correctness — strategies, sizing, execution, state, resolution pipeline
> Codebase root: `polybot-v2/src/`

## Summary

The V2 engine has multiple P0-class trading correctness defects, several of which compound to produce the symptom the user flagged: PROD has 40 open positions and only $2.49 cash because positions are not closing. The most likely root cause of the resolution-pipeline stall is a **dual data-source race between v1's `auto_redeem.py` cron (which redeems on-chain by polling Polymarket Data API) and v2's `resolution-checker.ts` (which queries Polymarket Gamma API and waits for `closed === true && outcomePrices > 0.95`)**, compounded by **(a) Gamma's `condition_ids` plural query parameter being non-standard and likely ignored by Gamma**, **(b) the Gamma response shape being cast as a flat array when it is in fact `{data: [], next_cursor: ...}` for paginated responses**, and **(c) any market in `resolution_pending` state where Gamma still shows ~0.5/0.5 prices being skipped silently with no retry/backoff/escalation**. Beyond resolution, I found: a hardcoded 2% phantom fee in both paper and live execution that drains cash on every fill; a stop-loss monitor that is a no-op (only logs, never executes, and the position prices it depends on are never refreshed); a strategy-weighter "average of subs" fallback path that mathematically inflates a brand-new sub-strategy's weight by mixing in unrelated sub-strategies' performance; a strategy-weighter cross-entity contamination (last-write-wins on the in-memory map); a position-sizer that applies the 2.0x performance boost AFTER the per-position cap (effectively doubling the cap); a `parseSingleMarket` parser that hardcodes tokens[0]=YES with no validation against the outcome string; live order_id never being assigned (orders.order_id stays NULL, `updateOrderStatus(null,...)` updates nothing); the `complement` "arbitrage" strategy which only buys YES and is therefore directional, not arbitrage; and the `value` and `skew` strategies which fabricate `edge` and `model_prob` from arithmetic on the market price. Sub-strategy refactor: longshot's FADE inversion is correct; favorites' four sub-strategies are mostly correct with one off-by-one boundary at the 0.92 cutoff between `compounding` and `fan_fade`.

---

## P0 Findings (immediate financial risk)

### A-P0-1: Hardcoded 2% phantom fee inflates cash deduction on every BUY fill (live + paper)

- **Severity**: P0
- **Evidence**: `polybot-v2/src/execution/clob-router.ts:124-125` and `polybot-v2/src/execution/paper-simulator.ts:44-48`
- **Root cause**: Both the live router and the paper simulator hardcode `feeRate = 0.02` and compute `net_usdc = usdc_size + fee_usdc` for BUY orders. Polymarket's actual maker/taker fees are 0% (and CLOB sampling-poller correctly reads `taker_base_fee` / `maker_base_fee` from the API, both default 0 — see `sampling-poller.ts:131-133`). The engine then deducts `fill.net_usdc` from `entity.cash_balance` in `core/engine.ts:266` for BUYs, so a $5 order debits $5.10 from cash instead of $5.00. Over hundreds of fills this is structural cash drainage that the engine cannot account for through any other mechanism — there is no offsetting credit anywhere.
- **Impact**: For PROD's reported 40 positions at $5-$20 each, the phantom fee represents $4-$16 of unaccounted-for cash drainage already. In live mode (when the dual-flag is set) the fee is also added to the orders the CLOB does NOT actually charge — but the local DB and in-memory state still believe the cash was spent. Reconciliation against the on-chain wallet will show a persistent positive delta that the engine attributes to nothing.
- **Recommended fix**: Read `taker_fee` / `maker_fee` from `marketCache.get(order.condition_id)` in both router and simulator. For Polymarket (which uses 0%), default the fee to 0 if the market isn't found. Do NOT inflate `net_usdc` on BUY by a fabricated fee.
- **Effort**: S
- **REBUILD scope?**: No — surgical edit in two files
- **Skills cited**: agi-slippage-modeling

---

### A-P0-2: Stop-loss monitor is a no-op — `scan()` only returns ExitSignals, engine only logs them

- **Severity**: P0
- **Evidence**: `polybot-v2/src/core/engine.ts:130-137` and `polybot-v2/src/risk/stop-loss-monitor.ts:26-40`. The engine wires a `riskCheckInterval` that calls `stopLossMonitor.scan()`, then iterates `for (const exit of exits) log.info(...)`. The comment on line 133 literally says `// Process exits (would generate sell signals)`. There is no SELL order construction, no `clobRouter.routeOrder` invocation, no position closure call.
- **Root cause**: Stop-loss "processing" was never wired. The `ExitSignal` data type exists, the scan logic exists, the tier configs exist, but the action is missing.
- **Impact**: In live mode, every position that hits its stop loss, hard stop, or profit target stays open. The engine has no automated exit. Combined with A-P0-3 (position prices never refresh), this means the stop-loss subsystem is doubly broken.
- **Recommended fix**: Wire `exits` into a sell-order pipeline: build a SELL Signal at the current market price, run it through `riskEngine.evaluate()` (which needs to allow zero-edge SELLs as a special case for exits), then route. Better: short-circuit risk gates for exits — they're risk-reducing, not new risk.
- **Effort**: M
- **REBUILD scope?**: No — net new wiring inside the existing class
- **Skills cited**: agi-exit-strategies, agi-risk-management

---

### A-P0-3: Position `current_price` and `unrealized_pnl` are never updated; `updatePositionPrice` is dead code

- **Severity**: P0
- **Evidence**: `polybot-v2/src/storage/repositories/position-repo.ts:61-70` defines `updatePositionPrice`. Grep across `polybot-v2/src` shows ZERO callers. `engine.ts:213-215` has a comment-only loop: `for (const market of this.marketCache.getActive()) { /* prices already updated by poller via upsertFromSampling */ }` — the loop body is empty.
- **Root cause**: The position-side reconciliation step that should write each tick into `positions.current_price` is missing. Stop-loss-monitor.ts:43-46 reads `pos.current_price` and computes `pnlPct = (pos.current_price - pos.avg_entry_price) / pos.avg_entry_price`. Since `current_price` is set at fill time and never updated, `pnlPct` is always 0 (or close to 0), and stop-loss never triggers even if it were wired.
- **Impact**: (1) Stop loss never activates. (2) Profit target never activates. (3) Hard stop USD threshold never reached. (4) The dashboard's unrealized PnL is meaningless. (5) Snapshots compute `positions_value` from `cost_basis` (engine.ts:336), which masks losses on losing positions and overstates them on winning ones.
- **Recommended fix**: After each scan cycle, iterate `getAllOpenPositions()`, look up the current market price from `marketCache`, and call `updatePositionPrice(slug, condition_id, token_id, current_yes_or_no_price)` with the price for the SIDE of the position. Run on every cycle, or every 5 cycles for efficiency.
- **Effort**: S
- **REBUILD scope?**: No
- **Skills cited**: agi-portfolio-analytics

---

### A-P0-4: Resolution pipeline — Gamma `condition_ids` plural parameter is non-standard, response shape is unverified, and the `>0.95` price gate strands `resolution_pending` markets

- **Severity**: P0
- **Evidence**: `polybot-v2/src/risk/resolution-checker.ts:182` constructs URL with `chunk.map(id => 'condition_ids=${...}').join('&')`. Polymarket Gamma API (per `data-api-client.ts:52` and standard Polymarket docs) uses singular `condition_id` for a single market or numeric `id` for batched lookups; `condition_ids` (plural) repeated is non-standard. Then line 194 casts the JSON response as `GammaMarket[]` directly without checking shape — Gamma may return `{data: [...], next_cursor: ...}` for some endpoints. Then line 220 requires `price > 0.95` before considering a market resolved, but markets in `resolution_pending` may show ~0.5/0.5 prices and never escalate.
- **Root cause**: Three compounding hypotheses, all of which would manifest as PROD's 40 stuck positions:
  1. **Hypothesis A (URL parameter ignored)**: Gamma silently ignores unrecognized `condition_ids` repeated params and returns a default markets list. None of those markets match the prod position condition IDs. All 40 positions get `skipped_not_found++` every cycle.
  2. **Hypothesis B (response shape mismatch)**: Gamma returns `{data: [], next_cursor: null}`. The cast `as GammaMarket[]` typechecks but `for (const market of data)` either iterates an empty array silently or throws "object not iterable" which is caught and logged as "Gamma API bulk fetch failed".
  3. **Hypothesis C (resolution_pending stall)**: Even if the request works, markets that have stopped trading but haven't UMA-settled return `closed: true` with prices at 0.50/0.50, which `parseGammaResolution` sees no winner > 0.95 and returns null. The condition is logged once at debug level and never retried with a better strategy.
- **Impact**: PROD positions cannot resolve. Cash cannot be credited. The engine cannot place new trades because it has no cash. The system is functionally dead. The user is observing exactly this behavior.
- **Recommended fix**: (i) Switch to per-market Gamma lookups using the canonical singular parameter (single condition_id per request, with concurrency limit ~10). (ii) Validate response shape: if `Array.isArray(data)`, use it; else use `data.data ?? []`. (iii) For markets that are `closed: true` but lack a clear winner, fall back to the Polymarket Data API's `redeemable` flag, which is the on-chain truth source. (iv) Log every skip reason at INFO level so the failure mode is immediately visible.
- **Effort**: M
- **REBUILD scope?**: No — replace the bulk-fetch implementation in resolution-checker.ts
- **Skills cited**: polymarket-official-agent, polymarket-trading-expert, obra-systematic-debugging

---

### A-P0-5: v1 `auto_redeem.py` cron silently drains the on-chain wallet that v2 thinks it owns (R-6)

- **Severity**: P0
- **Evidence**: `Polymarket/auto_redeem.py:138-143` queries `https://data-api.polymarket.com/positions?user={wallet_address}` and filters on `redeemable: true`. Then `auto_redeem.py:245-289` calls `NegRiskAdapter.redeemPositions(condition_id, [yes_amount, no_amount])` on-chain, converting CTF tokens to USDC and sending to the wallet. There is no notification to v2's database — v2's `positions` table still shows `status='open'`.
- **Root cause**: Two trading systems share one wallet with no shared state. v1 uses Data API + on-chain redemption (the authoritative source). v2 uses Gamma API + a SQLite DB it manages independently. When v1 redeems, v2's view of `positions` and `entity.cash_balance` becomes wrong by exactly the redeemed amount.
- **Impact**: Cash discrepancy between DB and wallet grows monotonically as v1 redeems markets v2 doesn't know about. v2's risk gates think it has $2.49 of cash; the actual on-chain wallet may have significantly more from v1's redemptions. Worse: when v2 eventually tries to resolve those same positions via Gamma, it cannot — the tokens are already gone from the wallet, and even if the resolution succeeds in v2's logic, v2 will credit "payout" that v1 already collected, double-counting the win.
- **Recommended fix**: Two paths: (a) **Disable v1 cron immediately** during the rebuild and let v2 own redemption end-to-end. (b) Have v2's resolution-checker, instead of waiting for Gamma `closed && >0.95`, query Polymarket Data API's `/positions?user={wallet}` and reconcile against `getAllOpenPositions()`: any DB position not in the Data API positions list (or marked `redeemable: true`) should be force-closed and its payout credited from the wallet's USDC delta. This is the actual reconciliation R-6 demands.
- **Effort**: M (path b) or S (path a, but only buys time)
- **REBUILD scope?**: Yes — resolution-checker rewrite
- **Skills cited**: polymarket-official-agent, obra-defense-in-depth

---

### A-P0-6: Position-sizer applies strategy weight (up to 2.0x) AFTER the per-position cap, doubling the effective cap

- **Severity**: P0
- **Evidence**: `polybot-v2/src/risk/position-sizer.ts:41-60`. Line 41-53 caps `sizeUsd` to `pctCap` and `max_position_usd`. Then line 56-59 multiplies by `stratWeight = strategyWeighter.getWeight(...)`. `strategy-weighter.ts:91` allows `boost = Math.min(2.0, 1.0 + (win_rate - 60) / 100)`, so `stratWeight` can be 2.0.
- **Root cause**: Cap is applied first, then the multiplier. Order is reversed.
- **Impact**: A "proven" strategy can double the per-position cap. If `max_position_usd = 20`, a proven strategy can place a $40 position, breaching the declared limit. In R&D mode (where weighting is enabled), this is ongoing; in PROD mode, weighting is disabled (engine.ts:62-63) so this is dormant — but the moment PROD enables performance weighting, the cap silently doubles.
- **Recommended fix**: Apply the weight BEFORE the cap, OR clamp `sizeUsd = min(sizeUsd * stratWeight, pctCap, max_position_usd)` after the multiply.
- **Effort**: S
- **REBUILD scope?**: No
- **Skills cited**: agi-position-sizing, agi-risk-management

---

### A-P0-7: `value` and `skew` and `complement` strategies fabricate `edge` and `model_prob` from arithmetic on the market price

- **Severity**: P0
- **Evidence**:
  - `polybot-v2/src/strategy/custom/value.ts:64-65`: `edge: payoff * 0.1, model_prob: price + 0.05`. Both arbitrary.
  - `polybot-v2/src/strategy/custom/skew.ts:57-58`: `edge: up * 0.5, model_prob: up * 1.5`. Both arbitrary.
  - `polybot-v2/src/strategy/custom/complement.ts:88-89`: `edge: profitPct, model_prob: 0.95`. The 0.95 is hardcoded regardless of YES price.
  - `polybot-v2/src/strategy/custom/convergence.ts:75`: `edge: (1 - cp) * 0.5` — overstated by ~10x relative to the actual model assumption (`model_prob - market_price`).
- **Root cause**: These strategies were ported from v1 with their original "edge" calculations preserved. None compute `edge = model_prob - market_price`. The risk-engine's `min_edge_threshold` check (risk-engine.ts:50) is therefore evaluating a fabricated number against a real threshold — most signals trivially pass the gate, which means the gate provides no protection from these strategies. Position sizer's Kelly formula then uses the fake `model_prob` to size aggressively.
- **Impact**: In paper this generates noisy paper trades that pollute the R&D performance database; the strategy-advisor will see them as "underperforming" (because random bets lose to edge-eating) and downweight them, but only after enough resolutions accumulate. In live mode, these strategies will systematically destroy capital because Kelly sizing on a fabricated edge is a one-way ticket to ruin.
- **Recommended fix**: For each strategy, rewrite the model: define a real `model_prob` (based on data) and emit `edge = model_prob - market_price`. If no real model is available, the strategy should not exist — disable it.
- **Effort**: L (requires actually building models for each strategy)
- **REBUILD scope?**: Yes — these belong in the rebuild
- **Skills cited**: agi-strategy-framework, agi-walk-forward-validation, agi-kelly-criterion

---

### A-P0-8: `complement` strategy is not arbitrage — it only buys YES, so it's a directional bet with a false 0.95 model_prob

- **Severity**: P0
- **Evidence**: `polybot-v2/src/strategy/custom/complement.ts:78-104`. The strategy detects when `yes_price + no_price < 0.96` (a real arb signal) but only emits ONE signal, for the YES side, with `model_prob: 0.95`. The comment at line 100-101 admits: `// Note: ideally we'd also buy NO side simultaneously / For v2.0 we signal YES; the NO side arb is a future enhancement`.
- **Root cause**: Single-signal API. Strategies emit `Signal[]` and the engine processes one signal per market gate. There's no atomic "both sides" execution path. The author shipped half the arb and called it done.
- **Impact**: Every "arb" position is actually a 50/50 directional bet on YES with a fictitious 0.95 confidence, sized aggressively by Kelly. When YES loses (statistically half the time), the position is a complete loss. Complement is one of the worst capital destroyers in the strategy suite.
- **Recommended fix**: Extend the strategy interface to allow paired-execution signals (atomic two-leg orders), or have complement emit both YES and NO signals with metadata linking them, and add an "arb pair" handler in the engine that only fills both-or-neither.
- **Effort**: M
- **REBUILD scope?**: Yes
- **Skills cited**: agi-strategy-framework, agi-risk-management

---

### A-P0-9: Live order ID is NULL at insert; `updateOrderStatus(null, ...)` updates nothing; live orders sit at status='pending' forever

- **Severity**: P0
- **Evidence**: `polybot-v2/src/execution/order-builder.ts:39`: `order_id: isPaper ? 'paper_${nanoid(12)}' : null`. `polybot-v2/src/execution/clob-router.ts:26` calls `insertOrder(order)` with order_id=null. Lines 39, 63 then call `updateOrderStatus(order.order_id!, 'filled', fill.size)` with a `!` non-null assertion that is a lie. The CLOB returns its own order ID in `result.order_id` (line 233) but it's only stored in `fill.trade_id`, not on the parent `Order` row. So `updateOrderStatus(null, ...)` runs an UPDATE WHERE order_id IS null, which matches every NULL-id row in the orders table — meaning it could mass-update all NULL orders, OR update zero rows.
- **Root cause**: Live order ID lifecycle was never wired. Order is inserted before submit, then submit returns the actual ID, then nothing reattaches.
- **Impact**: (1) `orders.status` for live orders never advances past 'pending'. (2) `getOpenOrders(slug)` (used by `risk-engine.ts:84` for the max_open_orders gate) returns all the dead 'pending' orders forever, causing the gate to lock the entity once it accumulates `max_open_orders` (default 5) live orders. (3) The orders table accumulates indefinitely, and dashboards can't reconcile orders to fills.
- **Recommended fix**: Generate a local order_id (`nanoid`) at build time for both paper AND live, use it as the primary key, and store the CLOB-returned ID in a separate `clob_order_id` column.
- **Effort**: S
- **REBUILD scope?**: No
- **Skills cited**: polymarket-official-agent

---

### A-P0-10: Sampling-poller hardcodes tokens[0]=YES with no validation against the outcome name

- **Severity**: P0 (if real)
- **Evidence**: `polybot-v2/src/market/sampling-poller.ts:100-117`. The parser builds `yesToken` from `tokens[0]` and `noToken` from `tokens[1]` blindly, hardcoding `outcome: 'Yes'` and `'No'` regardless of what the API returns. The `RawMarket.tokens` interface (line 172-176) doesn't even include an outcome field on the token.
- **Root cause**: Trust in implicit ordering. Polymarket APIs do not document a guarantee that tokens[0] is always YES.
- **Impact**: If Polymarket ever returns tokens in a different order for any market, every strategy that reads `m.yes_price` and `m.no_price` will buy the wrong side. Favorites would buy the longshot. Longshot would buy the favorite (cancelling its own thesis). Etc. This is a silent catastrophic flip across the entire engine.
- **Recommended fix**: Read the `outcome` field from each token (it exists in the actual Polymarket API, just not in the local interface) and explicitly map `outcome === 'Yes' || 'YES' || 'yes'` → yesToken. Default to tokens[0]=YES only after a runtime warning if the outcome field is missing.
- **Effort**: S
- **REBUILD scope?**: No
- **Skills cited**: obra-defense-in-depth, polymarket-official-agent

---

## P1 Findings (high-priority correctness)

### A-P1-1: Strategy weighter "average of subs" fallback contaminates a brand-new sub-strategy with sibling performance

- **Severity**: P1
- **Evidence**: `polybot-v2/src/risk/strategy-weighter.ts:39-44`. When neither exact key nor parent key is found, the code averages all weights for any sub of the same parent strategy. If `longshot.systematic_fade` has weight 2.0 (proven) and `longshot.bucketed_fade` has weight 0.25 (no data), and a brand-new `longshot.news_overreaction_fade` is queried, the fallback returns `(2.0 + 0.25) / 2 = 1.125` — effectively granting the new sub a "promising" tier without ever placing a trade.
- **Root cause**: The averaging path is meant as a sane default but conflates unrelated sub-strategies. Sub-strategies in the same parent can have wildly different signal logic; their performance is not transferable.
- **Impact**: Brand-new sub-strategies get sized up aggressively based on unrelated siblings' performance. This is data leakage from one strategy to another.
- **Recommended fix**: Replace the average with the global default (0.25). Or only fall back to the average if all subs have ≥10 resolutions each (i.e., the average is a real signal, not noise).
- **Effort**: S
- **Skills cited**: agi-walk-forward-validation, agi-position-sizing

---

### A-P1-2: Strategy weighter's in-memory map has cross-entity contamination (last-write-wins)

- **Severity**: P1
- **Evidence**: `polybot-v2/src/risk/strategy-weighter.ts:75-114`. The map key is `${strategy_id}|${sub_strategy_id}` with NO entity_slug. But `getStrategyPerformance()` returns rows keyed by `(strategy_id, sub_strategy_id, entity_slug)` (per `v_strategy_performance` view at `schema.ts:387-411`). When the loop processes multiple entities' rows with the same (strategy, sub) combination, each `newWeights.set(key, ...)` overwrites the previous one. The final stored weight is whichever entity's row was iterated last — non-deterministic.
- **Root cause**: Missing entity dimension in the cache key.
- **Impact**: When R&D engine has 16 entities, the strategy weighter for each entity reads a single global weight that's actually one random entity's data. An entity that has never traded a strategy can inherit another entity's poor (or excellent) performance and be sized accordingly.
- **Recommended fix**: Make the key `${strategy_id}|${sub_strategy_id}|${entity_slug}` and require the lookup to pass entity_slug. Or, sum/average across entities deliberately (and document the choice).
- **Effort**: S
- **Skills cited**: obra-root-cause-tracing

---

### A-P1-3: Cash deduction race window — engine restart between fill and DB persist loses the cash deduction

- **Severity**: P1
- **Evidence**: `polybot-v2/src/core/engine.ts:259-285`. After `clobRouter.routeOrder` returns a fill, the engine calls `processPosition(fill)` which calls `upsertPosition(...)` (DB write), then computes `newCash = entity.cash_balance - fill.net_usdc` and calls `entityManager.updateBalances(slug, newCash, ...)` which calls `updateEntityBalances` (separate DB write). These are TWO separate transactions with no atomic boundary.
- **Root cause**: No transaction wrapping. A SIGTERM or crash between the upsertPosition and updateBalances would leave the position in the DB but the cash unchanged. On restart, the entity reloads cash from DB (entity-manager.ts:47) and the engine sees the position as if it were free.
- **Impact**: Rare in steady state, but reliably triggers on every shutdown that happens mid-cycle. Compounds over restarts: positions accumulate, cash stays high, engine over-trades.
- **Recommended fix**: Wrap the post-fill processing in a single SQLite transaction (`better-sqlite3` supports `db.transaction(() => { ... })` synchronously). All DB writes from a single fill must commit atomically.
- **Effort**: S
- **Skills cited**: obra-systematic-debugging

---

### A-P1-4: Trading_balance is not recalculated on resolution credit, but IS recalculated on BUY/SELL fills — inconsistent

- **Severity**: P1
- **Evidence**: `polybot-v2/src/core/engine.ts:197-208` (resolution credit) passes `entity.trading_balance` unchanged. Lines 264-272 (BUY) and 273-282 (SELL) compute `newCash * config.risk.trading_ratio`. So after a win, trading_balance stays at its old value; after a buy, trading_balance shrinks proportionally; after a sell, it grows proportionally. Three different behaviors.
- **Root cause**: Three separate ad-hoc updates to balances rather than a single derive-from-cash function.
- **Impact**: After a string of wins, trading_balance lags actual cash, capping the engine's effective sizing budget below what it could legitimately trade. After a string of losses then wins, trading_balance and cash drift apart.
- **Recommended fix**: Centralize: any change to cash should trigger `trading_balance = cash * trading_ratio` and `reserve_balance = cash * reserve_ratio` (or the opposite if reserve is fixed). Pick a single rule and apply it uniformly.
- **Effort**: S
- **Skills cited**: obra-defense-in-depth

---

### A-P1-5: `daily-loss-guard` triggers lockout even when `daily_loss_lockout_usd === 0` (intended-disabled)

- **Severity**: P1
- **Evidence**: `polybot-v2/src/risk/daily-loss-guard.ts:30`: `if (updatedEntity.daily_pnl <= -this.limits.daily_loss_lockout_usd && !updatedEntity.is_locked_out)`. There is no guard `if (this.limits.daily_loss_lockout_usd > 0)`. By contrast, `risk-engine.ts:61` correctly guards: `if (this.limits.daily_loss_lockout_usd > 0 && entity.daily_pnl <= -this.limits.daily_loss_lockout_usd)`.
- **Root cause**: Two callers, two guards, inconsistent enforcement.
- **Impact**: If a user sets `daily_loss_lockout_usd = 0` to DISABLE the limit, the guard interprets it as "lock out at any non-zero loss". The first $0.01 loss bricks the entity for the day.
- **Recommended fix**: Add the `> 0` guard to `daily-loss-guard.ts:30`.
- **Effort**: S
- **Skills cited**: obra-defense-in-depth

---

### A-P1-6: Order-builder hardcodes 0.01 tick size and clamps to 0.01-0.99 — incorrect for tighter-tick markets

- **Severity**: P1
- **Evidence**: `polybot-v2/src/execution/order-builder.ts:31-32`. `roundToTick(price, 0.01)` ignores per-market `minimum_tick_size` (which is read by sampling-poller.ts:131 and stored on every market). Markets with 0.001 tick get rejected by Polymarket as unrounded; markets at 0.001-0.009 prices get clamped to 0.01.
- **Impact**: Live orders for tight-tick or extreme-price markets fail or are mispriced. Specifically, longshot strategy candidates (~$0.02-$0.20) and convergence strategy candidates (~$0.93-$0.99) skirt the clamp boundaries.
- **Recommended fix**: Look up `marketCache.get(condition_id)?.minimum_tick_size` and use it. Default to 0.01 only if missing.
- **Effort**: S
- **Skills cited**: polymarket-official-agent

---

### A-P1-7: `v_strategy_performance` view starts FROM trades, so strategies that have never traded never appear

- **Severity**: P1
- **Evidence**: `polybot-v2/src/storage/schema.ts:386-391`. The base subquery is `SELECT ... FROM trades WHERE strategy_id IS NOT NULL GROUP BY ...`. Then resolutions and positions are LEFT JOINed onto trade rows.
- **Root cause**: Trades-first design. A registered strategy that has emitted signals but never placed a fill has zero rows in the view.
- **Impact**: (1) Strategy-advisor cannot enable a strategy that has never traded, even if R&D has resolutions for it (which is impossible since resolutions imply trades, but the structural issue remains). (2) More problematically, if all trades for a strategy were placed before sub_strategy_id was added in the migration, those trades have NULL sub_strategy_id and group as one row, masking sub-strategy granularity. (3) The advisor cannot "wake up" a never-traded sub-strategy.
- **Recommended fix**: Build the view starting FROM a UNION of (strategy_id, sub_strategy_id) keys gathered from BOTH trades AND signals. Or use `FROM (SELECT DISTINCT strategy_id, sub_strategy_id FROM signals WHERE strategy_id IS NOT NULL)`. The strategy registry could also seed the view via a periodic maintenance job.
- **Effort**: M
- **Skills cited**: agi-portfolio-analytics

---

### A-P1-8: Multiple longshot sub-strategies fire on the same market, multiplying position size

- **Severity**: P1
- **Evidence**: `polybot-v2/src/strategy/custom/longshot.ts:54-128`. For a market with tail in the 10-20¢ range, ALL THREE sub-strategies (`systematic_fade`, `bucketed_fade`, `news_overreaction_fade`) fire and emit three separate signals on the same condition_id with the same fade side. Each is dedup'd by `${sub}:${condition_id}` so they don't collide. The risk-engine then processes each signal independently.
- **Root cause**: Per-sub dedup, no per-market dedup at the parent level.
- **Impact**: Three positions get opened on the same fade outcome, each sized independently. Total exposure is 3x the per-position cap. The `getOpenPositionCount` gate in risk-engine doesn't catch this because each is an open position counted separately, but the `max_positions=40` cap is consumed three times faster.
- **Recommended fix**: Either (a) track existing positions per (entity, condition_id) and skip if any exist, OR (b) decide which sub takes precedence and only emit one signal per market.
- **Effort**: S
- **Skills cited**: agi-position-sizing

---

### A-P1-9: Favorites `compounding` and `fan_fade` boundary collision at 0.85-0.92

- **Severity**: P1
- **Evidence**: `polybot-v2/src/strategy/custom/favorites.ts:62` (`compounding`: 0.50-0.92) and line 102 (`fan_fade`: 0.85-0.92, exclusive at 0.92 because `< 0.92`). For favorite_price ∈ [0.85, 0.92), BOTH compounding and fan_fade fire — and they take OPPOSITE sides (compounding buys the favorite, fan_fade buys the underdog). Each has its own dedup key so they don't collide.
- **Root cause**: Overlapping price ranges with no precedence.
- **Impact**: For markets in the 85-92% range, the engine simultaneously buys both sides of the same market (favorite via compounding, underdog via fan_fade) — except that fan_fade is on a DIFFERENT (opposite) outcome and gets its own dedup, so both fire. Net effect: a synthetic complement-arb with no profit guarantee.
- **Recommended fix**: Make the ranges disjoint: compounding 0.50-0.85, fan_fade 0.85-0.92. Or document that they intentionally overlap (which is hard to defend).
- **Effort**: S
- **Skills cited**: agi-strategy-framework

---

### A-P1-10: Skew strategy has no `hours_to_resolve` filter — buys 3-15¢ underdogs in markets weeks away from resolution

- **Severity**: P1
- **Evidence**: `polybot-v2/src/strategy/custom/skew.ts:35-69`. Compare to favorites/value/convergence which all check `hoursToResolve` bounds. Skew has no time gate.
- **Root cause**: Missing filter.
- **Impact**: Capital is locked up in long-duration underdog positions where the price has weeks to drift further down before any settlement.
- **Recommended fix**: Add `hoursToResolve <= 48 && hoursToResolve >= 0` filter.
- **Effort**: S
- **Skills cited**: agi-strategy-framework

---

### A-P1-11: Skew and longshot are systematically opposed on the same markets

- **Severity**: P1
- **Evidence**: `skew.ts:41-44` buys the underdog when favorite >85% (i.e., underdog in 3-15¢). `longshot.ts:39-46` does the OPPOSITE: buys the favorite (fade side) when tail is in 2-20¢. For a market with favorite at 0.86 and underdog at 0.14, BOTH strategies fire, with skew buying the underdog and longshot buying the favorite. Net: two opposing positions in the same market, paying both directions.
- **Impact**: Capital wasted, no thesis is right. Effectively a worse complement arb (with a real cost: cap exhausted on both sides).
- **Recommended fix**: Pick one thesis. Either "fade longshots" (longshot strategy) or "fade favorites" (skew strategy) — they cannot both be alpha. One is wrong.
- **Effort**: M (requires research)
- **Skills cited**: agi-strategy-framework, agi-walk-forward-validation

---

### A-P1-12: No idempotency on order submission; network retry can double-submit

- **Severity**: P1
- **Evidence**: `polybot-v2/src/execution/clob-router.ts:25-67`. There's no idempotency key passed to `client.placeOrder`. The `submitToClob` function constructs a fresh `nanoid` for `trade_id` on every call. If the network fails after the CLOB accepts the order but before the response returns, a retry would create a NEW order with a NEW trade_id and the CLOB would happily accept the duplicate.
- **Root cause**: No client-side dedup; no idempotency-key header.
- **Impact**: Live mode duplicate fills on transient network errors.
- **Recommended fix**: Generate a deterministic idempotency key from (entity_slug, condition_id, token_id, signal_id, submitted_at_minute) and pass it as a header (if Polymarket supports it) or as a local lock that prevents re-submission of the same key for N minutes.
- **Effort**: M
- **Skills cited**: polymarket-official-agent

---

### A-P1-13: No kill switch — once dual-flag is set, every approved order goes live with no runtime override

- **Severity**: P1
- **Evidence**: `polybot-v2/src/config/loader.ts:55-68` performs the dual-flag check ONCE at startup. After that, `entity.config.mode === 'live'` is the only check, set on the `EntityState` in memory. There is no in-memory "halt all trading" flag, no SIGTERM handler that cancels in-flight orders, no per-cycle authorization check.
- **Root cause**: Static gate, no dynamic kill.
- **Impact**: An operator who realizes a bug is happening cannot stop the engine without `kill -9`, and `kill -9` does NOT stop in-flight CLOB orders that have been signed and broadcast. SIGTERM handling at engine.stop() does clearInterval but does not abort an in-flight `await this.clobRouter.routeOrder(...)`.
- **Recommended fix**: Add a `KillSwitch` singleton with a boolean. Check it at the top of `routeOrder`. Add a CLI command and a dashboard endpoint to flip it. Document SIGUSR1 → kill-switch as the standard halt mechanism.
- **Effort**: M
- **Skills cited**: agi-risk-management

---

## P2 Findings (correctness improvements)

### A-P2-1: Resolution-checker chunk size is 50 but the URL `&limit=50` may conflict with multiple `condition_ids` params

- **Severity**: P2
- **Evidence**: `resolution-checker.ts:183`. If Gamma applies `limit=50` to its default response and ignores the repeated `condition_ids` params (per A-P0-4 hypothesis A), the response has 50 unrelated markets and the lookup fails.
- **Recommended fix**: Remove the `limit=` parameter; let the API return what it matches.
- **Effort**: S

### A-P2-2: `parseGammaResolution` requires winner price > 0.95 — too tight for markets that resolved at 0.85+

- **Severity**: P2
- **Evidence**: `resolution-checker.ts:220`. After UMA settlement the winning side should be at exactly 1.0, but stale Gamma cache may show 0.85-0.95.
- **Recommended fix**: Lower the threshold to >0.5 once `closed === true`, or check `umaResolutionStatuses` field directly.
- **Effort**: S

### A-P2-3: Schema CHECK on `positions.side IN ('YES','NO')` blocks multi-outcome positions (R-4)

- **Severity**: P2
- **Evidence**: `schema.ts:156`. Although the `resolutions` table CHECK was removed in a prior migration, the `positions` CHECK remains. Any attempt to insert a multi-outcome position fails with a constraint violation, which is silently caught somewhere.
- **Impact**: v2 cannot trade multi-outcome markets at all. The strategies that "support" them (commented as such in convergence.ts:6 `partition: deferred — needs multi-outcome support`) are dead code on this constraint.
- **Recommended fix**: Drop the CHECK constraint and store the outcome name as a free-form string. Validate at the app layer.
- **Effort**: S

### A-P2-4: `didPositionWin` falls back to side-name comparison for binary markets but silently mis-settles multi-outcome legacy positions

- **Severity**: P2
- **Evidence**: `resolution-checker.ts:241-248`. If `winningTokenIds.size === 0` OR `tokenId` is missing, the fallback compares `positionSide.toUpperCase() === winningOutcome.toUpperCase()`. For a multi-outcome market with winner "Trump" and a position with side "YES", returns false → settled as LOSS.
- **Recommended fix**: Make the fallback explicit: if no token_id match AND market is multi-outcome, log a warning and skip settlement, do not silently lose.
- **Effort**: S

### A-P2-5: `INSERT OR IGNORE` on trades table relies on `tx_hash UNIQUE`, which is null for paper trades — no idempotency for paper

- **Severity**: P2
- **Evidence**: `trade-repo.ts:9` and `schema.ts:122`. `tx_hash UNIQUE` allows multiple NULLs in SQLite. Paper trades have `tx_hash = null` and are not deduplicated.
- **Recommended fix**: Add a UNIQUE on (entity_slug, signal_id) or (trade_id) to provide idempotency.
- **Effort**: S

### A-P2-6: Snapshots compute `positions_value` from `cost_basis`, masking unrealized PnL

- **Severity**: P2
- **Evidence**: `engine.ts:336`. Should be `cost_basis + unrealized_pnl` or `current_price * size`.
- **Impact**: Total equity in snapshots understates wins and overstates losses by the unrealized delta — but since A-P0-3 means unrealized_pnl is always 0, the practical impact is muted.
- **Recommended fix**: After fixing A-P0-3, also fix this to use `current_price * size`.
- **Effort**: S

### A-P2-7: Resolution-checker invokes `markMarketClosed(conditionId)` per position, not per market — N+1 redundancy

- **Severity**: P2
- **Evidence**: `resolution-checker.ts:122` inside the `marketPositions` loop. Should be once per market after the loop.
- **Recommended fix**: Hoist outside the inner loop.
- **Effort**: S

### A-P2-8: `getOpenPositions` orders by `m.end_date ASC NULLS LAST` but SQLite does not support `NULLS LAST` syntax in older versions

- **Severity**: P2
- **Evidence**: `position-repo.ts:45`. better-sqlite3 ships with a recent SQLite, so this should work, but it's a portability gotcha.
- **Recommended fix**: Use `ORDER BY (m.end_date IS NULL), m.end_date ASC, p.opened_at DESC` for portability.
- **Effort**: S

### A-P2-9: `min_edge_threshold` check uses `Math.abs(signal.edge)` — allows negative-edge signals through

- **Severity**: P2
- **Evidence**: `risk-engine.ts:50`. A signal with `edge = -0.10` (negative expected value) passes the check because `|−0.10| = 0.10 > 0.02`.
- **Impact**: Sell-edge signals or buggy strategies that emit negative edge get approved.
- **Recommended fix**: `if (signal.edge < this.limits.min_edge_threshold)` (no abs).
- **Effort**: S

### A-P2-10: Market price clamp at 0.01-0.99 excludes Polymarket's allowed 0.001-0.999 range

- **Severity**: P2
- **Evidence**: `order-builder.ts:32` and `paper-simulator.ts:34`. Polymarket allows extreme prices for unlikely outcomes.
- **Recommended fix**: Clamp to 0.001-0.999 (or read from market metadata).
- **Effort**: S

---

## P3 Findings (cleanup, hardening)

### A-P3-1: Unused private field — `private clobBaseUrl` in clob-router never read after constructor stores it

- **Severity**: P3
- **Evidence**: `clob-router.ts:22, 81`. Stored but `ClobClientWrapper` is constructed with it as `host`, then never used elsewhere. Minor.

### A-P3-2: Engine.runScanCycle has an empty for loop with a comment, dead code

- **Severity**: P3
- **Evidence**: `engine.ts:213-216`. The loop body is just a comment.
- **Recommended fix**: Delete; or wire A-P0-3's price update here.

### A-P3-3: `getOpenPositions` doesn't accept a status filter, hardcoded `'open'`

- **Severity**: P3
- **Evidence**: `position-repo.ts:38-47`. Minor; restricts reusability.

### A-P3-4: `bid_premium_pct` default of 2% is too aggressive for tight markets

- **Severity**: P3
- **Evidence**: `config/schema.ts:39`. Combined with the 2% phantom fee bug, BUYs cost +4% over the actual price. Compounds A-P0-1.

### A-P3-5: Strategy-advisor's `lastCheck` throttle (line 49) and the engine's `setInterval` (line 145) both throttle — double throttle

- **Severity**: P3
- **Evidence**: `strategy-advisor.ts:49` returns early if called within `check_interval_ms`, and engine.ts:145 wraps in `setInterval(check_interval_ms)`. Defensive, but means an extra call from the initial 10s timeout (engine.ts:151) is the only one that bypasses, then the interval throttle kicks in.

### A-P3-6: `nanoid` import in three different files; consolidate into a `utils/id.ts`

- **Severity**: P3 — cosmetic.

---

## Position Resolution Pipeline Deep Dive (R-1 through R-10)

### R-1: Is `risk/resolution-checker.ts` actually invoked in the engine scan loop?

**Yes — invoked every scan cycle, but throttled internally to 2-min cadence.**

Evidence: `core/engine.ts:196-211` — the very first `try` block in `runScanCycle()` calls `await this.resolutionChecker.checkResolutions(callback)`. The callback updates entity cash via `entityManager.updateBalances` and records the PnL via `dailyLossGuard.recordPnl`. So if the engine cycles, the resolution checker is called.

**However**, `resolution-checker.ts:33,40-41`:
```ts
private checkIntervalMs = 120_000; // 2 minutes
async checkResolutions(...) {
  const now = Date.now();
  if (now - this.lastCheck < this.checkIntervalMs) return;
  this.lastCheck = now;
```
So calls within 2 minutes are no-ops. With `scan_interval_ms` defaulting to 300,000 (5 min), every scan cycle triggers an actual check. With aggressive scan intervals (e.g., 60s), only every other cycle does.

**Verdict**: R-1 is not the cause of the stall. The checker IS running.

---

### R-2: Does the resolution checker query ALL prod's open positions on every cycle?

**Yes for the position list, but the Gamma API call is suspicious.**

Evidence: `resolution-checker.ts:43` — `getAllOpenPositions()` returns ALL open positions globally with no entity filter, no pagination, no limit. For 40 positions this is fine.

The Gamma API call at line 178-203 chunks 50 condition_ids per request. For 40 positions this is one request. **The chunking logic is fine; the query parameter shape is the issue (see R-3 / A-P0-4).**

`fetchGammaMarkets` parses the response as `await response.json() as GammaMarket[]` and then `for (const market of data) { if (market.conditionId) map.set(market.conditionId, market); }`. **If Gamma returns `{data: [...], next_cursor: ...}` instead of a flat array, `for...of` throws and the catch logs "Gamma API bulk fetch failed". If Gamma returns a flat list of 50 default markets (because it ignored the unrecognized `condition_ids` plural param), `map` is populated with 50 unrelated markets and ALL of prod's positions get `skipped_not_found++`.**

**Verdict**: R-2 — the position list is queried correctly, but the response handling has zero shape validation and zero error visibility beyond "fetch failed".

---

### R-3: What field/state does the resolution checker filter on?

**`gammaMarket.closed === true` plus `outcomePrices[i] > 0.95` to find a winner.**

Evidence: `resolution-checker.ts:74` (`if (!gammaMarket.closed) { skipped_not_closed++; continue; }`) and lines 207-228 (`parseGammaResolution`).

`closed: true` in Polymarket Gamma terms means "trading has stopped." It does NOT mean "UMA-settled." A market in `resolution_pending` will have `closed: true` and `outcomePrices` may be stale at the last trading price (e.g., 0.50/0.50). The `> 0.95` check then fails and `parseGammaResolution` returns null, the position is logged at debug level as "Closed market but no clear winner", and the loop continues — **forever, with no retry strategy, no escalation, no fallback**.

**Verdict**: R-3 — `closed` is a necessary but insufficient filter. The price gate is too strict for stale Gamma data. This alone could explain the stall for any subset of positions in `resolution_pending` state.

---

### R-4: Multi-outcome market handling

**Schema-blocked at the `positions` table, partial at the resolutions table, silent mis-settlement risk for legacy data.**

Evidence: `schema.ts:156` — `positions.side TEXT NOT NULL CHECK(side IN ('YES','NO'))`. Multi-outcome positions cannot be inserted via `upsertPosition`; the constraint violation throws and is caught/logged in the engine's strategy evaluation try/catch.

`schema.ts:181-203` — the `resolutions` table has NO CHECK constraint on `position_side` (correct, the prior session's removal applies here). So writing a resolution for a multi-outcome winner is fine.

`resolution-checker.ts:241-248` (`didPositionWin`):
```ts
if (winningTokenIds.size > 0 && tokenId) return winningTokenIds.has(tokenId);
return positionSide.toUpperCase() === winningOutcome.toUpperCase();
```
The PRIMARY path (token_id match) works for multi-outcome correctly. The FALLBACK path (side-name match) returns false silently for multi-outcome positions where the winner is "Trump" and the side is "YES" — the position is recorded as a LOSS even if it should have won.

**Verdict**: R-4 — Resolution checker handles multi-outcome correctly via token_id match, IF the token_id is populated. Legacy positions (pre-migration) without token_id get silently mis-settled. Worse, the positions table CHECK still blocks NEW multi-outcome positions from being recorded at all.

---

### R-5: Cash credit on resolution win

**The credit IS atomic with the in-memory and DB balance update; this is NOT the cause of the stall.**

Evidence: `resolution-checker.ts:118-120`:
```ts
if (payout > 0) {
  updateEntityCash(pos.entity_slug, payout);
}
```
Calls into the engine.ts callback at `engine.ts:197-208`:
```ts
this.entityManager.updateBalances(slug, entity.cash_balance + payout, entity.reserve_balance, entity.trading_balance);
```
Which calls `entity-manager.ts:124-138`:
```ts
entity.cash_balance = cash;  // in-memory
entity.reserve_balance = reserve;
entity.trading_balance = trading;
...
updateEntityBalances(slug, cash, reserve, trading, hwm);  // DB write
```
Both updates happen in sequence. The next scan cycle reads `entity.cash_balance` from the in-memory map and gets the updated value. After a restart, the DB row is read and the in-memory state is rebuilt with the updated cash.

**However**, A-P1-4 notes the `trading_balance` is NOT recomputed here, so subsequent BUY sizing reads a stale `trading_balance`. The cash IS credited. The issue is downstream sizing.

Also: `payout = won ? pos.size : 0` at line 92. `pos.size` is the share count BEFORE `closePosition` zeroes it. `closePosition` is called at line 116 AFTER the read at line 92. So the payout calculation reads the correct size.

**Verdict**: R-5 — Cash credit IS correctly applied. The bug is in `trading_balance` consistency (P1) and in the resolution NEVER FIRING in the first place (P0).

---

### R-6: Wallet-state-vs-DB-state divergence due to v1 `auto_redeem.py` cron

**Confirmed real and severe.** See **A-P0-5**.

`auto_redeem.py:138-143` queries `https://data-api.polymarket.com/positions?user={wallet}` for `redeemable: true`, then calls `NegRiskAdapter.redeemPositions` on-chain. The on-chain redemption converts CTF tokens to USDC and sends to the wallet. **v2 has no awareness of this happening.**

This is the most plausible root cause of PROD's symptom: v1 has been redeeming positions for weeks while v2's resolution-checker has been failing to process them via Gamma. The on-chain wallet has received USDC; v2's DB shows positions still open and cash still at $2.49.

**Recommendation**: Until rebuild, **disable the v1 auto_redeem cron immediately**. Otherwise the on-chain wallet and v2 DB drift permanently.

**Verdict**: R-6 — Almost certainly the proximate cause of the stall, and a structural integrity issue regardless of resolution-checker fixes.

---

### R-7: `v_strategy_performance` view correctness

**The view starts FROM trades and LEFT JOINs resolutions, NOT the other way around.** See A-P1-7.

`schema.ts:386-391`:
```sql
FROM (
  SELECT strategy_id, COALESCE(sub_strategy_id, '') AS sub_strategy_id, entity_slug,
         COUNT(*) AS total_trades, SUM(usdc_size) AS total_volume
  FROM trades WHERE strategy_id IS NOT NULL
  GROUP BY strategy_id, COALESCE(sub_strategy_id, ''), entity_slug
) s
LEFT JOIN ( ... resolutions ... ) r ON ...
LEFT JOIN ( ... open positions ... ) p ON ...
```

`total_resolutions` is correctly joined from the resolutions subquery. The COALESCE(sub_strategy_id, '') normalization is consistent across all three subqueries (trades, resolutions, positions). The JOIN should work. **The miscounting risk is that resolutions for a (strategy, sub) combination that has NO trades (e.g., legacy v1 resolutions imported via migration) are LEFT-JOINED out — they don't appear in the view at all because the FROM clause is trades.**

**Verdict**: R-7 — The view's join is technically correct. But the view structure (trades-first) makes never-traded strategies invisible and legacy-only-resolutions invisible. Not the proximate cause of the resolution stall, but masks visibility into the problem.

---

### R-8: SQLite WAL contention between strategy-advisor and resolution-checker

**Not the cause.** Strategy-advisor opens a SEPARATE Database connection to the R&D path (`config.advisor.rd_database_path`) in **read-only** mode (`{readonly: true, fileMustExist: true}`) per call (`strategy-advisor.ts:267`), and explicitly `db.close()`s in the `finally` block (line 278-279). It does NOT touch prod's DB. Even if it did, SQLite WAL allows concurrent readers and one writer; readonly readers do not block the writer.

**Verdict**: R-8 — No contention. The advisor and resolution checker operate on different DB files with no overlap.

---

### R-9: Stale advisor data — promotion decisions on bad data

**Real and impactful, but not the proximate cause of the prod stall.**

Evidence: `strategy-advisor.ts:148-160` checks `rd.total_resolutions >= t.min_resolutions_to_enable` (default 10). If R&D's resolutions are stuck at 7% (831/11,245), then most (strategy, sub) pairs lack 10 resolutions and never get promoted. Prod's strategy list stays at whatever was hand-configured.

The stall feedback loop: R&D resolution checker is broken (same code as prod) → R&D resolutions don't accumulate → advisor never promotes → prod gets no new strategies → existing prod strategies place positions → prod resolution checker is broken → prod positions stuck → prod cash drains → prod stops trading → R&D continues sampling but its resolutions also stay stuck.

**Verdict**: R-9 — The advisor IS making decisions on incomplete data, but the root issue is the resolution checker, not the advisor. Fix R-3 / A-P0-4 / A-P0-5 first.

---

### R-10: Five better resolution mechanism candidates

| # | Mechanism | Likelihood of working | Effort | Failure modes |
|---|-----------|----------------------|--------|---------------|
| **a** | **Polymarket Data API `/positions?user={wallet}` reconciliation** — query the same source v1 uses; for each open DB position, look up the Data API position; if `redeemable: true` or absent, force-close in the DB and credit cash from wallet USDC delta | **Highest** — this is what v1 does and it works. Authoritative on-chain truth. | M | Requires the wallet address per entity (already loaded), requires polling RPC for USDC delta to credit accurately. Race with manual on-chain redeems. |
| **b** | **Switch to per-market singular Gamma lookups** with proper response shape validation and lower price threshold (0.5 once `closed`) | Medium-high | S | Still depends on Gamma's freshness, which has been the original problem. Doesn't solve R-6 (v1 still drains the wallet). |
| **c** | **On-chain CTF balance polling** — for each position, call `CTF.balanceOf(wallet, token_id)`. If balance == 0, the position has been redeemed (or never existed). Force-close in DB. | Medium | M | Requires Polygon RPC reliability, gas-free read but rate limits matter. Authoritative for the "is the token still in the wallet" question. |
| **d** | **Listen for `PositionRedeemed` and `ConditionResolution` events** on Polygon via WebSocket/RPC subscription | Low — high implementation complexity | L | Brittle, requires reorg handling, needs persistent state. Polymarket-friendly when it works but not worth the engineering for V2. |
| **e** | **Trust the prior cycle's `resolutions` table** — if v1 (or any external process) writes to `resolutions`, treat that as authoritative and force-close the position. Build a one-way ingest from v1 to v2. | Medium | M | Requires v1 to write to v2's DB or vice versa, which couples two systems. Doesn't survive the rebuild. |

**Recommended approach**: **(a) — Polymarket Data API reconciliation** because it's the same source of truth v1 uses, it's authoritative for redemption status, it requires no on-chain RPC dependency, and it can be implemented in a single new function in `resolution-checker.ts` that runs in parallel with the existing Gamma path. Phase one: replace `parseGammaResolution` with a Data API position lookup. Phase two (post-rebuild): drop the Gamma path entirely.

The implementation:
```
For each entity slug:
  positions = getAllOpenPositions(slug)
  apiPositions = await fetch(`https://data-api.polymarket.com/positions?user=${entity.wallet_address}`)
  apiByCondition = Map.from(apiPositions, p => [p.conditionId, p])
  for pos in positions:
    apiPos = apiByCondition.get(pos.condition_id)
    if !apiPos OR apiPos.size == 0:
      // Position has been redeemed or never existed
      // Use Polymarket /positions resolved fields to compute payout
      force_close(pos, payout = pos.size * winning_price)
```

The wallet USDC delta is credited via a separate periodic reconciliation against `USDC.balanceOf(wallet)`.

---

## Out of scope

- **Live VPS state** — I cannot SSH to 178.62.225.235 per audit boundaries. All claims about "what is happening in prod right now" are inferred from the code paths and the user's stated symptoms. To convert hypotheses A/B/C in A-P0-4 into a verified root cause, an operator with VPS access should grep `polybot-v2.log` for `Resolution check complete` and inspect the `skipped_not_found` and `gamma_returned` fields.
- **Strategy R&D performance database content** — I did not query the SQLite databases. The 7% resolution rate (831/11,245) is taken from the user's prompt, not verified.
- **Polymarket Gamma API exact response shape** — I did not call the live API. The hypothesis that `condition_ids` is non-standard is based on Polymarket documentation patterns and the absence of this parameter shape in `data-api-client.ts`. An operator should run `curl 'https://gamma-api.polymarket.com/markets?condition_ids=0xabc&condition_ids=0xdef'` and inspect the response to definitively confirm.
- **Frontend dashboard correctness** — `polybot-v2/src/dashboard/` was not audited (out of scope for trading correctness).
- **Backtests, walk-forward validation, statistical significance of declared edges** — Track A is correctness, not strategy performance evaluation. The fabricated-edge findings (A-P0-7) are correctness defects regardless of whether the strategies happen to be profitable.
- **Wallet credentials, private keys, .env files** — not opened.
- **CLI tools and scripts** — `polybot-v2/src/cli/` not audited beyond imports.
- **Order book WebSocket integrity** — `orderbook-ws.ts` not audited; the engine catches connection failures and continues without realtime data, which is a known degradation path.
- **Lifecycle / process management** — `core/lifecycle.ts` not audited.
- **Schema migration safety** — `storage/migration/` not audited.
- **The 8th strategy (`weather-forecast.ts`) and `crypto-price.ts`** — only the entry sections were audited; both appear to use real data sources (Open-Meteo, Binance/CoinGecko) with real models, so they are flagged as the only two strategies with non-fabricated edges.

---

## Adversarial review notes

I challenged each of my findings before recording them:

- **A-P0-1 (2% phantom fee)**: Could the 2% be intentional for slippage padding? No — slippage is handled separately by `applySlippage` in paper-simulator (line 33) and by `bid_premium_pct` in order-builder (line 24). The 2% is explicitly labeled `feeRate` in the code and added to `net_usdc`. It is a fee, not slippage. Verified.
- **A-P0-2 (stop loss no-op)**: Is there another place where exits are processed? Grep across the engine for `'profit_target'` or `'hard_stop'` or `routeOrder.*sell` finds nothing beyond the log statement. The `exits` array is never passed to any other component. Verified.
- **A-P0-3 (price never updated)**: Could the price be updated indirectly via market-cache mutations? Grep for `updatePositionPrice` shows no callers. The orderbook-ws update at `market-cache.ts:50-58` updates the MARKET cache in-memory, not the position DB row. Verified.
- **A-P0-4 (Gamma API)**: Hypothesis A vs B vs C — all three are plausible. The strongest evidence is that the user reports 40 positions not closing, which means EITHER all three apply, OR one is severe enough alone to block all 40. Without API access I cannot pick. The recommendation (rewrite to use Data API per R-10 candidate a) bypasses all three.
- **A-P0-5 (v1 drain)**: Could the v1 cron be disabled already? The user's prompt says "v1 auto_redeem.py cron is still running on the VPS" — taken as fact. If it's been disabled, this finding is moot but the structural concern remains for any future cohabitation.
- **A-P0-6 (cap × weight)**: Could the cap be intended to be a "soft" cap and the weight a hard one? The variable is named `pctCap` and the comment is "Cap: percentage of trading balance" — indicating intent that it be a hard cap. The post-cap multiplication is a defect.
- **A-P0-7 (fabricated edges)**: Could the strategies actually have hidden alpha despite fabricated math? Possibly, but the audit's job is correctness — fabricated math is incorrect regardless of accidental profitability.
- **A-P0-8 (complement is not arb)**: The author's own comment confirms this. Verified.
- **A-P0-9 (live order_id NULL)**: Could the CLOB return an order_id that's somehow used? Grep for `clob_order_id` or any back-population code finds nothing. The fill's `trade_id` carries the local nanoid, not the CLOB ID. Verified.
- **A-P0-10 (token order)**: Could Polymarket's API actually guarantee token order? I did not find evidence either way. Treating as P0-if-real because the consequence is catastrophic.

---

## Path

This file: `audit/2026-04-09/A-trading-correctness.md`
