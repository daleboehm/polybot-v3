// Position CRUD operations

import { getDatabase } from '../database.js';
import type { Outcome } from '../../types/index.js';

function assertStrategyAttribution(p: PositionUpsert, fn: string): void {
  // 2026-04-20 G8: NULL-strategy guard. Every position MUST have a strategy_id.
  // Reconciler orphans are tagged 'reconciler_orphan' (commit 26af1c8). Any other
  // path that lands here without attribution is a bug — throw so it's loud.
  // Historical orphans (IDs 117-125, opened 2026-04-10) were backfilled with
  // 'pre_guard_legacy' to keep this assert clean on startup.
  const sid = p.strategy_id?.trim();
  if (!sid) {
    throw new Error(
      `${fn}: strategy_id is null/empty for entity=${p.entity_slug} condition=${p.condition_id} token=${p.token_id}. ` +
      'All positions must carry attribution. If this is an on-chain reconciler orphan, set strategy_id="reconciler_orphan".'
    );
  }
}

export function upsertPosition(p: PositionUpsert): void {
  assertStrategyAttribution(p, "upsertPosition");
  // 2026-04-10 contamination fix: previously the ON CONFLICT UPDATE clause
  // overwrote `sub_strategy_id` (but not `strategy_id`) on every conflict,
  // producing mixed-strategy rows like `favorites|bucketed_fade` whenever a
  // second strategy's fill landed on an already-open (entity, condition, token).
  // The fix: on conflict, preserve the original strategy/sub assignment from
  // the first fill. Size, cost basis and current price still update so stop-loss
  // and equity math stay correct. If you need to "add to a position" (accumulate
  // size with weighted avg price), that's a different operation and should be
  // an explicit add-to-position mutator, not an overloaded upsert.
  const db = getDatabase();
  db.prepare(`
    INSERT INTO positions (
      entity_slug, condition_id, token_id, side, size, avg_entry_price,
      cost_basis, current_price, unrealized_pnl, market_question, market_slug,
      strategy_id, sub_strategy_id, is_paper, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
    ON CONFLICT(entity_slug, condition_id, token_id) DO UPDATE SET
      size = excluded.size,
      avg_entry_price = excluded.avg_entry_price,
      cost_basis = excluded.cost_basis,
      current_price = excluded.current_price,
      unrealized_pnl = excluded.unrealized_pnl,
      updated_at = datetime('now')
      -- intentionally NOT updating strategy_id / sub_strategy_id: preserve
      -- the original strategy ownership of the position row.
  `).run(
    p.entity_slug, p.condition_id, p.token_id, p.side, p.size,
    p.avg_entry_price, p.cost_basis, p.current_price ?? null,
    p.unrealized_pnl ?? null, p.market_question ?? null, p.market_slug ?? null,
    p.strategy_id, p.sub_strategy_id ?? null, p.is_paper ? 1 : 0,
  );
}

export function closePosition(entitySlug: string, conditionId: string, tokenId: string, status: 'closed' | 'resolved' = 'closed'): void {
  const db = getDatabase();
  db.prepare(`
    UPDATE positions SET status = ?, size = 0, closed_at = datetime('now'), updated_at = datetime('now')
    WHERE entity_slug = ? AND condition_id = ? AND token_id = ?
  `).run(status, entitySlug, conditionId, tokenId);
}

