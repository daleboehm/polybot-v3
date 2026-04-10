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

export interface AppConfig {
  engine: EngineConfig;
  risk: RiskLimits;
  execution: ExecutionConfig;
  api: ApiConfig;
  dashboard: DashboardConfig;
  database: DatabaseConfig;
  advisor: AdvisorConfig;
  entities: EntityConfig[];
}
