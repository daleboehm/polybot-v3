# Track E — Backtest Validity & R&D Engine Analytics

**Audit date:** 2026-04-09
**Auditor:** Claude (Opus 4.6, audit-only)
**Scope:** R&D engine validity, statistical thresholds, look-ahead bias, view correctness, weighter math, feature engineering, walk-forward, R&D/live equivalence, portfolio analytics, calibration
**Mode:** Read-only. No code, config, or VPS state was modified.
**Skills consulted:** ar-statistical-analyst (binomial CI math), agi-walk-forward-validation (recommended framework), agi-strategy-framework, agi-portfolio-analytics, agi-feature-engineering, obra-verification-before-completion (every finding cited file:line).

---

## Executive summary

The R&D engine is real code that *does* aggregate per-(strategy, sub-strategy) trades and resolutions and feeds them to a weighter and an advisor. But the statistical scaffolding around it is unsound enough that the "validation" stamp the engine produces is meaningless at the sample sizes it currently uses, and the data path it claims to share with live execution diverges in at least four material ways. There is **no walk-forward**, **no Sharpe / Sortino / Calmar / drawdown / Brier / calibration** anywhere in the repository, the four "model probability" implementations on the heuristic strategies are tautologies that *cannot* generate edge, and the strategy weighter and advisor read aggregate rows that mix entities together. None of this is fatal — it is fixable — but no one should treat the current "promotion-from-R&D" pipeline as evidence-based until it is fixed.

**Severity tally:** P0 = 6, P1 = 7, P2 = 4.

---

## E-1 — Statistical Validity of Advisor Thresholds **[P0]**

### What the code actually does

`polybot-v2/src/risk/strategy-advisor.ts:148-160` (enable) and `:165-172` (disable) implement:

```
ENABLE  if total_resolutions ≥ min_resolutions_to_enable AND
          win_rate           ≥ min_win_rate_to_enable     AND
          total_pnl          >  min_pnl_to_enable
DISABLE if total_resolutions ≥ min_resolutions_to_disable AND
          win_rate           <  max_win_rate_to_disable   AND
          total_pnl          <  0
```

The defaults are set in `polybot-v2/src/config/schema.ts:63-69`:

| Field | Default |
|---|---|
| `min_resolutions_to_enable` | **10** |
| `min_win_rate_to_enable` | **50** |
| `min_pnl_to_enable` | **0** |
| `min_resolutions_to_disable` | **20** |
| `max_win_rate_to_disable` | **30** |

(Track scope said "5 resolutions, 50% WR" — actual code is **10** to enable. Still grossly insufficient. Note: there is **no override in any YAML** under `polybot-v2/config/`, so defaults are in force.)

### Why this is broken

A binary outcome with n=10 and 5 wins (the *minimum* a sub-strategy can present to be enabled) does not distinguish between "edge" and "coin flip". The exact one-sided binomial test below shows the threshold itself permits enablement of a strategy whose true win rate could be **23.7%**.

### Binomial confidence intervals (Wilson, 95%, two-sided)

For an observed 60% WR — a credible "this looks promising" datapoint — at varying sample sizes:

| n | k (60% WR) | Wilson 95% CI | One-sided p (H₀: p=0.5) | Distinguishable from random? |
|---|---|---|---|---|
| 5 | 3 | **[0.231, 0.882]** | 0.500 | NO |
| 10 | 6 | [0.313, 0.832] | 0.377 | NO |
| 20 | 12 | [0.387, 0.781] | 0.252 | NO |
| 50 | 30 | [0.462, 0.724] | 0.101 | NO |
| 80 | 48 | [0.498, 0.692] | 0.054 | borderline |
| **100** | **60** | **[0.503, 0.689]** | **0.028** | **YES** |
| 200 | 120 | [0.531, 0.665] | 0.0023 | YES (with margin) |

**Math shown for n=10, k=6 (the "minimum-passing" enablement scenario):**
Wilson center = (p̂ + z²/(2n)) / (1 + z²/n) = (0.6 + 1.96²/20) / (1 + 1.96²/10) = (0.6 + 0.192) / 1.384 = 0.572.
Wilson half-width = z·√(p̂(1-p̂)/n + z²/(4n²)) / (1 + z²/n) = 1.96·√(0.024 + 0.0096) / 1.384 = 1.96·0.183 / 1.384 = 0.260.
**95% CI: [0.313, 0.832].**

**Math shown for n=10, k=5 (the actual enable threshold — 50% WR):**
Wilson center = (0.5 + 0.192) / 1.384 = 0.500. Half-width = 1.96·√(0.025 + 0.0096) / 1.384 = 0.263.
**95% CI: [0.237, 0.763].** A "passing" strategy at the threshold could have a true win rate as low as **24%**.

**Math shown for n=20, k=5 (the disable threshold — 25% WR):**
Wilson center = (0.25 + 0.096) / 1.192 = 0.290. Half-width = 1.96·√(0.009375 + 0.0024) / 1.192 = 0.178.
**95% CI: [0.112, 0.468].** A "disabled-as-broken" strategy at threshold could have a true win rate up to **47%** — almost coin-flip — meaning we are killing strategies that may be perfectly fine.

### Minimum sample size to distinguish 60% WR from 50% at p<0.05 (one-sided)

By exact binomial: **n ≥ ~80** (one-sided p ≈ 0.054 at n=80,k=48; ≈ 0.028 at n=100,k=60). To get a Wilson lower bound **strictly above 0.5**, the minimum is **n = 100** (LB = 0.503).

### Recommendation

