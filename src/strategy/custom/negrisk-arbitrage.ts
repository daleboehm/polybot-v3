// NegRisk combinatorial arbitrage — buy every outcome in a mutually-exclusive
// NegRisk family when the sum of YES prices is below $1.00 (less fees/slippage).
//
// Thesis (Saguillo et al. 2025 / arXiv 2412.18989-adjacent):
//   41% of Polymarket multi-outcome market conditions have sum-of-probability
//   violations. For an EXHAUSTIVE NegRisk family (guaranteed to have exactly
//   one winner among the listed outcomes), buying all YES legs for a total
//   cost < $1.00 is risk-free: one leg pays $1.00 at resolution, the others
//   go to $0, net profit = $1.00 − Σ(entry_price).
//
// The hard part is identifying EXHAUSTIVE families. Polymarket NegRisk groups
// allow an implicit "none of the above" outcome — in those families the sum
// can be well below 1.00 and still be fair (the gap is the market's estimate
// of the unlisted outcome). A blind "buy all if sum < 1.00" loses money on
// non-exhaustive families when "none" actually resolves.
//
// Safety filters for the first implementation:
//   1. Min family members: 3 (binary 2-outcome families are riskier —
//      a "YES/NO/neither" market shows up as 2 members with implicit
//      "neither" pricing the gap).
//   2. Sum-of-YES range: [0.85, 0.97]. Below 0.85 is almost certainly a
//      family with a dominant "none" probability; above 0.97 there's no
//      profit after slippage. Between those bounds, the family is plausibly
//      exhaustive and mispriced enough to be worth the risk.
//   3. Conservative per-leg sizing: $4 default. A 10-member family commits
//      $40 for ~$0.50 − $1.50 of EV. Small absolute P&L but clean alpha
//      signal for the advisor to promote.
//   4. Max family size: 25. Caps total exposure at $100 per family. Larger
//      families are typically 2028-election-style markets where individual
//      outcomes are priced near their base rate and the arb is either
//      noise-level or already being harvested by faster actors.
//   5. Per-family dedup: once we fire on a family, skip re-entry for
//      DEDUP_TTL_MS. Even if the sum stays below 0.97 the next scan, we
//      don't re-stack the same position.
//   6. Existing-position skip: if any leg of the family is already in our
//      open-position set, we've already entered — don't double up.
//
// Execution notes:
//   - We use `last_yes_price` (MarketCache's yes_price, which tracks
//     orderbook midpoint when a snapshot is available). In a production
//     version we'd use best_ask for the leg we'd actually pay — slippage
//     buffer in the [0.85, 0.97] threshold is intended to absorb the gap.
//   - Fire N BUY signals in a single evaluate() cycle. The engine processes
//     them sequentially in shuffle order; partial fills leave residual
//     exposure but still positive EV at the size we're using.
//   - Exits use the default stop-loss / profit-target / hard-stop plumbing.
//     A future enhancement: hold-to-settlement flag on NegRisk-arb positions
//     so we capture the full $1.00 redemption rather than exiting on
//     mid-life price swings.

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal, MarketData } from '../../types/index.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger('strategy:negrisk-arb');

// Thresholds
const MIN_FAMILY_MEMBERS = 3;
const MAX_FAMILY_MEMBERS = 25;
const MIN_SUM_YES = 0.85;
const MAX_SUM_YES = 0.97;
const DEFAULT_LEG_SIZE_USD = 4;
// 2026-04-20: cap per-leg price to avoid partial-basket bleed. R&D data
// (n=184, 19% WR, -$64 total) showed a clear split: tail legs < $0.10
// earned +$37 on n=39, mid legs $0.25-$0.50 LOST -$127 on n=74. Hypothesis:
// with equal-share basket sizing, mid-priced legs tie up enough capital
// per leg that risk-engine caps reject later legs in the same family -
// the basket math breaks when partial. Tails stay cheap enough that even
// a partial basket is net-positive on accumulated tail wins across many
// families. Full partial-basket diagnosis in docs/todo.md.
const MAX_LEG_PRICE = 0.15;
const DEDUP_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours — don't re-stack same family

