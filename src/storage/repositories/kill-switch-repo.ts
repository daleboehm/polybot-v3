// Kill switch state — persisted halt primitive.
//
// G1 (2026-04-15). Backs the in-memory kill switch in src/core/kill-switch.ts
// with a single-row SQLite table so a halt survives process restart. The
// kill-switch module calls setKillSwitchState on halt() and clearKillSwitchState
// on resume(). The engine calls getKillSwitchState on startup and, if it finds
// a row with halted=1, re-halts the in-memory singleton before any trading
// code runs. This is the fix for the 4/13 prod blow-up root cause: the
// in-memory-only halt cleared on restart and auto-resumed trading into the
// broken longshot strategy.
//
// Single row enforced by `CHECK (id = 1)` — there is only ever one kill-switch
// state per engine process. Upsert via `INSERT OR REPLACE`.

import { getDatabase } from '../database.js';

export interface KillSwitchStateRow {
  halted: boolean;
  reason: string | null;
  message: string | null;
  halted_at: string | null; // ISO string
  updated_at: string;       // ISO string
}

interface RawKillSwitchRow {
  id: number;
  halted: number;
  reason: string | null;
  message: string | null;
  halted_at: string | null;
  updated_at: string;
}

/**
 * Read the persisted kill-switch state. Returns null if no row exists
 * (fresh DB) or if the stored state is "not halted". The engine startup
 * path only needs to act when a halted row is present.
 */
export function getKillSwitchState(): KillSwitchStateRow | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT id, halted, reason, message, halted_at, updated_at FROM kill_switch_state WHERE id = 1`)
    .get() as RawKillSwitchRow | undefined;

  if (!row) return null;

  return {
    halted: row.halted === 1,
    reason: row.reason,
    message: row.message,
    halted_at: row.halted_at,
    updated_at: row.updated_at,
  };
}

/**
 * Persist a halted state. Called from KillSwitch.halt() immediately after
 * the in-memory flag flips. Idempotent — uses INSERT OR REPLACE on id=1.
 */
export function setKillSwitchState(reason: string, message: string | null, haltedAt: Date): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR REPLACE INTO kill_switch_state (id, halted, reason, message, halted_at, updated_at)
     VALUES (1, 1, ?, ?, ?, datetime('now'))`,
  ).run(reason, message, haltedAt.toISOString());
}

/**
 * Clear the persisted halt. Called from KillSwitch.resume() after the
 * in-memory flag has been cleared. We REPLACE with halted=0 (rather than
 * DELETE) so the last halt reason is preserved as history in the row
 * until the next halt overwrites it — useful for postmortem forensics.
 */
export function clearKillSwitchState(): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR REPLACE INTO kill_switch_state (id, halted, reason, message, halted_at, updated_at)
     VALUES (1, 0,
             (SELECT reason FROM kill_switch_state WHERE id = 1),
             (SELECT message FROM kill_switch_state WHERE id = 1),
             (SELECT halted_at FROM kill_switch_state WHERE id = 1),
             datetime('now'))`,
  ).run();
}
