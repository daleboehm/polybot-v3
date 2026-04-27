// KL-divergence scout — 2026-04-20 (Tranche 2 C, PolySwarm paper arXiv 2604.03888).
//
// Information-theoretic mispricing detector for neg-risk market clusters.
// Computes two signals per cluster (markets sharing a neg_risk_market_id):
//
//   1. Sum-of-YES deviation: sum(yes_price) should equal 1.0 across a
//      mutually-exclusive neg-risk group. Deviation > 0.05 is either
//      arbitrage (if large) or mispricing (if small). NegRisk-arb strategy
//      handles the large case; this scout surfaces smaller deviations that
//      directional strategies might exploit.
//
//   2. KL(P || Q) where P is the implied distribution (yes_prices normalized
//      to sum to 1) and Q is the uniform reference (1/n). High KL means a
//      sharply-concentrated distribution — usually because real info arrived.
//      Dominant-leg markets deserve out-of-cycle priority scanning so
//      strategies can act before the crowd fully prices it in.
//
// Neither signal alone fires a trade — the scout only writes priority rows.
// Strategies and the main scanner act on those priorities via the existing
// PriorityScanner → strategy pipeline.
//
// Scope limit: v1 uses uniform Q (1/n) as reference. v2 could use historical
// distribution for the same neg-risk ID once we have enough resolved data.

import { ScoutBase, type ScoutRunResult } from './scout-base.js';
import type { MarketCache } from '../market/market-cache.js';
import type { MarketData } from '../types/index.js';
import { insertPriority } from '../storage/repositories/market-priority-repo.js';
import { createChildLogger } from '../core/logger.js';
import { getDatabase } from '../storage/database.js';

const log = createChildLogger('scout:kl-divergence');

// Sum-of-YES absolute deviation threshold. Below this, the cluster is
// coherent. Above this (but below the NegRisk arb 5-10% threshold), we
// flag it as a mispricing candidate for directional strategies.
const SUM_DEVIATION_MIN = 0.02;
const SUM_DEVIATION_MAX = 0.10; // above this, NegRisk arb already handles it

// KL(P||Q) threshold for "sharply-concentrated" distribution. KL>1.5 on
// a uniform baseline means one or two legs dominate the mass significantly.
const KL_CONCENTRATION_THRESHOLD = 1.5;

// Minimum legs required to compute a cluster. 3 legs = meaningful distribution.
const MIN_LEGS = 3;

// Priority TTL: these are short-lived signals, 10 min is plenty.
const PRIORITY_TTL_MS = 10 * 60 * 1000;

// Rate limit: don't re-flag the same cluster more than once per N ms.
const FLAG_RATE_LIMIT_MS = 5 * 60 * 1000;

// Tick velocity gates — filter stale markets and mid-reprice news events.
// Min: must have >= 2 ticks in last 60s (market is actively quoted)
// Max: skip if > 25 ticks/min (rapid reprice cascade = news event in flight)
const MIN_TICKS_60S = 2;
const MAX_TICKS_60S = 25;

export class KLDivergenceScout extends ScoutBase {
  readonly id = 'kl-divergence-scout';
  readonly description = 'Detect mispricing in neg-risk market clusters via sum-of-YES deviation and KL-divergence';

  private lastFlaggedAt = new Map<string, number>();

  constructor() {
    super();
    this.log = createChildLogger(`scout:${this.id}`);
  }

  // F6 FIX: prepared statement cached at instance level rather than re-compiled
  // on every call. better-sqlite3 docs recommend preparing once and reusing.
  // Lazily initialised on first use so construction doesn't throw on missing table.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _tickCountStmt: any = null; // cached better-sqlite3 Statement

  /** Returns tick count for a condition in the given window. Falls back to 0 if table missing. */
  private getConditionTickCount(conditionId: string, windowMs: number): number {
    try {
      const db = getDatabase();
      if (!this._tickCountStmt) {
        this._tickCountStmt = db.prepare(
          'SELECT COUNT(*) as cnt FROM market_ticks WHERE condition_id = ? AND received_ms > ?'
        );
      }
      const result = this._tickCountStmt.get(conditionId, Date.now() - windowMs) as { cnt: number } | undefined;
      return result?.cnt ?? 0;
    } catch (err) {
      // F8 FIX: log WARN so DB infrastructure failures are visible, not silently swallowed.
      log.warn({ err, conditionId }, 'tick count query failed — gate defaults to stale (conservative)');
      this._tickCountStmt = null; // reset so next call re-prepares after transient failure
      return 0;
    }
  }

  /** Returns true if the market has healthy tick activity (not stale, not mid-reprice). */
  private isTickRateHealthy(conditionId: string): boolean {
    const ticks = this.getConditionTickCount(conditionId, 60_000);
    return ticks >= MIN_TICKS_60S && ticks <= MAX_TICKS_60S;
  }

  // F7 FIX: check tick health across the cluster, not just first leg.
  // Array ordering is arbitrary — checking only legs[0] gave false negatives
  // (stale first leg → entire cluster skipped) and false positives
  // (active first leg → stale cluster passed). Require ≥50% of legs healthy.
  private isClusterTickRateHealthy(legs: MarketData[]): boolean {
    const healthyCount = legs.filter(m => this.isTickRateHealthy(m.condition_id)).length;
    return healthyCount >= Math.ceil(legs.length * 0.5);
  }

