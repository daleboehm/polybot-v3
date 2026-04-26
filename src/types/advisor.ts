// Strategy Advisor types — R&D-to-Prod automated strategy sync

export interface AdvisorConfig {
  enabled: boolean;
  rd_database_path: string;
  check_interval_ms: number;
  target_entity_slug: string;
  protected_strategies: string[];
  /** Strategies that are NEVER auto-enabled, even if R&D stats validate them.
   *  Permanently overrides advisor enable gate for manually-killed strategies. */
  never_enable_strategies: string[];
  thresholds: AdvisorThresholds;
}

export interface AdvisorThresholds {
  min_resolutions_to_enable: number;
  min_win_rate_to_enable: number;
  min_pnl_to_enable: number;
  min_resolutions_to_disable: number;
  max_win_rate_to_disable: number;
}

export interface AdvisorDecision {
  strategy_id: string;
  sub_strategy_id?: string;
  action: 'enable' | 'disable' | 'keep';
  reason: string;
  rd_stats: {
    total_trades: number;
    total_resolutions: number;
    win_rate: number;
    total_pnl: number;
    open_positions: number;
    open_upside: number;
  } | null;
}

/** Serialized strategy reference for reporting — includes sub_strategy if set */
export interface AdvisorStrategyRef {
  strategy_id: string;
  sub_strategy_ids?: string[];
}

export interface AdvisorCheckResult {
  timestamp: string;
  decisions: AdvisorDecision[];
  strategies_before: AdvisorStrategyRef[];
  strategies_after: AdvisorStrategyRef[];
  changes_made: number;
  rd_available: boolean;
  error?: string;
}
