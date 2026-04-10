// Order CRUD operations

import { getDatabase } from '../database.js';
import type { Order, OrderStatus } from '../../types/index.js';

export function insertOrder(order: Order): void {
  const db = getDatabase();
  db.prepare(`
    INSERT INTO orders (
      order_id, entity_slug, condition_id, token_id, side, price,
      original_size, filled_size, remaining_size, usdc_amount, status,
      order_type, expiration, is_paper, strategy_id, sub_strategy_id, signal_id,
      error_message, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.order_id, order.entity_slug, order.condition_id, order.token_id,
    order.side, order.price, order.original_size, order.filled_size,
    order.remaining_size, order.usdc_amount, order.status, order.order_type,
    order.expiration?.toISOString() ?? null, order.is_paper ? 1 : 0,
    order.strategy_id, order.sub_strategy_id ?? null, order.signal_id, order.error_message ?? null,
    order.submitted_at.toISOString(),
  );
}

export function updateOrderStatus(orderId: string, status: OrderStatus, filledSize?: number, errorMessage?: string): void {
  const db = getDatabase();
  if (filledSize !== undefined) {
    db.prepare(`
      UPDATE orders SET status = ?, filled_size = ?, remaining_size = original_size - ?,
        filled_at = CASE WHEN ? IN ('filled') THEN datetime('now') ELSE filled_at END,
        cancelled_at = CASE WHEN ? IN ('cancelled') THEN datetime('now') ELSE cancelled_at END,
        error_message = COALESCE(?, error_message)
      WHERE order_id = ?
    `).run(status, filledSize, filledSize, status, status, errorMessage ?? null, orderId);
  } else {
    db.prepare(`
      UPDATE orders SET status = ?,
        cancelled_at = CASE WHEN ? IN ('cancelled') THEN datetime('now') ELSE cancelled_at END,
        error_message = COALESCE(?, error_message)
      WHERE order_id = ?
    `).run(status, status, errorMessage ?? null, orderId);
  }
}

export function getOpenOrders(entitySlug: string): OrderRow[] {
  const db = getDatabase();
  return db.prepare(
    "SELECT * FROM orders WHERE entity_slug = ? AND status IN ('pending', 'open', 'partially_filled') ORDER BY submitted_at DESC",
  ).all(entitySlug) as OrderRow[];
}

export function getOrdersByEntity(entitySlug: string, limit = 50): OrderRow[] {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM orders WHERE entity_slug = ? ORDER BY submitted_at DESC LIMIT ?',
  ).all(entitySlug, limit) as OrderRow[];
}

export function getOrderById(orderId: string): OrderRow | undefined {
  const db = getDatabase();
  return db.prepare('SELECT * FROM orders WHERE order_id = ?').get(orderId) as OrderRow | undefined;
}

export interface OrderRow {
  id: number;
  order_id: string | null;
  entity_slug: string;
  condition_id: string;
  token_id: string;
  side: string;
  price: number;
  original_size: number;
  filled_size: number;
  remaining_size: number;
  usdc_amount: number;
  status: string;
  order_type: string;
  expiration: string | null;
  is_paper: number;
  strategy_id: string | null;
  sub_strategy_id: string | null;
  signal_id: string | null;
  error_message: string | null;
  submitted_at: string;
  filled_at: string | null;
  cancelled_at: string | null;
  created_at: string;
}
