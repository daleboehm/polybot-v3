// ScoutCoordinator — runs all registered scouts on a shared interval timer
// inside the engine process.
//
// Phase 4 (2026-04-11). Scouts are not separate services — they live
// inside the engine process, share its market cache, and write to its
// database via repository functions. The coordinator is the bridge
// between the engine and the scouts: on engine start, it instantiates
// each scout and kicks off its own interval loop; on engine stop, it
// cleans up the timers.
//
// Design choices:
//   - Scouts run sequentially per tick, not in parallel. Market cache
//     reads are cheap, DB writes are fast on WAL mode, and sequential
//     runs give deterministic ordering for logs.
//   - One failed scout does NOT halt the other scouts. Each scout's
//     run() is try/catch-wrapped so a broken scout logs and moves on.
//   - Cost is tracked per-scout in the summary log so the dashboard
//     can later surface which scouts are actually finding opportunities.

import type { MarketCache } from '../market/market-cache.js';
import type { ScoutBase, ScoutRunResult } from './scout-base.js';
import { VolumeSpikeScout } from './volume-spike-scout.js';
import { PriceJumpScout } from './price-jump-scout.js';
import { NewListingScout } from './new-listing-scout.js';
import { LlmNewsScout } from './llm-news-scout.js';
import { LeaderboardPollerScout } from './leaderboard-poller-scout.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('scout-coordinator');

export interface ScoutCoordinatorConfig {
  enabled: boolean;
  /** How often to tick all scouts, in ms. Default 60s. */
  interval_ms: number;
  /** Explicitly enable/disable scouts by id. Missing id = enabled. */
  disabled_scouts: string[];
}

export const DEFAULT_SCOUT_COORDINATOR_CONFIG: ScoutCoordinatorConfig = {
  enabled: true,
  interval_ms: 60_000,
  disabled_scouts: [],
};

export class ScoutCoordinator {
  private scouts: ScoutBase[] = [];
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private tickCount = 0;

  constructor(private config: ScoutCoordinatorConfig = DEFAULT_SCOUT_COORDINATOR_CONFIG) {
    this.registerDefaultScouts();
  }

  private registerDefaultScouts(): void {
    // 2026-04-11 Phase C1a: LeaderboardPollerScout added but DEFAULT
    // DISABLED. Activation requires explicit operator opt-in via the
    // scouts.disabled_scouts yaml list (remove 'leaderboard-poller-scout'
    // from the list). See docs/todo.md WHALE ACTIVATION PLAYBOOK for
    // the full flip-on sequence.
    const all: ScoutBase[] = [
      new VolumeSpikeScout(),
      new PriceJumpScout(),
      new NewListingScout(),
      new LlmNewsScout(),
      new LeaderboardPollerScout(),
    ];
    this.scouts = all.filter(s => !this.config.disabled_scouts.includes(s.id));
    log.info(
      {
        enabled: this.scouts.map(s => s.id),
        disabled: this.config.disabled_scouts,
      },
      'Scouts registered',
    );
  }

  start(marketCache: MarketCache): void {
    if (!this.config.enabled) {
      log.info('ScoutCoordinator disabled via config — not starting');
      return;
    }
    if (this.interval) {
      log.warn('ScoutCoordinator already running');
      return;
    }
    this.interval = setInterval(() => {
      if (this.running) return;
      this.tickOnce(marketCache);
    }, this.config.interval_ms);
    log.info(
      {
        interval_ms: this.config.interval_ms,
        scout_count: this.scouts.length,
      },
      'ScoutCoordinator started',
    );
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
      log.info('ScoutCoordinator stopped');
    }
  }

  /** Run all scouts once. Synchronous — scouts are cheap. */
  tickOnce(marketCache: MarketCache): void {
    this.running = true;
    try {
      this.tickCount++;
      const results: ScoutRunResult[] = [];
      for (const scout of this.scouts) {
        try {
          const result = scout.run(marketCache);
          results.push(result);
        } catch (err) {
          log.error(
            { err, scout: scout.id },
            'Scout run failed — continuing with remaining scouts',
          );
        }
      }

      const totalPri = results.reduce((s, r) => s + r.priorities_written, 0);
      const totalInt = results.reduce((s, r) => s + r.intel_written, 0);
      if (totalPri > 0 || totalInt > 0) {
        log.info(
          {
            tick: this.tickCount,
            priorities: totalPri,
            intel: totalInt,
            per_scout: results
              .filter(r => r.priorities_written > 0 || r.intel_written > 0)
              .map(r => `${r.scout_id}:${r.priorities_written}p/${r.intel_written}i`),
          },
          'Scout tick complete',
        );
      }
    } finally {
      this.running = false;
    }
  }
}
