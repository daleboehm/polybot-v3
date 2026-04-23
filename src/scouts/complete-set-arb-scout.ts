// Complete-set arb scout — 2026-04-21 (Dale research item #2).
//
// Detects binary markets where YES + NO sum < 1.0 after fees, creating
// a guaranteed-payout arbitrage by buying both sides. Since exactly one
// side must pay out $1 at resolution (binary markets, non-neg-risk), if
// we buy 1 share of YES at $P_yes and 1 share of NO at $P_no for total
// cost P_yes + P_no < 1, we guarantee a profit of 1 - (P_yes + P_no)
// minus trading fees.
//
// Fills a gap NOT covered by existing scouts:
//   - negrisk_arbitrage (strategy): SUM of YES prices across a
//     neg-risk CLUSTER (multiple outcomes) — different math.
//   - cross-market-arb-scout: monotonicity violations across linked
//     numeric-threshold markets — different pattern.
//   - This scout:            SUM of YES + NO within ONE binary market.
//
// Thresholds:
//   - Must clear round-trip taker fees on BOTH sides. Worst category
//     (crypto) = 1.80% peak per side, so round-trip max ~3.6%. Require
//     sum < 0.965 to leave a margin.
//   - Skip markets where either side is <0.02 (dust/stale prices).
//   - Skip neg-risk markets (already handled by negrisk_arbitrage).
//
// Output: writes priorities to the market_priorities table with
// descriptive reason strings. Observation-only; no strategy acts on
// these yet. v2 will add an execution strategy that fires on the
// priorities.
//
// Exchange-agnostic: works on V1 USDC.e and V2 pUSD identically —
// the arb math is about the sum, not the collateral token.

import { ScoutBase, type ScoutRunResult } from './scout-base.js';
import type { MarketCache } from '../market/market-cache.js';
import { insertPriority } from '../storage/repositories/market-priority-repo.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('scout:complete-set-arb');

// Sum threshold. Need sum < this to flag. 0.965 leaves ~3.5% margin
// after worst-case round-trip fees + slippage.
const SUM_THRESHOLD = 0.975;  // 2026-04-23 Phase 3: 0.965→0.975 broadens arb window (still clears 2% round-trip fees)

// Floor on individual side price — reject dust/stale orderbook reads.
const MIN_SIDE_PRICE = 0.02;

// Cap: if sum is absurdly low (< 0.5), almost certainly a stale-book
// artifact not a real arb. Flag only the plausible band.
const MIN_SUM = 0.50;

// Priority TTL
const PRIORITY_TTL_MS = 10 * 60 * 1000;

// Rate-limit per market so we don't spam priorities on slow book updates
const FLAG_RATE_LIMIT_MS = 5 * 60 * 1000;

export class CompleteSetArbScout extends ScoutBase {
  readonly id = 'complete-set-arb-scout';
  readonly description = 'Detect YES+NO sum-of-prices arb in individual binary markets';

  private lastFlaggedAt = new Map<string, number>();

  constructor() {
    super();
    this.log = createChildLogger(`scout:${this.id}`);
  }

  run(marketCache: MarketCache): ScoutRunResult {
    const markets = this.getCandidateMarkets(marketCache, 1, 168); // 1h to 7d horizon
    const now = Date.now();

    let evaluated = 0;
    let flagged = 0;
    let prioritiesWritten = 0;
    let biggestGap = 0;
    let biggestGapCid = '';

    for (const m of markets) {
      // Skip neg-risk — handled by negrisk_arbitrage strategy
      if (m.neg_risk_market_id) continue;

      const yesPrice = m.yes_price;
      const noPrice = m.no_price;
      if (!yesPrice || !noPrice) continue;
      if (yesPrice < MIN_SIDE_PRICE || noPrice < MIN_SIDE_PRICE) continue;
      if (yesPrice >= 1 || noPrice >= 1) continue;

      evaluated++;
      const sum = yesPrice + noPrice;

      // Track biggest gap for summary even if we don't flag
      const gap = 1 - sum;
      if (gap > biggestGap) {
        biggestGap = gap;
        biggestGapCid = m.condition_id;
      }

      if (sum >= SUM_THRESHOLD || sum < MIN_SUM) continue;
      flagged++;

      // Rate-limit per market
      const lastFlag = this.lastFlaggedAt.get(m.condition_id);
      if (lastFlag && (now - lastFlag) < FLAG_RATE_LIMIT_MS) continue;
      this.lastFlaggedAt.set(m.condition_id, now);

      const gapPct = (gap * 100).toFixed(1);
      const reason =
        `complete-set arb: YES=${yesPrice.toFixed(3)} + NO=${noPrice.toFixed(3)} = ${sum.toFixed(3)}, ` +
        `gap=${gapPct}% (buy both sides for guaranteed $1 payout)`;

      const priority = Math.min(10, 7 + this.tickSizePriorityBonus(m.minimum_tick_size));
      insertPriority({
        condition_id: m.condition_id,
        priority,
        reason,
        created_by: this.id,
        ttl_ms: PRIORITY_TTL_MS,
      });
      prioritiesWritten++;
    }

    // GC old rate-limit entries
    if (this.lastFlaggedAt.size > 5000) {
      const stale = now - FLAG_RATE_LIMIT_MS * 2;
      for (const [k, t] of this.lastFlaggedAt) {
        if (t < stale) this.lastFlaggedAt.delete(k);
      }
    }

    const summary = prioritiesWritten > 0
      ? `${prioritiesWritten} arb markets flagged of ${evaluated} evaluated (biggest gap ${(biggestGap * 100).toFixed(1)}%)`
      : null;

    if (prioritiesWritten > 0) {
      log.info({
        flagged,
        priorities: prioritiesWritten,
        evaluated,
        biggest_gap_pct: (biggestGap * 100).toFixed(1),
        biggest_cid: biggestGapCid.substring(0, 16),
      }, 'Complete-set-arb findings');
    }

    return {
      scout_id: this.id,
      priorities_written: prioritiesWritten,
      intel_written: 0,
      markets_evaluated: evaluated,
      summary,
    };
  }
}
