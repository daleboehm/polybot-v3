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
  reason: 'stop_loss' | 'hard_stop' | 'profit_target' | 'trailing_lock';
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

    // 2026-04-16 Fix 4: hold-to-settlement for directional weather subs.
    // arXiv 2604.07355 (6 AI models, 57 days, real money) found that weather
    // positions outperform when held to settlement — early exits lock in
    // path-dependent losses from intra-day forecast volatility that typically
    // mean-reverts by the resolution time. Our own R&D data corroborates:
    // weather_forecast/single_forecast is the #1 P&L contributor across all
    // strategies. We gate ALL non-emergency exits on directional weather
    // positions so trailing-lock and stop-loss can't fire against them.
    //
    // Still honored on weather positions:
    //   - profit_target (positive exit — good to take)
    //   - hard_stop (catastrophic floor — independent safety net)
    // Suppressed on weather directional subs:
    //   - trailing_lock (early exit on a pullback)
    //   - stop_loss (drawdown-triggered exit)
    //
    // ensemble_spread_fade is explicitly a low-confidence contrarian trade
    // and gets normal exits. Other strategies are unaffected.
    //
    // V1 implementation: strategy-level rule. V2 will read a per-position
    // `hold_to_settlement` flag from the positions table once the schema is
    // migrated (the flag is set at signal time from ensemble confidence in
    // weather-forecast.ts — see Fix 4).
    const isWeatherHold =
      pos.strategy_id === 'weather_forecast' &&
      pos.sub_strategy_id !== 'ensemble_spread_fade' &&
      pos.sub_strategy_id !== null;

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

    // 2026-04-11 Phase 2.5: trailing profit lock.
    // If the position has EVER reached peak PnL >= trailing_activation_pct
    // (default 20%) AND current PnL has dropped below peak * retention
    // (default 70%), trigger an exit to lock in at least (peak * 0.70) of
    // the observed profit.
    //
    // CRITICAL: the trigger is gated on pnlPct > 0 so this NEVER fires on
    // a loss. This respects Dale's NO-LOSE mantra — it's upside protection,
    // not a stop-loss. Losing positions are held to resolution.
    const trailActivation = this.limits.trailing_activation_pct ?? 0.20;
    const trailRetention = this.limits.trailing_retention_pct ?? 0.70;
    const peak = pos.peak_pnl_pct ?? 0;
    if (
      !isWeatherHold && // Fix 4: weather directional subs hold to settlement
      trailRetention > 0 &&
      peak >= trailActivation &&
      pnlPct > 0 && // never exit at a loss
      pnlPct < peak * trailRetention
    ) {
      return {
        entity_slug: pos.entity_slug,
        condition_id: pos.condition_id,
        token_id: pos.token_id,
        reason: 'trailing_lock',
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

    // Tiered stop loss (only after min hold period, and never on
    // weather directional subs — Fix 4 hold-to-settlement).
    if (!isWeatherHold && pastMinHold && pnlPct < 0) {
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
