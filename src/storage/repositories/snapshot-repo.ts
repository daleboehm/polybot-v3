// Snapshot CRUD operations

import { getDatabase } from '../database.js';

export function insertSnapshot(s: SnapshotInsert): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO snapshots (
      entity_slug, timestamp, timestamp_utc, total_equity, cash_balance,
      reserve_balance, trading_balance, positions_value, num_positions,
      open_orders_value, num_open_orders, daily_pnl, deposit_basis, pnl_vs_deposit
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.entity_slug, s.timestamp, s.timestamp_utc, s.total_equity, s.cash_balance,
    s.reserve_balance, s.trading_balance, s.positions_value, s.num_positions,
    s.open_orders_value, s.num_open_orders, s.daily_pnl, s.deposit_basis, s.pnl_vs_deposit,
  );
}

export function getSnapshots(entitySlug: string, limit = 168): SnapshotRow[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM snapshots WHERE entity_slug = ? ORDER BY timestamp DESC LIMIT ?',
  ).all(entitySlug, limit) as SnapshotRow[];
}

export function getLatestSnapshot(entitySlug: string): SnapshotRow | undefined {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM snapshots WHERE entity_slug = ? ORDER BY timestamp DESC LIMIT 1',
  ).get(entitySlug) as SnapshotRow | undefined;
}

export interface SnapshotInsert {
  entity_slug: string;
  timestamp: number;
  timestamp_utc: string;
  total_equity: number;
  cash_balance: number;
  reserve_balance: number;
  trading_balance: number;
  positions_value: number;
  num_positions: number;
  open_orders_value: number;
  num_open_orders: number;
  daily_pnl: number;
  deposit_basis: number;
  pnl_vs_deposit: number;
}

export interface SnapshotRow extends SnapshotInsert {
  id: number;
  created_at: string;
}
