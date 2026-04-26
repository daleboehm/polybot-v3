// Strategy Advisor — reads R&D engine performance data and adjusts prod strategies
// Now evaluates per (strategy_id, sub_strategy_id) pair for granular promotion

import Database from 'better-sqlite3';
import type {
  AdvisorConfig,
  AdvisorDecision,
  AdvisorCheckResult,
  AdvisorStrategyRef,
  EntityStrategyConfig,
} from '../types/index.js';
import type { EntityManager } from '../entity/entity-manager.js';
import type { StrategyRegistry } from '../strategy/strategy-registry.js';
import { eventBus } from '../core/event-bus.js';
import { wilsonLowerBound, wilsonUpperBound } from './wilson.js';
import { computeAdvisorV2Decision, type AdvisorV2Decision } from './advisor-v2-metrics.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('strategy-advisor');

// R2 PR#2 (2026-04-10): advisor gates use Wilson LB/UB + practical P&L floors
// per rebuild-design-decisions-2026-04-10.md §B1/B2. Replaces raw win-rate gates
// (which were statistically meaningless at n=10 per audit §6.1).
const MIN_N_ENABLE = 50;
const MIN_WILSON_LB_ENABLE = 0.50;
const MIN_PNL_ENABLE = 5.0;

const MIN_N_DISABLE = 50;
const MAX_WILSON_UB_DISABLE = 0.50;
const MAX_PNL_DISABLE = -5.0;

// Phase B (2026-04-11): advisor v2 dual-decision shadow mode.
//
// When process.env.ADVISOR_V2_ENABLED === 'true', the advisor ALSO runs
// the DSR + PSR + MinTRL + Brier metrics pipeline (computeAdvisorV2Decision)
// on each pair and logs the result SIDE-BY-SIDE with the Wilson LB
// decision. Behavior is UNCHANGED — v2 output is shadow-logged only.
// This is the 7-day A/B window: we need to see how often DSR/PSR would
// disagree with Wilson LB before we let either one drive an auto
// enable/disable.
//
// Flag defaults OFF so the extra DB read (returns-series per pair) only
// happens when you explicitly opt in. To enable in R&D only:
//   systemctl edit polybot-v3-rd.service
//     Environment=ADVISOR_V2_ENABLED=true
//   systemctl restart polybot-v3-rd
//
// There is intentionally NO code path where v2 overrides Wilson. The
// point of this phase is measurement, not action. After the 7-day
// window, a follow-up PR will promote v2 to a voting role or replace
// Wilson outright.
const ADVISOR_V2_ENABLED = process.env.ADVISOR_V2_ENABLED === 'true';

function roundMetric(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return Math.round(x * 10000) / 10000;
}

interface RdStrategyRow {
  strategy_id: string;
  sub_strategy_id: string; // empty string for parent-only
  entity_slug: string;
  total_resolutions: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_pnl: number;
  avg_pnl_per_trade: number;
  best_trade: number;
  worst_trade: number;
  open_positions: number;
  open_cost_basis: number;
  open_upside: number;
  total_trades: number;
  total_volume: number;
}

export class StrategyAdvisor {
  private lastCheck = 0;

  constructor(
    private config: AdvisorConfig,
    private entityManager: EntityManager,
    private strategyRegistry: StrategyRegistry,
  ) {}

