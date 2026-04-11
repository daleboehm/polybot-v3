// Constructs Order objects from approved StrategyDecisions

import type { Order, OrderRequest, StrategyDecision } from '../types/index.js';
import type { EntityState } from '../types/index.js';
import { roundToTick, applySlippage, roundTo } from '../utils/math.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('order-builder');

/**
 * 2026-04-11 Phase 3: maker/taker hybrid pricing.
 *
 * Empirical finding from Jonathan Becker's 72.1M-trade study (captured via
 * 0xMovez article, Apr 8 2026): makers earn +1.12% per trade, takers lose
 * -1.12% per trade. A 2.24pp swing applied to every fill.
 *
 * Our previous execution path quoted every order with bid_premium_pct = 0.02
 * on top of the signal's market_price, which guaranteed a taker fill (book
 * crosses us immediately). We paid the -1.12% Optimism Tax on every trade.
 *
 * New policy:
 *   - Entry signals (new positions): price at signal.market_price - 1¢ for
 *     BUY, + 1¢ for SELL. This is 1 tick below the midpoint — we rest in
 *     the book as a maker. If the market moves into us, we fill at a better
 *     price AND earn the maker edge. If it doesn't, we don't fill, and the
 *     next scan cycle re-evaluates.
 *   - Exit signals (stop_loss, profit_target, hard_stop, trailing_lock,
 *     exit_reason set): KEEP the aggressive taker pricing. Exits are urgent
 *     and we're willing to pay the tax to get out at the target.
 *
 * No explicit cancellation of unfilled entry orders — the natural scan cycle
 * re-evaluates and posts fresh orders at the new market_price. Worst case:
 * we miss a runner (the price gaps through our resting bid). Best case (the
 * majority): we fill at better-than-market + earn +1.12% edge per trade.
 *
 * For live mode, the order_type is set on the Polymarket SDK call site in
 * clob-router. For paper mode, the paper simulator needs to respect maker
 * orders — if the book isn't crossed, the order sits unfilled.
 */
function isExitDecision(decision: StrategyDecision): boolean {
  // decision.signal is always present on an approved decision; its is_exit
  // flag is set by processExitSignal() when building stop-loss, profit-target,
  // hard-stop, or trailing-lock exit signals. Entry signals leave it undefined.
  return decision.signal?.is_exit === true;
}

export function buildOrder(
  decision: StrategyDecision,
  entity: EntityState,
  slippageBps: number,
  bidPremiumPct: number,
): Order | null {
  const req = decision.order_request;
  if (!req) return null;

  const isPaper = entity.config.mode === 'paper';
  const isExit = isExitDecision(decision);

  // Pricing rule: entries post as maker (one tick below market for BUY,
  // above for SELL). Exits post as taker with the bid premium (existing
  // behavior — urgent, willing to pay the tax).
  let price = req.price;
  let executionMode: 'maker' | 'taker';
  if (isExit) {
    // Aggressive taker: cross the book immediately
    executionMode = 'taker';
    if (req.side === 'BUY') {
      price = price * (1 + bidPremiumPct);
    } else {
      price = price * (1 - bidPremiumPct);
    }
  } else {
    // Passive maker: rest in the book at one tick better than market
    executionMode = 'maker';
    const tick = 0.01;
    if (req.side === 'BUY') {
      price = price - tick;
    } else {
      price = price + tick;
    }
  }

  // Round to tick
  price = roundToTick(price, 0.01);
  price = roundTo(Math.max(0.01, Math.min(0.99, price)), 2);

  const size = roundTo(req.size, 2);
  const usdcAmount = roundTo(price * size, 4);

  // AUDIT FIX A-P0-9 (2026-04-10): assign order_id at build time for BOTH paper
  // and live orders. Previously live orders had order_id = null and the CLOB-
  // returned id was stuffed into trade_id, which meant updateOrderStatus(null, ...)
  // no-oped and live orders sat at 'pending' forever until max_open_orders tripped.
  // The CLOB's returned id is now captured separately in the fill's trade_id.
  const orderId = isPaper ? `paper_${nanoid(12)}` : `live_${nanoid(12)}`;

  const order: Order = {
    ...req,
    order_id: orderId,
    price,
    size,
    original_size: size,
    filled_size: 0,
    remaining_size: size,
    usdc_amount: usdcAmount,
    status: 'pending',
    is_paper: isPaper,
    submitted_at: new Date(),
    execution_mode: executionMode,
  };

  log.info({
    entity: order.entity_slug,
    side: order.side,
    price: order.price,
    size: order.size,
    usdc: order.usdc_amount,
    paper: order.is_paper,
    strategy: order.strategy_id,
    execution_mode: executionMode,
    is_exit: isExit,
  }, 'Order built');

  return order;
}
