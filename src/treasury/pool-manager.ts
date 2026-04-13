// Central treasury & profit pool — R3c dormant subsystem.
//
// R3c (2026-04-10). Per Dale 2026-04-10: as the fleet activates, profits
// from all 16 entities flow to a central treasury once per day. The treasury
// then:
//   1. Tops up any entity that dropped below its working-capital floor
//   2. Funds newly-provisioned entities as they come online
//   3. Allocates remainder to debt service for the Caspian $2.5M debt
//   4. Reserves the rest for growth
//
// A Brown entity is EXCLUDED from the pool (Dale 2026-04-10: "keep A Brown
// separate once it gets funded"). Its profits stay with the A Brown wallet.
//
// **DORMANT BY DEFAULT** behind `FLEET_ACTIVE=true`. In single-entity mode
// there's nothing to pool — only Caspian is funded.
//
// Daily sweep cadence (Dale 2026-04-10, Item 1 walk): at 00:00 UTC sweep all
// non-isolated entities' excess over working-capital floor into the pool.

import { eventBus } from '../core/event-bus.js';
import { createChildLogger } from '../core/logger.js';
import type { EntityManager } from '../entity/entity-manager.js';

const log = createChildLogger('treasury');

export interface PoolAllocation {
  toDebtService: number;     // paid out to Caspian debt service
  toEntityRefund: number;    // topped up under-floor entities
  toGrowthReserve: number;   // held for future entity activation
}

export interface SweepResult {
  sweptAt: Date;
  totalInflow: number;
  perEntityInflow: Record<string, number>;
  allocation: PoolAllocation;
  poolBalanceBefore: number;
  poolBalanceAfter: number;
  refunds: Array<{ entitySlug: string; amountUsd: number }>;
  skippedEntities: string[];  // isolated or pending
}

export interface TreasuryConfig {
  workingCapitalFloorUsd: number;  // e.g. 2000 per Dale Q1 (deferred)
  debtServicePctOfSurplus: number; // e.g. 0.50 = 50% of pool surplus to debt
  growthReservePct: number;        // e.g. 0.30 = 30% to growth reserve
  sweepHourUtc: number;            // 0-23
  isolatedEntities: Set<string>;   // slugs excluded from pool
}

export const DEFAULT_TREASURY_CONFIG: TreasuryConfig = {
  workingCapitalFloorUsd: 2000,
  debtServicePctOfSurplus: 0.50,
  growthReservePct: 0.30,
  sweepHourUtc: 0,
  isolatedEntities: new Set(['a-brown']),
};

