# Track C — Code Quality & Structure Audit

> Audit date: 2026-04-09
> Auditor: subagent (Track C)
> Scope: TypeScript correctness, async hygiene, error handling, schema integrity, repos, dead code, fix_*.py debt, sub-strategy refactor completeness, dashboard code quality
> Method: Read-only static analysis. Skills applied conceptually: sk-vibe-code-auditor, sk-fix-review, ar-tech-debt-tracker, ar-adversarial-reviewer.

## Summary

The 60-file TypeScript codebase has surprisingly clean type-safety hygiene at the surface — zero `as any`, zero `@ts-ignore`, zero `eslint-disable`, and `strict: true` is enabled. But that hides three classes of debt that materially threaten correctness: (1) **silent error swallowing** in the resolution-checker, orderbook parser, and four other locations consistently returns `null` on parse/JSON errors with no telemetry — this is the most likely root cause of the prod-blocking resolution issue, because closed markets that don't have a `>0.95` price (e.g. neg-risk multi-outcome, UMA-pending, mid-settle 0.5/0.5) silently fall through and never settle; (2) **double-purpose pnl accounting bugs** in `engine.runScanCycle` where `fill.net_usdc` (gross sell proceeds) is recorded as P&L via `dailyLossGuard.recordPnl` and resolution `payout` is added to cash but also recorded as pnl, making daily P&L meaningless and the daily-loss lockout effectively dead; (3) the `polybot-v2/scripts/` directory contains **54 brittle Python patch scripts (4,148 LOC)** that overwrite both `.ts` source AND already-built `.js` dist files via string replacement with no idempotency, no backup, no verification — including `bypass_risk.py`, `force_sizer.py`, and `fix_max_positions.py` which mutate the live risk engine in dangerous ways. The sub-strategy refactor IS structurally complete (verified in all 34 files that touch `sub_strategy_id`). The schema is reasonable, foreign keys are enforced, but the v_strategy_performance view's INNER FROM on `trades` means strategies that have only signaled (no fills yet) never appear. The dashboard `sse-server.ts` is one giant 540-line file with a 200-line HTML template embedded as a TypeScript string — unauditable, with one demonstrably wrong calculation (`p.size - p.cost_basis` rendered as "gain" mixes shares and dollars).

---

## TypeScript posture

### tsconfig.json — `polybot-v2/tsconfig.json`

| Flag | Value | Notes |
|---|---|---|
| `strict` | `true` | enables noImplicitAny, strictNullChecks, etc. |
| `noImplicitReturns` | `true` | good |
| `noFallthroughCasesInSwitch` | `true` | good |
| `noUncheckedIndexedAccess` | **MISSING** | causes latent unsafe array indexing |
| `exactOptionalPropertyTypes` | **MISSING** | |
| `noUnusedLocals` | `false` | dead code allowed |
| `noUnusedParameters` | `false` | |
| `target` / `module` | ES2022 / NodeNext | modern, good |

### Type-safety violations across `src/`

- `as any` casts: **0**
- `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck`: **0**
- `eslint-disable` comments: **0**
- Explicit `: any` annotations: **0** (the four hits for `\bany\b` in a Grep are all the English word "any" inside comments)
- `unknown` usage: 22 occurrences, all reasonable (typed boundaries at config parse, JSON responses, event emitter)

This is excellent surface posture, the cleanest I've seen on a system in this state. Credit where due. **However**, the codebase is chock-full of unchecked array indexing that would be flagged the moment `noUncheckedIndexedAccess` is turned on. See P2-3 below.

---

## P1 Findings (high-priority quality issues)

### C-P1-1: Silent JSON parse failure swallows resolution data — likely root cause of the prod-blocking resolution issue

**Severity:** P1 — directly blocks the prod-blocking issue this audit is investigating
**Evidence:** `polybot-v2/src/risk/resolution-checker.ts:206-238`

```ts
private parseGammaResolution(market: GammaMarket): MarketResolution | null {
  try {
    const prices = JSON.parse(market.outcomePrices) as string[];
    const outcomes = JSON.parse(market.outcomes) as string[];
    const tokenIds = JSON.parse(market.clobTokenIds) as string[];

    if (prices.length !== outcomes.length || prices.length !== tokenIds.length) {
      return null;  // silent
    }

    let winningIdx = -1;
    for (let i = 0; i < prices.length; i++) {
      const price = parseFloat(prices[i]);
      if (price > 0.95) {
        winningIdx = i;
        break;
      }
    }

    if (winningIdx === -1) {
      // Closed market but no clear winner — possibly 50/50 cancellation
      return null;  // silent
    }

    return {
      resolved: true,
      winningOutcome: outcomes[winningIdx],
      winningTokenIds: new Set([tokenIds[winningIdx]]),
    };
  } catch {
    return null;  // silent — swallows JSON.parse errors completely
  }
}
```

**Root cause:** Three independent failure modes return `null` with zero telemetry:
1. **JSON.parse failure** — if Gamma returns a closed market with `outcomePrices: null` or differently-shaped fields, the catch swallows it.
2. **Length mismatch** — silent.
3. **No price > 0.95** — silent. This trips on:
   - neg-risk multi-outcome markets where the winner only reaches `0.97` after UMA finalization, but the API returns intermediate `0.50/0.50` during the resolution window
   - markets that resolve at exactly `0.95` (string `"0.95"` parses to `0.95`, fails strict `>` check)
   - markets that voided/refunded (both prices `0.50`)
   - markets where the price is reported as `"1"` rather than `"1.0"` — works, but `> 0.95` check is fragile against quoting changes

**Impact:** Caller `checkResolutions()` increments `skipped_not_found` or `skipped_not_closed`, the position stays `open` forever, the market stays in `markets` table, and the operator gets a log line saying "Closed market but no clear winner" at `debug` level (line 82). No alert. No retry. No flag in DB. **This is exactly the symptom that would manifest as "positions stuck in resolution".**

