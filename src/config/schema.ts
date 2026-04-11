// Zod validation schemas for all config files

import { z } from 'zod';

const tieredStopSchema = z.object({
  max_entry: z.number(),
  min_entry: z.number(),
  stop_pct: z.number().nullable(),
});

const riskLimitsSchema = z.object({
  max_position_pct: z.number().min(0).max(1).default(0.10),
  max_position_usd: z.number().min(0).default(20),
  // 2026-04-10: removed max_positions, reserve_ratio, trading_ratio.
  // Dale's directive: "the only limit should be cash. No limit on positions,
  // no reserve." Trading balance is now always equal to cash balance.
  // When reserves come back, it'll be via the central-node sweep pattern,
  // not these knobs — this is a clean slate.
  max_open_orders: z.number().int().min(1).default(5),
  fractional_kelly: z.number().min(0).max(1).default(0.25),
  daily_loss_lockout_usd: z.number().min(0).default(20),
  stop_loss_pct: z.number().min(0).max(1).default(0.20),
  hard_stop_usd: z.number().positive().default(5),
  profit_target_pct: z.number().min(0).default(0.40),
  min_edge_threshold: z.number().min(0).default(0.02),
  min_hold_hours: z.number().min(0).default(6),
  // Dale 2026-04-10: global short-horizon filter. Only take positions that
  // resolve within this window. Default 1-48h matches Dale's "keep the wheels
  // spinning, no long-term positions" directive. Applied in strategy-context's
  // getActiveMarkets() so every strategy automatically complies.
  min_hours_to_resolve: z.number().min(0).default(1),
  max_hours_to_resolve: z.number().min(0).default(48),
  tiered_stops: z.array(tieredStopSchema).default([]),
  // 2026-04-11 Phase 1.5: per-strategy capital envelope. Each strategy_id
  // can tie up at most this fraction of trading_balance before the risk
  // engine blocks new entries. Orphan positions (strategy_id = NULL) are
  // counted under "__orphan" and share the same default cap. A buggy
  // strategy cannot drain the bankroll; it gets its envelope and stops.
  // Set to 0 to disable the check entirely.
  max_strategy_envelope_pct: z.number().min(0).max(1).default(0.25),
  // Phase 2.2: cap on any single correlated cluster (same neg_risk_market_id,
  // keyword cluster like "us-election-2026", or weather-day grouping).
  // Default 0.15 = 15% of trading_balance. Set to 0 to disable.
  max_cluster_pct: z.number().min(0).max(1).default(0.15),
  // Phase 2.5: trailing profit lock. Tracks peak unrealized PnL % per
  // position. When current PnL drops below peak * trailing_retention_pct,
  // trigger a profit-target exit at the retained level. Never fires below
  // 0% PnL, so the NO-LOSE mantra is preserved — this is upside protection,
  // not a stop-loss. Set trailing_retention_pct to 0 to disable.
  trailing_retention_pct: z.number().min(0).max(1).default(0.70),
  trailing_activation_pct: z.number().min(0).max(1).default(0.20),
});

const engineConfigSchema = z.object({
  scan_interval_ms: z.number().positive().default(300_000),
  snapshot_interval_ms: z.number().positive().default(3_600_000),
  risk_check_interval_ms: z.number().positive().default(60_000),
  orderbook_subscribe: z.boolean().default(true),
  max_concurrent_orders: z.number().positive().default(5),
  log_level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

const executionConfigSchema = z.object({
  slippage_bps: z.number().min(0).default(50),
  bid_premium_pct: z.number().min(0).default(0.02),
  max_retries: z.number().min(0).default(3),
  retry_delay_ms: z.number().positive().default(2000),
  paper_fill_delay_ms: z.number().min(0).default(500),
});

const apiConfigSchema = z.object({
  clob_base_url: z.string().url().default('https://clob.polymarket.com'),
  data_api_base_url: z.string().url().default('https://data-api.polymarket.com'),
  ws_url: z.string().default('wss://ws-subscriptions-clob.polymarket.com/ws/market'),
  rate_limit_per_second: z.number().positive().default(10),
});

const dashboardConfigSchema = z.object({
  port: z.number().positive().default(9100),
  auth_enabled: z.boolean().default(true),
  auth_user: z.string().default('admin'),
  auth_password: z.string().default('changeme'),
});

const databaseConfigSchema = z.object({
  path: z.string().default('./data/polybot.db'),
});

const advisorThresholdsSchema = z.object({
  min_resolutions_to_enable: z.number().int().min(1).default(10),
  min_win_rate_to_enable: z.number().min(0).max(100).default(50),
  min_pnl_to_enable: z.number().default(0),
  min_resolutions_to_disable: z.number().int().min(1).default(20),
  max_win_rate_to_disable: z.number().min(0).max(100).default(30),
});

const advisorConfigSchema = z.object({
  enabled: z.boolean().default(false),
  rd_database_path: z.string().default('/opt/polybot-v3-rd/data/rd.db'),
  check_interval_ms: z.number().positive().default(1_800_000),
  target_entity_slug: z.string().default('polybot'),
  protected_strategies: z.array(z.string()).default([]),
  thresholds: advisorThresholdsSchema.default({}),
});

export const defaultConfigSchema = z.object({
  engine: engineConfigSchema,
  risk: riskLimitsSchema,
  execution: executionConfigSchema,
  api: apiConfigSchema,
  dashboard: dashboardConfigSchema,
  database: databaseConfigSchema,
  advisor: advisorConfigSchema.default({}),
});

const entityStrategyConfigSchema = z.object({
  strategy_id: z.string(),
  sub_strategy_ids: z.array(z.string()).optional(),
});

const entityConfigSchema = z.object({
  slug: z.string(),
  name: z.string(),
  port: z.number().positive(),
  entity_path: z.string(),
  mode: z.enum(['paper', 'live']).default('paper'),
  status: z.enum(['pending', 'active', 'paused', 'disabled']).default('pending'),
  starting_capital: z.number().min(0).default(0),
  // Accept either string (legacy) or object format
  strategies: z.array(z.union([z.string(), entityStrategyConfigSchema])).default([]),
});

export const entitiesConfigSchema = z.object({
  entities: z.array(entityConfigSchema),
});

export type ValidatedConfig = z.infer<typeof defaultConfigSchema>;
export type ValidatedEntities = z.infer<typeof entitiesConfigSchema>;