export class NegRiskArbitrageStrategy extends BaseStrategy {
  readonly id = 'negrisk_arbitrage';
  readonly name = 'NegRisk Combinatorial Arbitrage';
  readonly description =
    'Buy every outcome in a NegRisk family when Σ YES prices < 1.00 (exhaustive-family assumption)';
  readonly version = '3.0.0';

  readonly SUB_ID = 'buy_the_set';

  private recentFamilies = new Map<string, number>(); // neg_risk_market_id -> ts

  override getSubStrategies(): string[] {
    return [this.SUB_ID];
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    this.cleanupDedup();

    if (!this.isSubStrategyEnabled(ctx, this.SUB_ID)) return [];

    const markets = ctx.getActiveMarkets();
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id),
    );

    // Group active markets by neg_risk_market_id
    const families = new Map<string, MarketData[]>();
    for (const m of markets) {
      if (!m.neg_risk || !m.neg_risk_market_id) continue;
      if (!m.active || m.closed) continue;
      if (m.yes_price === null || m.yes_price === undefined) continue;
      if (m.yes_price <= 0 || m.yes_price >= 1) continue;
      const arr = families.get(m.neg_risk_market_id);
      if (arr) {
        arr.push(m);
      } else {
        families.set(m.neg_risk_market_id, [m]);
      }
    }

    const signals: Signal[] = [];
    let familiesExamined = 0;
    let familiesInArbZone = 0;

    for (const [familyId, members] of families.entries()) {
      familiesExamined++;

      // Size filter
      if (members.length < MIN_FAMILY_MEMBERS) continue;
      if (members.length > MAX_FAMILY_MEMBERS) continue;

      // Skip if already holding any leg of this family
      const alreadyIn = members.some(m => existingPositions.has(m.condition_id));
      if (alreadyIn) continue;

      // Dedup by family
      if (this.recentFamilies.has(familyId)) continue;

      // Compute sum of YES prices
      let sumYes = 0;
      for (const m of members) sumYes += m.yes_price!;

      if (sumYes < MIN_SUM_YES || sumYes > MAX_SUM_YES) continue;

      // 2026-04-20 partial-basket defense: skip families where any leg
      // price exceeds MAX_LEG_PRICE. See R&D data analysis in the
      // constant's comment above.
      const maxLegPrice = Math.max(...members.map(m => m.yes_price!));
      if (maxLegPrice > MAX_LEG_PRICE) continue;

      familiesInArbZone++;

      // Basket-level economics. An EXHAUSTIVE negrisk family guarantees
      // exactly one leg resolves to $1.00, so the arb requires EQUAL SHARE
      // COUNTS across every leg (NOT equal dollar amounts).
      //
      // Bug we're fixing (discovered 2026-04-16 post-deploy):
      //   v1 of this strategy set `recommended_size_usd = DEFAULT_LEG_SIZE_USD`
      //   uniformly across all legs. With equal dollars, share counts differ
      //   by leg price — the winning leg determines payout and within the
      //   fair-price assumption the expected payout exactly equals the cost.
      //   The basket edge collapses to zero. You only capture the (1 − Σp)
      //   edge when you buy the SAME number of shares on every leg.
      //
      // Correct math:
      //   Let target_basket_usd = DEFAULT_LEG_SIZE_USD × N (roughly the size
      //   v1 intended to spend). To buy equal shares and land on that basket
      //   budget, target_shares_per_leg = target_basket_usd / sumYes. Per-leg
      //   cost = target_shares_per_leg × leg_price. Guaranteed payout at
      //   resolution = target_shares_per_leg × $1. Guaranteed profit =
      //   target_shares × (1 − sumYes) = target_shares × basketEdge.
      const basketEdge = 1 - sumYes;
      const targetBasketUsd = DEFAULT_LEG_SIZE_USD * members.length;
      const targetSharesPerLeg = targetBasketUsd / sumYes;
      const guaranteedPayoutUsd = targetSharesPerLeg; // $1 × shares
      const guaranteedProfitUsd = guaranteedPayoutUsd - targetBasketUsd;
      // Per-leg edge seen by risk engine — the whole basket delivers a
      // (1 − sumYes) return on cost. Every leg contributes to that same
      // basket-level return, so we expose `basketEdge` as each leg's edge.
      const perLegEdge = basketEdge;

      log.info({
        family_id: familyId.substring(0, 14) + '...',
        members: members.length,
        sum_yes: +sumYes.toFixed(4),
        basket_edge: +basketEdge.toFixed(4),
        target_shares_per_leg: +targetSharesPerLeg.toFixed(2),
        target_basket_usd: +targetBasketUsd.toFixed(2),
        guaranteed_profit_usd: +guaranteedProfitUsd.toFixed(2),
      }, 'NegRisk arb family detected');

      for (const m of members) {
        // model_prob: for a fair exhaustive family the true prob of this leg
        // winning is unknown — but across the basket, exactly one leg will
        // resolve to 1.00 and the rest to 0. Using p = yes_price + (basketEdge
        // / N) attributes the edge evenly; this is just a scorecard number
        // for the risk engine, the real edge is at the basket level.
        const modelProb = Math.min(0.99, m.yes_price! + basketEdge / members.length);
        // Per-leg dollar size that keeps share count constant across the
        // basket. Round to the nearest cent so we don't send odd precision.
        const legSizeUsd = +(targetSharesPerLeg * m.yes_price!).toFixed(2);

        signals.push({
          signal_id: nanoid(),
          entity_slug: ctx.entity.config.slug,
          strategy_id: this.id,
          sub_strategy_id: this.SUB_ID,
          condition_id: m.condition_id,
          token_id: m.token_yes_id,
          side: 'BUY',
          outcome: 'YES',
          strength: Math.min(1.0, basketEdge * 10), // 0.03 edge → 0.3 strength, 0.10 → 1.0
          edge: perLegEdge,
          model_prob: modelProb,
          market_price: m.yes_price!,
          recommended_size_usd: legSizeUsd,
          metadata: {
            question: m.question,
            sub_strategy: this.SUB_ID,
            neg_risk_market_id: familyId,
            family_members: members.length,
            basket_sum_yes: +sumYes.toFixed(4),
            basket_edge: +basketEdge.toFixed(4),
            basket_total_cost_usd: +targetBasketUsd.toFixed(2),
            basket_expected_profit_usd: +guaranteedProfitUsd.toFixed(2),
            target_shares_per_leg: +targetSharesPerLeg.toFixed(2),
            // `bypass_sizer=true` tells position-sizer.ts to honor
            // `recommended_size_usd` directly instead of running Kelly +
            // weighter. NegRisk arb requires EQUAL SHARE COUNTS across every
            // leg; Kelly would produce sizes ∝ 1/(1-p_i) which gives unequal
            // shares and breaks the guaranteed-payout math. Hard caps, the
            // 5-share minimum, and the liquidity bound still apply.
            bypass_sizer: true,
            // Leg math — useful for post-hoc analysis of which legs drove P&L.
            leg_price: m.yes_price!,
            leg_size_usd: legSizeUsd,
            leg_size_usd_proportional: true,
            leg_price_pct_of_basket: +(m.yes_price! / sumYes).toFixed(4),
          },
          created_at: new Date(),
        });
      }

      // Dedup this family so we don't re-fire on subsequent cycles
      this.recentFamilies.set(familyId, Date.now());
    }

    if (signals.length > 0) {
      log.info({
        families_examined: familiesExamined,
        families_in_arb_zone: familiesInArbZone,
        signals_generated: signals.length,
      }, 'NegRisk arb signals generated');
    } else if (familiesExamined > 0) {
      log.debug({
        families_examined: familiesExamined,
      }, 'NegRisk arb: no opportunities');
    }

    return signals;
  }

  private cleanupDedup(): void {
    const now = Date.now();
    for (const [fid, ts] of this.recentFamilies.entries()) {
      if (now - ts > DEDUP_TTL_MS) this.recentFamilies.delete(fid);
    }
  }
}
