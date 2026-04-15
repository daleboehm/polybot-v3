# Longshot 0.83-dead-zone diagnosis — 2026-04-15

**Question (from `docs/todo.md` next-actionable #5):** `longshot.news_overreaction_fade` has 71.7% WR on n≥50 but -$37.30 total P&L. Execution slippage or exit timing?

**Answer:** neither. It's **structural payoff asymmetry concentrated in two entry-price bins (0.83 and 0.84) that lose ~$102 of P&L between them** — more than the full longshot strategy deficit. Everywhere else the strategy is either clearly profitable or near break-even.

## Method

All numbers pulled from `/opt/polybot-v3-rd/data/rd.db resolutions` where `strategy_id = 'longshot'` as of 2026-04-15 17:30 UTC. n=664 resolved longshot fade positions across all three sub-strategies. Fresh R&D data is a superset of the snapshot the todo was written against (664 vs ~157).

## Sub-strategy P&L

| sub                    |   n | WR    | total P&L | avg_win | avg_loss |
|------------------------|----:|------:|----------:|--------:|---------:|
| bucketed_fade          | 217 | 82.0% |   +$31.84 |  $1.04  |  -$3.93  |
| news_overreaction_fade | 323 | 75.5% |   -$19.88 |  $1.61  |  -$5.23  |
| systematic_fade        | 124 | 86.3% |   -$30.74 |  $0.44  |  -$4.59  |
| **total**              | 664 | 79.1% |   -$18.78 |         |          |

All three subs share the same underlying problem shape — the winner is the one with the best avg_win / avg_loss ratio, not the highest WR. systematic_fade wins 86% of the time and still loses, because its avg_win is $0.44.

## Per-entry-price-bin breakdown (the real story)

This is a 1¢-wide bucket count across ALL longshot subs (bucket = `ROUND(cost_basis / size, 2)`, i.e. actual fill price on the fade side):

| entry |   n | WR    |   total pnl | avg_win | avg_loss |
|------:|----:|------:|------------:|--------:|---------:|
| 0.80  |  48 | 77%   |     **+$47.3** | $2.40   | -$3.76   |
| 0.81  |  12 | 58%   |       -$1.6 | $2.29   | -$3.52   |
| 0.82  |  42 | 81%   |     **+$41.3** | $2.02   | -$3.42   |
| **0.83**  |  **50** | **58%**   |     **-$71.8** | **$1.85**   | **-$5.98**   |
| **0.84**  |  **34** | **74%**   |     **-$30.1** | **$1.74**   | **-$8.18**   |
| 0.85  |  41 | 78%   |       +$9.1 | $1.91   | -$5.76   |
| 0.86  |  40 | 78%   |       -$1.2 | $1.61   | -$5.67   |
| 0.87  |  46 | 80%   |       -$0.2 | $1.35   | -$5.58   |
| 0.88  |  27 | 81%   |       -$1.5 | $1.32   | -$6.11   |
| 0.89  |  29 | 72%   |      -$18.7 | $1.10   | -$5.22   |
| 0.90  |  40 | 83%   |      +$13.5 | $1.06   | -$3.08   |
| 0.91  |  31 | 87%   |       +$3.9 | $0.90   | -$5.11   |
| 0.92  |  26 | 73%   |      -$15.0 | $0.83   | -$4.41   |
| 0.93  |  53 | 85%   |       -$5.6 | $0.60   | -$4.09   |
| 0.94  |  37 | 81%   |       -$8.7 | $0.58   | -$3.71   |
| 0.95  |  21 | 95%   |       +$8.8 | $0.45   | -$0.26   |
| 0.97  |  14 | 93%   |       +$2.7 | $0.23   | -$0.35   |
| 0.98  |  25 | 88%   |       +$2.9 | $0.17   | -$0.24   |
| 0.99  |  39 | 95%   |       +$3.5 | $0.11   | -$0.22   |

**The two bins 0.83 and 0.84 lose −$101.9 combined** — more than the entire longshot strategy's −$18.8 total. Everywhere else, the strategy is either net profitable (0.80, 0.82, 0.85, 0.90, 0.95+) or slightly negative in a way that's within noise for n~30-50 per bin.

The WR anomaly is also clearest at 0.83 and 0.84: every other bin in the table has a WR between 72% and 95%, but 0.83 sits at **58%** and 0.81 (n=12, too small to matter) at 58%. 20 percentage points below the surrounding bins is not noise at n=50 — it's a selection effect.

## Why 0.83-0.84 specifically

These bins are dominated by `news_overreaction_fade` (tailPrice 0.10-0.20 → fadePrice 0.80-0.90). The name implies it's catching markets where hype pushed the tail from an obvious 5¢ longshot up to 17¢. The data says what it's ACTUALLY catching is markets where the tail got bid from 5¢ to 17¢ **because of real information** — and the "fade" trade is wrong 42% of the time.

Candidate drivers (can't distinguish from this data alone):
1. **Informed flow at the 15-17¢ price point.** When a longshot is priced at 15¢, it often reflects real news that the fade-side bots don't see. Buying the fade at 83-84¢ lands on the losing side of informed flow.
2. **Scout overlay amplification.** `applyScoutOverlay()` fires on volume spikes, price jumps, and LLM news scout output. Those scouts are MORE likely to trigger on markets that just moved from 5¢ to 17¢ (volume spike + price jump). So the multiplier stack inflates position size EXACTLY on the markets that turn out to be informed flow, not overreaction. This is the "correlated mistake" that doubles losses.
3. **Stop-loss half-triggers.** In the 0.85-0.90 band above, 43-73% of losses are early exits (sell at ~$4 of an $10 cost basis). In 0.83-0.84, losses are bigger (-$5.98, -$8.18) which suggests the stop is catching them later or not at all. The stop-loss geometry may be too loose for fades in this band.

## Proposed fix — NOT YET IMPLEMENTED

**Filter: skip fade entries when `fadePrice ∈ [0.825, 0.85)`** — equivalently, require tail EITHER `≤ 0.175` OR `> 0.175` with a discontinuity. The cleanest code-level form:

```ts
// Inside longshot.evaluate(), immediately after computing fadePrice/tailPrice:
// 2026-04-15 dead-zone filter: the 0.83-0.84 fadePrice band is where
// informed-flow contamination concentrates (see
// docs/longshot-0.83-dead-zone-2026-04-15.md). R&D data shows n=84
// losing -$102 combined — more than the full longshot deficit.
if (fadePrice >= 0.825 && fadePrice < 0.85) continue;
```

Hypothesized impact over the same 664-trade universe:
- Drops 84 trades worth -$101.9 of P&L
- Leaves +$82.9 total over 580 trades (roughly +$0.14/trade)
- Flips longshot from -$0.03/trade to +$0.14/trade

**Exit criterion** (commitment 7.1): if we ship this filter and don't see longshot per-trade P&L climb from ~-$0.06 to **≥ +$0.09** over the next 100 paper trades, the filter was overfit and we roll it back.

## Why I'm NOT shipping this without approval

This is a one-slice post-hoc finding on a single engine's R&D history. Specifically I can't distinguish between:
- **Real effect** (informed-flow contamination, a fixable cause we should filter against permanently)
- **Selection artifact** (scout firing pattern that happens to cluster in this band for reasons that won't generalize)
- **Noise** (50-trade bins with 20-pp WR deltas look convincing but CIs are wide)

Partnership commitment 7.3 says: push back hard when the plan looks eager. The eager plan is to ship the filter now. The better plan is:
1. **Dale reviews this memo** and says "interesting, ship it" or "wait — I want to check the scout overlay contribution first" or "no, this is overfitting".
2. If shipped, it lands as a single-commit R&D change behind a config flag (`longshot.dead_zone_filter: true` in yaml), not a hard code path.
3. R&D burn-in for 72h or 100 trades post-ship, whichever comes first.
4. If P&L trend confirms, include in the next live cap-raise release. If not, flag off + postmortem.

No code changes from this memo yet. Filter proposal is on the shelf.
