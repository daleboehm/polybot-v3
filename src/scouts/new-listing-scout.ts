// New listing scout — flags newly-appeared markets so the engine doesn't
// wait for the next 5-min scan cycle to notice them.
//
// Heuristic:
//   Maintain a set of known condition_ids. Each tick, compare against the
//   current candidate set. Anything new that ALSO meets a liquidity bar
//   gets flagged as a high-priority scan target — strategies that care
//   about new listings (favorites, convergence) will pick it up on the
//   next priority scan (30s) instead of the next normal scan (5 min).
//
// This is the simplest scout in the fleet. No sliding-window math, just
// set difference.

import type { MarketCache } from '../market/market-cache.js';
import { insertPriority } from '../storage/repositories/market-priority-repo.js';
import { ScoutBase, type ScoutRunResult } from './scout-base.js';
import { createChildLogger } from '../core/logger.js';

const MIN_LIQUIDITY = 500;              // $500 minimum so we don't flag dust markets
const PRIORITY = 7;                     // moderately high — faster than normal scan
const TTL_MS = 15 * 60 * 1000;          // 15 min

export class NewListingScout extends ScoutBase {
  readonly id = 'new-listing-scout';
  readonly description = 'Flags newly-appeared markets for priority scanning';

  private knownIds = new Set<string>();
  private initialized = false;

  constructor() {
    super();
    this.log = createChildLogger(`scout:${this.id}`);
  }

  run(marketCache: MarketCache): ScoutRunResult {
    const candidates = this.getCandidateMarkets(marketCache);
    let prioritiesWritten = 0;

    // First tick: seed the known set without flagging anything. Otherwise
    // we'd flag every market in the cache as "new" on startup.
    if (!this.initialized) {
      for (const m of candidates) this.knownIds.add(m.condition_id);
      this.initialized = true;
      this.log.info({ seeded: this.knownIds.size }, 'New-listing scout seeded');
      return { ...this.emptyResult(), markets_evaluated: candidates.length };
    }

    for (const m of candidates) {
      if (this.knownIds.has(m.condition_id)) continue;
      this.knownIds.add(m.condition_id);

      if ((m.liquidity ?? 0) < MIN_LIQUIDITY) continue;

      // Phase A2: coarser tick = more edge per fill
      const tickBonus = this.tickSizePriorityBonus(m.minimum_tick_size);
      const weighted = Math.max(1, Math.min(10, PRIORITY + tickBonus));

      try {
        insertPriority({
          condition_id: m.condition_id,
          priority: weighted,
          reason: `new listing: ${m.question.substring(0, 60)} (tick=${m.minimum_tick_size})`,
          created_by: this.id,
          ttl_ms: TTL_MS,
        });
        prioritiesWritten++;
        this.log.info(
          {
            condition_id: m.condition_id.substring(0, 12),
            question: m.question.substring(0, 60),
            liquidity: m.liquidity,
          },
          'New listing flagged',
        );
      } catch (err) {
        this.log.warn({ err }, 'Failed to insert priority row');
      }
    }

    // Prune knownIds for markets that have dropped off the candidate set
    // (expired, closed, or moved out of the time window). Without this,
    // if a market re-enters the window (e.g., a weekly recurring event),
    // we wouldn't flag it again.
    const activeIds = new Set(candidates.map(m => m.condition_id));
    for (const id of this.knownIds) {
      if (!activeIds.has(id)) this.knownIds.delete(id);
    }

    return {
      scout_id: this.id,
      priorities_written: prioritiesWritten,
      intel_written: 0,
      markets_evaluated: candidates.length,
      summary: prioritiesWritten > 0 ? `flagged ${prioritiesWritten} new listings` : null,
    };
  }
}