  run(marketCache: MarketCache): ScoutRunResult {
    const markets = this.getCandidateMarkets(marketCache, 1, 168); // 1h to 7d horizon
    const now = Date.now();

    // Group by neg_risk_market_id (skip null/empty)
    const groups = new Map<string, MarketData[]>();
    for (const m of markets) {
      const nr = m.neg_risk_market_id;
      if (!nr) continue;
      if (!m.yes_price || m.yes_price <= 0 || m.yes_price >= 1) continue;
      const arr = groups.get(nr) ?? [];
      arr.push(m);
      groups.set(nr, arr);
    }

    let prioritiesWritten = 0;
    let clustersEvaluated = 0;
    let mispricingsFlagged = 0;
    let concentrationsFlagged = 0;

    for (const [nrId, legs] of groups) {
      if (legs.length < MIN_LEGS) continue;
      clustersEvaluated++;

      // Rate-limit per cluster
      const lastFlag = this.lastFlaggedAt.get(nrId);
      if (lastFlag && (now - lastFlag) < FLAG_RATE_LIMIT_MS) continue;

      // Sum of YES prices across all legs
      const sumYes = legs.reduce((a, m) => a + m.yes_price, 0);
      const sumDeviation = Math.abs(sumYes - 1.0);

      // Implied distribution P (normalize yes_prices to sum 1)
      const probP = legs.map(m => m.yes_price / sumYes);
      // Uniform reference Q = [1/n, ...]
      const n = legs.length;
      const qVal = 1 / n;

      // KL(P || Q) = sum_i P_i * log(P_i / Q_i)
      // = sum_i P_i * log(P_i * n) = sum_i P_i * (log P_i + log n)
      // Use natural log; KL in nats. For probabilities sum=1, bounded.
      let kl = 0;
      for (const p of probP) {
        if (p <= 0) continue;
        kl += p * Math.log(p / qVal);
      }

      // Tick-rate gate: skip clusters that are stale OR mid-reprice.
      // F7 FIX: require ≥50% of legs healthy (not just the arbitrary first leg).
      if (!this.isClusterTickRateHealthy(legs)) continue;

      const didFlag =
        (sumDeviation >= SUM_DEVIATION_MIN && sumDeviation <= SUM_DEVIATION_MAX) ||
        kl >= KL_CONCENTRATION_THRESHOLD;

      if (!didFlag) continue;

      // Determine reason + priority. Sum-deviation flag boosts ALL legs;
      // concentration flag boosts only the dominant leg.
      if (sumDeviation >= SUM_DEVIATION_MIN && sumDeviation <= SUM_DEVIATION_MAX) {
        mispricingsFlagged++;
        const reason = `neg-risk cluster ${nrId.substring(0, 10)}: sum-of-yes=${sumYes.toFixed(3)} (deviation ${sumDeviation.toFixed(3)})`;
        for (const m of legs) {
          const priority = Math.min(10, 5 + this.tickSizePriorityBonus(m.minimum_tick_size));
          insertPriority({
            condition_id: m.condition_id,
            priority,
            reason,
            created_by: this.id,
            ttl_ms: PRIORITY_TTL_MS,
          });
          prioritiesWritten++;
        }
      }

      if (kl >= KL_CONCENTRATION_THRESHOLD) {
        concentrationsFlagged++;
        // Find the dominant leg (largest P_i)
        let maxIdx = 0;
        for (let i = 1; i < probP.length; i++) {
          if (probP[i] > probP[maxIdx]) maxIdx = i;
        }
        const dominant = legs[maxIdx];
        const reason = `neg-risk cluster ${nrId.substring(0, 10)}: high KL=${kl.toFixed(2)} dominant-leg p=${probP[maxIdx].toFixed(3)}`;
        const priority = Math.min(10, 6 + this.tickSizePriorityBonus(dominant.minimum_tick_size));
        insertPriority({
          condition_id: dominant.condition_id,
          priority,
          reason,
          created_by: this.id,
          ttl_ms: PRIORITY_TTL_MS,
        });
        prioritiesWritten++;
      }

      this.lastFlaggedAt.set(nrId, now);
    }

    // GC old rate-limit entries
    if (this.lastFlaggedAt.size > 1000) {
      const stale = now - FLAG_RATE_LIMIT_MS * 2;
      for (const [k, t] of this.lastFlaggedAt) {
        if (t < stale) this.lastFlaggedAt.delete(k);
      }
    }

    const summary = prioritiesWritten > 0
      ? `${mispricingsFlagged} mispricings + ${concentrationsFlagged} concentrations flagged across ${clustersEvaluated} clusters`
      : null;

    if (prioritiesWritten > 0) {
      log.info({ mispricings: mispricingsFlagged, concentrations: concentrationsFlagged, priorities_written: prioritiesWritten, clusters: clustersEvaluated }, 'KL-divergence scout findings');
    }

    return {
      scout_id: this.id,
      priorities_written: prioritiesWritten,
      intel_written: 0,
      markets_evaluated: markets.length,
      summary,
    };
  }
}
