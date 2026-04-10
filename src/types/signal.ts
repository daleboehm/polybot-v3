// Strategy signal types

import type { Side, Outcome, OrderRequest } from './order.js';

export type SignalStrength = number; // 0.0 to 1.0

export interface Signal {
  signal_id: string;
  entity_slug: string;
  strategy_id: string;
  sub_strategy_id?: string;
  condition_id: string;
  token_id: string;
  side: Side;
  outcome: Outcome;
  strength: SignalStrength;
  edge: number;             // model_prob - market_price
  model_prob: number;
  market_price: number;
  recommended_size_usd: number;
  metadata: Record<string, unknown>;
  created_at: Date;
  /**
   * Exit-signal flag (R1 PR#2, 2026-04-10). When true, this signal represents a
   * stop-loss, profit-target, or time-stop exit — not a new entry. Risk engine
   * short-circuits edge/daily-loss/max-position checks for exits because those
   * gates would prevent the engine from exiting losing positions during a
   * drawdown — exactly when exits matter most. Exits still respect the kill
   * switch and cash-available checks.
   */
  is_exit?: boolean;
  /**
   * For exits: the reason the exit fired. One of 'stop_loss' | 'hard_stop' |
   * 'profit_target' | 'time_stop'. Populated by the stop-loss monitor conversion
   * path in engine.runScanCycle().
   */
  exit_reason?: string;
}

export interface StrategyDecision {
  signal: Signal;
  risk_approved: boolean;
  risk_rejection?: string;
  final_size_usd: number;
  final_price: number;
  order_request?: OrderRequest;
}