// 2026-04-10: the mutator the upsertPosition comment has been asking for since day 1.
//
// upsertPosition's ON CONFLICT overwrites size/cost_basis/avg_entry_price because its
// intended caller is the on-chain reconciler's orphan-insert path — that's a "sync DB
// to on-chain truth" operation where the incoming row already represents the full
// aggregated wallet state. That semantics is correct for its caller.
//
// The engine's BUY-fill handler (engine.ts:processPosition) was also calling
// upsertPosition with ONE fill's data, expecting it to accumulate on repeat fills to
// the same (entity, condition, token). It didn't. Every second BUY dropped the first
// one's cost_basis and size on the floor. That was the root cause of R&D's ~$400
// equity leak: whenever a strategy hit a market it already held (averaging-down, or
// a later cycle re-entering after partial exit), cost_basis was overwritten instead
// of summed. The SAME cash was debited twice but only recorded once. Over 1346 buys,
// that added up.
//
// This function is the accumulate-on-conflict counterpart. INSERT on first fill,
// accumulate size/cost_basis and recompute the weighted average entry price on every
// subsequent fill. SQLite evaluates ON CONFLICT RHS expressions against the OLD row,
// so referencing `size` / `cost_basis` here gives the existing values — safe to add
// `excluded.size` / `excluded.cost_basis`.
//
// Weighted-average math: avg = (old_cost + new_cost) / (old_size + new_size). The
// two filled amounts are weighted by their dollars, which is what we want. NULLIF
// guards against a divide-by-zero in the degenerate case where both sizes are 0.
export function addFillToPosition(p: PositionUpsert): void {
  assertStrategyAttribution(p, "addFillToPosition");
  const db = getDatabase();
  db.prepare(`
    INSERT INTO positions (
      entity_slug, condition_id, token_id, side, size, avg_entry_price,
      cost_basis, current_price, unrealized_pnl, market_question, market_slug,
      strategy_id, sub_strategy_id, is_paper, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
    ON CONFLICT(entity_slug, condition_id, token_id) DO UPDATE SET
      size = size + excluded.size,
      cost_basis = cost_basis + excluded.cost_basis,
      avg_entry_price = (cost_basis + excluded.cost_basis)
                        / NULLIF(size + excluded.size, 0),
      current_price = excluded.current_price,
      unrealized_pnl = excluded.unrealized_pnl,
      updated_at = datetime('now')
      -- intentionally NOT updating strategy_id / sub_strategy_id: preserve the
      -- original strategy ownership of the position row (same contamination fix
      -- rationale as upsertPosition above). Also: status stays 'open' because
      -- ON CONFLICT only fires for an already-open row; a closed row is a
      -- different (entity, condition, token) lifecycle.
  `).run(
    p.entity_slug, p.condition_id, p.token_id, p.side, p.size,
    p.avg_entry_price, p.cost_basis, p.current_price ?? null,
    p.unrealized_pnl ?? null, p.market_question ?? null, p.market_slug ?? null,
    p.strategy_id, p.sub_strategy_id ?? null, p.is_paper ? 1 : 0,
  );
}

