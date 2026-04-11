// Application configuration types

import type { RiskLimits } from './risk.js';
import type { EntityConfig } from './entity.js';
import type { AdvisorConfig } from './advisor.js';

export interface EngineConfig {
  scan_interval_ms: number;
  snapshot_interval_ms: number;
  risk_check_interval_ms: number;
  orderbook_subscribe: boolean;
  max_concurrent_orders: number;
  log_level: 'debug' | 'info' | 'warn' | 'error';
}

export interface ExecutionConfig {
  slippage_bps: number;
  bid_premium_pct: number;
  max_retries: number;
  retry_delay_ms: number;
  paper_fill_delay_ms: number;
}

export interface ApiConfig {
  clob_base_url: string;
  data_api_base_url: string;
  ws_url: string;
  rate_limit_per_second: number;
}

export interface DashboardConfig {
  port: number;
  auth_enabled: boolean;
  auth_user: string;
  auth_password: string;
}

export interface DatabaseConfig {
  path: string;
}

// Phase 2 (2026-04-11): attention router config. Runs a 30-second
// parallel scan on markets the scouts flagged as high-priority so the
// engine reacts to breaking moves faster than its normal 5-min cycle.
export interface PriorityScannerConfig {
  enabled: boolean;
  interval_ms: number;
  max_priorities_per_run: number;
  min_scan_gap_ms: number;
  gc_every_n_runs: number;
}

export interface AppConfig {
  engine: EngineConfig;
  risk: RiskLimits;
  execution: ExecutionConfig;
  api: ApiConfig;
  dashboard: DashboardConfig;
  database: DatabaseConfig;
  advisor: AdvisorConfig;
  priority_scanner: PriorityScannerConfig;
  entities: EntityConfig[];
}
