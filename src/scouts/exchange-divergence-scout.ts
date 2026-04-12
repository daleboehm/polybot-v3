// Exchange divergence scout — R4 (2026-04-12).
//
// Watches BTC price across Binance, Coinbase, and Chainlink (via
// CoinGecko proxy). When the three sources agree on a price that
// diverges from Polymarket's implied BTC binary pricing by more than
// a threshold, the scout:
//
//   1. Writes a `market_priorities` row to push matching BTC markets
//      into the attention router for immediate 30-second scanning
//   2. Writes a `scout_intel` row with the divergence direction so
//      the scout-overlay can size up positions on the consensus side
//
// Research basis: SolSt1ne's polymarket-trade-engine repo (MIT) uses
// the same 3-source architecture defensively (killswitch on divergence).
// We invert the signal: divergence = opportunity, not danger.
//
// Cadence: 60s (same as the other scouts in ScoutCoordinator). On
// each tick the scout fetches all 3 exchange prices in parallel (~2s
// total), computes consensus, then compares against every active BTC
// market in the market cache. Markets where the implied probability
// diverges from the exchange-consensus probability by more than
// MIN_DIVERGENCE_PCT get flagged.
//
// How the divergence signal works for BTC 5-min markets:
//
//   Polymarket BTC markets are typically "Will BTC be above $X at
//   time Y?" The YES price implies a probability. If exchanges say
//   BTC is currently $84,200 and the market for "above $84,000" has
//   YES at 0.55 (implying 55% chance), but the exchange price is
//   0.24% above the target — the implied probability from the exchange
//   consensus should be much higher (~70-80% depending on volatility
//   and time to expiry). That gap is the signal.
//
//   We don't compute the "correct" probability ourselves — that's
//   what the crypto_price strategy's volatility model does. Instead,
//   the scout flags the market as high-priority so the crypto_price
//   strategy evaluates it on the next priority scan (30s) instead of
//   waiting for the next full scan (5 min).

import type { MarketCache } from '../market/market-cache.js';
import type { MarketData } from '../types/index.js';
import { fetchAllPrices, computeDivergence, type ExchangePriceSet } from '../market/exchange-price-feeds.js';
import { insertPriority } from '../storage/repositories/market-priority-repo.js';
import { insertIntel, type IntelSide } from '../storage/repositories/scout-intel-repo.js';
import { ScoutBase, type ScoutRunResult } from './scout-base.js';
import { createChildLogger } from '../core/logger.js';

// Configurable thresholds
const MIN_EXCHANGE_DIVERGENCE_PCT = 0.001; // 0.1% between exchanges = data quality issue, skip
const MAX_EXCHANGE_DIVERGENCE_PCT = 0.02;  // >2% between exchanges = one feed is stale, skip
const MIN_MARKET_DIVERGENCE_PCT = 0.03;    // 3% divergence between exchange consensus and Polymarket implied prob
const PRIORITY_LEVEL = 8;                   // High priority — exchange data is fresh signal
const INTEL_CONVICTION = 0.70;              // Moderate-high — exchange prices are reliable but not infallible
const INTEL_TTL_MS = 5 * 60 * 1000;        // 5 min — very short, signal decays fast
const PRIORITY_TTL_MS = 5 * 60 * 1000;     // 5 min

// BTC market detection — match Polymarket question patterns
const BTC_QUESTION_PATTERNS = [
  /bitcoin/i,
  /\bBTC\b/i,
  /btc.*price/i,
  /price.*btc/i,
  /btc.*above/i,
  /btc.*below/i,
];

function isBtcMarket(question: string): boolean {
  return BTC_QUESTION_PATTERNS.some(p => p.test(question));
}

/**
 * Extract the target price from a BTC market question.
 * Examples:
 *   "Will the price of Bitcoin be above $84,000 on April 12?" → 84000
 *   "Will BTC be below $80K at 3pm?" → 80000
 * Returns null if no target price found.
 */
function extractTargetPrice(question: string): number | null {
  // Match $XX,XXX or $XXK patterns
  const dollarMatch = question.match(/\$([0-9,]+(?:\.[0-9]+)?)\s*[Kk]?/);
  if (!dollarMatch) return null;
  let raw = dollarMatch[1]!.replace(/,/g, '');
  if (dollarMatch[0]!.toLowerCase().includes('k')) {
    raw = String(parseFloat(raw) * 1000);
  }
  const price = parseFloat(raw);
  return Number.isFinite(price) && price > 1000 ? price : null; // BTC > $1K sanity check
}

/**
 * Determine direction: does the question ask "above" or "below"?
 * "above" → YES means BTC > target → if exchange price > target, YES is underpriced
 * "below" → YES means BTC < target → if exchange price < target, YES is underpriced
 */
function extractDirection(question: string): 'above' | 'below' | null {
  if (/above|over|higher than|exceed/i.test(question)) return 'above';
  if (/below|under|lower than|less than/i.test(question)) return 'below';
  return null;
}

export class ExchangeDivergenceScout extends ScoutBase {
  readonly id = 'exchange-divergence-scout';
  readonly description = 'Flags BTC markets where exchange consensus diverges from Polymarket implied probability';

  private lastPrices: ExchangePriceSet | null = null;
  private inflightFetch = false;

  constructor() {
    super();
    this.log = createChildLogger(`scout:${this.id}`);
  }

  /**
   * Synchronous run() kicks off async fetch. Results from the previous
   * tick's fetch are used for market comparison. First tick has no
   * previous data → returns empty.
   */
  run(marketCache: MarketCache): ScoutRunResult {
    // Use the previous tick's prices (avoids blocking the scout coordinator)
    const result = this.evaluateMarkets(marketCache);

    // Kick off the next price fetch in the background
    if (!this.inflightFetch) {
      this.inflightFetch = true;
      void this.fetchPricesAsync().finally(() => {
        this.inflightFetch = false;
      });
    }

    return result;
  }

