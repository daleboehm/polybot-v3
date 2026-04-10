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