Raise thresholds to: **`min_resolutions_to_enable: 100`**, **`min_resolutions_to_disable: 100`**, and add a **lower-confidence-bound check** rather than a point-estimate check (i.e., advisor decides on Wilson LB > 0.5 to enable, Wilson UB < 0.5 to disable). Also: separate "promote to live with full size" (n ≥ 200) from "promote to live with reduced size" (n ≥ 100). The current single-step promotion is the wrong granularity.

**Severity: P0.** The current advisor will flip live strategies on and off based on noise, and the strategy weighter described in §E-5 will simultaneously *amplify* sizing on those noise-promoted strategies up to 2.0x.

---

## E-2 — R&D Purpose vs Implementation **[P1]**

The R&D engine *exists* and is wired correctly in three places:

1. **Schema view `v_strategy_performance`** (`polybot-v2/src/storage/schema.ts:366-412`) joins three subqueries: `trades` aggregated by `(strategy_id, sub_strategy_id, entity_slug)`, `resolutions` aggregated by the same key, and open `positions` aggregated by the same key. This is the right shape.
2. **Repository `getStrategyPerformance`** (`polybot-v2/src/storage/repositories/resolution-repo.ts:52-55`) reads the view.
3. **Strategy weighter** (`polybot-v2/src/risk/strategy-weighter.ts:71-114`) consumes the view rows and produces tier classifications, then plumbs into the position sizer.
4. **Strategy advisor** (`polybot-v2/src/risk/strategy-advisor.ts:266-280`) opens the *R&D database* (read-only, separate path) via `Database(this.config.rd_database_path, { readonly: true })` and reads the same view.

So at the high level, the chain of evidence is real. But:

- **The view has no `is_paper` filter** (`schema.ts:386-411`). It mixes paper and live trades into one performance row. In R&D-only DB this happens to be all paper. In live DB it would mix sources of truth. **P2** in current state (R&D and live use separate DBs per `rd-default.yaml:54` vs `default.yaml:54`), but it **becomes P1 the moment** you point the advisor at a unified DB or run paper trades inside the live DB for sandboxing.
- **The repository call `getStrategyPerformance()` does not filter by `entity_slug`** (`resolution-repo.ts:52-55`). The strategy weighter (`strategy-weighter.ts:75`) iterates `perfRows` and stuffs each row into a `Map` keyed by `(strategy_id, sub_strategy_id)`. **If two entities trade the same strategy, the second row overwrites the first**, silently dropping data and producing per-strategy weights that depend on dictionary insertion order. In a multi-entity R&D engine this is a correctness bug, not a performance issue. **P1.**

**Severity: P1.**

---

## E-3 — Look-ahead bias in resolution checker **[P2]**

`polybot-v2/src/risk/resolution-checker.ts:36-172`. Walked carefully:

- The checker hits the **live Polymarket Gamma API** for closed/winning state (`fetchGammaMarkets`, lines 175-203). It does not consult any pre-existing `markets.end_date` field for the resolution decision. End dates from local DB are not part of the resolution path. **No look-ahead from end_date.**
- `winning_outcome` and `winningTokenIds` come from Gamma API at the time of the check, not at the time of the trade. This is the *correct* usage — the truth value of the prediction is only knowable post-resolution.
- The local `markets` table's `end_date` column is **set on insert and never updated** (`market-repo.ts:6-31`, the `ON CONFLICT DO UPDATE SET` clause on lines 15-21 does **not** include `end_date`). So if a strategy snapshots the end date at signal-generation time, it is the same one the resolver later sees. **No retroactive end_date drift.**
- Strategies that read `end_date` (`favorites.ts:46`, `weather-forecast.ts:89`, `crypto-price.ts:69`, `convergence.ts:42`, `complement.ts:52`, `value.ts:37`) all read `market.end_date.getTime()` from the live cache. **As long as the cache is hydrated from the same immutable column, the time-to-resolve filter is honest.**
- One subtle issue: the `markets` row has `closed = excluded.closed` and `active = excluded.active` in the upsert (`market-repo.ts:17-18`), so a market's "closed" status *can* change retroactively in the local cache. However, strategies all check `if (market.closed) continue;` (e.g., `favorites.ts:42`) **before** generating a signal, and the signal records its own `created_at`. When the resolution checker later queries Gamma, the market is closed, so closed-status retroactivity is consistent with the market truly closing. No reflection bias here.

**No look-ahead bias identified in resolution-checker.ts.**

The minor risk: **Gamma API itself can be wrong at the moment of check** (price > 0.95 logic on `resolution-checker.ts:218-221` to identify a "winner" can mis-classify a market that has briefly spiked past 95% but is not actually settled). The `closed` flag from Gamma is the safety, but if Gamma is slow to flip `closed` while the price > 0.95 logic fires, you can record a false resolution. **P2.**

---

## E-4 — `v_strategy_performance` view correctness (R-7) **[P0]**

The view at `polybot-v2/src/storage/schema.ts:366-412`:

```
FROM   (SELECT strategy_id, COALESCE(sub_strategy_id,'') AS sub_strategy_id, entity_slug,
              COUNT(*) AS total_trades, SUM(usdc_size) AS total_volume
       FROM trades WHERE strategy_id IS NOT NULL
       GROUP BY strategy_id, COALESCE(sub_strategy_id,''), entity_slug) s
LEFT JOIN (SELECT strategy_id, COALESCE(sub_strategy_id,'') ..., COUNT(*) AS total_resolutions, ...
          FROM resolutions WHERE strategy_id IS NOT NULL
          GROUP BY strategy_id, COALESCE(sub_strategy_id,''), entity_slug) r
   ON s.strategy_id = r.strategy_id AND s.sub_strategy_id = r.sub_strategy_id AND s.entity_slug = r.entity_slug
LEFT JOIN (SELECT strategy_id, COALESCE(sub_strategy_id,'') ..., COUNT(*) AS open_count, ...
          FROM positions WHERE status = 'open' AND strategy_id IS NOT NULL
          GROUP BY strategy_id, COALESCE(sub_strategy_id,''), entity_slug) p
   ON s.strategy_id = p.strategy_id AND s.sub_strategy_id = p.sub_strategy_id AND s.entity_slug = p.entity_slug
```

