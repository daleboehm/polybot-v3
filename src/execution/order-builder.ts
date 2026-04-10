// Constructs Order objects from approved StrategyDecisions

import type { Order, OrderRequest, StrategyDecision } from '../types/index.js';
import type { EntityState } from '../types/index.js';
import { roundToTick, applySlippage, roundTo } from '../utils/math.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('order-builder');

export function buildOrder(
  decision: StrategyDecision,
  entity: EntityState,
  slippageBps: number,
  bidPremiumPct: number,
): Order | null {
  const req = decision.order_request;
  if (!req) return null;

  const isPaper = entity.config.mode === 'paper';

  // Apply bid premium for market orders (helps ensure fill)
  let price = req.price;
  if (req.side === 'BUY') {
    price = price * (1 + bidPremiumPct);
  } else {
    price = price * (1 - bidPremiumPct);
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
  };

  log.info({
    entity: order.entity_slug,
    side: order.side,
    price: order.price,
    size: order.size,
    usdc: order.usdc_amount,
    paper: order.is_paper,
    strategy: order.strategy_id,
  }, 'Order built');

  return order;
}