  check(): AdvisorCheckResult {
    const now = Date.now();
    if (now - this.lastCheck < this.config.check_interval_ms) {
      return {
        timestamp: new Date().toISOString(),
        decisions: [],
        strategies_before: [],
        strategies_after: [],
        changes_made: 0,
        rd_available: true,
      };
    }
    this.lastCheck = now;

    log.info('Running strategy advisor check');

    const entity = this.entityManager.getEntity(this.config.target_entity_slug);
    if (!entity) {
      log.warn({ slug: this.config.target_entity_slug }, 'Target entity not found');
      return {
        timestamp: new Date().toISOString(),
        decisions: [],
        strategies_before: [],
        strategies_after: [],
        changes_made: 0,
        rd_available: false,
        error: 'Target entity not found',
      };
    }

    // Normalize legacy strategies format
    const currentConfigs: EntityStrategyConfig[] = (entity.config.strategies ?? []).map(s =>
      typeof s === 'string' ? { strategy_id: s, sub_strategy_ids: undefined } : s
    );

    const strategiesBefore: AdvisorStrategyRef[] = currentConfigs.map(c => ({
      strategy_id: c.strategy_id,
      sub_strategy_ids: c.sub_strategy_ids,
    }));

    // Read R&D data keyed by `${strategy_id}|${sub_strategy_id}`
    let rdData: Map<string, RdStrategyRow>;
    try {
      rdData = this.readRdPerformance();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ error: msg }, 'R&D database unavailable — skipping advisor check');
      return {
        timestamp: new Date().toISOString(),
        decisions: [],
        strategies_before: strategiesBefore,
        strategies_after: strategiesBefore,
        changes_made: 0,
        rd_available: false,
        error: msg,
      };
    }

    // 2026-04-11 Phase 2.3: recent (last 14 days) Wilson LB for regime
    // decay detection. Read once, alongside the all-time data; used in
    // the disable branch below to catch strategies that are failing NOW
    // even though their all-time stats still look OK.
    const recentLBs = this.readRecentRdPerformance(14, 10);

    // Get all registered (strategy_id, sub_strategy_id) pairs from the registry
    const allPairs = this.strategyRegistry.getAllSubStrategyKeys();
    const decisions: AdvisorDecision[] = [];
    const t = this.config.thresholds;

    // Build a mutable set of enabled (strategy_id, sub_strategy_id) pairs
    // Use key `${strategy_id}|${sub_strategy_id ?? ''}` to track enablement
    const enabledKeys = new Set<string>();
    for (const cfg of currentConfigs) {
      if (!cfg.sub_strategy_ids || cfg.sub_strategy_ids.length === 0) {
        // Legacy: parent enabled without sub allow-list = all sub-strategies enabled
        const strategy = this.strategyRegistry.get(cfg.strategy_id);
        const subs = strategy?.getSubStrategies() ?? [];
        if (subs.length === 0) {
          enabledKeys.add(this.key(cfg.strategy_id, ''));
        } else {
          for (const sub of subs) {
            enabledKeys.add(this.key(cfg.strategy_id, sub));
          }
        }
      } else {
        for (const sub of cfg.sub_strategy_ids) {
          enabledKeys.add(this.key(cfg.strategy_id, sub));
        }
      }
    }

    for (const pair of allPairs) {
      const pairKey = this.key(pair.strategy_id, pair.sub_strategy_id ?? '');
      const rd = rdData.get(pairKey) ?? null;
      const isEnabled = enabledKeys.has(pairKey);
      const isProtected =
        this.config.protected_strategies.includes(pair.strategy_id) ||
        (pair.sub_strategy_id &&
          this.config.protected_strategies.includes(`${pair.strategy_id}.${pair.sub_strategy_id}`));

      let action: AdvisorDecision['action'] = 'keep';
      let reason: string;

      if (!rd || rd.total_trades === 0) {
        reason = 'No R&D data available';
      } else if (!isEnabled) {
        // R2 PR#2: Wilson LB-gated ENABLE. Requires statistical significance
        // (n ≥ 50, Wilson LB ≥ 0.50) AND practical significance (P&L > $5).
        const wilsonLB = wilsonLowerBound(rd.wins, rd.total_resolutions);
        // Never-enable check: if strategy was manually killed in prod, skip auto-enable.
        const isNeverEnable =
          this.config.never_enable_strategies.includes(pair.strategy_id) ||
          (pair.sub_strategy_id &&
            this.config.never_enable_strategies.includes(`${pair.strategy_id}.${pair.sub_strategy_id}`));

        if (isNeverEnable) {
          reason = `Never-enable: manually killed in prod — advisor cannot resurrect`;
        } else if (
          rd.total_resolutions >= MIN_N_ENABLE &&
          wilsonLB >= MIN_WILSON_LB_ENABLE &&
          rd.total_pnl > MIN_PNL_ENABLE
        ) {
          action = 'enable';
          reason = `R&D validated: Wilson LB ${wilsonLB.toFixed(3)} (${rd.win_rate.toFixed(1)}% raw WR), $${rd.total_pnl.toFixed(2)} P&L over ${rd.total_resolutions} resolutions`;
          enabledKeys.add(pairKey);
        } else if (rd.total_resolutions < MIN_N_ENABLE) {
          reason = `Collecting data: ${rd.total_resolutions}/${MIN_N_ENABLE} resolutions needed`;
        } else if (wilsonLB < MIN_WILSON_LB_ENABLE) {
          reason = `Below statistical threshold: Wilson LB ${wilsonLB.toFixed(3)} < ${MIN_WILSON_LB_ENABLE} (raw WR ${rd.win_rate.toFixed(1)}%)`;
        } else {
          reason = `Below practical threshold: $${rd.total_pnl.toFixed(2)} P&L (need >$${MIN_PNL_ENABLE})`;
        }
      } else if (isProtected) {
        reason = 'Protected — cannot be auto-disabled';
      } else {
        // R2 PR#2: Wilson UB-gated DISABLE. Requires 95% confidence that true
        // win rate is below 0.50 (Wilson UB < 0.50) AND P&L < -$5 to prevent
        // killing a merely-unlucky strategy.
        const wilsonUB = wilsonUpperBound(rd.wins, rd.total_resolutions);

        // 2026-04-11 Phase 2.3: regime decay check. If the last-14-days
        // Wilson LB is < 0.40 AND we have n ≥ 10 in the recent window,
        // disable the strategy even if all-time Wilson UB hasn't tripped.
        // This catches recent failures that the all-time average masks.
        const recentLB = recentLBs.get(pairKey);
        const recentRegimeDecay = recentLB !== undefined && recentLB !== null && recentLB < 0.40;

        if (
          rd.total_resolutions >= MIN_N_DISABLE &&
          wilsonUB < MAX_WILSON_UB_DISABLE &&
          rd.total_pnl < MAX_PNL_DISABLE
        ) {
          action = 'disable';
          reason = `R&D underperforming: Wilson UB ${wilsonUB.toFixed(3)} < ${MAX_WILSON_UB_DISABLE}, $${rd.total_pnl.toFixed(2)} P&L over ${rd.total_resolutions} resolutions`;
          enabledKeys.delete(pairKey);
        } else if (recentRegimeDecay) {
          action = 'disable';
          reason = `Regime decay: last-14d Wilson LB ${recentLB!.toFixed(3)} < 0.40 (all-time still OK, recent trend negative)`;
          enabledKeys.delete(pairKey);
        } else {
          reason = `Active — R&D: ${rd.total_resolutions > 0 ? rd.win_rate.toFixed(1) + '% raw WR, $' + rd.total_pnl.toFixed(2) + ' P&L' : 'collecting data'}`;
          if (recentLB !== undefined && recentLB !== null) {
            reason += ` (recent 14d LB: ${recentLB.toFixed(3)})`;
          }
        }
      }

      decisions.push({
        strategy_id: pair.strategy_id,
        sub_strategy_id: pair.sub_strategy_id,
        action,
        reason,
        rd_stats: rd
          ? {
              total_trades: rd.total_trades,
              total_resolutions: rd.total_resolutions,
              win_rate: rd.win_rate,
              total_pnl: rd.total_pnl,
              open_positions: rd.open_positions,
              open_upside: rd.open_upside,
            }
          : null,
      });

      // Phase B (2026-04-11): advisor v2 dual-decision shadow mode.
      //
      // If ADVISOR_V2_ENABLED=true, compute the DSR/PSR/MinTRL/Brier
      // decision on the same pair and log it alongside the Wilson LB
      // decision above. This is PURELY observational — we are not
      // acting on v2 decisions yet. The point is to accumulate a log
      // of "Wilson said X, DSR/PSR said Y, they agreed/disagreed" so
      // that after a 7-day window we have data to decide whether to
      // promote v2 to a voting role.
      //
      // Errors in this path MUST NOT interfere with the main Wilson-LB
      // decision flow. Try/catch swallows everything.
      if (ADVISOR_V2_ENABLED) {
        let v2Decision: AdvisorV2Decision | null = null;
        try {
          v2Decision = computeAdvisorV2Decision(
            this.config.rd_database_path,
            pair.strategy_id,
            pair.sub_strategy_id ?? '',
            enabledKeys.size,
          );
        } catch (err) {
          log.debug(
            {
              err: err instanceof Error ? err.message : String(err),
              strategy: pair.strategy_id,
              sub: pair.sub_strategy_id,
            },
            'Advisor v2 shadow metric failed',
          );
        }

        if (v2Decision) {
          // Three-way classification so the A/B window's disagreement
          // rate isn't inflated by "v2 has no opinion yet":
          //   - "insufficient_data": v2 lacks n, not actually disagreeing
          //   - "agrees": both methods reached the same action
          //   - "disagrees": both methods have an opinion and they differ
          let classification: 'agrees' | 'disagrees' | 'insufficient_data';
          let headline: string;
          if (v2Decision.action === 'insufficient_data') {
            classification = 'insufficient_data';
            headline = 'Advisor v2 shadow — INSUFFICIENT DATA';
          } else if (v2Decision.action === action) {
            classification = 'agrees';
            headline = 'Advisor v2 shadow — AGREES with Wilson';
          } else {
            classification = 'disagrees';
            headline = 'Advisor v2 shadow — DISAGREES with Wilson';
          }
          log.info(
            {
              strategy: pair.strategy_id,
              sub: pair.sub_strategy_id,
              wilson_action: action,
              v2_action: v2Decision.action,
              classification,
              v2_reason: v2Decision.reason,
              v2_n: v2Decision.n,
              v2_sharpe: roundMetric(v2Decision.sharpe),
              v2_psr: roundMetric(v2Decision.psr),
              v2_dsr: roundMetric(v2Decision.dsr.dsr),
              v2_min_trl: Number.isFinite(v2Decision.min_track_record_length)
                ? Math.ceil(v2Decision.min_track_record_length)
                : null,
              v2_skew: roundMetric(v2Decision.dsr.skew),
              v2_kurtosis: roundMetric(v2Decision.dsr.kurtosis),
              v2_brier: v2Decision.brier_score !== null ? roundMetric(v2Decision.brier_score) : null,
              v2_brier_reliability: v2Decision.brier_reliability !== null ? roundMetric(v2Decision.brier_reliability) : null,
              v2_brier_drift: v2Decision.brier_drift_warning,
            },
            headline,
          );
        }
      }
    }

    // Rebuild EntityStrategyConfig from enabledKeys
    const newConfigs = this.buildEntityConfigsFromKeys(enabledKeys);
    const strategiesAfter: AdvisorStrategyRef[] = newConfigs.map(c => ({
      strategy_id: c.strategy_id,
      sub_strategy_ids: c.sub_strategy_ids,
    }));

    const changesMade = decisions.filter(d => d.action !== 'keep').length;

    if (changesMade > 0) {
      this.entityManager.updateStrategies(this.config.target_entity_slug, newConfigs);
      log.info(
        {
          entity: this.config.target_entity_slug,
          before: strategiesBefore,
          after: strategiesAfter,
          changes: changesMade,
          enabled: decisions
            .filter(d => d.action === 'enable')
            .map(d => `${d.strategy_id}${d.sub_strategy_id ? '.' + d.sub_strategy_id : ''}`),
          disabled: decisions
            .filter(d => d.action === 'disable')
            .map(d => `${d.strategy_id}${d.sub_strategy_id ? '.' + d.sub_strategy_id : ''}`),
        },
        'Strategy advisor applied changes'
      );
    } else {
      log.info(
        { pairs: allPairs.length, rd_rows: rdData.size },
        'Strategy advisor check complete — no changes'
      );
    }

    const result: AdvisorCheckResult = {
      timestamp: new Date().toISOString(),
      decisions,
      strategies_before: strategiesBefore,
      strategies_after: strategiesAfter,
      changes_made: changesMade,
      rd_available: true,
    };

    eventBus.emit('advisor:check_complete', { result });
    return result;
  }

  private buildEntityConfigsFromKeys(enabledKeys: Set<string>): EntityStrategyConfig[] {
    // Group enabled keys by strategy_id → sub_strategy_ids[]
    const grouped = new Map<string, string[]>();
    for (const key of enabledKeys) {
      const [strategyId, subStrategyId] = key.split('|');
      if (!grouped.has(strategyId)) grouped.set(strategyId, []);
      if (subStrategyId) grouped.get(strategyId)!.push(subStrategyId);
    }

    const result: EntityStrategyConfig[] = [];
    for (const [strategyId, subIds] of grouped.entries()) {
      if (subIds.length === 0) {
        result.push({ strategy_id: strategyId });
      } else {
        result.push({ strategy_id: strategyId, sub_strategy_ids: subIds });
      }
    }
    return result;
  }

  private key(strategyId: string, subStrategyId: string): string {
    return `${strategyId}|${subStrategyId}`;
  }

  private readRdPerformance(): Map<string, RdStrategyRow> {
    const db = new Database(this.config.rd_database_path, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare('SELECT * FROM v_strategy_performance').all() as RdStrategyRow[];
      const map = new Map<string, RdStrategyRow>();
      for (const row of rows) {
        const subId = row.sub_strategy_id ?? '';
        map.set(this.key(row.strategy_id, subId), row);
      }
      log.debug({ rows: map.size, path: this.config.rd_database_path }, 'R&D performance data loaded');
      return map;
    } finally {
      db.close();
    }
  }

  /**
   * 2026-04-11 Phase 2.3: recency-weighted performance.
   *
   * Reads the last N days of resolutions per (strategy_id, sub_strategy_id)
   * and returns a recent Wilson LB. Used to detect regime decay — when a
   * strategy's all-time Wilson LB is still good but its last-14-days LB
   * has collapsed, we demote it even though the advisor's all-time gate
   * wouldn't catch it.
   *
   * Returns a Map keyed by the same composite key as readRdPerformance(),
   * with value = recent Wilson lower bound (0-1) or null if insufficient n.
   */
  private readRecentRdPerformance(daysBack = 14, minN = 10): Map<string, number | null> {
    const db = new Database(this.config.rd_database_path, { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`
        SELECT
          strategy_id,
          COALESCE(sub_strategy_id, '') AS sub_strategy_id,
          COUNT(*) AS n,
          SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins
        FROM resolutions
        WHERE resolved_at >= datetime('now', ?)
          AND strategy_id IS NOT NULL
        GROUP BY strategy_id, COALESCE(sub_strategy_id, '')
      `).all(`-${daysBack} days`) as Array<{
        strategy_id: string;
        sub_strategy_id: string;
        n: number;
        wins: number;
      }>;

      const map = new Map<string, number | null>();
      for (const row of rows) {
        const key = this.key(row.strategy_id, row.sub_strategy_id);
        if (row.n < minN) {
          map.set(key, null);
          continue;
        }
        const lb = wilsonLowerBound(row.wins, row.n);
        map.set(key, lb);
      }
      log.debug({ rows: map.size, days: daysBack }, 'Recent R&D performance loaded');
      return map;
    } catch (err) {
      log.warn({ err }, 'Failed to read recent R&D performance — skipping regime check');
      return new Map();
    } finally {
      db.close();
    }
  }
}
