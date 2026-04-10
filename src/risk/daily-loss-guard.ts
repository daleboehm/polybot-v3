// Daily P&L tracking and lockout enforcement

import type { EntityState, RiskLimits } from '../types/index.js';
import type { EntityManager } from '../entity/entity-manager.js';
import { updateEntityDailyPnl } from '../storage/repositories/entity-repo.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('daily-loss-guard');

export class DailyLossGuard {
  constructor(
    private entityManager: EntityManager,
    private limits: RiskLimits,
  ) {}

  /**
   * Called after each trade/resolution to update daily P&L.
   * Triggers lockout if threshold breached.
   */
  recordPnl(entitySlug: string, pnl: number): void {
    const entity = this.entityManager.getEntity(entitySlug);
    if (!entity) return;

    this.resetIfNewDay(entity);
    this.entityManager.addDailyPnl(entitySlug, pnl);

    const updatedEntity = this.entityManager.getEntity(entitySlug)!;
    updateEntityDailyPnl(entitySlug, updatedEntity.daily_pnl, updatedEntity.daily_pnl_reset_date);

    // AUDIT FIX A-P1-5 (2026-04-10): guard against daily_loss_lockout_usd = 0 (disabled).
    // Without the `> 0` guard, the check becomes `daily_pnl <= 0` which fires on the
    // first negative cent, locking out the entity even when the feature is disabled.
    if (
      this.limits.daily_loss_lockout_usd > 0 &&
      updatedEntity.daily_pnl <= -this.limits.daily_loss_lockout_usd &&
      !updatedEntity.is_locked_out
    ) {
      this.entityManager.lockOut(
        entitySlug,
        `Daily loss $${Math.abs(updatedEntity.daily_pnl).toFixed(2)} exceeded $${this.limits.daily_loss_lockout_usd} threshold`,
      );
      log.warn({ entity: entitySlug, pnl: updatedEntity.daily_pnl }, 'Daily loss lockout triggered');
    }
  }

  /**
   * Run at the start of each cycle to reset daily counters and unlock entities.
   */
  checkDailyReset(): void {
    for (const entity of this.entityManager.getAllEntities()) {
      const wasReset = this.resetIfNewDay(entity);
      if (wasReset && entity.is_locked_out) {
        this.entityManager.unlock(entity.config.slug);
        log.info({ entity: entity.config.slug }, 'Daily lockout reset');
      }
    }
  }

  private resetIfNewDay(entity: EntityState): boolean {
    const today = new Date().toISOString().split('T')[0];
    if (entity.daily_pnl_reset_date !== today) {
      entity.daily_pnl = 0;
      entity.daily_pnl_reset_date = today;
      updateEntityDailyPnl(entity.config.slug, 0, today);
      return true;
    }
    return false;
  }
}
