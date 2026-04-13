// Volume spike scout — flags markets whose 24h volume grew disproportionately
// since the last tick. A rapid volume influx is often a leading indicator of
// a price move (either fresh information is arriving, or a whale is building
// a position). This scout writes `market_priorities` rows to push those
// markets into the attention router.
//
// Heuristic:
//   1. Each scout tick (~60 sec) records current `volume_24h` per market
//   2. Compare to the snapshot from ~5 minutes ago
//   3. If volume grew by >= SPIKE_RATIO in that window AND absolute
//      volume is above NOISE_FLOOR, flag as priority
//
// Priority level is scaled by how big the spike is:
//   5x → priority 6
//   10x → priority 8
//   20x+ → priority 10
//
// False-positive protection: NOISE_FLOOR filters out tiny markets where a
// single $10 trade would look like a "500% spike" in a $2-volume book.

import type { MarketCache } from '../market/market-cache.js';
import { insertPriority } from '../storage/repositories/market-priority-repo.js';
import { ScoutBase, type ScoutRunResult } from './scout-base.js';
import { createChildLogger } from '../core/logger.js';

interface VolumeSnapshot {
  volume: number;
  timestamp: number;
}

const WINDOW_MS = 5 * 60 * 1000;       // 5 minutes
const SPIKE_RATIO = 3.0;                // 3x volume growth within window
const NOISE_FLOOR_USD = 5_000;          // ignore markets with <$5K 24h volume
const TTL_MS = 15 * 60 * 1000;          // priority row lives 15 minutes

export class VolumeSpikeScout extends ScoutBase {
  readonly id = 'volume-spike-scout';
  readonly description = 'Flags markets with rapid volume growth via market_priorities';

  private history = new Map<string, VolumeSnapshot[]>();

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
      const vol = m.volume_24h ?? 0;
      if (vol <= 0) continue;

      // Append current snapshot
      const snapshots = this.history.get(m.condition_id) ?? [];
      snapshots.push({ volume: vol, timestamp: now });

      // Drop snapshots older than 2x WINDOW_MS so the history doesn't grow unbounded
      const keepFrom = now - 2 * WINDOW_MS;
      const pruned = snapshots.filter(s => s.timestamp >= keepFrom);
      this.history.set(m.condition_id, pruned);

      // Need at least one older snapshot in the window to compare against
      const older = pruned.find(s => now - s.timestamp >= WINDOW_MS * 0.8);
      if (!older) continue;
      if (older.volume <= 0) continue;
      if (vol < NOISE_FLOOR_USD) continue;

      const ratio = vol / older.volume;
      if (ratio < SPIKE_RATIO) continue;

      // Scale priority by spike magnitude
      let priority = 6;
      if (ratio >= 10) priority = 8;
      if (ratio >= 20) priority = 10;

      // Phase A2 (2026-04-11): coarser tick = more edge per fill. Add a
      // bonus so scout priorities implicitly prefer coarse-tick markets.
      const tickBonus = this.tickSizePriorityBonus(m.minimum_tick_size);
      priority = Math.max(1, Math.min(10, priority + tickBonus));

      try {
        insertPriority({
          condition_id: m.condition_id,
          priority,
          reason: `volume spike ${ratio.toFixed(1)}x (${older.volume.toFixed(0)} → ${vol.toFixed(0)}) over ~${Math.round((now - older.timestamp) / 1000)}s; tick=${m.minimum_tick_size}`,
          created_by: this.id,
          ttl_ms: TTL_MS,
        });
        prioritiesWritten++;
        this.log.info(
          {
            condition_id: m.condition_id.substring(0, 12),
            ratio: Math.round(ratio * 100) / 100,
            prior_volume: older.volume,
            current_volume: vol,
            priority,
          },
          'Volume spike flagged',
        );
      } catch (err) {
        this.log.warn({ err, condition_id: m.condition_id }, 'Failed to insert priority row');
      }
    }

    // Garbage collect stale history entries for markets that have dropped
    // off the candidate set
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