**Fix (not applied):**
- Replace `catch { return null }` with `catch (err) { log.warn({ conditionId, raw: market.outcomePrices, err }, 'Failed to parse Gamma resolution'); return null; }`
- Lower the threshold to `>= 0.95` or store the actual price for diagnostic logging
- Distinguish "closed but un-resolved" (UMA pending) from "voided 50/50" — Gamma `umaResolutionStatuses` is in the type but never read
- Add a `last_resolution_attempt_at` column to `positions` so stuck positions are visible
- Persist a `resolution_attempt_log` table or emit `resolution:parse_failed` events

**Skills:** sk-bug-hunter, sk-error-detective, obra-root-cause-tracing

---

### C-P1-2: Daily P&L double-counts gross proceeds, lockout effectively dead

**Severity:** P1 — risk control compromised
**Evidence:**
- `polybot-v2/src/core/engine.ts:282` — `this.dailyLossGuard.recordPnl(entity.config.slug, fill.net_usdc);` on SELL fills
- `polybot-v2/src/core/engine.ts:206` — `this.dailyLossGuard.recordPnl(slug, payout);` on resolution payouts
- `polybot-v2/src/risk/daily-loss-guard.ts:25` — `this.entityManager.addDailyPnl(entitySlug, pnl);`

**Problem 1 — SELL fills:** `fill.net_usdc` is the gross sell proceeds (price × size, minus fees). It is **not** P&L. A SELL of $5 worth of shares records `+$5` daily P&L regardless of whether the cost basis was $4 (true gain $1) or $6 (true loss $1). Daily P&L is therefore strictly cumulative gross sells, not net P&L.

**Problem 2 — Resolution payouts:** `payout` is the gross winning payout (full $1 × size for winning side, $0 for losing). It is **not** realized pnl. The realized pnl variable already exists at `resolution-checker.ts:94` (`realizedPnl = payout - costBasis`), but the engine doesn't pass it back to the callback — only `payout`.

**Impact:** `daily_loss_lockout_usd` (default `$20`) will essentially never trigger from gains side, and from losses side it will trigger on losing positions after they accumulate $20 of cost basis (not $20 of loss). The risk control is broken in both directions. The strategy advisor and human operators see misleading daily P&L numbers.

**Fix:** The callback in `runScanCycle:197-208` needs to pass `realizedPnl` not `payout`. The SELL branch in `runScanCycle:280-282` should pass `fill.net_usdc - costBasisOfSoldShares` after looking up the position. Better: emit a `position:closed` event with realized P&L computed once and use that.

**Skills:** sk-bug-hunter, ar-tech-debt-tracker

---

### C-P1-3: Engine resolution-check exception swallowed, scan loop continues blind

**Severity:** P1
**Evidence:** `polybot-v2/src/core/engine.ts:196-211`

```ts
try {
  await this.resolutionChecker.checkResolutions((slug, payout) => { ... });
} catch (err) {
  log.error({ err }, 'Resolution check failed');
}
```

If Gamma API is down, throws, or any of the JSON parsing within `checkResolutions` blows up at a level not caught internally, the scan cycle just logs and proceeds to evaluate strategies. No retry. No backoff. No circuit breaker. No alert. No counter. This means resolution issues can be silent for hours/days while strategies happily keep adding new positions (which compounds the prod-blocking issue).

**Fix:** Add a `consecutiveResolutionFailures` counter; after N failures, page on it. Or expose via dashboard. At minimum, emit `resolution_check:failed` events.

**Skills:** sk-error-detective, ar-incident-commander

---

### C-P1-4: `bypass_risk.py` exists in scripts directory and modifies built dist in place

**Severity:** P1 — operational landmine
**Evidence:** `polybot-v2/scripts/bypass_risk.py`

```python
path = "/opt/polybot-v2-rd/dist/risk/risk-engine.js"
code = code.replace(
    "const approved = !blocked && sizing.size_usd > 0;",
    "const approved = true; // R&D: force approve everything"
)
```

This script unconditionally rewrites the risk engine to approve EVERY signal. It hardcodes the R&D path, but a one-character typo or env confusion (e.g. running it on prod by mistake during a deploy panic) would silently disable risk gating in production. There is no backup, no dry-run, no path validation, no `--confirm` flag. After running, the next `npm run build` reverts the change without anyone noticing.

**Fix:** Delete this file. If R&D needs permissive risk, set it via config (`risk.min_edge_threshold: 0`, `risk.max_position_pct: 0.99`), not via post-build patching.

**Skills:** sk-fix-review, ar-tech-debt-tracker, ar-incident-response

---

### C-P1-5: `force_sizer.py` overwrites position-sizer.js entirely AND patches risk-engine.js

**Severity:** P1
**Evidence:** `polybot-v2/scripts/force_sizer.py`

```python
new_code = '''import { createChildLogger } from '../core/logger.js';
const log = createChildLogger('position-sizer');
export function calculatePositionSize(signal, entity, limits) {
    const sizeUsd = 20;  // R&D: flat $20 per trade
    const sizeShares = Math.round((sizeUsd / signal.market_price) * 100) / 100;
    return { size_usd: sizeUsd, size_shares: sizeShares, method: 'cap' };
}
'''
with open(path, "w") as f:
    f.write(new_code)
```

It wholesale replaces the compiled `position-sizer.js`, dropping the `StrategyWeighter` integration, any caps from limits, and the dust floor. Then it ALSO patches `risk-engine.js` to bypass the size check. Both changes are reverted on the next `npm run build`. The author has effectively created a parallel non-version-controlled risk system.

Same problem as C-P1-4: the path could be mis-targeted, the file could be left in a broken intermediate state if write fails mid-stream, and there's zero verification.

**Skills:** sk-fix-review, sk-vibe-code-auditor

---

### C-P1-6: Engine has dead code in scan loop and never updates market cache prices from poller

**Severity:** P1 — silent stale-data hazard
**Evidence:** `polybot-v2/src/core/engine.ts:213-216`

```ts
// Update market cache from latest polling data
for (const market of this.marketCache.getActive()) {
  // prices already updated by poller via upsertFromSampling
}
```

