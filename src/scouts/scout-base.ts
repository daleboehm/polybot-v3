// Scout base class — in-process market watchers that feed the
// attention router (priority table) and the qualitative overlay
// (intel table).
//
// Phase 4 (2026-04-11). Scouts run as interval timers inside the engine
// process — not separate services. They read from `marketCache` directly,
// compute heuristics over sliding windows they maintain themselves, and
// write rows into either `market_priorities` (attention router) or
// `scout_intel` (qualitative overlay) as findings emerge.
//
// Why in-process?
//   - No new systemd unit, no cron timer, no cross-process coordination
//   - Direct access to the engine's live market cache (no DB round trip)
//   - Scouts deploy atomically with the engine binary
//   - Sliding-window state lives in scout memory — survives as long as
//     the engine process does, exactly matching the engine's uptime
//
// Scouts NEVER place orders. They can only:
//   1. insertPriority() — tell the engine to scan a market out-of-cycle
//   2. insertIntel() — record a qualitative opinion that strategies
//      will consume via scout-overlay.ts during signal build
//
// Each scout is a subclass of ScoutBase with its own run() implementation.
// The ScoutCoordinator runs all scouts on a shared timer and logs
// aggregate findings per tick.

import type { MarketCache } from '../market/market-cache.js';
import type { MarketData } from '../types/index.js';
import { createChildLogger } from '../core/logger.js';

type Logger = ReturnType<typeof createChildLogger>;

export interface ScoutRunResult {
  /** Scout's unique ID — used as `created_by` on rows it writes. */
  scout_id: string;
  /** Number of priority rows written this run. */
  priorities_written: number;
  /** Number of intel rows written this run. */
  intel_written: number;
  /** Number of markets the scout evaluated. */
  markets_evaluated: number;
  /** Human-readable summary of what happened, if anything. */
  summary: string | null;
}

export abstract class ScoutBase {
  abstract readonly id: string;
  abstract readonly description: string;
  protected log: Logger;

  constructor() {
    // createChildLogger is typed such that this.id isn't known until the
    // subclass runs its own constructor. We create the logger with a
    // placeholder and let subclasses override via their constructor.
    this.log = createChildLogger('scout:base');
  }

  /**
   * Called once per scout tick by the coordinator. Returns a ScoutRunResult
   * summarizing what the scout did this tick. Subclasses should log their
   * own per-row decisions at debug level and rely on the summary for info-
   * level visibility.
   */
  abstract run(marketCache: MarketCache): ScoutRunResult;

  /**
   * Helper used by subclasses that need to iterate active, non-closed
   * markets inside the engine's sampling window. Matches the filter used
   * by StrategyContext.getActiveMarkets() so scouts see the same market
   * universe the strategies will evaluate.
   */
  protected getCandidateMarkets(
    marketCache: MarketCache,
    minHours = 1,
    maxHours = 48,
  ): MarketData[] {
    const now = Date.now();
    const minMs = minHours * 60 * 60 * 1000;
    const maxMs = maxHours * 60 * 60 * 1000;
    return marketCache.getActive().filter(m => {
      if (!m.active || m.closed) return false;
      if (!m.end_date) return false;
      const delta = m.end_date.getTime() - now;
      return delta >= minMs && delta <= maxMs;
    });
  }

  protected emptyResult(): ScoutRunResult {
    return {
      scout_id: this.id,
      priorities_written: 0,
      intel_written: 0,
      markets_evaluated: 0,
      summary: null,
    };
  }
}
