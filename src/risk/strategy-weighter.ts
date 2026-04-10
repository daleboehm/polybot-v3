// Strategy Weighter — R&D cash-preservation rationing (NOT alpha promotion).
//
// PURPOSE (Dale 2026-04-10, lessons.md): the R&D weighter is a cash-preservation
// device. Its job is to keep R&D buying across ALL sub-strategies for coverage
// (the whole strategy space must keep producing resolution data for analytical
// purposes) while REDUCING bet size on known-underperforming subs so paper cash
// isn't burned exploring dead ends. It is NOT a signal-promotion device — that
// job belongs to the Strategy Advisor, which reads R&D's performance view and
// auto-enables validated subs on the prod engine.
//
// TIERS (R2 PR#2, 2026-04-10 — renamed from proven/promising/unproven/under-
// performing to Dale's Avoid/Monitor/Buy vocabulary, now gated on Wilson LB):
//
//   - Buy:     Wilson LB ≥ 0.52 AND n ≥ 30 AND total_pnl > 0
//              → weight scales 1.0 → 2.0 by LB overshoot above 0.52
//   - Monitor: n < 30 OR Wilson LB between 0.45 and 0.52
//              → weight 1.0 (neutral baseline — new subs default here)
//   - Avoid:   Wilson LB < 0.45 AND n ≥ 30, OR total_pnl < -$2 AND n ≥ 30
//              → weight 0.15 (floor — never zero; keeps data flowing for
//                regime-change detection per Dale 2026-04-10)
//
// The 0.15 floor is CRITICAL. A sub that goes to zero weight stops producing
// resolutions, creating a blind spot in the exploration map. If market conditions
// change and that sub becomes profitable again, we won't notice because there's
// no data flowing.
//
// Cross-entity cache keying: audit A-P1-2 fix. The old code keyed by
// `${strategy_id}|${sub_strategy_id}` which collided across R&D's 16 paper
// entities (each entity has different data). New key includes entity_slug.

import { getStrategyPerformance } from '../storage/repositories/resolution-repo.js';
import { wilsonLowerBound, classifyTier, type Tier } from './wilson.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('strategy-weighter');

export interface StrategyWeight {
  strategy_id: string;
  sub_strategy_id: string;  // empty string for parent-only
  entity_slug: string;       // populated when entity-scoped, empty for fleet-wide
  weight: number;            // 0.15 to 2.0 multiplier applied to position size
  tier: Tier;                // 'avoid' | 'monitor' | 'buy'
  reason: string;
  wilson_lb: number;         // conservative win-rate estimate
  n: number;                 // total resolved positions (sample size)
}

const MIN_BUY_N = 30;              // minimum sample size to qualify for Buy
const BUY_LB_THRESHOLD = 0.52;     // Wilson LB floor for Buy tier
const AVOID_LB_THRESHOLD = 0.45;   // Wilson LB ceiling for Avoid tier
const WEIGHT_FLOOR = 0.15;         // never let any sub go to zero
const WEIGHT_CEILING = 2.0;        // cap amplification at 2.0x
const MONITOR_DEFAULT = 1.0;       // neutral baseline weight
const AVOID_PNL_FLOOR = -2.0;      // $-2 practical-significance floor for Avoid

export class StrategyWeighter {
  private weights = new Map<string, StrategyWeight>(); // key: `${entitySlug}|${strategy}|${sub}`
  private lastUpdate = 0;
  private updateIntervalMs = 300_000; // 5 minutes

  /**
   * Get weight for a (strategy, sub-strategy, entity) triple. Returns the
   * Monitor-tier neutral baseline (1.0) if no data exists yet — per Dale
   * 2026-04-10, brand-new subs should NOT be under-sized; the 0.25 default
   * from the original code was wrong because it double-punished against the
   * global fractional Kelly.
   */
  getWeight(strategyId: string, subStrategyId?: string, entitySlug?: string): number {
    this.refreshIfStale();

    // Try exact (entity, strategy, sub) match first
    if (entitySlug && subStrategyId) {
      const exact = this.weights.get(this.key(entitySlug, strategyId, subStrategyId));
      if (exact) return exact.weight;
    }

    // Fall back to (entity, strategy) parent
    if (entitySlug) {
      const parent = this.weights.get(this.key(entitySlug, strategyId, ''));
      if (parent) return parent.weight;
    }

    // Fall back to fleet-wide (no entity scope) — for prod or new entities
    if (subStrategyId) {
      const fleetExact = this.weights.get(this.key('', strategyId, subStrategyId));
      if (fleetExact) return fleetExact.weight;
    }
    const fleetParent = this.weights.get(this.key('', strategyId, ''));
    if (fleetParent) return fleetParent.weight;

    // Brand-new sub with zero data → Monitor baseline. Do NOT return 0.25 here;
    // that starves exploration.
    return MONITOR_DEFAULT;
  }

