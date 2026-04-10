// Position and resolution types

import type { Outcome } from './order.js';

export type PositionStatus = 'open' | 'closed' | 'resolved';

export interface Position {
  id?: number;
  entity_slug: string;
  condition_id: string;
  token_id: string;
  side: Outcome;
  size: number;
  avg_entry_price: number;
  cost_basis: number;
  current_price: number | null;
  unrealized_pnl: number | null;
  market_question: string;
  strategy_id: string;
  is_paper: boolean;
  status: PositionStatus;
  opened_at: Date;
  closed_at?: Date;
}

export interface Resolution {
  id?: number;
  entity_slug: string;
  condition_id: string;
  token_id: string;
  winning_outcome: Outcome;
  position_side: Outcome;
  size: number;
  payout_usdc: number;
  cost_basis_usdc: number;
  sell_proceeds_usdc: number;
  realized_pnl: number;
  is_paper: boolean;
  strategy_id: string;
  sub_strategy_id?: string;
  market_question: string;
  market_slug: string;
  tx_hash: string | null;
  resolved_at: Date;
}
