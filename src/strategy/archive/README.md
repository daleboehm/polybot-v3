# Quarantined Strategies — DO NOT IMPORT

> **Status**: QUARANTINED (R2 PR#1, 2026-04-10)
> **Deletion target**: Day 31 from quarantine date — **2026-05-10**
> **Removed from**: `strategy-registry.ts`, `engine.ts` imports, `entities.yaml` strategy lists

---

## What's in here

| File | Why it's archived |
|---|---|
| `value.ts` | Fabricated edge: `model_prob = price + 0.05` / `price + 0.08`. No empirical thesis. |
| `skew.ts` | Fabricated edge: `model_prob = up * 1.5`. Systematically opposed to longshot — two strategies taking opposite sides on the same markets. |
| `complement.ts` | "Arbitrage" that's actually directional — only bought YES side. `model_prob = 0.95` hardcoded. Not a real two-leg atomic arb. |

All three had tautological `model_prob` values that were arithmetic on `market_price`.
Per the 2026-04-09 audit §6.3 and `agi-kelly-criterion`: a strategy whose probability
model IS the market price (plus a constant) mathematically cannot generate alpha
against the market — Kelly sizing on such a model is a random walk with drift toward
ruin.

## Why quarantined and not deleted immediately

Per Dale's 2026-04-10 decision (rebuild-plan §4 R2): 30-day safety window in case any
in-progress work or historical analysis references them. On 2026-05-10 these files
and this README get deleted entirely. Git history preserves them if a future
investigation needs to reference the old logic.

## Replacement strategies

Not all quarantined strategies are being rebuilt — some were fundamentally flawed:

- **value / skew**: not being rebuilt. The core theses were wrong. If future research
  produces a real value or skew model, it will be a greenfield implementation.
- **complement**: not being rebuilt as a single-side directional. A real two-leg
  atomic cross-leg arb is R4 low-priority scope, unrelated to this file.

The remaining strategies (favorites, longshot, convergence, weather_forecast,
crypto_price) are being rewritten in R2 PR #1 to use historical base-rate calibration
(`src/validation/base-rate-calibrator.ts`) instead of arithmetic-on-price.

## Do not restore any of these files to `strategy/custom/` without explicit signoff.
