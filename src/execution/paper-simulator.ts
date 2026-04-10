// Paper trading simulator — realistic fills with slippage model

import type { Order, OrderFill, Outcome } from '../types/index.js';
import type { MarketCache } from '../market/market-cache.js';
import { applySlippage, roundTo } from '../utils/math.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('paper-sim');

export class PaperSimulator {
  constructor(
    private marketCache: MarketCache,
    private slippageBps: number,
    private fillDelayMs: number,
  ) {}

  async simulateFill(order: Order): Promise<OrderFill | null> {
    if (!order.is_paper) {
      throw new Error('PaperSimulator called with a live order');
    }

    // Simulate network latency
    if (this.fillDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.fillDelayMs));
    }

    // Get current market data for slippage
    const market = this.marketCache.get(order.condition_id);

    // Apply slippage to get realistic fill price
    let fillPrice = order.price;
    fillPrice = applySlippage(fillPrice, this.slippageBps, order.side === 'BUY');
    fillPrice = roundTo(Math.max(0.01, Math.min(0.99, fillPrice)), 4);

    // Determine outcome from token
    let outcome: Outcome = 'YES';
    if (market) {
      outcome = order.token_id === market.token_yes_id ? 'YES' : 'NO';
    }

    const fillSize = order.remaining_size;
    const usdcSize = roundTo(fillPrice * fillSize, 4);
    // Fee model: HARD-CODED 0 per the second 2026-04-10 fix.
    //
    // History:
    //   v1 → v2:  hardcoded 0.02 (2%) → drained paper cash on every fill.
    //   2026-04-10 morning fix: read `market.taker_fee` from cache "because Polymarket's
    //     mainnet taker fee is 0 today and reading keeps paper symmetric with live."
    //   2026-04-10 afternoon: discovered Polymarket's CLOB API returns `taker_base_fee`
    //     as a scaled integer (1000 for 1641 of 6288 markets, 0 for the rest). The
    //     morning fix multiplied that raw integer by usdcSize, producing a $51,479 fee
    //     on a $51 trade. R&D paper cash drained to 0 in one cycle, daily-loss-guard
    //     fired 100% drawdown, kill switch halted prod. Singapore/Kuala Lumpur weather
    //     positions ended up with $13K-$51K bogus cost basis before the halt.
    //
    // Polymarket's actual mainnet CLOB taker fee IS zero today. Until the correct
    // scaling factor for `taker_base_fee` is verified (bps? tenths of bps? percent?),
    // this site hard-codes 0 to match live execution. When Polymarket turns fees on,
    // update this after verifying the scale against a known fee value from the docs.
    const feeRate = 0;
    const feeUsdc = roundTo(usdcSize * feeRate, 4);
    const netUsdc = order.side === 'BUY'
      ? roundTo(usdcSize + feeUsdc, 4)     // buying costs more
      : roundTo(usdcSize - feeUsdc, 4);    // selling nets less

    const fill: OrderFill = {
      trade_id: `paper_fill_${nanoid(12)}`,
      order_id: order.order_id!,
      entity_slug: order.entity_slug,
      condition_id: order.condition_id,
      token_id: order.token_id,
      tx_hash: null, // paper trades have no on-chain tx
      side: order.side,
      size: fillSize,
      price: fillPrice,
      usdc_size: usdcSize,
      fee_usdc: feeUsdc,
      net_usdc: netUsdc,
      is_paper: true,
      strategy_id: order.strategy_id,
      sub_strategy_id: order.sub_strategy_id,
      outcome,
      market_question: market?.question ?? '',
      market_slug: market?.market_slug ?? '',
      timestamp: Math.floor(Date.now() / 1000),
    };

    log.info({
      order_id: order.order_id,
      side: order.side,
      fill_price: fillPrice,
      slippage_bps: this.slippageBps,
      size: fillSize,
      usdc: usdcSize,
      fee: feeUsdc,
    }, 'Paper fill simulated');

    return fill;
  }
}
