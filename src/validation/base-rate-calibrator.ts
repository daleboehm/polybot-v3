// Historical base-rate calibration for strategy `model_prob` values.
//
// Problem: the original favorites/longshot/convergence strategies computed
// `model_prob` as arithmetic on `market_price` (e.g. `price + 0.05`), which per
// the 2026-04-09 audit §6.3 "cannot in principle generate alpha — a strategy
// whose model is the market price plus a constant is a random walk with drift
// toward ruin."
//
// Fix: for each strategy, bucket all historical resolved positions by their
// entry price into 5% bins, compute the empirical resolution rate in each
// bucket, and use THAT as the model_prob for new entries. This is the minimum
// viable data-driven model — the calibration is backward-looking (no lookahead
// bias), refreshed periodically, and produces a real probability estimate that
// beats market_price + constant if the strategy has any edge at all.
//
// This is R2 PR#1 scope per the rebuild plan. R2 PR#2 extends it with walk-
// forward validation (train/test splits, DSR overfit detection, Brier score).

import { getDatabase } from '../storage/database.js';
import { wilsonLowerBound } from '../risk/wilson.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('base-rate-calibrator');

/**
 * A single entry-price bucket for a strategy. Populated by SQL aggregation
 * over the `resolutions` table, scoped to a strategy_id (+ optional sub).
 */
export interface BaseRateBucket {
  bucketLow: number;        // inclusive lower edge (e.g. 0.50)
  bucketHigh: number;       // exclusive upper edge (e.g. 0.55)
  n: number;                // total resolved positions in this bucket
  wins: number;             // positions that returned payout > cost_basis
  rawWinRate: number;       // wins / n — raw estimate
  wilsonLB: number;         // Wilson 95% lower bound — the conservative prob
  avgEntryPrice: number;    // mean entry price inside the bucket
  avgRealizedPnl: number;   // mean realized P&L per resolved position
}

export interface CalibrationCacheEntry {
  buckets: BaseRateBucket[];
  builtAt: number;           // unix ms of last refresh
  totalResolutions: number;  // denominator across all buckets
}

/**
 * In-memory cache of base rates per strategy key. Refreshed every 60 minutes
 * by default — strategy rewrites call `getBaseRate(strategyId, entryPrice)`
 * on every signal evaluation and the cache hits 99% of the time.
 */
export class BaseRateCalibrator {
  private cache = new Map<string, CalibrationCacheEntry>();
  private readonly refreshIntervalMs: number;
  private readonly bucketSize: number;
  private readonly minBucketN: number;

  constructor(options: { refreshIntervalMs?: number; bucketSize?: number; minBucketN?: number } = {}) {
    this.refreshIntervalMs = options.refreshIntervalMs ?? 60 * 60 * 1000;
    this.bucketSize = options.bucketSize ?? 0.05; // 5% buckets
    this.minBucketN = options.minBucketN ?? 10;    // need ≥10 resolutions to trust a bucket
  }

  /**
   * Return the calibrated probability for a given entry price under this
   * strategy. If the bucket has too few resolutions (< minBucketN), returns
   * `null` and the caller should fall back to its default behaviour or skip
   * the signal entirely.
   *
   * We return the Wilson LB (conservative estimate) rather than the raw rate
   * so Kelly sizing stays disciplined even when one bucket happens to have
   * a lucky streak.
   */
  getBaseRate(strategyId: string, entryPrice: number, subStrategyId?: string): number | null {
    const key = this.cacheKey(strategyId, subStrategyId);
    this.refreshIfStale(strategyId, subStrategyId);
    const entry = this.cache.get(key);
    if (!entry) return null;

    const bucket = this.findBucket(entry.buckets, entryPrice);
    if (!bucket || bucket.n < this.minBucketN) return null;

    return bucket.wilsonLB;
  }

  /**
   * Raw bucket lookup — used by the dashboard and R2 PR#2 reliability diagram.
   * Returns null if the strategy has zero resolutions in the bucket.
   */
  getBucket(strategyId: string, entryPrice: number, subStrategyId?: string): BaseRateBucket | null {
    const key = this.cacheKey(strategyId, subStrategyId);
    this.refreshIfStale(strategyId, subStrategyId);
    const entry = this.cache.get(key);
    if (!entry) return null;
    return this.findBucket(entry.buckets, entryPrice);
  }

  /**
   * Total resolved sample size for a strategy. Used by the advisor to gate
   * whether there's enough history to trust the calibration at all.
   */
  getTotalResolutions(strategyId: string, subStrategyId?: string): number {
    const key = this.cacheKey(strategyId, subStrategyId);
    this.refreshIfStale(strategyId, subStrategyId);
    return this.cache.get(key)?.totalResolutions ?? 0;
  }

  /**
   * Force a refresh of the cache for a specific strategy. Called when
   * a new resolution lands and we want the advisor to see it immediately.
   */
  invalidate(strategyId: string, subStrategyId?: string): void {
    this.cache.delete(this.cacheKey(strategyId, subStrategyId));
  }