export function getOpenPositions(entitySlug: string): PositionRow[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT p.*, m.end_date AS market_end_date
    FROM positions p
    LEFT JOIN markets m ON p.condition_id = m.condition_id
    WHERE p.entity_slug = ? AND p.status = 'open'
    ORDER BY m.end_date ASC NULLS LAST, p.opened_at DESC
  `).all(entitySlug) as PositionRow[];
}

export function getAllOpenPositions(): PositionRow[] {
  const db = getDatabase();
  return db.prepare("SELECT * FROM positions WHERE status = 'open' ORDER BY entity_slug, opened_at DESC").all() as PositionRow[];
}

// 2026-04-11 Phase 1.5: sum of open cost_basis per strategy_id for a given
// entity. Used by the per-strategy capital envelope in risk-engine to cap
// the total capital any one strategy can tie up, so a buggy strategy can't
// drain the bankroll before daily loss lockout trips.
//
// Returns an object keyed by strategy_id. NULL strategy_ids (orphan
// reconciler-inserted positions) are aggregated under the key "__orphan".
export function getDeployedByStrategy(entitySlug: string): Record<string, number> {
  const db = getDatabase();
  const rows = db.prepare(`
    SELECT COALESCE(strategy_id, '__orphan') AS strategy_id,
           SUM(cost_basis) AS total_cost
    FROM positions
    WHERE entity_slug = ? AND status = 'open'
    GROUP BY COALESCE(strategy_id, '__orphan')
  `).all(entitySlug) as Array<{ strategy_id: string; total_cost: number }>;
  const out: Record<string, number> = {};
  for (const row of rows) {
    out[row.strategy_id] = row.total_cost ?? 0;
  }
  return out;
}

// 2026-04-11 Phase 1.6: positions pre-joined with market metadata for the
// dashboard. Includes end_date + uma_resolution_status so the frontend can
// render triage states (overdue / uma_pending / dispute) without needing a
// separate /api/markets/all call.
export interface PositionWithMarketRow extends PositionRow {
  market_end_date: string | null;
  uma_resolution_status: string | null;
  market_question_joined: string | null;
}
export function getOpenPositionsWithMarketMeta(entitySlug: string): PositionWithMarketRow[] {
  const db = getDatabase();
  return db.prepare(`
    SELECT
      p.*,
      m.end_date              AS market_end_date,
      m.uma_resolution_status AS uma_resolution_status,
      m.question              AS market_question_joined
    FROM positions p
    LEFT JOIN markets m ON p.condition_id = m.condition_id
    WHERE p.entity_slug = ? AND p.status = 'open'
    ORDER BY m.end_date ASC NULLS LAST, p.opened_at DESC
  `).all(entitySlug) as PositionWithMarketRow[];
}

export function getPosition(entitySlug: string, conditionId: string, tokenId: string): PositionRow | undefined {
  const db = getDatabase();
  return db.prepare(
    'SELECT * FROM positions WHERE entity_slug = ? AND condition_id = ? AND token_id = ?',
  ).get(entitySlug, conditionId, tokenId) as PositionRow | undefined;
}

export function updatePositionPrice(entitySlug: string, conditionId: string, tokenId: string, price: number): void {
  const db = getDatabase();
  // 2026-04-11 Phase 2.5: also maintain peak_pnl_pct for the trailing profit
  // lock. Only increases; once the peak is set, it ratchets up only.
  db.prepare(`
    UPDATE positions SET
      current_price = ?,
      unrealized_pnl = (? - avg_entry_price) * size,
      peak_pnl_pct = MAX(
        COALESCE(peak_pnl_pct, 0),
        CASE WHEN avg_entry_price > 0
             THEN (? - avg_entry_price) / avg_entry_price
             ELSE 0 END
      ),
      updated_at = datetime('now')
    WHERE entity_slug = ? AND condition_id = ? AND token_id = ? AND status = 'open'
  `).run(price, price, price, entitySlug, conditionId, tokenId);
}

export function getOpenPositionCount(entitySlug: string): number {
  const db = getDatabase();
  const row = db.prepare("SELECT COUNT(*) as cnt FROM positions WHERE entity_slug = ? AND status = 'open'").get(entitySlug) as { cnt: number };
  return row.cnt;
}

export interface PositionUpsert {
  entity_slug: string;
  condition_id: string;
  token_id: string;
  side: Outcome;
  size: number;
  avg_entry_price: number;
  cost_basis: number;
  current_price?: number;
  unrealized_pnl?: number;
  market_question?: string;
  market_slug?: string;
  strategy_id?: string;
  sub_strategy_id?: string;
  is_paper: boolean;
}

export interface PositionRow {
  id: number;
  entity_slug: string;
  condition_id: string;
  token_id: string;
  side: string;
  size: number;
  avg_entry_price: number;
  cost_basis: number;
  current_price: number | null;
  unrealized_pnl: number | null;
  market_question: string | null;
  market_slug: string | null;
  strategy_id: string | null;
  sub_strategy_id: string | null;
  is_paper: number;
  status: string;
  opened_at: string;
  closed_at: string | null;
  updated_at: string;
  market_end_date: string | null;
  peak_pnl_pct?: number; // Phase 2.5: trailing profit lock peak
}
