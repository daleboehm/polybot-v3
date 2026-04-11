// Order and trade types

export type Side = 'BUY' | 'SELL';
export type Outcome = 'YES' | 'NO';
export type TimeInForce = 'GTC' | 'GTD' | 'FOK' | 'IOC';

export type OrderStatus =
  | 'pending'
  | 'open'
  | 'partially_filled'
  | 'filled'
  | 'cancelled'
  | 'rejected'
  | 'expired';

export interface OrderRequest {
  entity_slug: string;
  condition_id: string;
  token_id: string;
  side: Side;
  price: number;
  size: number;
  order_type: TimeInForce;
  expiration?: Date;
  strategy_id: string;
  sub_strategy_id?: string;
  signal_id: string;
  // Phase A2 (2026-04-11): the market's minimum tick size, passed from
  // risk-engine through to order-builder so the maker offset and price
  // rounding use the correct precision. On 0.001-tick markets a hardcoded
  // 0.01 offset gave us 10× worse queue position than necessary.
  minimum_tick_size?: number;
}

export interface Order extends OrderRequest {
  order_id: string | null;
  original_size: number;
  filled_size: number;
  remaining_size: number;
  usdc_amount: number;
  status: OrderStatus;
  is_paper: boolean;
  error_message?: string;
  submitted_at: Date;
  filled_at?: Date;
  cancelled_at?: Date;
  // 2026-04-11 Phase 3: maker vs taker execution intent.
  // maker = passive, priced one tick better than market, earns +1.12% edge
  // taker = aggressive, priced with bid_premium_pct, guarantees fill
  // Entry signals use maker by default; exit signals use taker.
  execution_mode?: 'maker' | 'taker';
}

export interface OrderFill {
  trade_id: string;
  order_id: string;
  entity_slug: string;
  condition_id: string;
  token_id: string;
  tx_hash: string | null;
  side: Side;
  size: number;
  price: number;
  usdc_size: number;
  fee_usdc: number;
  net_usdc: number;
  is_paper: boolean;
  strategy_id: string;
  sub_strategy_id?: string;
  outcome: Outcome;
  market_question: string;
  market_slug: string;
  timestamp: number;
}