### Verification walkthrough

| Concern | Verdict |
|---|---|
| GROUP BY on `(strategy_id, COALESCE(sub_strategy_id,''), entity_slug)` correct? | **YES** — uses the same `COALESCE('')` consistently across all three subqueries, so a row with sub_strategy_id NULL is unambiguously joined by `''`. |
| `win_rate` denominator? | `100 * wins / total_resolutions`, where `wins = SUM(realized_pnl > 0)`. **Correct numerator/denominator** — both come from the resolutions subquery. **Caveat:** `losses = SUM(realized_pnl <= 0)`, so a break-even resolution (pnl = 0) is counted as a *loss*. This biases win rate slightly downward. **P2.** |
| Strategies with trades but no resolutions? | LEFT JOIN handles this — `total_resolutions = 0`, `win_rate = 0` (via `CASE WHEN ... > 0 THEN ... ELSE 0`). **Correct.** |
| Strategies with resolutions but no current open positions? | LEFT JOIN handles this — `open_positions = 0`. **Correct.** |
| Strategies with resolutions but **no rows in `trades`** (e.g. trade record was deleted/migrated)? | **BROKEN.** The base of the FROM is the `trades` subquery `s`. If a strategy has resolutions but its trades have been pruned, the resolutions silently disappear from the view. **P1** under any normal operation; **P0** if you ever consider archiving old trades. |
| `is_paper` filter? | **MISSING.** Both paper and live trades, paper and live resolutions are pooled. R&D-only DB hides this; would corrupt any unified DB. See E-2. |

### Sample-data walkthrough (the "100/30/50" trace from track scope)

> 100 trades in `trades` table for `(favorites, compounding)` on `polybot`
> 30 of those 100 are resolved in `resolutions` table
> 50 are still open in `positions` table

What the view returns:

- `s` row: `total_trades = 100`, `total_volume = sum of usdc_size for all 100`.
- `r` row: `total_resolutions = 30`, `wins = #pnl>0`, `losses = #pnl≤0`, `win_rate = 100*wins/30`, `total_pnl = SUM(realized_pnl)`.
- `p` row: `open_count = 50` (from positions table).

So the view returns: `total_trades=100, total_resolutions=30, open_positions=50`.

**Critical R-7 finding:** `30 + 50 = 80 ≠ 100`. **The 20 missing trades are positions that have been closed but never resolved.** The schema has positions transitioning through `'open' → 'closed' → 'resolved'` (`schema.ts:167`), but `closePosition(... 'resolved')` is the *only* path that the resolution checker uses (`resolution-checker.ts:116`). A position can also be closed by stop-loss / take-profit (see `stop-loss-monitor.ts`) into status `'closed'`, never reaching a `resolutions` row. **Those trades are double-orphans:** they're counted in `total_trades` but contribute no PnL to `total_pnl` and don't appear in `open_positions`. The view will show them as "we have 100 trades, only 30 PnL events, 50 open" — and the operator will reasonably wonder where the missing 20 went.

**This is the R-7 prod-blocking question** referenced in the audit scope. The answer: **the view is incomplete because the schema has no first-class concept of "closed via stop-loss" → realized_pnl record outside the resolutions table.** Stops generate sells (which write a sell trade) but no resolution row.

**Recommendation:**
- Add a `v_strategy_performance` enhancement that joins `trades` aggregated by `side='SELL'` to capture stop-loss exits.
- OR write a synthetic resolution row whenever stop-loss closes a position with `winning_outcome = 'STOPPED'` and `realized_pnl = sell_price * size - cost_basis`. This is the cleaner option.
- Add `is_paper` to the GROUP BY and view columns.
- Add `entity_slug` filter at the repository layer (`getStrategyPerformance(entitySlug?)`).

**Severity: P0.** The view is the input to both the weighter and the advisor. Wrong view = wrong promotion decisions, wrong sizing.

---

## E-5 — Strategy weighter math correctness **[P1]**

`polybot-v2/src/risk/strategy-weighter.ts`.

### Tier logic verification (lines 82-103)

```
total_resolutions == 0 → 0.25, 'unproven', "data collection"
total_resolutions  < 5 → 0.4,  'unproven', "insufficient data"
win_rate >= 60 AND pnl > 0 → boost = min(2.0, 1.0 + (wr-60)/100), 'proven'
win_rate >= 40 AND pnl >= 0 → 0.6, 'promising'
else → 0.15, 'underperforming'
```

### Boundary tests

| Inputs | Expected tier | Actual (per code path) |
|---|---|---|
| WR=60.0001, pnl=0.01 | proven | proven (`>=60` is true, `>0` is true) — **OK** |
| WR=59.9999, pnl=any | promising or underperforming | falls to `>=40 && >=0` → promising if pnl≥0 — **OK** |
| WR=40.0, pnl=0.0 | promising | promising (`>=40 && >=0`) — **OK** |
| WR=39.9, pnl=-0.01 | underperforming | underperforming — **OK** |
| WR=80, pnl=10, n=4 | unproven (data) | unproven (n<5 short-circuits) — **OK** |
| WR=80, pnl=-1, n=10 | should be… underperforming? | **FALLS TO `else` → 'underperforming' weight 0.15.** Even at 80% WR, if PnL is negative (e.g., one big loss) it's killed. — sane. |
| **WR=60, pnl=0** (positive WR but exactly break-even) | promising? proven? | `>=60` is true but `>0` is false → falls to next: `>=40 && >=0` → **promising at 0.6**. — sane but loses the "proven" label. |
| **WR=100, pnl=1000, n=10000** | should not exceed 2.0x | `boost = min(2.0, 1.0 + 40/100) = 1.4`. **2.0x cap is never reached** at WR=100 because the formula caps at boost=`1.0 + (100-60)/100 = 1.4`. The `min(2.0, ...)` is a defensive cap that does nothing. — OK but the formula is *not* what the comment ("up to 2.0x") implies.

