// Risk management types

export interface RiskLimits {
  max_position_pct: number;         // 0.10 = 10%
  max_position_usd: number;         // 20
  // 2026-04-10: max_positions, reserve_ratio, trading_ratio removed per Dale's
  // directive ("only limit is cash, no reserve"). Trading balance == cash now.
  // Reserves will return via the central-node sweep pattern when built.
  max_open_orders: number;          // max concurrent open orders per entity
  fractional_kelly: number;         // 0.25
  daily_loss_lockout_usd: number;   // 20
  stop_loss_pct: number;            // 0.20 = -20%
  hard_stop_usd: number;            // 5
  profit_target_pct: number;        // 0.40 = +40%
  min_edge_threshold: number;       // 0.02 = 2%
  min_hold_hours: number;           // 6
  min_hours_to_resolve?: number;    // 1 — global short-horizon filter floor (Dale 2026-04-10)
  max_hours_to_resolve?: number;    // 48 — global short-horizon filter ceiling
  tiered_stops: TieredStop[];
  max_strategy_envelope_pct?: number;   // 0.25 — per-strategy capital cap (Phase 1.5, 2026-04-11)
  max_cluster_pct?: number;             // 0.15 — correlated-cluster cap (Phase 2.2, 2026-04-11)
  max_portfolio_exposure_pct?: number;  // 0.15 — aggregate portfolio exposure cap (G2, 2026-04-15)
  trailing_retention_pct?: number;      // 0.70 — trailing profit lock retention (Phase 2.5, 2026-04-11)
  trailing_activation_pct?: number;     // 0.20 — min PnL % before trailing arms
}

export interface TieredStop {
  max_entry: number;
  min_entry: number;
  stop_pct: number | null;  // null = no stop for that tier
}

export interface RiskCheck {
  approved: boolean;
  violations: RiskViolation[];
  adjusted_size_usd: number;
  adjusted_price: number;
}

export interface RiskViolation {
  rule: string;
  message: string;
  severity: 'block' | 'warn' | 'adjust';
  current_value: number;
  limit_value: number;
}

export interface DailyRiskState {
  entity_slug: string;
  date: string;
  starting_equity: number;
  current_pnl: number;
  realized_today: number;
  trades_today: number;
  is_locked_out: boolean;
  lockout_reason?: string;
}