This loop body is empty. The comment says "prices already updated" but there's no Y/N verification. Worse, the cache's `last_updated` is set on `upsertFromSampling()` BUT `getActive()` just reads from the cache map — there's no eviction of stale markets. A market that hasn't been polled in 6 hours but is still in the cache will return active, and strategies will trade against stale prices. The `MarketCache.touch()` LRU only evicts at `MAX_CACHE_SIZE = 5000`, never by age.

**Fix:** Either delete the loop entirely or implement TTL-based eviction in `MarketCache`. Markets older than `2 × scan_interval_ms` should be considered stale and dropped from `getActive()`.

**Skills:** sk-vibe-code-auditor, ar-tech-debt-tracker

---

### C-P1-7: 54 patch scripts in `polybot-v2/scripts/` are accumulated technical debt with high blast radius

**Severity:** P1 — operational hygiene
**Evidence:** `polybot-v2/scripts/` — 4,148 LOC across 54 files

Categorized inventory below in dedicated section. Key concerns:
- Most patch *both* src `.ts` AND built dist `.js` files inconsistently — patching dist is reverted on rebuild, patching src means the script must re-run after every git pull.
- Most use brittle `code.replace(old, new)` with no idempotency check — re-running can corrupt files.
- Several have hardcoded prod paths (`/opt/polybot-v2/...`) and could be run by accident.
- No naming convention separating "one-time fix that's been applied" from "active runbook" from "experimental".
- No README or changelog explaining what was applied to which environment when.
- The fact that 54 of these exist proves the development loop is "patch in prod via scripts → forget to backport → next deploy reverts → write new patch script". This is the worst possible failure mode for a system that handles money.

**Recommendation:** Move `scripts/` to `scripts/_archive/` immediately. Re-derive any active runbooks into a `runbooks/` directory with clear naming and a per-script header comment documenting what it does, when it was applied, and whether it's idempotent. Delete `bypass_risk.py`, `force_sizer.py`, anything matching `fix_dashboard*.py` (just rebuild from src), and anything matching `fix_rd_*` once the source is correct.

**Skills:** sk-fix-review, ar-tech-debt-tracker, sk-vibe-code-auditor

---

## P2 Findings (correctness improvements)

### C-P2-1: `MarketCache.touch()` is O(n) per call — burns CPU on every market lookup

**Evidence:** `polybot-v2/src/market/market-cache.ts:96-99`

```ts
private touch(conditionId: string): void {
  this.accessOrder = this.accessOrder.filter(id => id !== conditionId);
  this.accessOrder.push(conditionId);
}
```

Every call to `get()` invokes `touch()`, which does an `Array.filter` over up to 5000 entries. For a typical scan cycle that calls `getActive()` (returns full filtered array, no touch — OK) and then strategies call `getMarketData(conditionId)` repeatedly, this becomes O(n²) per cycle. For 5000 markets and 8 strategies × ~100 lookups each, that's ~20M filter operations per cycle.

**Fix:** Use a `Map<string, number>` for access timestamps instead, or just delete the LRU entirely (5000 markets × ~1KB each is 5MB; the JS heap can handle it without LRU).

**Skills:** sk-react-component-performance, ar-performance-profiler

---

### C-P2-2: `market-repo.upsertMarket` SQL silently drops `volume_24h`, `liquidity` columns

**Evidence:** `polybot-v2/src/storage/repositories/market-repo.ts:6-31`

The DDL has `volume_24h` and `liquidity` columns (defaults `0`), but the INSERT statement only lists 19 columns and never inserts these two. They will always be `0` for fresh markets and only get values via direct SQL or some other path. The `MarketRow` type interface (lines 65-90) declares them as `number | null`, so callers reading them get `0` always.

`ConvergenceStrategy.filtered_high_prob` (`convergence.ts:61`) requires `(m.liquidity ?? 0) >= 10000`. **This sub-strategy never fires.** Verify by checking R&D performance — if `convergence:filtered_high_prob` has zero trades, this is why.

**Fix:** Add `volume_24h` and `liquidity` to the INSERT, sourced from the `SamplingMarket` payload (Polymarket sampling-markets includes these). Or remove the columns and the dependent logic.

**Skills:** sk-bug-hunter, sk-sql-optimization-patterns

---

### C-P2-3: Pervasive unchecked array indexing — latent crashes if `noUncheckedIndexedAccess` is enabled

**Evidence:** widespread, examples:
- `polybot-v2/src/market/market-cache.ts:25-28` — `market.tokens[0].token_id`, `market.tokens[1].token_id`
- `polybot-v2/src/storage/repositories/market-repo.ts:28-29` — same
- `polybot-v2/src/market/sampling-poller.ts:106-117` — `tokens[0]`, `tokens[1]` (guarded by length check, OK but not type-safe)
- `polybot-v2/src/risk/resolution-checker.ts:208-234` — `prices[i]`, `outcomes[winningIdx]`, `tokenIds[winningIdx]`
- `polybot-v2/src/strategy/custom/weather-forecast.ts:222, 229` — `rangeMatch[1]`, `rangeMatch[2]`, `exactMatch[1]` (regex match arrays)
- `polybot-v2/src/strategy/custom/crypto-price.ts:188` — `match[1]`
- `polybot-v2/src/entity/entity-manager.ts:38, 144` — `new Date().toISOString().split('T')[0]`
- `polybot-v2/src/risk/daily-loss-guard.ts:53` — same
- `polybot-v2/src/market/orderbook-ws.ts:125-128` — `bids[0].price`, `asks[0].price` (guarded by length, OK)

**Impact:** Today the code works because the data conformance assumptions hold. But the moment Polymarket's API returns a market with `tokens.length === 1` (single-outcome resolution edge case), or a regex match returns `null` because `parseInt(undefined)` happens, the code throws unhandled. With `noUncheckedIndexedAccess: true`, these would all be compile errors and the codebase would be safer.

**Fix:** Enable `noUncheckedIndexedAccess` in tsconfig and fix the resulting ~30-50 errors. This is a 2-day refactor and would close a whole class of latent bugs.