### Fallback chain (`strategy-weighter.ts:26-47`)

| Scenario | Behaviour |
|---|---|
| Sub has 0 resolutions, parent (`sub_strategy_id=''`) has 100 | **Parent does not exist as a row.** The view is keyed on `(strategy_id, COALESCE(sub_strategy_id,''))`, and signals always set `sub_strategy_id` (e.g., `favorites.ts:165`). So the parent row only exists if some old trade had a NULL `sub_strategy_id`. In practice, **the parent fallback is dead code** for current strategies. Falls through to the "average of all subs" branch. |
| All subs have different tiers (proven 1.4x, promising 0.6x, unproven 0.4x) | Average = (1.4 + 0.6 + 0.4) / 3 = **0.8x** — applies to a brand-new sub-strategy that wasn't in the data. Sane. |
| Sub is brand new AND parent doesn't exist AND no other subs | **Default 0.25** (line 46) — sane. |

### Critical interaction with position sizer **[P0]**

`polybot-v2/src/risk/position-sizer.ts:42-60` applies caps **before** the strategy weight:

```
sizeUsd = kellySize(...)
if (sizeUsd > pctCap) sizeUsd = pctCap                  // line 42-46
if (sizeUsd > max_position_usd) sizeUsd = max_position_usd  // line 49-53
sizeUsd = sizeUsd * stratWeight                          // line 56-60
```

So a "proven" strategy at 1.4x or 1.5x **bypasses** both the percentage cap and the absolute USD cap. With R&D config `max_position_usd: 50` (`rd-default.yaml:13`), a "proven" sub-strategy at WR=80 gets `1.0 + (80-60)/100 = 1.2x → $60 final size`. With WR=100 you get $70. **P0 in production.** The weight should be applied **before** the caps so caps still bind. The current order of operations gives the strategy weighter the power to override the position-size limit.

This is also the same bug that means the (theoretical) 2.0x cap on the weight is the *only* defense against the size limit being bypassed — and as shown above, that cap is never reached.

**Severity: P0** for the cap-bypass; **P1** for the dead parent fallback path; **P2** for the boundary cosmetic issues.

---

## E-6 — Feature engineering critique **[P1]**

