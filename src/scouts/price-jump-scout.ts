// Price jump scout — flags markets whose mid-price moved rapidly in a short
// window. Two failure modes both represent opportunity:
//
//   Overreaction: crowd panic/hype pushes price beyond fair value → fade
//     opportunity for longshot/favorites
//   Underreaction: new info is spreading slowly through the book → continuation
//     opportunity (catch the trend early)
//
// The scout itself doesn't decide which mode applies — it just flags the
// market. The downstream strategies (longshot.news_overreaction_fade,
// convergence.filtered_high_prob, etc.) handle direction.
//
// Heuristic:
//   Each tick we snapshot mid-price per market. If mid-price has moved by
//   more than JUMP_PCT since a snapshot from ~5 min ago, flag as priority.

import type { MarketCache } from '../market/market-cache.js';
import { insertPriority } from '../storage/repositories/market-priority-repo.js';
import { ScoutBase, type ScoutRunResult } from './scout-base.js';
import { createChildLogger } from '../core/logger.js';

interface PriceSnapshot {
  mid: number;
  timestamp: number;
}

const WINDOW_MS = 5 * 60 * 1000;
const JUMP_PCT = 0.05;              // 5% mid-price move within window
const TTL_MS = 10 * 60 * 1000;      // 10 min
const MIN_LIQUIDITY = 1_000;        // avoid thin/illiquid markets

export class PriceJumpScout extends ScoutBase {
  readonly id = 'price-jump-scout';
  readonly description = 'Flags markets whose mid-price moved >=5% in <=5 min';

  private history = new Map<string, PriceSnapshot[]>();

  constructor() {
    super();
    this.log = createChildLogger(`scout:${this.id}`);
  }

  run(marketCache: MarketCache): ScoutRunResult {
    const candidates = this.getCandidateMarkets(marketCache);
    const now = Date.now();
    let prioritiesWritten = 0;
    let evaluated = 0;

    for (const m of candidates) {
      evaluated++;
      if ((m.liquidity ?? 0) < MIN_LIQUIDITY) continue;
      if (!m.yes_price || !m.no_price) continue;

      // Mid-price = midpoint between yes and no (usually ~1 but drift matters)
      // For a binary, yes+no should equal 1. Actual mid is just yes_price.
      const mid = m.yes_price;
      if (mid <= 0 || mid >= 1) continue;

      const snapshots = this.history.get(m.condition_id) ?? [];
      snapshots.push({ mid, timestamp: now });
      const keepFrom = now - 2 * WINDOW_MS;
      const pruned = snapshots.filter(s => s.timestamp >= keepFrom);
      this.history.set(m.condition_id, pruned);

      const older = pruned.find(s => now - s.timestamp >= WINDOW_MS * 0.8);
      if (!older) continue;

      const absMove = Math.abs(mid - older.mid);
      if (absMove < JUMP_PCT) continue;

      const direction = mid > older.mid ? 'up' : 'down';
      // Priority scales with magnitude:
      //   5% → 6
      //   10% → 8
      //   20%+ → 10
      let priority = 6;
      if (absMove >= 0.10) priority = 8;
      if (absMove >= 0.20) priority = 10;

      // Phase A2: tick-size weight
      const tickBonus = this.tickSizePriorityBonus(m.minimum_tick_size);
      priority = Math.max(1, Math.min(10, priority + tickBonus));

      try {
        insertPriority({
          condition_id: m.condition_id,
          priority,
          reason: `price ${direction} ${(absMove * 100).toFixed(1)}% (${older.mid.toFixed(3)} → ${mid.toFixed(3)}) over ~${Math.round((now - older.timestamp) / 1000)}s; tick=${m.minimum_tick_size}`,
          created_by: this.id,
          ttl_ms: TTL_MS,
        });
        prioritiesWritten++;
        this.log.info(
          {
            condition_id: m.condition_id.substring(0, 12),
            direction,
            abs_move: Math.round(absMove * 1000) / 1000,
            prior_mid: older.mid,
            current_mid: mid,
            priority,
          },
          'Price jump flagged',
        );
      } catch (err) {
        this.log.warn({ err }, 'Failed to insert priority row');
      }
    }

    const activeIds = new Set(candidates.map(m => m.condition_id));
    for (const key of this.history.keys()) {
      if (!activeIds.has(key)) this.history.delete(key);
    }

    return {
      scout_id: this.id,
      priorities_written: prioritiesWritten,
      intel_written: 0,
      markets_evaluated: evaluated,
      summary: prioritiesWritten > 0 ? `flagged ${prioritiesWritten} markets` : null,
    };
  }
}
