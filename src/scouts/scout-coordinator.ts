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
import { ExchangeDivergenceScout } from './exchange-divergence-scout.js';
import { KLDivergenceScout } from './kl-divergence-scout.js';
import { CrossMarketArbScout } from './cross-market-arb-scout.js';
import { CompleteSetArbScout } from './complete-set-arb-scout.js';
import { PositionIntelScout } from './position-intel-scout.js';
import { DuneWhaleScout } from './dune-whale-scout.js';
import { SubgraphWhaleScout } from './subgraph-whale-scout.js';
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

// 2026-04-15: log a periodic tick summary every N ticks even when totals are
// zero. Without this, all-zero ticks produce no log evidence and a silent
// scout fleet looks identical to a healthy one (this is exactly the trap that
// hid the scout_intel empty-table bug until we queried SQLite directly).
const PERIODIC_SUMMARY_EVERY_N_TICKS = 10;

export class ScoutCoordinator {
  private scouts: ScoutBase[] = [];
  private interval: NodeJS.Timeout | null = null;
  private running = false;
  private tickCount = 0;
  private lastSummaryAtTick = 0;

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
      new ExchangeDivergenceScout(),
      new KLDivergenceScout(),
      new CrossMarketArbScout(),
      new CompleteSetArbScout(),
      new PositionIntelScout(),
      new DuneWhaleScout(),
      new SubgraphWhaleScout(),
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
      const totalEval = results.reduce((s, r) => s + r.markets_evaluated, 0);
      const nonZeroTick = totalPri > 0 || totalInt > 0;
      const periodicTick =
        this.tickCount - this.lastSummaryAtTick >= PERIODIC_SUMMARY_EVERY_N_TICKS;
      if (nonZeroTick || periodicTick) {
        log.info(
          {
            tick: this.tickCount,
            evaluated: totalEval,
            priorities: totalPri,
            intel: totalInt,
            // Full per-scout breakdown so zero-tick ticks still show which
            // scouts are even looking at markets. Format: id:Mm/Pp/Ii.
            per_scout: results.map(
              r =>
                `${r.scout_id}:${r.markets_evaluated}m/${r.priorities_written}p/${r.intel_written}i`,
            ),
          },
          nonZeroTick ? 'Scout tick complete' : 'Scout tick summary (periodic, zero activity)',
        );
        this.lastSummaryAtTick = this.tickCount;
      }
    } finally {
      this.running = false;
    }
  }
}
