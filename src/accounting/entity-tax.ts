// Per-entity tax accounting — R3c dormant subsystem, live data for single entity.
//
// R3c (2026-04-10). Dale 2026-04-10: "I will need tax tracking regardless"
// (the entities map to real tax filers eventually). This module computes
// FIFO cost basis, realized P&L, and year-to-date totals per entity — all
// from the existing `trades` + `resolutions` tables, no schema change needed.
//
// The accountant/CPA will pull this via CLI or dashboard at quarter-end.
// Everything is computed on-demand (no cron, no materialized view) so it
// always reflects the latest state.

import { getDatabase } from '../storage/database.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('entity-tax');

export type CostBasisMethod = 'FIFO' | 'LIFO';

export interface TaxLot {
  openedAt: string;        // ISO
  entitySlug: string;
  conditionId: string;
  tokenId: string;
  size: number;
  costBasis: number;       // USD paid to acquire
  strategyId: string | null;
}

export interface RealizedGain {
  closedAt: string;
  entitySlug: string;
  conditionId: string;
  tokenId: string;
  size: number;
  proceeds: number;         // USD received (payout_usdc or sell_proceeds)
  costBasis: number;        // matched from lot (FIFO/LIFO)
  realizedPnl: number;      // proceeds - costBasis
  holdingPeriodDays: number;
  isShortTerm: boolean;     // true if < 365 days
}

export interface TaxSummary {
  entitySlug: string;
  year: number;
  totalProceeds: number;
  totalCostBasis: number;
  netRealizedPnl: number;
  shortTermGains: number;
  longTermGains: number;
  winCount: number;
  lossCount: number;
  resolutions: number;
  lots: RealizedGain[];
}

export class EntityTaxLedger {
  constructor(private readonly method: CostBasisMethod = 'FIFO') {}

  /**
   * Compute the full tax summary for an entity for a given calendar year.
   * Walks chronologically through trades + resolutions, matches closes against
   * open lots by FIFO/LIFO, and produces a year-to-date summary ready for CPA
   * export.
   */
  computeYearSummary(entitySlug: string, year: number): TaxSummary {
    const db = getDatabase();

    // All buy fills (lots opened)
    const buyFills = db.prepare(`
      SELECT entity_slug, condition_id, token_id, size, net_usdc, strategy_id, timestamp
      FROM trades
      WHERE entity_slug = ? AND side = 'BUY'
      ORDER BY timestamp ASC
    `).all(entitySlug) as Array<{
      entity_slug: string;
      condition_id: string;
      token_id: string;
      size: number;
      net_usdc: number;
      strategy_id: string | null;
      timestamp: number;
    }>;

    // All resolutions (lot closes via resolution)
    const resolutions = db.prepare(`
      SELECT entity_slug, condition_id, token_id, size, payout_usdc, cost_basis_usdc,
             realized_pnl, resolved_at
      FROM resolutions
      WHERE entity_slug = ?
      ORDER BY resolved_at ASC
    `).all(entitySlug) as Array<{
      entity_slug: string;
      condition_id: string;
      token_id: string;
      size: number;
      payout_usdc: number;
      cost_basis_usdc: number;
      realized_pnl: number;
      resolved_at: string;
    }>;

    // Build per-token lot queues
    const lotQueues = new Map<string, TaxLot[]>();
    for (const buy of buyFills) {
      const key = `${buy.condition_id}|${buy.token_id}`;
      let queue = lotQueues.get(key);
      if (!queue) {
        queue = [];
        lotQueues.set(key, queue);
      }
      queue.push({
        openedAt: new Date(buy.timestamp * 1000).toISOString(),
        entitySlug: buy.entity_slug,
        conditionId: buy.condition_id,
        tokenId: buy.token_id,
        size: buy.size,
        costBasis: buy.net_usdc,
        strategyId: buy.strategy_id,
      });
    }

    // Walk resolutions chronologically, matching lots
    const realizedGains: RealizedGain[] = [];
    for (const resolution of resolutions) {
      const closedAtMs = new Date(resolution.resolved_at).getTime();
      const closedYear = new Date(resolution.resolved_at).getUTCFullYear();
      if (closedYear !== year) continue;

      const key = `${resolution.condition_id}|${resolution.token_id}`;
      const queue = lotQueues.get(key);
      if (!queue || queue.length === 0) {
        // Lot not found — the resolution predates our trade history, skip.
        log.debug({ condition: resolution.condition_id, token: resolution.token_id }, 'No matching lot for resolution');
        continue;
      }

      let remainingSize = resolution.size;
      let remainingProceeds = resolution.payout_usdc;
      while (remainingSize > 0 && queue.length > 0) {
        const lot = this.method === 'FIFO' ? queue[0] : queue[queue.length - 1];
        const matched = Math.min(remainingSize, lot.size);
        const matchedCostBasis = (matched / lot.size) * lot.costBasis;
        const matchedProceeds = remainingSize > 0 ? (matched / resolution.size) * resolution.payout_usdc : 0;

        const openedAtMs = new Date(lot.openedAt).getTime();
        const holdingDays = (closedAtMs - openedAtMs) / (1000 * 60 * 60 * 24);

        realizedGains.push({
          closedAt: resolution.resolved_at,
          entitySlug,
          conditionId: resolution.condition_id,
          tokenId: resolution.token_id,
          size: matched,
          proceeds: matchedProceeds,
          costBasis: matchedCostBasis,
          realizedPnl: matchedProceeds - matchedCostBasis,
          holdingPeriodDays: holdingDays,
          isShortTerm: holdingDays < 365,
        });

        lot.size -= matched;
        lot.costBasis -= matchedCostBasis;
        remainingSize -= matched;
        remainingProceeds -= matchedProceeds;

        if (lot.size <= 0.0001) {
          if (this.method === 'FIFO') queue.shift();
          else queue.pop();
        }
      }
    }

    // Aggregate
    const totalProceeds = realizedGains.reduce((s, r) => s + r.proceeds, 0);
    const totalCostBasis = realizedGains.reduce((s, r) => s + r.costBasis, 0);
    const shortTermGains = realizedGains.filter(r => r.isShortTerm).reduce((s, r) => s + r.realizedPnl, 0);
    const longTermGains = realizedGains.filter(r => !r.isShortTerm).reduce((s, r) => s + r.realizedPnl, 0);
    const winCount = realizedGains.filter(r => r.realizedPnl > 0).length;
    const lossCount = realizedGains.filter(r => r.realizedPnl < 0).length;

    return {
      entitySlug,
      year,
      totalProceeds,
      totalCostBasis,
      netRealizedPnl: totalProceeds - totalCostBasis,
      shortTermGains,
      longTermGains,
      winCount,
      lossCount,
      resolutions: realizedGains.length,
      lots: realizedGains,
    };
  }

  /**
   * Export the tax summary as CSV rows suitable for CPA import.
   */
  exportCsv(summary: TaxSummary): string {
    const lines: string[] = [];
    lines.push('date_closed,entity,condition_id,token_id,size,proceeds,cost_basis,realized_pnl,holding_days,short_term');
    for (const r of summary.lots) {
      lines.push([
        r.closedAt.split('T')[0],
        r.entitySlug,
        r.conditionId,
        r.tokenId,
        r.size.toFixed(4),
        r.proceeds.toFixed(2),
        r.costBasis.toFixed(2),
        r.realizedPnl.toFixed(2),
        r.holdingPeriodDays.toFixed(0),
        r.isShortTerm ? '1' : '0',
      ].join(','));
    }
    return lines.join('\n') + '\n';
  }
}
