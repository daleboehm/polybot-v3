// Entity CRUD operations

import { getDatabase } from '../database.js';
import type { EntityConfig, EntityState, EntityMode, EntityStatus } from '../../types/index.js';

export function upsertEntity(config: EntityConfig, walletAddress?: string, proxyAddress?: string): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO entities (slug, name, port, entity_path, mode, status, starting_capital, wallet_address, proxy_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(slug) DO UPDATE SET
      name = excluded.name,
      port = excluded.port,
      entity_path = excluded.entity_path,
      mode = excluded.mode,
      status = excluded.status,
      wallet_address = COALESCE(excluded.wallet_address, entities.wallet_address),
      proxy_address = COALESCE(excluded.proxy_address, entities.proxy_address),
      updated_at = datetime('now')
  `).run(config.slug, config.name, config.port, config.entity_path, config.mode, config.status, config.starting_capital, walletAddress ?? null, proxyAddress ?? null);
}

export function getEntity(slug: string): EntityRow | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM entities WHERE slug = ?').get(slug) as EntityRow | undefined;
}

export function getAllEntities(): EntityRow[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM entities ORDER BY port ASC').all() as EntityRow[];
}

export function getActiveEntities(): EntityRow[] {
  const db = getDatabase();
  return db.prepare("SELECT * FROM entities WHERE status = 'active' ORDER BY port ASC").all() as EntityRow[];
}

export function updateEntityMode(slug: string, mode: EntityMode): void {
  const db = getDatabase();
  db.prepare("UPDATE entities SET mode = ?, updated_at = datetime('now') WHERE slug = ?").run(mode, slug);
}

export function updateEntityStatus(slug: string, status: EntityStatus): void {
  const db = getDatabase();
  db.prepare("UPDATE entities SET status = ?, updated_at = datetime('now') WHERE slug = ?").run(status, slug);
}

export function updateEntityBalances(slug: string, cash: number, reserve: number, trading: number, hwm: number): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE entities SET
      current_cash = ?, reserve_balance = ?, trading_balance = ?,
      high_water_mark = MAX(high_water_mark, ?),
      updated_at = datetime('now')
    WHERE slug = ?
  `).run(cash, reserve, trading, hwm, slug);
}

export function updateEntityDailyPnl(slug: string, pnl: number, date: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE entities SET daily_pnl = ?, daily_pnl_reset = ?, updated_at = datetime('now') WHERE slug = ?
  `).run(pnl, date, slug);
}

export function setEntityLockout(slug: string, locked: boolean, reason?: string): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE entities SET is_locked_out = ?, lockout_reason = ?, updated_at = datetime('now') WHERE slug = ?
  `).run(locked ? 1 : 0, reason ?? null, slug);
}

export function getEntityPnlView(): EntityPnlRow[] {
  const db = getDatabase();
  return db.prepare('SELECT * FROM v_entity_pnl').all() as EntityPnlRow[];
}

// Row types
export interface EntityRow {
  id: number;
  slug: string;
  name: string;
  wallet_address: string | null;
  proxy_address: string | null;
  port: number;
  entity_path: string;
  mode: EntityMode;
  status: EntityStatus;
  starting_capital: number;
  current_cash: number;
  reserve_balance: number;
  trading_balance: number;
  high_water_mark: number;
  daily_pnl: number;
  daily_pnl_reset: string | null;
  is_locked_out: number;
  lockout_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntityPnlRow {
  slug: string;
  name: string;
  mode: string;
  status: string;
  starting_capital: number;
  current_cash: number;
  reserve_balance: number;
  trading_balance: number;
  total_realized_pnl: number;
  total_wins: number;
  total_losses: number;
  total_trades: number;
  total_volume: number;
  open_positions: number;
  open_positions_value: number;
  total_upside: number;
}
