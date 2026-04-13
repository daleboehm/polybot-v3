# Backtesting Integration Scoping — 2026-04-11

**Target:** `evan-kolberg/prediction-market-backtesting` (Phase 2.6)
**Decision:** Defer to post-R1/R2. Plan as **Option B (Python sidecar)** when unblocked.

## Summary

Active NautilusTrader-based repo (522 stars, daily commits, 145 MB) with
Polymarket + Kalshi adapters. Ships queue-position, latency injection, walk-forward
optimizer primitives, and pulls L2 orderbook history from PMXT (r2.pmxt.dev).
License is MIT at root + LGPL-3.0 for the adapter extensions; a subprocess
boundary from polybot-v3 cleanly avoids LGPL linking obligations.

## Key facts

| Dimension | Finding |
|---|---|
| Existence | Confirmed, branch `v2`, last push 2026-04-10 |
| Language | Python 3.12 + Rust 1.93 (Nautilus core) |
| License | MIT root / LGPL-3.0-or-later on adapter layer |
| Historical data | PMXT parquet (L2 deltas, hour-bucketed, r2.pmxt.dev) |
| Queue position sim | Built in (`queue_position` flag in `ExecutionModelConfig`) |
| Latency sim | Built in (`base/insert/update/cancel_latency_ms`) |
| Maker/taker fills | Built in (liquidity_side tracked) |
| Walk-forward | Built in via `_optimizer.py` (train_windows + holdout_windows) |
| Brier / reliability | **Missing** — add in TS post-processor |
| Neg-risk fill mechanics | **Partial** — Gamma parses neg-risk fields; no specialized fill logic |
| Tick enforcement | Data yes, execution no |
| Slippage depth model | Defaults only, no custom depth-consumption |

## Execution realism: 4/5

Queue position + latency + partial fills + post-only + L2 simulator. Dings for
no custom depth model, no tick enforcement in the adapter, no neg-risk mechanics,
no resolution-day UMA dispute modeling (our trailing-lock logic can't be fully
exercised here without extensions).

## Integration options

| Option | Description | Effort | Risk |
|---|---|---|---|
| **A** | Port Polymarket fetcher to TS + build our own backtester | 3-5 weeks | Re-implement PMXT parquet reader, queue-position, latency, walk-forward, Brier — highest maintenance tax |
| **B** ⭐ | Python sidecar — `backtest-runner/` subdir, TS calls via `child_process.spawn`, consumes JSON summary + trades CSV | 1-2 weeks | License-clean (subprocess = not linking); keeps TS monorepo pure; leverages active upstream |
| **C** | Fork + migrate strategies to Python | 4-8 weeks | Code-base bifurcation, LGPL adoption, Python-Rust toolchain on VPS |

## Recommendation

**Option B (Python sidecar)** — but NOT until R1 + R2 clear.

### Rationale
1. PMXT historical L2 data alone is worth the integration cost — we have zero
   historical book depth today
2. Queue position + latency injection are non-trivial to build; reusing them
   saves 2-3 weeks vs. Option A
3. `_optimizer.py` gives windowed train/holdout primitives for free
4. Subprocess boundary is license-clean
5. Polybot-v3 stays TypeScript-pure with one sidecar directory
6. Brier + reliability diagrams become a simple TS post-processor over the
   trades CSV — slots cleanly under our existing `v_strategy_performance`
   pattern

### Watch-outs
- **PMXT coverage** may not cover our full resolved-positions window
  (100-500 trades/sub-strategy). Validate coverage BEFORE committing integration
  work.
- **No Brier/calibration** ships with the harness — budget 2-3 days to add
  over the trades CSV output
- **UMA/resolution mechanics** can't be tested without extending the adapter
  (our trailing-lock + NO-LOSE exit logic lives outside this harness)
- **Rust 1.93 build requirement** means the VPS needs a real toolchain OR we
  use prebuilt wheels

## Sequencing

This is **deferred** in the rebuild plan (see `spicy-puzzling-robin.md`):

- **R1 gate** must clear first (resolution pipeline, phantom fee, sizer reorder,
  kill switch, `/health`, backups). Prod still paused.
- **R2 gate** must clear next (real strategy models, walk-forward in-house via
  `v_strategy_performance` SQL, Wilson LB gating, Brier calibration added).
- **Phase 2.6** slots into R2 Week 4 or R3a Week 1 as an accelerator AFTER
  R2's in-house walk-forward ships. By that point we'll know whether the
  in-house harness is sufficient (and we skip this integration) or we hit
  its limits (and this becomes the next step up).

## Do-not-do-now

- Do NOT clone the repo and start porting strategies
- Do NOT set up the Python sidecar before R2 clears
- Do NOT treat this as a replacement for the R2 walk-forward work — the in-house
  SQL-view walk-forward is the audit's critical path and ships first

## Re-evaluate when

- R2 verification gate clears AND at least one sub-strategy has crossed
  Wilson LB at n≥30 on live R&D data
- OR R2 in-house walk-forward reveals a blocker we can't solve in SQL
  (e.g., queue-position modeling, realistic maker fill rates on thin books)

## File references

- Polybot source: `polybot-v3/src/validation/` (where R2's in-house walk-forward will live)
- Rebuild plan: `Polymarket/docs/spicy-puzzling-robin.md` R2 section
- This memo: `Polymarket/docs/backtesting-scoping-2026-04-11.md`
