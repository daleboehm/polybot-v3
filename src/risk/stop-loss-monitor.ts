// Position-level stop loss and profit target monitor

import type { RiskLimits, TieredStop } from '../types/index.js';
import type { PositionRow } from '../storage/repositories/position-repo.js';
import { getAllOpenPositions } from '../storage/repositories/position-repo.js';
import { eventBus } from '../core/event-bus.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('stop-loss-monitor');

export interface ExitSignal {
  entity_slug: string;
  condition_id: string;
  token_id: string;
  reason: 'stop_loss' | 'hard_stop' | 'profit_target';
  current_pnl_pct: number;
  current_pnl_usd: number;
}

export class StopLossMonitor {
  constructor(private limits: RiskLimits) {}

  /**
   * Scan all open positions and return any that trigger exit conditions.
   */
  scan(): ExitSignal[] {
    const positions = getAllOpenPositions();
    const exits: ExitSignal[] = [];

    for (const pos of positions) {
      const exit = this.checkPosition(pos);
      if (exit) exits.push(exit);
    }

    if (exits.length > 0) {
      log.info({ count: exits.length }, 'Exit signals generated');
    }

    return exits;
  }

  private checkPosition(pos: PositionRow): ExitSignal | null {
    if (pos.current_price === null || pos.avg_entry_price <= 0) return null;

    const pnlPct = (pos.current_price - pos.avg_entry_price) / pos.avg_entry_price;
    const pnlUsd = (pos.current_price - pos.avg_entry_price) * pos.size;

    // Check hold period — don't stop-loss too early
    const openedAt = new Date(pos.opened_at).getTime();
    const holdHours = (Date.now() - openedAt) / (1000 * 60 * 60);
    const pastMinHold = holdHours >= this.limits.min_hold_hours;

    // Profit target (always active regardless of hold period)
    if (pnlPct >= this.limits.profit_target_pct) {
      return {
        entity_slug: pos.entity_slug,
        condition_id: pos.condition_id,
        token_id: pos.token_id,
        reason: 'profit_target',
        current_pnl_pct: pnlPct,
        current_pnl_usd: pnlUsd,
      };
    }

    // Hard stop (always active — absolute USD loss)
    if (pnlUsd <= -this.limits.hard_stop_usd) {
      return {
        entity_slug: pos.entity_slug,
        condition_id: pos.condition_id,
        token_id: pos.token_id,
        reason: 'hard_stop',
        current_pnl_pct: pnlPct,
        current_pnl_usd: pnlUsd,
      };
    }

    // Tiered stop loss (only after min hold period)
    if (pastMinHold && pnlPct < 0) {
      const tierStop = this.getTieredStopPct(pos.avg_entry_price);
      const effectiveStop = tierStop ?? this.limits.stop_loss_pct;

      if (effectiveStop !== null && Math.abs(pnlPct) >= effectiveStop) {
        return {
          entity_slug: pos.entity_slug,
          condition_id: pos.condition_id,
          token_id: pos.token_id,
          reason: 'stop_loss',
          current_pnl_pct: pnlPct,
          current_pnl_usd: pnlUsd,
        };
      }
    }

    return null;
  }

  private getTieredStopPct(entryPrice: number): number | null {
    for (const tier of this.limits.tiered_stops) {
      if (entryPrice >= tier.min_entry && entryPrice <= tier.max_entry) {
        return tier.stop_pct;
      }
    }
    return null; // Fall through to default stop_loss_pct
  }
}
