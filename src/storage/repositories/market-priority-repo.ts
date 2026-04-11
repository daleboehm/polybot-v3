// Market priorities — attention router for scout-flagged markets.
//
// Phase 2 (2026-04-11). Scouts (heuristic or LLM) write rows here to tell
// the engine "scan this market NOW, don't wait for the next 5-minute scan
// cycle." The PriorityScanner polls this table every 30 seconds and fires
// strategies on the priority markets out of the normal cycle.
//
// Design: priorities are time-bounded (expires_at) and rate-limited
// (scanned_count + last_scanned_at). A scout can upsert the same
// condition_id by different scouts and each row stands alone — the scanner
// de-dupes at scan time by picking the highest-priority unexpired row per
// condition_id.

import { getDatabase } from '../database.js';

export interface MarketPriorityRow {
  id: number;
  condition_id: string;
  priority: number;         // 1-10
  reason: string;
  created_by: string;       // scout_id
  created_at: number;       // unix ms
  expires_at: number;       // unix ms
  scanned_count: number;
  last_scanned_at: number | null;
}

export interface InsertPriorityInput {
  condition_id: string;
  priority: number;
  reason: string;
  created_by: string;
  ttl_ms?: number;          // default 15 min
}

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * Insert a new priority row. Does not de-dupe — if the same scout flags the
 * same market twice in one window, both rows survive and the scanner will
 * pick the newest/highest.
 */
export function insertPriority(input: InsertPriorityInput): number {
  const db = getDatabase();
  const now = Date.now();
  const expires = now + (input.ttl_ms ?? DEFAULT_TTL_MS);
  const info = db
    .prepare(
      `INSERT INTO market_priorities
       (condition_id, priority, reason, created_by, created_at, expires_at, scanned_count)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      input.condition_id,
      input.priority,
      input.reason,
      input.created_by,
      now,
      expires,
    );
  return Number(info.lastInsertRowid);
}

/**
 * Return the N highest-priority active (unexpired) priority rows. Dedupes
 * by condition_id — if two scouts flag the same market, the higher
 * priority row wins (tie-break: newer). Skips rows scanned in the last
 * `minScanGapMs` milliseconds to avoid hammering the same market.
 */
export function getActivePriorities(
  limit = 50,
  minScanGapMs = 60_000,
): MarketPriorityRow[] {
  const db = getDatabase();
  const now = Date.now();
  const scanCutoff = now - minScanGapMs;
  const rows = db
    .prepare(
      `SELECT mp.* FROM market_priorities mp
       INNER JOIN (
         SELECT condition_id, MAX(priority) AS max_pri, MAX(created_at) AS max_created
         FROM market_priorities
         WHERE expires_at > ?
         GROUP BY condition_id
       ) best
         ON mp.condition_id = best.condition_id
        AND mp.priority = best.max_pri
        AND mp.created_at = best.max_created
       WHERE mp.expires_at > ?
         AND (mp.last_scanned_at IS NULL OR mp.last_scanned_at < ?)
       ORDER BY mp.priority DESC, mp.created_at DESC
       LIMIT ?`,
    )
    .all(now, now, scanCutoff, limit) as MarketPriorityRow[];
  return rows;
}

/** Mark a priority row as scanned. Called by the PriorityScanner after each firing. */
export function markScanned(id: number): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE market_priorities
     SET scanned_count = scanned_count + 1,
         last_scanned_at = ?
     WHERE id = ?`,
  ).run(Date.now(), id);
}

/** Delete expired rows. Called on a timer to keep the table small. */
export function purgeExpired(olderThanMs = 60 * 60 * 1000): number {
  const db = getDatabase();
  const cutoff = Date.now() - olderThanMs;
  const info = db
    .prepare(`DELETE FROM market_priorities WHERE expires_at < ?`)
    .run(cutoff);
  return info.changes;
}

/** Count of active priorities. Used for dashboard + metrics. */
export function countActive(): number {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM market_priorities WHERE expires_at > ?`)
    .get(Date.now()) as { n: number };
  return row.n;
}

/** Per-scout breakdown of active priorities. Used for dashboard. */
export function countByScout(): Array<{ created_by: string; n: number }> {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT created_by, COUNT(*) AS n
       FROM market_priorities
       WHERE expires_at > ?
       GROUP BY created_by
       ORDER BY n DESC`,
    )
    .all(Date.now()) as Array<{ created_by: string; n: number }>;
}
