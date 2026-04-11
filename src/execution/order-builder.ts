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

/**
 * Phase A1 (2026-04-11): strategies can override the default entry-maker
 * execution mode by setting `metadata.preferred_execution_mode` on the signal.
 *
 * Used for tail-zone dead-band entries where maker posts collect no liquidity
 * reward and eat concentrated adverse selection — the winning play is to
 * cross as a taker, pay the -1.12% Optimism Tax, and capture the dominant
 * Becker empirical edge before informed traders move the price.
 *
 * Returns 'maker' | 'taker' | undefined. Undefined = apply default policy.
 */
function readPreferredExecutionMode(
  decision: StrategyDecision,
): 'maker' | 'taker' | undefined {
  const metadata = decision.signal?.metadata;
  if (!metadata || typeof metadata !== 'object') return undefined;
  const value = (metadata as Record<string, unknown>).preferred_execution_mode;
  if (value === 'maker' || value === 'taker') return value;
  return undefined;
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
  const preferredMode = readPreferredExecutionMode(decision);

  // Phase A4 (2026-04-11): price-conditioned maker-only gate.
  //
  // Kalshi 72M-trade analysis (Hacking the Markets, Becker): taker losses
  // average ~32% for trades entered below 25¢ — a combination of the
  // longshot bias and concentrated informed flow at low prices. Our
  // existing maker/taker hybrid prefers makers but doesn't enforce a
  // hard price gate.
  //
  // Rule for ENTRIES only (exits bypass — if we need out, we need out):
  //   price < 0.25 → refuse taker fills entirely. If the signal wanted
  //                  taker execution (preferredMode = 'taker' from A1's
  //                  dead-band rule), refuse the order. Better to miss
  //                  the trade than eat a ~32% tax on a marginal edge.
  //   0.25 ≤ price < 0.40 → allow maker only; if preferredMode asked
  //                         for taker, downgrade to maker and rest
  //                         in the book (accept possible no-fill).
  //   price ≥ 0.40 → normal maker default, taker override honored.
  //
  // The A1 tail rule (preferredMode='taker' at fadePrice > 0.95) still
  // works for longshot: our fadePrice of 0.95 means the side we're
  // BUYING is at 0.95, which is well above the 0.25 floor, so the
  // taker override fires normally. This gate only bites when a signal
  // targets a low-price BUY (rare — would need a strategy that
  // explicitly buys the cheap side).
  const entryPrice = req.price;
  if (!isExit && preferredMode === 'taker' && entryPrice < 0.25) {
    log.info({
      entity: req.entity_slug,
      strategy: req.strategy_id,
      price: entryPrice,
      reason: 'A4: refused taker entry below 25¢',
    }, 'Order refused by A4 gate');
    return null;
  }

  // Pricing rule: entries post as maker (one tick below market for BUY,
  // above for SELL). Exits post as taker with the bid premium (existing
  // behavior — urgent, willing to pay the tax).
  //
  // Phase A1 (2026-04-11): strategies can override the entry-maker default
  // via signal.metadata.preferred_execution_mode. Used for tail-zone
  // entries where resting as a maker is a losing proposition.
  //
  // Phase A4 (2026-04-11): between 0.25 and 0.40, even an A1-requested
  // taker override gets downgraded back to maker. Taker fills in this
  // zone still have meaningful negative EV per the Kalshi analysis,
  // just less extreme than <0.25.
  let price = req.price;
  let executionMode: 'maker' | 'taker';
  const a4DowngradeToMaker = !isExit && preferredMode === 'taker' && entryPrice < 0.40;
  const shouldBeTaker = isExit || (preferredMode === 'taker' && !a4DowngradeToMaker);
  if (shouldBeTaker) {
    // Aggressive taker: cross the book immediately
    executionMode = 'taker';
    if (req.side === 'BUY') {
      price = price * (1 + bidPremiumPct);
    } else {
      price = price * (1 - bidPremiumPct);
    }
  } else {
    // Passive maker: rest in the book at one tick better than market
    // Phase A2 (2026-04-11): use the market's actual minimum_tick_size,
    // not a hardcoded 0.01. On 0.001-tick markets a 0.01 offset is 10×
    // too generous and we lose queue priority; on 0.0001-tick markets
    // it's 100× too generous. Falls back to 0.01 if req-provided value
    // is missing or zero.
    executionMode = 'maker';
    const tick = req.minimum_tick_size && req.minimum_tick_size > 0
      ? req.minimum_tick_size
      : 0.01;
    if (req.side === 'BUY') {
      price = price - tick;
    } else {
      price = price + tick;
    }
  }

  // Round to the market's actual tick. Phase A2 (2026-04-11): this was
  // hardcoded 0.01 even for 0.001 / 0.0001 tick markets which rejected valid
  // orders and made fills less precise. Now reads req.minimum_tick_size.
  const roundTick = req.minimum_tick_size && req.minimum_tick_size > 0
    ? req.minimum_tick_size
    : 0.01;
  // roundTo precision = number of decimals implied by the tick
  const tickDecimals = Math.max(2, Math.ceil(-Math.log10(roundTick)));
  price = roundToTick(price, roundTick);
  price = roundTo(Math.max(roundTick, Math.min(1 - roundTick, price)), tickDecimals);

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