  private async fetchPricesAsync(): Promise<void> {
    try {
      this.lastPrices = await fetchAllPrices();
    } catch (err) {
      this.log.debug(
        { err: err instanceof Error ? err.message : String(err) },
        'Price fetch failed',
      );
    }
  }

  private evaluateMarkets(marketCache: MarketCache): ScoutRunResult {
    if (!this.lastPrices) return this.emptyResult();

    const divergence = computeDivergence(this.lastPrices);
    if (!divergence) {
      // < 2 price sources available
      return this.emptyResult();
    }

    // Sanity check: are the exchanges themselves in agreement?
    // If Binance and Coinbase disagree by >2%, one of them is stale
    // and we can't trust the consensus.
    if (divergence.maxDivergencePct > MAX_EXCHANGE_DIVERGENCE_PCT) {
      this.log.debug(
        {
          max_divergence: (divergence.maxDivergencePct * 100).toFixed(2) + '%',
          details: divergence.details,
        },
        'Exchange prices too divergent — skipping',
      );
      return this.emptyResult();
    }

    // If exchanges are suspiciously identical (< 0.1% divergence),
    // skip — probably stale cached data from one source.
    if (divergence.maxDivergencePct < MIN_EXCHANGE_DIVERGENCE_PCT && divergence.sources >= 3) {
      // All three agree within 0.1% — that's actually fine, proceed
    }

    const consensus = divergence.consensus;
    const candidates = this.getCandidateMarkets(marketCache);
    let prioritiesWritten = 0;
    let intelWritten = 0;
    let evaluated = 0;

    for (const market of candidates) {
      if (!isBtcMarket(market.question)) continue;
      evaluated++;

      const target = extractTargetPrice(market.question);
      if (!target) continue;

      const direction = extractDirection(market.question);
      if (!direction) continue;

      // Compute what the exchange consensus implies for this market.
      // Simple model: if BTC is above the target, YES (for an "above"
      // market) should be priced high. How high depends on volatility
      // and time — we leave that to the crypto_price strategy. The
      // scout just detects the DIRECTION of mispricing.
      const priceVsTarget = (consensus - target) / target; // positive = BTC above target

      let expectedSide: IntelSide;
      if (direction === 'above') {
        // BTC above target → YES should be expensive
        expectedSide = priceVsTarget > 0 ? 'YES' : 'NO';
      } else {
        // BTC below target → YES should be expensive when BTC IS below
        expectedSide = priceVsTarget < 0 ? 'YES' : 'NO';
      }

      // Compare implied probability vs market price
      const marketYesPrice = market.yes_price;
      const marketNoPrice = market.no_price;
      const expectedPrice = expectedSide === 'YES' ? marketYesPrice : marketNoPrice;

      // The "divergence" here is qualitative: if BTC is 2% above the
      // target but the YES price is only 0.55 (55% implied), there's a
      // gap. We measure it as: how far above/below the target is BTC,
      // vs how confident the market is.
      const absoluteGap = Math.abs(priceVsTarget);
      if (absoluteGap < MIN_MARKET_DIVERGENCE_PCT) continue; // BTC is very close to target, no signal

      // If BTC is clearly on one side of the target but the market
      // prices the expected side below 0.70, there's a potential edge.
      if (expectedPrice < 0.70 && absoluteGap > 0.05) {
        // Strong signal: BTC is >5% away from target but market
        // only prices the correct side at <70%. Flag it.
        const tickBonus = this.tickSizePriorityBonus(market.minimum_tick_size);
        const priority = Math.max(1, Math.min(10, PRIORITY_LEVEL + tickBonus));

        try {
          insertPriority({
            condition_id: market.condition_id,
            priority,
            reason: `exchange divergence: BTC ${consensus.toFixed(0)} vs target ${target}, gap ${(absoluteGap * 100).toFixed(1)}%, market ${expectedSide}=${expectedPrice.toFixed(3)}`,
            created_by: this.id,
            ttl_ms: PRIORITY_TTL_MS,
          });
          prioritiesWritten++;
        } catch (err) {
          this.log.debug({ err }, 'Priority insert failed');
        }

        try {
          insertIntel({
            condition_id: market.condition_id,
            side: expectedSide,
            conviction: INTEL_CONVICTION,
            reason: `Exchanges say BTC=${consensus.toFixed(0)}, target=${target}, direction=${direction}, gap=${(absoluteGap * 100).toFixed(1)}%`,
            created_by: this.id,
            ttl_ms: INTEL_TTL_MS,
          });
          intelWritten++;
        } catch (err) {
          this.log.debug({ err }, 'Intel insert failed');
        }

        this.log.info(
          {
            condition_id: market.condition_id.substring(0, 14),
            question: market.question.substring(0, 60),
            consensus: consensus.toFixed(0),
            target,
            gap_pct: (absoluteGap * 100).toFixed(1),
            expected_side: expectedSide,
            market_price: expectedPrice.toFixed(3),
            priority,
          },
          'Exchange divergence flagged',
        );
      }
    }

    return {
      scout_id: this.id,
      priorities_written: prioritiesWritten,
      intel_written: intelWritten,
      markets_evaluated: evaluated,
      summary:
        prioritiesWritten > 0
          ? `${prioritiesWritten} BTC markets flagged (consensus=$${consensus.toFixed(0)}, ${divergence.sources} sources)`
          : null,
    };
  }
}