  /**
   * Invalidate all cached entries. Called at process start after the DB
   * loads so the first scan cycle sees fresh data.
   */
  invalidateAll(): void {
    this.cache.clear();
  }

  // ─── Internal ────────────────────────────────────────────────────

  private cacheKey(strategyId: string, subStrategyId?: string): string {
    return `${strategyId}|${subStrategyId ?? ''}`;
  }

  private refreshIfStale(strategyId: string, subStrategyId?: string): void {
    const key = this.cacheKey(strategyId, subStrategyId);
    const entry = this.cache.get(key);
    if (entry && Date.now() - entry.builtAt < this.refreshIntervalMs) return;

    try {
      const buckets = this.buildBuckets(strategyId, subStrategyId);
      const totalResolutions = buckets.reduce((sum, b) => sum + b.n, 0);
      this.cache.set(key, { buckets, builtAt: Date.now(), totalResolutions });
      log.debug(
        { strategy: strategyId, sub: subStrategyId, buckets: buckets.length, total: totalResolutions },
        'Base rates refreshed',
      );
    } catch (err) {
      log.warn(
        { strategy: strategyId, sub: subStrategyId, err: err instanceof Error ? err.message : String(err) },
        'Base rate refresh failed',
      );
    }
  }

  private buildBuckets(strategyId: string, subStrategyId?: string): BaseRateBucket[] {
    const db = getDatabase();

    // We need entry_price (the position's avg_entry_price at open), resolved
    // outcome, and realized P&L. Join resolutions to positions on the natural
    // key to get the entry price.
    const sql = `
      SELECT
        p.avg_entry_price AS entry_price,
        r.payout_usdc     AS payout,
        r.cost_basis_usdc AS cost_basis,
        r.realized_pnl    AS realized_pnl
      FROM resolutions r
      JOIN positions p
        ON p.entity_slug  = r.entity_slug
       AND p.condition_id = r.condition_id
       AND p.token_id     = r.token_id
      WHERE r.strategy_id = ?
        ${subStrategyId ? 'AND r.sub_strategy_id = ?' : 'AND (r.sub_strategy_id IS NULL OR r.sub_strategy_id = \'\')'}
        AND p.avg_entry_price > 0
        AND p.avg_entry_price < 1
    `;

    const params: unknown[] = [strategyId];
    if (subStrategyId) params.push(subStrategyId);

    const rows = db.prepare(sql).all(...params) as Array<{
      entry_price: number;
      payout: number;
      cost_basis: number;
      realized_pnl: number;
    }>;

    // Bucket by entry price. Use inclusive-low / exclusive-high so [0.50, 0.55)
    // captures 0.50, 0.51, 0.52, 0.53, 0.54 but not 0.55.
    type Acc = { n: number; wins: number; entrySum: number; pnlSum: number };
    const bucketMap = new Map<string, Acc>();

    for (const row of rows) {
      const bucketIdx = Math.floor(row.entry_price / this.bucketSize);
      const bucketLow = bucketIdx * this.bucketSize;
      const key = bucketLow.toFixed(4);
      let acc = bucketMap.get(key);
      if (!acc) {
        acc = { n: 0, wins: 0, entrySum: 0, pnlSum: 0 };
        bucketMap.set(key, acc);
      }
      acc.n += 1;
      acc.entrySum += row.entry_price;
      acc.pnlSum += row.realized_pnl;
      if (row.payout > row.cost_basis) acc.wins += 1;
    }

    const buckets: BaseRateBucket[] = [];
    for (const [keyStr, acc] of bucketMap.entries()) {
      const bucketLow = parseFloat(keyStr);
      const bucketHigh = bucketLow + this.bucketSize;
      const rawWinRate = acc.n > 0 ? acc.wins / acc.n : 0;
      buckets.push({
        bucketLow,
        bucketHigh,
        n: acc.n,
        wins: acc.wins,
        rawWinRate,
        wilsonLB: wilsonLowerBound(acc.wins, acc.n),
        avgEntryPrice: acc.n > 0 ? acc.entrySum / acc.n : 0,
        avgRealizedPnl: acc.n > 0 ? acc.pnlSum / acc.n : 0,
      });
    }

    // Sort ascending by bucketLow for deterministic output
    buckets.sort((a, b) => a.bucketLow - b.bucketLow);
    return buckets;
  }

  private findBucket(buckets: BaseRateBucket[], entryPrice: number): BaseRateBucket | null {
    for (const b of buckets) {
      if (entryPrice >= b.bucketLow && entryPrice < b.bucketHigh) return b;
    }
    return null;
  }
}

// Module-level singleton — the calibrator is stateless across strategies,
// each strategy just pulls its own rows. Strategies import this and call
// `baseRateCalibrator.getBaseRate(...)` inside evaluate().
export const baseRateCalibrator = new BaseRateCalibrator();
