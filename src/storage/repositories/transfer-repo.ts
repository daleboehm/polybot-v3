// Transfer CRUD operations

import { getDatabase } from '../database.js';

export type TransferType = 'DEPOSIT' | 'FUND' | 'SWEEP' | 'WITHDRAWAL';

export function insertTransfer(t: TransferInsert): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO transfers (from_entity, to_entity, amount_usdc, tx_hash, timestamp, timestamp_utc, transfer_type, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(t.from_entity, t.to_entity, t.amount_usdc, t.tx_hash ?? null, t.timestamp, t.timestamp_utc, t.transfer_type, t.notes ?? null);
}

export function getTransfersByEntity(entitySlug: string): TransferRow[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM transfers WHERE from_entity = ? OR to_entity = ? ORDER BY timestamp DESC',
  ).all(entitySlug, entitySlug) as TransferRow[];
}

export interface TransferInsert {
  from_entity: string;
  to_entity: string;
  amount_usdc: number;
  tx_hash?: string;
  timestamp: number;
  timestamp_utc: string;
  transfer_type: TransferType;
  notes?: string;
}

export interface TransferRow extends TransferInsert {
  id: number;
  created_at: string;
}
