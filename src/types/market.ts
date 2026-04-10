// Market data types — CLOB-sourced

export interface Token {
  token_id: string;
  outcome: 'Yes' | 'No';
  price: number;
  winner: boolean;
}

export interface SamplingMarket {
  condition_id: string;
  question_id: string;
  question: string;
  description: string;
  market_slug: string;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
  neg_risk: boolean;
  neg_risk_market_id: string | null;
  minimum_order_size: number;
  minimum_tick_size: number;
  maker_base_fee: number;
  taker_base_fee: number;
  tags: string[];
  tokens: [Token, Token]; // [YES, NO]
}

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBookSnapshot {
  token_id: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  best_bid: number | null;
  best_ask: number | null;
  spread: number | null;
  midpoint: number | null;
  timestamp: number;
}

export interface MarketData {
  condition_id: string;
  question: string;
  market_slug: string;
  end_date: Date;
  active: boolean;
  closed: boolean;
  neg_risk: boolean;
  token_yes_id: string;
  token_no_id: string;
  yes_price: number;
  no_price: number;
  yes_book: OrderBookSnapshot | null;
  no_book: OrderBookSnapshot | null;
  volume_24h: number;
  liquidity: number;
  maker_fee: number;
  taker_fee: number;
  minimum_order_size: number;
  minimum_tick_size: number;
  last_updated: Date;
}

export interface MarketResolution {
  condition_id: string;
  winning_token_id: string;
  winning_outcome: 'Yes' | 'No';
  resolved_at: Date;
}