**Skills:** sk-typescript-pro, sk-typescript-advanced-types

---

### C-P2-4: Six locations swallow errors with `catch { return null/false; }` and zero logging

**Evidence:**
| File:Line | What's swallowed | Risk |
|---|---|---|
| `src/risk/resolution-checker.ts:236` | JSON.parse of Gamma response | **HIGH** — see C-P1-1 |
| `src/dashboard/sse-server.ts:236` | Cookie token parse | LOW |
| `src/dashboard/sse-server.ts:282` | R&D DB read | MEDIUM — operator can't tell why R&D panel is blank |
| `src/dashboard/sse-server.ts:323` | Static file read | LOW (has fallback HTML) |
| `src/market/data-api-client.ts:29` | `getProfile` call | LOW |
| `src/market/orderbook-ws.ts:110` | Malformed WS message | **MEDIUM** — would mask CLOB protocol changes |
| `src/market/sampling-poller.ts:137` | `parseSingleMarket` | MEDIUM — bad markets silently dropped, no count of how many |

**Fix:** All should at minimum `log.warn({ err, context }, 'reason')`.

---

### C-P2-5: `unhandledRejection` only logs, does not stop the engine

**Evidence:** `polybot-v2/src/core/lifecycle.ts:32-34`

```ts
process.on('unhandledRejection', (reason) => {
  log.error({ reason }, 'Unhandled rejection');
});
```

If a strategy or risk path throws asynchronously and the rejection isn't caught, the engine keeps running in an unknown state. Per Node.js best practice for trading systems, unhandledRejection should be treated like uncaughtException — log fatal, attempt clean stop, exit non-zero so systemd restarts.

**Fix:** Match `uncaughtException` handler.

---

### C-P2-6: Shutdown handler has no timeout — `engine.stop()` can hang forever

**Evidence:** `polybot-v2/src/core/lifecycle.ts:13-19`

```ts
const shutdown = async (signal: string) => {
  log.info({ signal }, 'Shutdown signal received');
  if (engine?.running) {
    await engine.stop(signal);  // no timeout
  }
  process.exit(0);
};
```

If `engine.stop()` deadlocks waiting on the strategy registry teardown or DB close, systemd `SIGTERM` won't trigger a hard exit until systemd's own `TimeoutStopSec` kicks in (default 90s). Worse, the WAL sqlite db close is sync and could hang on FS issues.

**Fix:** Wrap with `Promise.race([engine.stop(signal), new Promise((_, reject) => setTimeout(reject, 30_000))])`.

---

### C-P2-7: Schema migration is not atomic; concurrent runs corrupt sub_strategy_id state

**Evidence:** `polybot-v2/src/storage/schema.ts:421-449`

The migration loop checks `PRAGMA table_info` then runs `ALTER TABLE ADD COLUMN`. If two engine processes start simultaneously (e.g. systemd unit restart race), both will see the column missing, both will issue ALTER, one will succeed and the other will throw — the catch (`log.warn`) will swallow it, but the engines may then race on view recreation. The view is unconditionally `DROP VIEW IF EXISTS` then recreated — also not atomic.

**Fix:** Wrap migrations in a transaction with `BEGIN EXCLUSIVE`. Or use a `migrations` table with row-level locking to coordinate.

---

### C-P2-8: `v_strategy_performance` view excludes signaled-but-untraded sub-strategies

**Evidence:** `polybot-v2/src/storage/schema.ts:386-411`

```sql
FROM (
    SELECT strategy_id, COALESCE(sub_strategy_id, '') AS sub_strategy_id, entity_slug, ...
    FROM trades WHERE strategy_id IS NOT NULL
    GROUP BY strategy_id, COALESCE(sub_strategy_id, ''), entity_slug
) s
LEFT JOIN ( ... resolutions ... ) r ON ...
LEFT JOIN ( ... open positions ... ) p ON ...
```

The driving FROM is `trades`. Strategies that emit signals but never get a trade (e.g. all rejected by risk engine) **never appear in the view**. The strategy advisor reads from this view to decide enable/disable. So a strategy can be permanently rejected by risk engine, generate zero trades, and the advisor will see "no R&D data" forever — never enabling the strategy nor disabling it. Bootstrap chicken-and-egg.

**Fix:** UNION the strategies from `signals` table where they aren't in `trades`. Or have the advisor check signals as a fallback.

---

### C-P2-9: Empty engine loop on line 213-216 was committed and not deleted

See C-P1-6 above. Counted as P2 if you accept the comment but it's also P1 because it represents a missing implementation.

---

### C-P2-10: `sse-server.ts` has 540 lines including a 200-line HTML template inline

**Evidence:** `polybot-v2/src/dashboard/sse-server.ts:334-540` (`getEntityPageHtml`) — string concatenation, no escaping for `slug` interpolation, untestable, unauditable.

**Specific bug:** `polybot-v2/src/dashboard/sse-server.ts:411`

```js
document.getElementById('entitySub').textContent = modeBadge + ' | ' + e.status + ' | Port ' + (e.slug);
```

Says "Port" but renders the slug. Trivial bug, but a sign nobody reviews this template.

**Specific bug:** `polybot-v2/src/dashboard/sse-server.ts:448`

```js
var gain = p.size - (p.cost_basis || 0);
```

`p.size` is the share count (e.g. `200` shares). `p.cost_basis` is dollars (e.g. `$94`). Subtracting them produces nonsense (`200 - 94 = 106` displayed as `$106 gain`). The "Est. Gain" column on the entity page is **wrong for every position**.

**Fix:** Move templates to `dashboard/static/entity.html`, render variables from `/api/entity/:slug` JSON. Compute estimated gain as `(1 - p.avg_entry_price) × p.size` (full upside if it pays out at $1).

---

### C-P2-11: `slug` interpolated directly into HTML without escaping (XSS surface)

**Evidence:** `polybot-v2/src/dashboard/sse-server.ts:336` and `polybot-v2/src/dashboard/sse-server.ts:368, 394`

