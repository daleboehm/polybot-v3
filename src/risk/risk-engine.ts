// Pre-trade and post-trade risk checks — gates every order

import type { Signal, RiskCheck, RiskViolation, RiskLimits, EntityState, StrategyDecision, OrderRequest } from '../types/index.js';
import { calculatePositionSize } from './position-sizer.js';
import { StrategyWeighter } from './strategy-weighter.js';
import { getOpenPositionCount } from '../storage/repositories/position-repo.js';
import { getOpenOrders } from '../storage/repositories/order-repo.js';
import { insertSignal } from '../storage/repositories/signal-repo.js';
import { eventBus } from '../core/event-bus.js';
import { createChildLogger } from '../core/logger.js';
import { nanoid } from 'nanoid';

const log = createChildLogger('risk-engine');

export class RiskEngine {
  private strategyWeighter: StrategyWeighter | undefined;

  constructor(private limits: RiskLimits, enableWeighting = false) {
    if (enableWeighting) {
      this.strategyWeighter = new StrategyWeighter();
    }
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

    // Check: max open positions — exits bypass (exits REDUCE position count).
    const openPositions = getOpenPositionCount(entity.config.slug);
    if (!isExit && openPositions >= this.limits.max_positions) {
      violations.push({
        rule: 'max_positions',
        message: `${openPositions} open positions (max ${this.limits.max_positions})`,
        severity: 'block',
        current_value: openPositions,
        limit_value: this.limits.max_positions,
      });
    }

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
      sizing = calculatePositionSize(signal, entity, this.limits, this.strategyWeighter ?? undefined);
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