`agi-feature-engineering` framing: a feature is a function of state-at-time-t that has *predictive* power on outcomes-at-t+k. A "model probability" is a posterior estimate `P(outcome | features)`. If `model_prob` is a deterministic function of `market_price` (the very thing it's supposed to disagree with), it cannot generate edge — it can only ratify the market.

### Audit of `model_prob` for each strategy

| Strategy.sub | `model_prob` formula | Class | Verdict |
|---|---|---|---|
| `favorites.compounding` | `price + payoff * 0.5` where `payoff = (1-price)/price` (`favorites.ts:57`) | Tautology | **Just a price-bucket filter dressed up.** Always > price, so always positive Kelly edge — meaningless. |
| `favorites.near_snipe` | same | Tautology | Same. |
| `favorites.stratified_bias` | same | Tautology | Same. |
| `favorites.fan_fade` | `underdog_price + 0.05` (`favorites.ts:122`) | Tautology | A flat additive 5% — independent of any feature. |
| `longshot.systematic_fade` | `min(0.99, fadePrice + 0.04)` (`longshot.ts:52`) | Tautology + magic number | The "expected edge" is hardcoded as `0.04` (line 50), with comment "~4% statistical edge from fading longshot bias". No source, no calibration. |
| `longshot.bucketed_fade` | `min(0.99, fadePrice + 0.06)` (`longshot.ts:94`) | Tautology + magic | Same, with `* 1.5` multiplier. |
| `longshot.news_overreaction_fade` | same as systematic | Tautology | The "news" claim is a placeholder per comment on line 105. |
| `value.statistical_model` | `price + 0.05` (`value.ts:65`) | Tautology | Constant 5% additive. |
| `value.positive_ev_grind` | `price + 0.08` (`value.ts:90`) | Tautology | Constant 8% additive. |
| `complement.intra_market_arb` | `0.95` constant (`complement.ts:89`) | Constant | Fine — this *is* arb; the probability is a placeholder (signal is the profit calc on lines 71-74). |
| `skew.probability_skew` | `up * 1.5` (`skew.ts:58`) | Tautology | Asserts "underdog is 1.5x more likely than priced", with no evidence. |
| `convergence.filtered_high_prob` | `cp + (1-cp) * 0.3` (`convergence.ts:76`) | Tautology | A 30% pull toward 1.0 — meaningless. |
| `convergence.long_term_grind` | `cp + 0.005` (`convergence.ts:110`) | Tautology | Flat half-percent additive. |
| **`weather_forecast.single_forecast`** | computed from forecast vs question range (`weather-forecast.ts:280-362`) | **Real model** | **Yes — actually computes `yesProbability` from a comparison of NWS/Open-Meteo forecast against the market's temperature target.** Has a real `forecastScore`, real `edge` calculation, real ensemble-spread confidence adjustment. This is the *only* well-formed `model_prob` in the codebase. |
| **`crypto_price.latency_arb`** | `normalCDF((current - target)/sigma)` (`crypto-price.ts:222-252`) | **Real model** | **Yes — actually computes a probability via a volatility-adjusted normal-CDF model from CoinGecko/Binance spot vs market target.** Real geometric Brownian motion approximation. Real model. |

### Result

- **2 strategies (weather, crypto) generate honest probability estimates from external features.**
- **6 strategies × 13 sub-strategies are heuristic price-bucket filters with `model_prob = market_price + ε`.** The Kelly edge they feed to the position sizer is whatever ε is — purely a sizing knob, not a probability.
- The R&D engine cannot tell the difference. To it, the heuristic strategies and the real-model strategies look identical. The weighter and advisor will rank the heuristic ones based purely on noise + structural payoff bias.

### What a real model would look like (per agi-feature-engineering)

For `favorites.compounding`, a credible model could include:
- Time-to-resolve (already in feature set, not used in `model_prob`).
- Liquidity (already in feature set, not used).
- Volume velocity (24h change).
- Distance from previous resolution time (markets older than X get a different prior).
- Cross-market correlation (do similar markets resolve to favorite at higher rate?).
- Polymarket category prior (sports markets vs politics markets have different favorite-resolution rates).
- A logistic regression / GBM trained on past resolved markets keyed on the above features.

None of this exists. The R&D engine has all the data to *build* it (resolutions table) but no scoring path other than the tautological one above.

**Severity: P1.** The heuristic strategies can produce data, and that data — once you have a real probability model — is recoverable. But promoting them based on sample-size hacking thresholds (E-1) and corrupted view aggregation (E-4) means the current pipeline is making decisions on noise.

---

## E-7 — Walk-forward validation existence check **[P0]**

Searched the entire `polybot-v2/` tree for `walk.?forward`, `out.?of.?sample`, `train.?test`, `cross.?valid`, `backtest`. **Zero matches.** None in source, none in scripts, none in config, none in tests.

There is also no historical-data harness in `polybot-v2/scripts/` — the scripts directory contains 50+ python helpers, all of which are either deployment fixers (`fix_*.py`), dashboards, or one-shot rebuilds. None do training/validation splits.

The closest thing to "validation" is the strategy advisor itself, but that operates on **production paper data accumulated over wall-clock time, not on a held-out sample of historical markets**. There is no temporal separation between training and evaluation data — every sub-strategy is evaluated in real-time on the same data it was generated on. This is an in-sample evaluation, full stop.

### Recommended walk-forward framework (per `agi-walk-forward-validation`)

Minimum viable setup:
1. **Anchored walk-forward**, 30-day windows. Train on days 1-30, validate days 31-37. Roll forward 7 days. Train days 1-37, validate 38-44. Roll. Etc.
2. **At least 6 windows** before promoting a sub-strategy — ensures consistency, not luck.
3. **Promotion gate**: a sub-strategy must show positive PnL in **≥4 of the last 6 windows** AND positive aggregate PnL across all windows AND Wilson LB on win-rate > 0.5 in the most recent 100-resolution window.
4. **Held-out test set**: the most recent 30 days are *never* used for training — only for final validation before live promotion.
5. **Track regime stability** (per `agi-regime-detection`): does the strategy work in volatile vs calm market regimes? Use a regime indicator (24h volume, market count) as a feature to compute regime-conditional win rate.
6. **Block bootstrapping** for confidence intervals on the aggregate PnL across windows — the resamples-with-replacement trick on contiguous blocks of trades to handle serial correlation.

### Why this matters

Without walk-forward, every "good performer" the R&D engine identifies suffers from selection bias: the strategies that *look* good are the ones whose noise lined up with reality during the observation window. There is no test that they generalize. Combined with E-1 (10-trade thresholds), the current promotion pipeline is essentially "keep whatever was lucky in the last few coin flips."

**Severity: P0.** This is the single most important missing piece in the R&D engine's claim to be a "validation laboratory."

---

## E-8 — R&D vs Live equivalence **[P0]**

The claim: "R&D and live use the same code path with different configs." Audit findings:

### Mode is auto-detected

`polybot-v2/src/core/engine.ts:62-64`:

```ts
const isRdMode = !config.entities.some(e => e.mode === 'live');
this.riskEngine = new RiskEngine(config.risk, isRdMode);
```

So "R&D mode" is **inferred** from the absence of any live entity in the entities list, not declared explicitly. **A live entity in the same engine instance disables the strategy weighter for all paper entities in that instance.** This is a P1 surprise — if you ever wanted to run paper validation alongside live trading, the weighter silently turns off.

### Risk parameters diverge between R&D and live configs

| Field | live (`default.yaml`) | R&D (`rd-default.yaml`) | Delta |
|---|---|---|---|
| `scan_interval_ms` | 300_000 (5 min) | 120_000 (2 min) | R&D 2.5x faster |
| `max_position_pct` | 0.10 | 0.05 | R&D more diversified |
| `max_position_usd` | $20.00 | $50.00 | **R&D 2.5x larger positions** |
| `daily_loss_lockout_usd` | $20.00 | $500.00 | **R&D 25x more loss tolerance** |
| `reserve_ratio` | 0.60 | 0.0 | R&D deploys 100% of capital |
| `trading_ratio` | 0.40 | 1.0 | same |
| `min_hold_hours` | 6 | 2 | R&D less patient |
| `paper_fill_delay_ms` | 500 | 200 | irrelevant |

**This is not "same code path with different configs" — it is "very different risk gates with different speed and capital constraints."** A strategy that hits its daily lockout on $20 loss in live config will trade for *25x more loss* in R&D before being stopped. So the R&D PnL will overstate live viability for any strategy with material drawdowns.

### Slippage model is fixed-bps, not regime-aware

`polybot-v2/src/execution/paper-simulator.ts:33`:

```ts
fillPrice = applySlippage(fillPrice, this.slippageBps, order.side === 'BUY');
```

`slippage_bps` is a constant (50 bps in both configs). Live execution will have **variable slippage that scales with order size, market liquidity, and book depth at the time of execution**. A constant 50 bps **systematically underestimates** slippage for thin markets and **overestimates** for deep ones — the bias is asymmetric and probably *favorable* (most R&D markets are thin, so real slippage > simulated). **R&D PnL will be optimistic vs live by an unknown amount.**

The fee assumption is hardcoded at 2% in `paper-simulator.ts:44` (`feeRate = 0.02`) — also constant. Real Polymarket fees are 0% maker / 2% taker, so this is conservative for taker but doesn't model maker rebates.

### Risk gates: same or different?

Examining `risk-engine.ts`: only **one** code path (`evaluate()`, line 24-164). The same gates run in both R&D and live, but with different `RiskLimits` injected. So the *structure* is shared. But:
- The weighter is *only* enabled in R&D-detected mode (`engine.ts:64`), so live trading has no per-strategy weight at all.
- The cap-bypass bug (E-5) only matters in R&D mode where the weighter is on.
- The daily-loss-guard (`daily-loss-guard.ts:30-35`) uses the same code path but different threshold ($20 vs $500).
- The lockout (`risk-engine.ts:28-37`) checks `entity.is_locked_out`, same for both.
- The position cap (`risk-engine.ts:73`), open orders cap (`:85`) — same path, different limits.

**Structural conclusion:** the *code* is shared, but the *configurations* are so different (especially the 25x daily-loss-lockout difference) that R&D PnL is **not** a faithful preview of live PnL. R&D will generate trade volume, drawdowns, and recovery patterns that live entities would never experience.

### Recommendation

- Run a "shadow live" entity in the R&D engine that uses the **live config** for risk gates and the **paper simulator** for execution. This is the actual validation surface.
- Replace the auto-detected `isRdMode` with an explicit `engine.weighter_enabled` config flag.
- Replace the constant slippage with a model: `slippage_bps = base_bps + size_factor * (order_size_usd / book_depth_usd)`. Even a crude one based on `liquidity` from the markets table is better than constant.
- Add a maker-vs-taker simulation distinguishing post-only orders from market orders.

**Severity: P0.** The current pipeline cannot make a defensible "this strategy will work live" claim from R&D data alone.

---

## E-9 — Portfolio analytics gaps **[P1]**

`agi-portfolio-analytics` framing: a trading system needs risk-adjusted return measures, not just total PnL.

Searched for: `sharpe`, `sortino`, `calmar`, `drawdown`, `max_dd`, `MAR ratio`, `peak.to.trough`, `time.weighted`, `money.weighted`.

| Metric | Status | File reference (or absence) |
|---|---|---|
| **Sharpe ratio** | **MISSING** | not in any `.ts`/`.js`/`.py` |
| **Sortino ratio** | **MISSING** | not in any file |
| **Calmar ratio (return / max DD)** | **MISSING** | not in any file |
| **Maximum drawdown** | **MISSING** | not in `daily-loss-guard.ts`, not in `snapshot-repo.ts`, not in dashboard |
| **Time-weighted return (TWR)** | **MISSING** | not computed; equity is point-in-time only |
| **Money-weighted return (IRR)** | **MISSING** | not computed |
| **Equity curve** | **MISSING** | snapshots are taken (`engine.ts:329-355`) but never plotted as a curve or analyzed for drawdown — only rendered as latest values in `dashboard/sse-server.ts:416` |
| **Win rate per strategy** | exists | `v_strategy_performance.win_rate` |
| **Profit factor (gross_wins / gross_losses)** | **MISSING** | could be derived but isn't |
| **Daily P&L distribution** | **MISSING** | only "today's running pnl" in `daily-loss-guard.ts` |
| **Per-trade R-multiple distribution** | **MISSING** | no R-multiples |
| **Sharpe of strategy weights** | **MISSING** | strategy weighter ranks by win rate + total pnl, not risk-adjusted |
| **Realized volatility** | **MISSING** | not computed |
| **Correlation between strategies** | **MISSING** | strategies are evaluated independently |

`daily-loss-guard.ts:30-35` has a hard daily-loss lockout but **does not track historical maximum drawdown**. It only knows "today's PnL crossed -$X."

`snapshots` table (`schema.ts:241-258`) records `total_equity`, `cash_balance`, `positions_value`, `daily_pnl`, `pnl_vs_deposit` — all the *raw inputs* for an equity curve and drawdown calculation are stored. But **no view, no script, no dashboard panel computes drawdown from them.**

### Why this matters

A strategy with 60% WR, $100 total PnL over 100 trades, that lost $400 on a single day before recovering is *worse* than a strategy with 55% WR, $100 PnL, max daily drawdown $20. The R&D promotion logic does not see the difference. The advisor would promote the high-volatility strategy.

### Recommendation

Add a `v_equity_curve` view that joins snapshots over time and computes:
- Rolling max equity (peak)
- Drawdown from peak (peak - current) / peak
- Max drawdown over window
- Daily returns: `(equity_t - equity_{t-1}) / equity_{t-1}`

Add a `v_strategy_risk_adjusted` view that computes per-strategy:
- Sharpe (mean / sd of per-trade R-multiples)
- Sortino (mean / downside sd)
- Profit factor

Add these to the advisor's promotion criteria, not just win rate and total PnL.

**Severity: P1** for each missing metric (5x P1 findings, rolled into one).

---

## E-10 — Probability calibration tracking **[P1]**

`agi-strategy-framework` framing: a strategy that says "I think this is 70% likely" and is right 50% of the time is not validated, even if it's profitable. Calibration is the property that *predicted* probability matches *empirical* frequency. Brier score is the standard measure. Reliability diagrams visualize it.

### Findings

- **Brier score:** zero implementations. Single mention in `value.ts:6` as a placeholder comment: `brier_calibrated: placeholder (requires historical calibration data)`. No code that computes it.
- **Reliability diagrams:** zero.
- **Per-bucket calibration:** zero. The R&D engine does not bin signals by predicted-probability bucket and check empirical frequency.
- **Logistic calibration / Platt scaling / isotonic regression:** none.

Even worse: as established in E-6, the only two strategies with real `model_prob` are `weather_forecast` and `crypto_price`. These two **could** be calibrated (their predictions are real probabilities). The other 13 sub-strategies have `model_prob = market_price + ε`, so calibration on them is meaningless because the prediction is structurally tied to the market.

### Recommendation

For the two real-model strategies:
1. After each resolution, log `(predicted_prob, actual_outcome_0_or_1)` to a `calibration_log` table.
2. Compute Brier score: `mean((predicted - actual)^2)` over rolling 100-resolution windows.
3. Build a reliability diagram: bucket predictions into deciles, plot empirical fraction won per bucket. Should be on the y=x line if calibrated.
4. If miscalibrated: apply Platt scaling (logistic regression of actual on predicted) and back-feed the corrected probability into the Kelly sizer.
5. If calibration drifts (Brier going up over time): automatic alert.

For the 13 heuristic sub-strategies: calibration is not applicable until they have a real `model_prob`. Tracking it would just measure how the constant ε relates to outcomes.

**Severity: P1.** Without calibration, the R&D engine has no way to know whether its probability claims are honest. The position sizer (`position-sizer.ts:30-35`) calls `kellySize(model_prob, market_price, ...)`, which assumes `model_prob` is a calibrated probability. If it's miscalibrated, Kelly sizing is wrong by definition.

---

## Cross-finding summary

| ID | Finding | Severity | File reference |
|---|---|---|---|
| E-1 | Advisor thresholds (n=10 / 50% WR) cannot distinguish noise from edge; need n≥100 + Wilson LB | **P0** | `strategy-advisor.ts:148-172`, `config/schema.ts:63-69` |
| E-2 | `getStrategyPerformance()` does not filter by entity_slug, weighter overwrites duplicate keys | **P1** | `resolution-repo.ts:52-55`, `strategy-weighter.ts:75` |
| E-3 | No look-ahead bias in resolution checker; minor risk from Gamma `closed` flag race | P2 | `resolution-checker.ts`, `market-repo.ts:15-21` |
| E-4 | `v_strategy_performance` doesn't account for stop-loss exits (R-7 question); 20 missing trades in 100/30/50 trace | **P0** | `schema.ts:366-412` |
| E-5 | Strategy weight applied AFTER position caps; "proven" strategies bypass `max_position_usd` | **P0** | `position-sizer.ts:42-60` |
| E-6 | 13 of 15 sub-strategies have `model_prob = market_price + ε` (tautology); only weather + crypto have real models | **P1** | `favorites.ts:57`, `longshot.ts:52,94`, `value.ts:65,90`, `skew.ts:58`, `convergence.ts:76,110` |
| E-7 | No walk-forward validation, train/test split, or out-of-sample testing anywhere | **P0** | (absence) |
| E-8 | R&D and live diverge in risk gates by 25x on daily-loss; weighter only on in R&D mode; constant slippage is biased | **P0** | `engine.ts:62-64`, `default.yaml` vs `rd-default.yaml`, `paper-simulator.ts:33,44` |
| E-9 | No Sharpe / Sortino / Calmar / drawdown / TWR / IRR / equity curve / Brier — only point-in-time equity | **P1** | `daily-loss-guard.ts`, `dashboard/sse-server.ts:416`, `engine.ts:329-355` |
| E-10 | No calibration tracking (Brier, reliability diagrams). Kelly assumes calibrated probability — invalid for 13 of 15 sub-strategies | **P1** | (absence) |

**P0 count: 5** (E-1, E-4, E-5, E-7, E-8).
**P1 count: 4** (E-2, E-6, E-9, E-10).
**P2 count: 1** (E-3).

### Adversarial review of each finding (obra-verification-before-completion)

- **E-1:** Could the threshold defaults be overridden? Searched all YAML in `config/`. No `advisor:` key. Defaults are in force. Confirmed.
- **E-2:** Does any caller pass entity_slug to `getStrategyPerformance`? `grep -rn "getStrategyPerformance"` shows two callers: `strategy-weighter.ts:72` (no arg) and `cli/index.ts` (verified — no arg). Confirmed.
- **E-3:** Could the strategies read `end_date` from a stale source? They read from `marketCache`, which is populated by `samplingPoller` upserting via `upsertMarket`, which doesn't update `end_date`. Cache hydration order matches DB. Confirmed safe.
- **E-4:** Could there be another code path that writes a resolution row on stop-loss? `grep -rn "insertResolution"`: only one caller, `resolution-checker.ts:96`. Stops never write resolutions. Confirmed.
- **E-5:** Could the cap be re-applied after the weight? `position-sizer.ts:62-66` does a final `roundTo` and floor check (>= $0.10), but no re-application of `max_position_usd` or `max_position_pct`. Confirmed cap-bypass.
- **E-6:** Could `model_prob` be derived from features I missed? Re-read each strategy. Confirmed each formula is purely a function of `market_price` and constants.
- **E-7:** Could walk-forward be in a script I missed? Re-grep'd `polybot-v2/scripts/*.py` — all 50+ scripts are deployment helpers / dashboard / one-shots. Confirmed absent.
- **E-8:** Could there be a unifying config that makes R&D risk match live? Both YAMLs are checked into the repo with the values shown. Confirmed divergence.
- **E-9:** Could analytics be in the dashboard JS? Grep'd `dashboard/static/*.html` — only computes `equity = cash + positionsValue`. No drawdown. Confirmed.
- **E-10:** Could calibration be in a sidecar? Grep'd entire `polybot-v2/`. Single mention is the placeholder comment in `value.ts:6`. Confirmed absent.

---

## Statistical Validity of Advisor Thresholds (consolidated section, per scope requirement)

### Question

The advisor's enable rule is: `total_resolutions ≥ 10 AND win_rate ≥ 50 AND total_pnl > 0`.
Is this statistically defensible? **No.**

### Binomial confidence intervals — full computation table

Wilson 95% two-sided CI for an observed 60% WR (k = 0.6n) at varying n:

| n | k | p̂ | Wilson lower | Wilson upper | One-sided exact p (H₀: p=0.5) |
|---|---|---|---|---|---|
| 5 | 3 | 0.600 | 0.231 | 0.882 | 0.500 |
| 10 | 6 | 0.600 | 0.313 | 0.832 | 0.377 |
| 20 | 12 | 0.600 | 0.387 | 0.781 | 0.252 |
| 50 | 30 | 0.600 | 0.462 | 0.724 | 0.101 |
| 80 | 48 | 0.600 | 0.498 | 0.692 | 0.054 |
| 100 | 60 | 0.600 | 0.503 | 0.689 | 0.028 |
| 200 | 120 | 0.600 | 0.531 | 0.665 | 0.0023 |

**Worked computation for n=10, k=6 (Wilson 95% CI):**
- z = 1.96
- Center = (p̂ + z²/(2n)) / (1 + z²/n) = (0.6 + 3.8416/20) / (1 + 3.8416/10) = (0.6 + 0.19208) / 1.38416 = 0.79208 / 1.38416 = **0.5723**
- Half-width = z·√(p̂(1-p̂)/n + z²/(4n²)) / (1 + z²/n) = 1.96·√(0.024 + 0.009604) / 1.38416 = 1.96·√0.033604 / 1.38416 = 1.96·0.18331 / 1.38416 = 0.3593 / 1.38416 = **0.2596**
- CI = [0.572 − 0.260, 0.572 + 0.260] = **[0.313, 0.832]**

### Worked computation at the actual enable threshold — n=10, k=5 (50% WR)

- p̂ = 0.5
- Center = (0.5 + 0.19208) / 1.38416 = 0.692 / 1.384 = **0.500**
- Half-width = 1.96·√(0.025 + 0.009604) / 1.38416 = 1.96·0.18603 / 1.38416 = **0.2634**
- **CI = [0.237, 0.763]**
- A "barely passing" sub-strategy at the enable threshold has a 95% probability that its true WR lies between **23.7% and 76.3%**.

### Worked computation at the disable threshold — n=20, k=5 (25% WR)

- p̂ = 0.25
- Center = (0.25 + 3.8416/40) / (1 + 3.8416/20) = 0.346 / 1.192 = **0.290**
- Half-width = 1.96·√(0.009375 + 0.0024) / 1.192 = 1.96·0.10852 / 1.192 = **0.1784**
- **CI = [0.112, 0.468]**
- A "barely failing" sub-strategy at the disable threshold has a 95% probability that its true WR lies between **11.2% and 46.8%** — i.e., it could be as good as 47% (only 3pp from random) and we're killing it.

### Minimum sample size for 60% WR to be statistically distinguishable from 50% at p<0.05 (one-sided)

By exact one-sided binomial test (H₀: p=0.5, observed = 0.6n wins):
- n = 50, k = 30: p ≈ 0.101 → reject? **No**
- n = 80, k = 48: p ≈ 0.054 → reject? **Borderline (no)**
- n = 100, k = 60: p ≈ 0.028 → reject? **YES**

By Wilson lower-bound > 0.5: **n ≥ 100** (LB at n=100,k=60 is 0.503).

**Recommended minimum: `min_resolutions_to_enable: 100`, `min_resolutions_to_disable: 100`.**
Replace point-estimate WR check with Wilson-LB-based check.

---

## Recommended next steps (no code, just direction)

Track E does not propose fixes. But for the audit consumer's planning:

1. **First fix (cheapest, biggest impact):** Raise `min_resolutions_to_enable` and `min_resolutions_to_disable` to 100. One-line config change. Eliminates the worst noise.
2. **Second fix:** Move `stratWeight` multiplication *before* the cap check in `position-sizer.ts`. Closes the cap-bypass.
3. **Third fix:** Add the synthetic-resolution-on-stop-loss path so `v_strategy_performance` includes all PnL events, not just market-resolved ones.
4. **Fourth fix:** Add `is_paper` and `entity_slug` filters to the view + repository call.
5. **Fifth fix:** Add the equity-curve / drawdown view from snapshots. Cheap, the data is already there.
6. **Sixth fix (weeks of work):** Build a real probability model for one heuristic strategy (start with `favorites.compounding` — most data, simplest market type) and replace the tautological `model_prob`.
7. **Seventh fix (multi-month):** Build the walk-forward harness from historical data exports.

---

**End of Track E findings.**