```ts
return `<!DOCTYPE html>
<html><head><title>${slug} — Gemini Capital</title>
...
const SLUG = '${slug}';
```

The path matcher restricts slug to `[\w][\w-]*`, so the practical attack surface is small, but if the route regex ever loosens, this becomes a stored XSS in the trading dashboard.

**Fix:** HTML-escape all interpolations.

---

### C-P2-12: `timingSafeEqual` will throw if buffers differ in length

**Evidence:** `polybot-v2/src/dashboard/sse-server.ts:229`

```ts
if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
```

Node's `timingSafeEqual` throws `RangeError: Input buffers must have the same byte length`. If a malformed cookie has a short signature, this throws inside `try { ... } catch { return false; }` so the user just gets logged out — but the throw goes through the catch, which is fine. Still, defensive: check lengths first.

---

## P3 Findings (cleanup, hardening)

### C-P3-1: 25+ magic numbers that should be config

| File:Line | Constant | Should be |
|---|---|---|
| `src/risk/resolution-checker.ts:33` | `120_000` (resolution check interval) | `config.engine.resolution_check_interval_ms` |
| `src/risk/resolution-checker.ts:220` | `0.95` (winning threshold) | `config.resolution.win_threshold` |
| `src/risk/resolution-checker.ts:179` | `50` (chunk size) | `config.gamma.chunk_size` |
| `src/risk/resolution-checker.ts:187` | `15_000` (timeout) | `config.gamma.timeout_ms` |
| `src/risk/strategy-weighter.ts:20` | `300_000` (refresh interval) | `config.weighter.refresh_ms` |
| `src/risk/strategy-weighter.ts:86, 88, 90, 95, 100` | `5`, `0.4`, `60`, `40`, `0.15` (tier thresholds) | config |
| `src/execution/clob-router.ts:124` | `0.02` (taker fee) | `config.execution.taker_fee_rate` |
| `src/execution/paper-simulator.ts:44` | `0.02` (paper sim taker fee) | same |
| `src/strategy/custom/favorites.ts:62, 76, 89, 103` | `0.50, 0.92, 0.40, 0.60, 0.85` (price bands) | config or strategy params |
| `src/strategy/custom/longshot.ts:46` | `0.20`, `0.02` (tail thresholds) | config |
| `src/strategy/custom/convergence.ts:61` | `10000` (liquidity floor) | config |
| `src/strategy/custom/skew.ts:41-44` | `0.85`, `0.03`, `0.15` | config |
| `src/strategy/custom/value.ts:46-48` | `0.20`, `0.50`, `1` | config |
| `src/strategy/custom/crypto-price.ts:23-26` | volatility table | config |
| `src/strategy/custom/weather-forecast.ts:14-34` | 38-city coordinate table | should live in `config/cities.yaml` |
| `src/market/market-cache.ts:7` | `MAX_CACHE_SIZE = 5000` | config |
| `src/market/orderbook-ws.ts:10-11` | reconnect/ping intervals | config |
| `src/dashboard/sse-server.ts:25, 28, 29` | session TTL, max attempts, lockout duration | config |

### C-P3-2: `addDailyPnl` swallows the day-rollover within `recordPnl` race

`entity-manager.ts:140-151` checks `daily_pnl_reset_date` against today and zeros if different. But this method is called from `recordPnl` after the lockout check has already used the (possibly stale) daily_pnl. If a fill arrives at 23:59:59 and processes at 00:00:01, the P&L for the previous day is reset before being persisted. Race condition.

### C-P3-3: Strategy registry has duplicate-registration overwrite without consent

`strategy-registry.ts:11-17` — `register()` warns and overwrites silently. In a production engine, two registrations of the same strategy ID is a bug, not a fallback. Should throw.

### C-P3-4: `clob-router.ts:39` and similar — non-null assertion `order.order_id!`

The Order type allows `order_id: string | null`, so the `!` is a lie. A live order in pending state has null until CLOB returns one. Multiple call sites assume non-null. Should be guarded.

### C-P3-5: Dashboard has no rate limiting on `/api/*` endpoints

Auth gate exists, but a logged-in client can hammer `/api/markets` (which loads 50 markets each time and spams the DB). Not exploitable externally because of auth, but a misbehaving SPA could DoS the engine.

### C-P3-6: `sse-server.ts:282` getRdStrategies opens a NEW SQLite connection on every dashboard request

`new Database(rdPath, { readonly: true })` then close. For a hot dashboard polling every 60s, this is 60 file opens per minute against a possibly large WAL'd DB. Prepare a connection pool or cache the result for 30s.

### C-P3-7: `applySchema` is called unconditionally on every startup

`schema.ts:415` always runs `db.exec(DDL)` even if the schema is already at version 2. The `CREATE TABLE IF NOT EXISTS` makes this safe, but it's wasteful and means startup can't detect a schema downgrade scenario.

### C-P3-8: Hardcoded VPS path `/opt/polybot-v2-rd/data/rd.db` in `sse-server.ts:274`

Should be `process.env.RD_DATABASE_PATH` only, with no fallback that ties this to the specific VPS layout.

### C-P3-9: `getDailyVolume` SQL has a magic `days * 16` multiplier

`trade-repo.ts:68` — `'SELECT * FROM v_daily_volume LIMIT ?'`.run(days * 16). Why 16? Presumably "16 entities × N days". This breaks if entity count changes. Use `WHERE trade_date >= date('now', '-N days')` instead.

### C-P3-10: `dashboard/static/entity.html` (separate file referenced from grep results) has `} catch(e) {}`

`polybot-v2/src/dashboard/static/entity.html:213` — empty catch in client JS. Should at minimum console.warn.

### C-P3-11: Engine `getStats()` exposes `event_stats` which could be large; no pagination

Minor, but `dashboard:status` is polled every cycle and the payload grows.

### C-P3-12: Hardcoded "Gemini Capital" branding mixed with "Polymarket Trading Engine" mixed with "Polybot V2"

`sse-server.ts:325, 336, 343, 518, 531` use various names. Pick one in config.

---

## fix_*.py / patch_*.py inventory

54 scripts in `polybot-v2/scripts/`, totaling 4,148 LOC.

| File | LOC | Category | Risk | Recommendation |
|---|---|---|---|---|
| `bypass_risk.py` | 29 | risk bypass | **CRITICAL** | DELETE — see C-P1-4 |
| `force_sizer.py` | 36 | sizer bypass | **CRITICAL** | DELETE — see C-P1-5 |
| `nuke_v1_prod.py` | 55 | dashboard cleanup | HIGH | dist patch, reverted on rebuild — DELETE, fix in src |
| `nuke_v1_rd.py` | 63 | dashboard cleanup | HIGH | DELETE, fix in src |
| `unwind_positions.py` | 108 | live trade execution | **CRITICAL** | uses live CLOB to SELL all positions; bare `except: pass` at line 58; reads V1 keys at `/opt/polybot/state/api_keys.json`; **MOVE to runbooks/ with explicit READ-CONFIRM** |
| `check_redeem.py` | 207 | live wallet inspection | MEDIUM | reads V1 keys; useful but should move to runbooks/ |
| `add_time_filter.py` | 59 | engine src patch | HIGH | patches src ts; likely already merged; verify with sk-fix-review and DELETE |
| `audit_source.py` | 127 | static analysis tool | LOW | KEEP if useful, move to tools/ |
| `build_all_strategies.py` | 365 | code generator? | UNKNOWN | review purpose, likely obsolete |
| `check_js.py` | 26 | dist verifier | LOW | KEEP, move to tools/ |
| `dashboard_v3.py` | 212 | dashboard rewrite | UNKNOWN | dead code, likely obsolete — DELETE if v3 is built |
| `debug_markets.py` | 53 | one-off debug | LOW | DELETE |
| `debug_weather.py` | 61 | one-off debug | LOW | DELETE |
| `deploy-vps.sh` | 75 | deployment | LOW | KEEP, move to deploy/ |
| `fix_cash_accounting.py` | 55 | engine.js patch | HIGH | dist patch — verify accounting was fixed in src and DELETE |
| `fix_cash_floor.py` | 29 | dist patch | HIGH | DELETE if applied to src |
| `fix_commas.py` | 39 | dist patch | HIGH | DELETE |
| `fix_dashboard_final.py` | 93 | dist HTML patch | HIGH | DELETE |
| `fix_dollar_fn.py` | 46 | dist HTML patch | HIGH | DELETE |
| `fix_empty_panel.py` | 62 | dist HTML patch | HIGH | DELETE |
| `fix_engine_cash.py` | 29 | dist patch | HIGH | DELETE if applied to src |
| `fix_entity_fetch.py` | 22 | dist HTML patch | HIGH | DELETE |
| `fix_entity_page.py` | 61 | dist HTML patch | HIGH | DELETE |
| `fix_entity_repo.py` | 35 | src ts patch | MEDIUM | verify and DELETE |
| `fix_fetchj.py` | 51 | dist HTML patch | HIGH | DELETE |
| `fix_max_positions.py` | 20 | src ts patch | HIGH | adds env-var hack to risk-engine.ts; should be config not env |
| `fix_metric_flex.py` | 27 | dist HTML patch | HIGH | DELETE |
| `fix_prod_dashboard.py` | 43 | dist HTML patch | HIGH | DELETE |
| `fix_prod_panel.py` | 68 | dist HTML patch | HIGH | DELETE |
| `fix_prod_strats.py` | 29 | dist HTML patch | HIGH | DELETE |
| `fix_rd.py` | 66 | dist HTML patch | HIGH | DELETE |
| `fix_rd_cookie.py` | 16 | dist HTML patch | HIGH | DELETE |
| `fix_rd_dashboard.py` | 62 | dist HTML patch | HIGH | DELETE |
| `fix_rd_dashboard2.py` | 68 | dist HTML patch | HIGH | DELETE — note `2` suffix proves iteration without cleanup |
| `fix_rd_dashboard_final.py` | 138 | dist HTML patch | HIGH | DELETE — `_final` suffix proves uncertainty |
| `fix_rd_final.py` | 89 | dist HTML patch | HIGH | DELETE |
| `fix_rd_positions_scope.py` | 96 | dist patch | HIGH | DELETE |
| `fix_rd_sizer.py` | 43 | dist patch | HIGH | DELETE — rebuild from src |
| `fix_rd_strategies.py` | 84 | dist patch | HIGH | DELETE |
| `fix_risk_percentages.py` | 165 | config + src patch | MEDIUM | adds `daily_loss_lockout_pct` field that doesn't exist in Zod schema — broken |
| `fix_scoreboard.py` | 93 | dist HTML patch | HIGH | DELETE |
| `fix_strategy_list.py` | 40 | dist HTML patch | HIGH | DELETE |
| `full_rebuild.sh` | 41 | deployment | LOW | KEEP, move to deploy/ |
| `patch_rd_cookies.py` | 41 | dist HTML patch | HIGH | DELETE |
| `patch_rd_final.py` | 88 | dist HTML patch | HIGH | DELETE |
| `prod_rebuild.sh` | 86 | deployment | LOW | KEEP, move to deploy/ |
| `rd_dashboard_all.py` | 255 | dashboard rewrite | HIGH | DELETE — rebuild from src |
| `rebuild_rd_dashboard.py` | 142 | dashboard rewrite | HIGH | DELETE |
| `remove_markets_from_header.py` | 26 | dist HTML patch | HIGH | DELETE |
| `remove_v1_panel_rd.py` | 55 | dist HTML patch | HIGH | DELETE |
| `remove_volume.py` | 57 | dist HTML patch | HIGH | DELETE |
| `replace_engine_market.py` | 120 | engine.js patch | HIGH | DELETE — fix in src |
| `restart_verify.sh` | 9 | deployment helper | LOW | KEEP |
| `rewrite_scoreboard.py` | 83 | dist HTML patch | HIGH | DELETE |

**Aggregate recommendation:** Of 54 scripts, **42 should be deleted** (38 fix_*.py / patch_*.py / nuke_*.py that patch dist or have been superseded by src changes), **5 should move to `runbooks/` with READ-CONFIRM** (`unwind_positions.py`, `check_redeem.py`, `bypass_risk.py` if explicitly retained for R&D-only use, plus the `_dangerous` ones), **5 should move to `tools/`** (`audit_source.py`, `check_js.py`), and **the 4 .sh files** (`deploy-vps.sh`, `full_rebuild.sh`, `prod_rebuild.sh`, `restart_verify.sh`) should move to `deploy/`. **`bypass_risk.py` and `force_sizer.py` should be deleted outright.**

Apply `sk-fix-review` to verify whether the in-place dist patches are still applied or were lost on the last rebuild — almost certainly lost, which is the entire problem with this pattern.

---

## Sub-strategy refactor completeness check

**Verdict: COMPLETE in TypeScript surface, with one ambiguity in the v_strategy_performance view (P2-8 above).**

| Layer | File | Verified |
|---|---|---|
| Type definition | `src/types/signal.ts:11` | `sub_strategy_id?: string` ✓ |
| Type definition | `src/types/order.ts:26, 59` | propagated through OrderRequest, OrderFill ✓ |
| Strategy interface | `src/strategy/strategy-interface.ts:32` | `getSubStrategies()` declared ✓ |
| Strategy interface | `src/strategy/strategy-interface.ts:13, 41-43` | `enabled_sub_strategies` + `isSubStrategyEnabled` helper ✓ |
| Strategy: weather_forecast | `src/strategy/custom/weather-forecast.ts:71-73, 149` | `getSubStrategies` overridden, signal emits sub_strategy_id ✓ |
| Strategy: crypto_price | `src/strategy/custom/crypto-price.ts:50-52, 113` | ✓ |
| Strategy: favorites | `src/strategy/custom/favorites.ts:26-28, 115, 165` | 4 sub-strategies, all emit ✓ |
| Strategy: complement | `src/strategy/custom/complement.ts:28-30, 82` | 1 sub-strategy ✓ |
| Strategy: longshot | `src/strategy/custom/longshot.ts:25-27, 62, 87, 113` | 3 sub-strategies, all emit ✓ |
| Strategy: value | `src/strategy/custom/value.ts:24-26, 58, 83` | 2 sub-strategies, all emit ✓ |
| Strategy: skew | `src/strategy/custom/skew.ts:23-25, 51` | 1 sub-strategy ✓ |
| Strategy: convergence | `src/strategy/custom/convergence.ts:25-27, 69, 103` | 2 sub-strategies, all emit ✓ |
| Strategy context | `src/strategy/strategy-context.ts:13, 18, 59` | `enabled_sub_strategies` plumbed; `getRecentSignals` maps sub_strategy_id ✓ |
| Strategy registry | `src/strategy/strategy-registry.ts:41-54` | `getAllSubStrategyKeys()` enumerates pairs ✓ |
| Risk engine | `src/risk/risk-engine.ts:124` | OrderRequest preserves sub_strategy_id ✓ |
| Strategy weighter | `src/risk/strategy-weighter.ts:26-47, 75-112` | weights keyed on `(strategy_id, sub_strategy_id)` ✓ |
| Strategy advisor | `src/risk/strategy-advisor.ts:78-130, 132-194, 242-260` | normalizes legacy, evaluates per pair, rebuilds configs per pair ✓ |
| Position sizer | `src/risk/position-sizer.ts:58` | passes sub_strategy_id to weighter ✓ |
| Order builder | `src/execution/order-builder.ts:38` | spreads OrderRequest, sub_strategy_id flows ✓ |
| Paper simulator | `src/execution/paper-simulator.ts:65` | emits OrderFill with sub_strategy_id ✓ |
| Live CLOB router | `src/execution/clob-router.ts:128` | emits OrderFill with sub_strategy_id ✓ |
| Engine processPosition | `src/core/engine.ts:321` | upserts position with sub_strategy_id ✓ |
| Repo: position | `src/storage/repositories/position-repo.ts:12, 20, 26` | INSERT + ON CONFLICT update both include sub_strategy_id ✓ |
| Repo: order | `src/storage/repositories/order-repo.ts:13, 20, 81` | INSERT, type includes ✓ |
| Repo: trade | `src/storage/repositories/trade-repo.ts:12, 18, 87` | INSERT, type includes ✓ |
| Repo: signal | `src/storage/repositories/signal-repo.ts:11, 15, 57` | INSERT, type includes ✓ |
| Repo: resolution | `src/storage/repositories/resolution-repo.ts:12, 17, 71, 90` | INSERT, type includes; StrategyPerfRow exposes ✓ |
| Schema DDL | `src/storage/schema.ts:97, 131, 165, 195, 216` | all five tables have `sub_strategy_id TEXT` column ✓ |
| Schema migration | `src/storage/schema.ts:421-435` | safe ALTER TABLE ADD COLUMN with PRAGMA check ✓ |
| Schema view: v_strategy_performance | `src/storage/schema.ts:386-411` | GROUPs by `(strategy_id, COALESCE(sub_strategy_id, ''), entity_slug)` — works but excludes signal-only sub-strategies (see C-P2-8) |
| Resolution checker | `src/risk/resolution-checker.ts:109` | passes `pos.sub_strategy_id ?? undefined` to insertResolution ✓ |
| Dashboard `/api/strategies` | `src/dashboard/sse-server.ts:106` | returns `getStrategyPerformance()` which includes sub_strategy_id ✓ |
| Dashboard entity page render | `src/dashboard/sse-server.ts:457-467` | sorts and renders by `(strategy_id, sub_strategy_id)` ✓ |
| Entity manager strategies | `src/entity/entity-manager.ts:165-178` | accepts string OR EntityStrategyConfig, propagates ✓ |
| Config schema | `src/config/schema.ts:90-104` | `entityStrategyConfigSchema` accepts sub_strategy_ids; `strategies` is union ✓ |

**Found NO missing propagation.** This is genuinely complete. The one weakness is C-P2-8 (the view's INNER FROM trades).

---

## Dashboard code quality

### Architecture
- **540 LOC single file** combining HTTP server, auth, sessions, SSE, REST, AND inline HTML templates.
- Inline `getEntityPageHtml(slug)` is 200 lines (line 334-513) of HTML+CSS+JS as a template literal.
- Inline `getLoginHtml(csrf, error)` is another template literal.
- The login template is the only thing in `dashboard/static/` that's a separate file (`index.html`), per the `serveStatic` call.

### Specific bugs (also listed in P2)
- `sse-server.ts:411` — "Port" label rendered with slug value (cosmetic but obvious)
- `sse-server.ts:448` — `gain = p.size - p.cost_basis` mixes shares and dollars; **gain column is wrong on every row**
- `sse-server.ts:282` — silent fallback to `[]` for getRdStrategies, no log
- `sse-server.ts:336` — `${slug}` interpolated into HTML without escaping (limited by route regex but XSS surface)
- `sse-server.ts:25-29` — magic number constants for session/lockout
- `sse-server.ts:27` — session secret derives from env var with hardcoded fallback `'polybot-v2-session-key'`; if env unset, all sessions trivially forgeable

### Auth flow
- Cookie-based sessions, HMAC-SHA256 signed, base64-encoded payload `user:expires:signature`. Decent.
- CSRF tokens stored in-memory `sessions` Map keyed `csrf_${token}`. Mixing CSRF tokens with user sessions in the same Map is confusing but works.
- Rate-limiting per-IP for login attempts (5 attempts → 15 min lockout). Good.
- `timingSafeEqual` used for signature comparison. Good.
- Cookie has `HttpOnly`, `SameSite=Lax`, `Secure` only in `NODE_ENV=production`. OK.
- Session secret rotates if `DASHBOARD_PASSWORD` env changes — by design but invalidates all sessions on password change.

### SSE handling
- 13 events wired in `wireSSE()` (lines 298-308).
- `sseClients: Set<ServerResponse>` — clients added on `/events` GET, removed on `close`.
- No heartbeat/ping → dead connections accumulate forever.
- No `Set-Cookie` cleanup on disconnect.
- `broadcastSSE` writes to all clients synchronously without backpressure handling — slow client blocks all clients.

### REST endpoints
- 10 routes, all read-only — no mutations. Good.
- `/api/markets` returns `{ counts, active: getActiveMarkets().slice(0, 50) }` — hardcoded limit of 50.
- Entity-specific routes regex `^\/api\/([\w][\w-]*)\/([\w]+)$` — restrictive, OK.
- No CORS preflight cache.
- No ETags or conditional requests.

---

## Dead code, magic numbers, debt

### Dead code
- `polybot-v2/src/core/engine.ts:213-216` — empty for loop with comment
- `polybot-v2/src/cli/index.ts` — not read but exists; needs review for dead commands
- `polybot-v2/src/storage/migration/v1-import.ts` — entire V1 migration script; if V2 is now standalone, could be archived

### Magic numbers
See C-P3-1 for the full list. Worst offenders:
- Resolution win threshold `0.95`
- Taker fee `0.02`
- Strategy weighter tier thresholds `60`, `40`, `5`
- Max cache size `5000`
- Session TTL `8 * 60 * 60 * 1000`
- Strategy price bands hardcoded across 8 strategy files

### TODO/FIXME comments
- **Zero `TODO`/`FIXME`/`XXX`/`HACK` markers in `src/`.** This is suspicious — either the codebase is genuinely complete or developers are deleting TODOs without fixing them. Given the volume of unfixed bugs found in this audit, the latter is more likely.

### Function length
- `engine.ts:runScanCycle` — 117 lines, too long, mixes 4 concerns (resolution, market update, strategy eval, fill processing). Should be 4 functions.
- `strategy-advisor.ts:check` — 194 lines, also too long.
- `weather-forecast.ts:scoreMarket` — 84 lines, dense conditionals.
- `sse-server.ts:getEntityPageHtml` — 180 lines (it's a template, but still).

### Duplicated logic
- The `cleanupDedup()` pattern is copy-pasted with slight variations across 7 of the 8 strategy files. Should be a base class method.
- `endTime/hoursToResolve` parsing block is copy-pasted in 6 strategies.
- "Find favorite/underdog side" logic in skew, longshot, favorites, convergence — should be a market helper.
- Repository INSERT statements all have the same shape; could use a tiny query builder.

---

## Out of scope

- Wallet/keystore safety (Track A's responsibility)
- Live CLOB integration safety (Track B / live trading)
- VPS deployment, systemd units, network security
- Strategy edge / backtest validation — math correctness of the 8 strategies
- Risk-engine math (Kelly, position sizing accuracy)
- Polymarket API contract verification
- Performance benchmarking under load
- Test coverage / `tests/` directory contents
- Git history / commit hygiene

---

## Recommended remediation priority

1. **Today** — Add logging to `parseGammaResolution` (C-P1-1). 5-line fix unblocks the prod resolution issue investigation.
2. **Today** — Delete `bypass_risk.py`, `force_sizer.py` (C-P1-4, C-P1-5). Operational hazard.
3. **This week** — Fix daily P&L double-counting (C-P1-2). Risk control is currently broken.
4. **This week** — Fix entity page "gain" calculation (C-P2-10). Dashboard shows wrong numbers.
5. **This week** — Add dedicated logging + counters around resolution-check failures (C-P1-3).
6. **This sprint** — Move all 54 scripts to `_archive/`, recreate active runbooks with proper headers (C-P1-7).
7. **This sprint** — Fix `market-cache.touch` perf bug (C-P2-1).
8. **Next sprint** — Enable `noUncheckedIndexedAccess` and fix the resulting errors (C-P2-3).
9. **Next sprint** — Refactor `sse-server.ts`: extract HTML to static files (C-P2-10).
10. **Next sprint** — Add `volume_24h`/`liquidity` to market upsert (C-P2-2) — unblocks `convergence:filtered_high_prob`.
