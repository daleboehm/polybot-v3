// Pre-trade and post-trade risk checks — gates every order

import type { Signal, RiskCheck, RiskViolation, RiskLimits, EntityState, StrategyDecision, OrderRequest } from '../types/index.js';
import type { MarketCache } from '../market/market-cache.js';
import { calculatePositionSize } from './position-sizer.js';
import { StrategyWeighter } from './strategy-weighter.js';
import { getOpenOrders } from '../storage/repositories/order-repo.js';
import { getDeployedByStrategy, getOpenPositions } from '../storage/repositories/position-repo.js';
import { checkClusterCap } from './portfolio-correlation.js';
import { insertSignal } from '../storage/repositories/signal-repo.js';
import { eventBus } from '../core/event-bus.js';
import { createChildLogger } from '../core/logger.js';
import { nanoid } from 'nanoid';

const log = createChildLogger('risk-engine');

export class RiskEngine {
  private strategyWeighter: StrategyWeighter | undefined;
  private marketCache?: MarketCache;

  constructor(private limits: RiskLimits, enableWeighting = false, marketCache?: MarketCache) {
    if (enableWeighting) {
      this.strategyWeighter = new StrategyWeighter();
    }
    this.marketCache = marketCache;
  }

  evaluate(signal: Signal, entity: EntityState): StrategyDecision {
    const violations: RiskViolation[] = [];
    const isExit = signal.is_exit === true;

    // Check: entity not locked out — exits bypass (we need to be able to sell
    // during drawdown; the lockout would strand us in losing positions).
    if (entity.is_locked_out && !isExit) {
      violations.push({
        rule: 'daily_lockout',
        message: `Entity ${entity.config.slug} is locked out: ${entity.lockout_reason ?? 'unknown'}`,
        severity: 'block',
        current_value: 1,
        limit_value: 0,
      });
    }

    // Check: entity is active — exits bypass (paused entities still need exits).
    if (entity.config.status !== 'active' && !isExit) {
      violations.push({
        rule: 'entity_status',
        message: `Entity ${entity.config.slug} status is ${entity.config.status}, not active`,
        severity: 'block',
        current_value: 0,
        limit_value: 1,
      });
    }

    // Check: minimum edge threshold — exits bypass (an exit has no meaningful edge,
    // it's a risk-management action not an alpha capture).
    // Also fixes audit A-P2-9: previously used Math.abs(signal.edge) which let
    // strategies pass with negative edge. Entries require positive edge.
    if (!isExit && signal.edge < this.limits.min_edge_threshold) {
      violations.push({
        rule: 'min_edge',
        message: `Edge ${signal.edge.toFixed(4)} below threshold ${this.limits.min_edge_threshold}`,
        severity: 'block',
        current_value: signal.edge,
        limit_value: this.limits.min_edge_threshold,
      });
    }

    // Check: daily loss lockout — exits bypass (see above; also 0 = disabled).
    if (
      !isExit &&
      this.limits.daily_loss_lockout_usd > 0 &&
      entity.daily_pnl <= -this.limits.daily_loss_lockout_usd
    ) {
      violations.push({
        rule: 'daily_loss',
        message: `Daily P&L $${entity.daily_pnl.toFixed(2)} exceeds lockout threshold -$${this.limits.daily_loss_lockout_usd}`,
        severity: 'block',
        current_value: Math.abs(entity.daily_pnl),
        limit_value: this.limits.daily_loss_lockout_usd,
      });
    }

    // 2026-04-10: max_positions count cap removed per Dale's directive —
    // "the only limit should be cash." Sizing now self-bounds via Kelly +
    // max_position_pct + max_position_usd, and the engine will refuse to open
    // a position when trading_balance < signal's minimum size. That's the
    // binding constraint we want, not an arbitrary count.

    // Check: max concurrent open orders (configurable via risk.max_open_orders)
    const openOrders = getOpenOrders(entity.config.slug);
    if (openOrders.length >= this.limits.max_open_orders) {
      violations.push({
        rule: 'max_open_orders',
        message: `${openOrders.length} open orders (max ${this.limits.max_open_orders})`,
        severity: 'warn',
        current_value: openOrders.length,
        limit_value: this.limits.max_open_orders,
      });
    }

    // 2026-04-11 Phase 1.5 + fix: per-strategy capital envelope.
    //
    // Denominator is EQUITY (cash + open_positions_value), not trading_balance.
    // The first pass of this check used trading_balance (== cash after Dale's
    // reserve removal) as the denominator, which collapsed the envelope cap
    // to near-zero once cash was fully deployed: a strategy with $50 already
    // in positions got checked against 25% of $12 current cash = $3 cap,
    // rejecting every new entry even though the entity had $160 equity.
    //
    // Fix: compute equity as cash + sum(open_positions.cost_basis), then
    // cap each strategy at envelope_pct of equity. This matches the
    // intuition — "no strategy should tie up more than 25% of the TOTAL
    // bankroll" — regardless of how much is currently sitting as cash vs
    // as open positions.
    //
    // Lookup getOpenPositions once and reuse for both envelope + cluster
    // checks below (same data).
    let openPositionsCache: ReturnType<typeof getOpenPositions> | null = null;
    const getOpenCached = () => {
      if (openPositionsCache === null) {
        openPositionsCache = getOpenPositions(entity.config.slug);
      }
      return openPositionsCache;
    };
    const computeEquity = (): number => {
      const cash = entity.trading_balance || 0;
      const deployed = getOpenCached().reduce((s, p) => s + (p.cost_basis || 0), 0);
      return cash + deployed;
    };

    const envelopePct = this.limits.max_strategy_envelope_pct ?? 0.25;
    if (!isExit && envelopePct > 0 && signal.strategy_id) {
      const equity = computeEquity();
      const envelopeCapUsd = equity * envelopePct;
      if (envelopeCapUsd > 0) {
        const deployedByStrategy = getDeployedByStrategy(entity.config.slug);
        const currentDeployed = deployedByStrategy[signal.strategy_id] ?? 0;
        const proposedIncrement = signal.recommended_size_usd ?? 0;
        if (currentDeployed + proposedIncrement > envelopeCapUsd) {
          violations.push({
            rule: 'strategy_envelope',
            message: `strategy ${signal.strategy_id} deployed $${currentDeployed.toFixed(2)} + proposed $${proposedIncrement.toFixed(2)} > envelope cap $${envelopeCapUsd.toFixed(2)} (${(envelopePct * 100).toFixed(0)}% of equity $${equity.toFixed(2)})`,
            severity: 'block',
            current_value: currentDeployed + proposedIncrement,
            limit_value: envelopeCapUsd,
          });
        }
      }
    }

    // 2026-04-11 Phase 2.2 + fix: correlated-cluster cap.
    // Same denominator change as above — use equity, not trading_balance.
    // Without the fix, every existing cluster (including __orphan with the
    // 4 political positions) was over its cap as soon as cash was deployed,
    // permanently blocking new entries into any cluster that already had
    // any position.
    const clusterPct = this.limits.max_cluster_pct ?? 0.15;
    if (!isExit && clusterPct > 0) {
      const openPositions = getOpenCached();
      const marketMeta = this.marketCache?.get(signal.condition_id);
      const marketQuestion = marketMeta?.question ?? '';
      const equity = computeEquity();
      const clusterCheck = checkClusterCap(
        marketQuestion,
        signal.condition_id,
        signal.recommended_size_usd ?? 0,
        equity,
        clusterPct,
        openPositions,
      );
      if (clusterCheck.breach) {
        violations.push({
          rule: 'cluster_cap',
          message: `cluster ${clusterCheck.cluster_id} deployed $${clusterCheck.current_deployed.toFixed(2)} + proposed $${(signal.recommended_size_usd ?? 0).toFixed(2)} > cap $${clusterCheck.cap_usd.toFixed(2)} (${(clusterPct * 100).toFixed(0)}% of equity $${equity.toFixed(2)})`,
          severity: 'block',
          current_value: clusterCheck.proposed_total,
          limit_value: clusterCheck.cap_usd,
        });
      }
    }

    // Calculate position size. Exits use the signal's recommended_size_usd directly
    // (full position sell), bypassing Kelly + weighter + caps since we're exiting,
    // not sizing a new entry.
    let sizing;
    if (isExit) {
      sizing = {
        size_usd: signal.recommended_size_usd,
        size_shares: signal.recommended_size_usd / Math.max(0.01, signal.market_price),
        method: 'cap' as const,
        capped_by: `exit: ${signal.exit_reason ?? 'unknown'}`,
        strategy_weight: 1.0,
      };
    } else {
      sizing = calculatePositionSize(signal, entity, this.limits, this.strategyWeighter ?? undefined, this.marketCache);
    }

    if (sizing.size_usd <= 0) {
      violations.push({
        rule: 'insufficient_size',
        message: 'Position size calculated to zero (insufficient balance or no edge)',
        severity: 'block',
        current_value: 0,
        limit_value: 0.10,
      });
    }

    // Determine approval
    const blocked = violations.some(v => v.severity === 'block');
    const approved = !blocked && sizing.size_usd > 0;

    // Build order request if approved
    let orderRequest: OrderRequest | undefined;
    if (approved) {
      orderRequest = {
        entity_slug: signal.entity_slug,
        condition_id: signal.condition_id,
        token_id: signal.token_id,
        side: signal.side,
        price: signal.market_price,
        size: sizing.size_shares,
        order_type: 'GTC',
        strategy_id: signal.strategy_id,
        sub_strategy_id: signal.sub_strategy_id,
        signal_id: signal.signal_id,
      };
    }

    const decision: StrategyDecision = {
      signal,
      risk_approved: approved,
      risk_rejection: blocked ? violations.find(v => v.severity === 'block')?.message : undefined,
      final_size_usd: sizing.size_usd,
      final_price: signal.market_price,
      order_request: orderRequest,
    };

    // Persist signal + decision
    insertSignal(signal, decision);

    // Emit events
    if (approved) {
      eventBus.emit('signal:approved', { decision });
    } else {
      const reason = decision.risk_rejection ?? 'Unknown rejection';
      eventBus.emit('signal:rejected', { signal, reason });
    }

    for (const violation of violations) {
      eventBus.emit('risk:violation', { entity_slug: signal.entity_slug, violation });
    }

    log.info({
      entity: signal.entity_slug,
      strategy: signal.strategy_id,
      condition: signal.condition_id,
      approved,
      size_usd: sizing.size_usd,
      violations: violations.length,
      rejection: decision.risk_rejection,
    }, approved ? 'Signal approved' : 'Signal rejected');

    return decision;
  }

  updateLimits(newLimits: Partial<RiskLimits>): void {
    Object.assign(this.limits, newLimits);
    log.info({ limits: this.limits }, 'Risk limits updated');
  }
}
