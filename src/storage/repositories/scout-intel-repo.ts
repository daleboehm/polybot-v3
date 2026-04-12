// Scout intel — qualitative overlay for signal sizing.
//
// Phase 3 (2026-04-11). Scouts write "qualitative intel" rows here: market
// X, side Y, conviction Z, reason "...". Strategies read the most recent
// unexpired intel for each market during signal build and apply a size
// multiplier:
//
//   scout agrees with strategy side + high conviction → 1.25x
//   scout disagrees with strategy side + high conviction → 0.5x
//   neutral / no intel → 1.0x
//
// Intel cannot CREATE signals — it only *weights* existing ones. The
// strategy math (Wilson LB + Markov grid + min_edge gate) stays primary.
//
// Expiration: default 24h. Scouts can set shorter (breaking news) or
// longer (structural observations) at write time.

import { getDatabase } from '../database.js';

export type IntelSide = 'YES' | 'NO';

export interface ScoutIntelRow {
  id: number;
  condition_id: string;
  side: IntelSide;
  conviction: number;       // 0-1
  reason: string;
  created_by: string;       // scout_id
  created_at: number;       // unix ms
  expires_at: number;       // unix ms
  used_count: number;
}

export interface InsertIntelInput {
  condition_id: string;
  side: IntelSide;
  conviction: number;
  reason: string;
  created_by: string;
  ttl_ms?: number;          // default 24h
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/** Insert a new intel row. */
export function insertIntel(input: InsertIntelInput): number {
  const db = getDatabase();
  const now = Date.now();
  const expires = now + (input.ttl_ms ?? DEFAULT_TTL_MS);
  const conviction = Math.max(0, Math.min(1, input.conviction));
  const info = db
    .prepare(
      `INSERT INTO scout_intel
       (condition_id, side, conviction, reason, created_by, created_at, expires_at, used_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
    )
    .run(
      input.condition_id,
      input.side,
      conviction,
      input.reason,
      input.created_by,
      now,
      expires,
    );
  return Number(info.lastInsertRowid);
}

/**
 * Get the single most-recent unexpired intel row for a market. Strategies
 * call this during signal build — null means "no intel, size at 1.0x".
 * If multiple scouts have written intel on the same market, returns the
 * newest — a scout that just wrote is the freshest opinion.
 */
export function getActiveIntel(conditionId: string): ScoutIntelRow | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `SELECT * FROM scout_intel
       WHERE condition_id = ?
         AND expires_at > ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(conditionId, Date.now()) as ScoutIntelRow | undefined;
  return row ?? null;
}

/**
 * Mark an intel row as used (applied to a signal). The `used_count`
 * column tracks how many signals each intel row has influenced so the
 * dashboard can surface which scouts are doing work.
 */
export function markUsed(id: number): void {
  const db = getDatabase();
  db.prepare(`UPDATE scout_intel SET used_count = used_count + 1 WHERE id = ?`).run(id);
}

/** Purge expired intel rows older than `olderThanMs`. */
export function purgeExpired(olderThanMs = 24 * 60 * 60 * 1000): number {
  const db = getDatabase();
  const cutoff = Date.now() - olderThanMs;
  const info = db.prepare(`DELETE FROM scout_intel WHERE expires_at < ?`).run(cutoff);
  return info.changes;
}

/** Count of active intel rows. */
export function countActive(): number {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM scout_intel WHERE expires_at > ?`)
    .get(Date.now()) as { n: number };
  return row.n;
}

/** Per-scout breakdown. */
export function countByScout(): Array<{ created_by: string; n: number; avg_conviction: number }> {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT created_by, COUNT(*) AS n, AVG(conviction) AS avg_conviction
       FROM scout_intel
       WHERE expires_at > ?
       GROUP BY created_by
       ORDER BY n DESC`,
    )
    .all(Date.now()) as Array<{ created_by: string; n: number; avg_conviction: number }>;
}
