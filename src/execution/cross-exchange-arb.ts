// Cross-exchange atomic arbitrage (Polymarket ↔ Kalshi) — R4 scaffold.
//
// R4 (2026-04-10). Per design-decisions §R4 #3: true atomic cross-exchange
// arb requires both legs execute simultaneously or NEITHER does. On
// Polymarket (Polygon CLOB) + Kalshi (REST API) this is non-trivial because
// the two venues have different settlement times, different fee structures,
// and different failure modes. A partial fill on one side without the
// other leaves us with unhedged directional exposure — exactly what arb
// is supposed to avoid.
//
// **SCAFFOLD ONLY** — documents the design but is not wired. R4 milestone
// #3. R3a's Kalshi read-only divergence signal captures ~80% of the value
// of this strategy without the atomic-execution complexity.
//
// Execution pattern (the hard part):
//
//   1. Identify opportunity: PM side A priced X, Kalshi side B priced Y
//      where (1 - X - Y) > fees + slippage budget = profitable lock
//   2. Check CLOB + Kalshi depth: can we fill both sides at current prices?
//   3. Place PM order FIRST (slower venue, clearer failure mode)
//   4. If PM fills → immediately place Kalshi order for the hedge
//   5. If PM rejects → abort, no exposure
//   6. If PM fills but Kalshi fails → log as stranded leg, alert operator,
//      enter recovery mode (market-close the PM leg)
//
// Recovery mode (what to do when leg 2 fails):
//   - Option A: wait for Kalshi to come back, retry hedge
//   - Option B: market-close leg 1 at a loss to flatten exposure
//   - Option C: hedge with a correlated different-venue market
// Recovery choice is a runtime decision based on how far the price has
// moved since the stranded fill. Runbook TBD at R4 activation time.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('cross-exchange-arb');

export interface ArbOpportunity {
  polyConditionId: string;
  polyTokenId: string;
  polySide: 'YES' | 'NO';
  polyPrice: number;
  polyDepth: number;

  kalshiTicker: string;
  kalshiSide: 'YES' | 'NO';
  kalshiPrice: number;

  implicitHedgeLockUsd: number;  // guaranteed profit if both legs fill
  legSizeUsd: number;
  totalFeesPct: number;
}

export interface ExecutionResult {
  opportunity: ArbOpportunity;
  polyFilled: boolean;
  kalshiFilled: boolean;
  polyTxHash?: string;
  kalshiOrderId?: string;
  strandedLeg?: 'poly' | 'kalshi' | null;
  netRealizedUsd: number;
  recoveryApplied?: string;
}

const MIN_LOCK_USD = 0.20;          // don't chase peanuts
const MAX_LEG_SIZE_USD = 50;        // scaffold conservative cap
const EST_TOTAL_FEES_PCT = 0.005;   // 0.5% budget for fees + slippage

export class CrossExchangeArbitrageur {
  /**
   * Scan for arb opportunities. Takes matched (PM, Kalshi) market pairs
   * from the R3a KalshiClient and checks each for a profitable lock.
   *
   * @param pairs list of matched market pairs with live prices
   */
  findOpportunities(pairs: Array<{
    polyConditionId: string;
    polyYesTokenId: string;
    polyNoTokenId: string;
    polyYesPrice: number;
    polyNoPrice: number;
    polyDepth: number;
    kalshiTicker: string;
    kalshiYesPrice: number;
    kalshiNoPrice: number;
  }>): ArbOpportunity[] {
    const opps: ArbOpportunity[] = [];

    for (const p of pairs) {
      // Two arb directions: (1) buy PM YES + Kalshi NO, (2) buy PM NO + Kalshi YES
      const d1 = this.checkDirection(p.polyYesPrice, p.kalshiNoPrice);
      if (d1.profitable) {
        opps.push({
          polyConditionId: p.polyConditionId,
          polyTokenId: p.polyYesTokenId,
          polySide: 'YES',
          polyPrice: p.polyYesPrice,
          polyDepth: p.polyDepth,
          kalshiTicker: p.kalshiTicker,
          kalshiSide: 'NO',
          kalshiPrice: p.kalshiNoPrice,
          implicitHedgeLockUsd: d1.lockUsd,
          legSizeUsd: Math.min(MAX_LEG_SIZE_USD, p.polyDepth * 0.5),
          totalFeesPct: EST_TOTAL_FEES_PCT,
        });
      }
      const d2 = this.checkDirection(p.polyNoPrice, p.kalshiYesPrice);
      if (d2.profitable) {
        opps.push({
          polyConditionId: p.polyConditionId,
          polyTokenId: p.polyNoTokenId,
          polySide: 'NO',
          polyPrice: p.polyNoPrice,
          polyDepth: p.polyDepth,
          kalshiTicker: p.kalshiTicker,
          kalshiSide: 'YES',
          kalshiPrice: p.kalshiYesPrice,
          implicitHedgeLockUsd: d2.lockUsd,
          legSizeUsd: Math.min(MAX_LEG_SIZE_USD, p.polyDepth * 0.5),
          totalFeesPct: EST_TOTAL_FEES_PCT,
        });
      }
    }

    return opps.sort((a, b) => b.implicitHedgeLockUsd - a.implicitHedgeLockUsd);
  }

  /**
   * Execute an arb opportunity. **NOT IMPLEMENTED** — this is the hard
   * part that R4 activation has to get right. Placeholder throws.
   */
  async execute(opportunity: ArbOpportunity): Promise<ExecutionResult> {
    log.warn({ opportunity }, 'Cross-exchange arb execution NOT IMPLEMENTED — R4 scaffold only');
    throw new Error('Cross-exchange arb execution is an R4 scaffold, not implemented');
  }

  private checkDirection(polySidePrice: number, kalshiOtherSidePrice: number): { profitable: boolean; lockUsd: number } {
    // For a $1 notional: payout = $1, cost = polySidePrice + kalshiOtherSidePrice
    // Lock = 1 - cost - fees
    const cost = polySidePrice + kalshiOtherSidePrice;
    const lock = 1 - cost - EST_TOTAL_FEES_PCT;
    return {
      profitable: lock > MIN_LOCK_USD,
      lockUsd: lock,
    };
  }
}