  getWeightInfo(strategyId: string, subStrategyId?: string, entitySlug?: string): StrategyWeight | undefined {
    this.refreshIfStale();
    if (entitySlug && subStrategyId) {
      const exact = this.weights.get(this.key(entitySlug, strategyId, subStrategyId));
      if (exact) return exact;
    }
    if (entitySlug) {
      const parent = this.weights.get(this.key(entitySlug, strategyId, ''));
      if (parent) return parent;
    }
    if (subStrategyId) {
      const fleetExact = this.weights.get(this.key('', strategyId, subStrategyId));
      if (fleetExact) return fleetExact;
    }
    return this.weights.get(this.key('', strategyId, ''));
  }

  getAllWeights(): StrategyWeight[] {
    this.refreshIfStale();
    return Array.from(this.weights.values());
  }

  /**
   * Force a refresh on the next call. Useful after a new resolution lands.
   */
  invalidate(): void {
    this.lastUpdate = 0;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private key(entitySlug: string, strategyId: string, subStrategyId: string): string {
    return `${entitySlug}|${strategyId}|${subStrategyId}`;
  }

  private refreshIfStale(): void {
    const now = Date.now();
    if (now - this.lastUpdate < this.updateIntervalMs) return;
    this.lastUpdate = now;

    try {
      const perfRows = getStrategyPerformance();
      const newWeights = new Map<string, StrategyWeight>();

      for (const row of perfRows) {
        const {
          strategy_id,
          sub_strategy_id = '',
          entity_slug = '',
          total_resolutions: n,
          wins = 0,
          total_pnl,
        } = row as { strategy_id: string; sub_strategy_id?: string; entity_slug?: string; total_resolutions: number; wins?: number; total_pnl: number };

        const tierResult = classifyTier(wins ?? 0, n);
        let weight: number;
        let reason: string;
        let tier: Tier = tierResult.tier;

        if (tierResult.tier === 'buy' && total_pnl > 0) {
          // Linear boost: LB=0.52 → 1.0, LB=0.70 → 2.0 (capped)
          const normalized = Math.max(0, Math.min(1, (tierResult.lb - BUY_LB_THRESHOLD) / (0.70 - BUY_LB_THRESHOLD)));
          weight = Math.min(WEIGHT_CEILING, MONITOR_DEFAULT + normalized * (WEIGHT_CEILING - MONITOR_DEFAULT));
          reason = `Buy: Wilson LB ${tierResult.lb.toFixed(3)}, ${n} resolved, $${total_pnl.toFixed(2)} P&L → ${weight.toFixed(2)}x`;
        } else if (tierResult.tier === 'buy' && total_pnl <= 0) {
          // Statistically significant WR but negative P&L — means small-edge wins
          // being erased by bigger losses. Keep at Monitor, not Buy.
          tier = 'monitor';
          weight = MONITOR_DEFAULT;
          reason = `Monitor: Wilson LB ${tierResult.lb.toFixed(3)} would qualify for Buy but P&L $${total_pnl.toFixed(2)} < 0`;
        } else if (tierResult.tier === 'avoid' || (n >= MIN_BUY_N && total_pnl <= AVOID_PNL_FLOOR)) {
          tier = 'avoid';
          weight = WEIGHT_FLOOR;
          reason = `Avoid: Wilson LB ${tierResult.lb.toFixed(3)}, ${n} resolved, $${total_pnl.toFixed(2)} P&L → floor ${WEIGHT_FLOOR}x (preserve exploration coverage)`;
        } else {
          // Monitor (ambiguous OR insufficient data)
          weight = MONITOR_DEFAULT;
          reason = n < MIN_BUY_N
            ? `Monitor: insufficient data (${n}/${MIN_BUY_N} resolutions)`
            : `Monitor: Wilson LB ${tierResult.lb.toFixed(3)} in ambiguous band [${AVOID_LB_THRESHOLD}, ${BUY_LB_THRESHOLD})`;
        }

        newWeights.set(this.key(entity_slug, strategy_id, sub_strategy_id), {
          strategy_id,
          sub_strategy_id,
          entity_slug,
          weight,
          tier,
          reason,
          wilson_lb: tierResult.lb,
          n,
        });
      }

      this.weights = newWeights;

      if (newWeights.size > 0) {
        const tierCounts = { avoid: 0, monitor: 0, buy: 0 } as Record<Tier, number>;
        for (const w of newWeights.values()) tierCounts[w.tier] += 1;
        log.info(
          { strategies: newWeights.size, by_tier: tierCounts },
          'Strategy weights refreshed',
        );
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to refresh strategy weights');
    }
  }
}
