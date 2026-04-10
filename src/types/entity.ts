// Entity and wallet types

export type EntityMode = 'paper' | 'live';
export type EntityStatus = 'pending' | 'active' | 'paused' | 'disabled';

export interface WalletCredentials {
  private_key: string;
  api_key: string;
  api_secret: string;
  api_passphrase: string;
  account_address: string;
  proxy_address: string;
}

// Sub-strategy configuration — if sub_strategy_ids is undefined, all sub-strategies run
export interface EntityStrategyConfig {
  strategy_id: string;
  sub_strategy_ids?: string[];
}

export interface EntityConfig {
  slug: string;
  name: string;
  port: number;
  entity_path: string;
  mode: EntityMode;
  status: EntityStatus;
  starting_capital: number;
  // strategies can be either a list of strategy_ids (legacy) or EntityStrategyConfig objects
  strategies: Array<string | EntityStrategyConfig>;
}

export interface EntityState {
  config: EntityConfig;
  credentials: WalletCredentials | null;
  cash_balance: number;
  reserve_balance: number;
  trading_balance: number;
  high_water_mark: number;
  daily_pnl: number;
  daily_pnl_reset_date: string;
  is_locked_out: boolean;
  lockout_reason?: string;
  open_positions: number;
  total_equity: number;
}