export class PoolManager {
  private poolBalance = 0;
  private lastSweepAt: Date | null = null;
  private sweepHistory: SweepResult[] = [];
  private active = false;
  private sweepInterval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private entityManager: EntityManager,
    private readonly config: TreasuryConfig = DEFAULT_TREASURY_CONFIG,
  ) {}

  activate(): void {
    this.active = true;
    log.info({ config: { ...this.config, isolatedEntities: Array.from(this.config.isolatedEntities) } }, 'Treasury activated');
    // Check every 30 min whether we've crossed the sweep hour
    this.sweepInterval = setInterval(() => this.maybeRunDailySweep(), 30 * 60 * 1000);
    this.maybeRunDailySweep();
  }

  deactivate(): void {
    if (this.sweepInterval) clearInterval(this.sweepInterval);
    this.sweepInterval = null;
    this.active = false;
  }

  isActive(): boolean {
    return this.active;
  }

  getPoolBalance(): number {
    return this.poolBalance;
  }

  getLastSweep(): SweepResult | null {
    return this.sweepHistory.length > 0 ? this.sweepHistory[this.sweepHistory.length - 1] : null;
  }

  private maybeRunDailySweep(): void {
    const now = new Date();
    if (now.getUTCHours() !== this.config.sweepHourUtc) return;
    if (this.lastSweepAt && now.getUTCDate() === this.lastSweepAt.getUTCDate() && now.getUTCMonth() === this.lastSweepAt.getUTCMonth()) {
      return; // already swept today
    }
    this.runSweep();
  }

  /**
   * Force a sweep immediately (operator-triggered). Use for testing or
   * to catch up after an engine restart that crossed the sweep hour.
   */
  runSweep(): SweepResult {
    const now = new Date();
    const poolBefore = this.poolBalance;
    const perEntityInflow: Record<string, number> = {};
    const refunds: Array<{ entitySlug: string; amountUsd: number }> = [];
    const skippedEntities: string[] = [];
    let totalInflow = 0;

    // Pass 1: collect excess from each non-isolated entity above working capital floor
    for (const entity of this.entityManager.getAllEntities()) {
      if (this.config.isolatedEntities.has(entity.config.slug)) {
        skippedEntities.push(entity.config.slug);
        continue;
      }
      const excess = Math.max(0, entity.cash_balance - this.config.workingCapitalFloorUsd);
      if (excess > 0) {
        perEntityInflow[entity.config.slug] = excess;
        totalInflow += excess;
        this.entityManager.updateBalances(
          entity.config.slug,
          entity.cash_balance - excess,
          entity.reserve_balance,
          entity.cash_balance - excess, // trading_balance == cash (2026-04-10)
        );
      }
    }

    this.poolBalance += totalInflow;

    // Pass 2: refund any non-isolated entity that's currently BELOW the floor
    for (const entity of this.entityManager.getAllEntities()) {
      if (this.config.isolatedEntities.has(entity.config.slug)) continue;
      const deficit = this.config.workingCapitalFloorUsd - entity.cash_balance;
      if (deficit <= 0) continue;
      const refund = Math.min(deficit, this.poolBalance);
      if (refund > 0) {
        this.poolBalance -= refund;
        this.entityManager.updateBalances(
          entity.config.slug,
          entity.cash_balance + refund,
          entity.reserve_balance,
          (entity.cash_balance + refund) * 0.4,
        );
        refunds.push({ entitySlug: entity.config.slug, amountUsd: refund });
      }
    }

    // Pass 3: allocate remaining pool balance per config
    const surplus = this.poolBalance;
    const toDebtService = surplus * this.config.debtServicePctOfSurplus;
    const toGrowthReserve = surplus * this.config.growthReservePct;
    const allocation: PoolAllocation = {
      toDebtService,
      toEntityRefund: refunds.reduce((s, r) => s + r.amountUsd, 0),
      toGrowthReserve,
    };
    // We DON'T actually pay out debt service here — just earmark and log.
    // External accounting handles the USDC → fiat transfer offline.
    // Pool balance stays the same (the allocation is a view, not a transfer).

    const result: SweepResult = {
      sweptAt: now,
      totalInflow,
      perEntityInflow,
      allocation,
      poolBalanceBefore: poolBefore,
      poolBalanceAfter: this.poolBalance,
      refunds,
      skippedEntities,
    };
    this.lastSweepAt = now;
    this.sweepHistory.push(result);
    if (this.sweepHistory.length > 100) this.sweepHistory.shift();

    eventBus.emit('treasury:sweep', {
      result: {
        totalInflow: result.totalInflow,
        poolBalanceAfter: result.poolBalanceAfter,
        refunds: result.refunds.length,
        sweptAt: result.sweptAt,
      },
    });
    log.info(
      {
        inflow: totalInflow.toFixed(2),
        refunds: refunds.length,
        pool: this.poolBalance.toFixed(2),
        skipped: skippedEntities,
      },
      'Treasury sweep complete',
    );
    return result;
  }

  snapshot(): Record<string, unknown> {
    return {
      active: this.active,
      pool_balance: this.poolBalance,
      last_sweep: this.lastSweepAt?.toISOString() ?? null,
      sweep_history_count: this.sweepHistory.length,
      config: {
        ...this.config,
        isolatedEntities: Array.from(this.config.isolatedEntities),
      },
    };
  }
}
