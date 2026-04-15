// Runtime kill switch — process-wide halt primitive.
//
// The audit (2026-04-09 §17) found ZERO runtime halt mechanism. The dual-flag
// live-mode gate is checked once at startup and can't be toggled. SIGTERM clears
// intervals but can't abort an in-flight routeOrder. kill -9 doesn't cancel live
// CLOB orders that are already in flight.
//
// This module provides:
//   1. A singleton flag that routeOrder checks before every submit (throws if halted)
//   2. A SIGUSR1 handler that halts in-process (call `wireSignals()` at lifecycle init)
//   3. A dashboard-callable API (halt/resume/status) for operator control
//   4. Event-bus integration so observability (R3b) can alert on activation
//   5. SQLite persistence (G1, 2026-04-15) so halt state survives process restart
//
// G1 persistence rationale (2026-04-15):
// The original design (see symmetry audit 2026-04-15) left the kill switch as
// in-memory-only, arguing that a halt caused by a runtime anomaly shouldn't
// permanently lock the engine out of recovery. In practice this was the root
// cause of the 2026-04-13 prod blow-up: the halt fired at 13:36 UTC on a 43.8%
// daily drawdown; the process later restarted (OOM / systemctl / graceful-
// shutdown); the in-memory flag cleared; live trading auto-resumed into the
// broken longshot strategy; trades 1347/1348 filled after the halt that should
// have been in force.
//
// Fix: persist the halt state to SQLite via kill-switch-repo. On engine
// startup, loadPersistedState() reads the row and (if halted) re-halts the
// in-memory singleton BEFORE any strategy or clob-router code runs. The only
// way out is deliberate operator action (SIGUSR2 or dashboard resume), which
// clears both the in-memory flag AND the DB row. Recovery is still an
// operator decision — persistence just means the default is "stay halted"
// instead of "silently resume on restart".

import { eventBus } from './event-bus.js';
import { createChildLogger } from './logger.js';
import { setKillSwitchState, clearKillSwitchState, getKillSwitchState } from '../storage/repositories/kill-switch-repo.js';

const log = createChildLogger('kill-switch');

export type KillReason =
  | 'operator_sigusr1'
  | 'operator_dashboard'
  | 'reconciliation_drift'
  | 'consecutive_api_failures'
  | 'prod_cash_below_floor'
  | 'daily_drawdown_breach'
  | 'weekly_drawdown_breach'
  | 'consecutive_losses'
  | 'unrecognized_scan_exception'
  | 'wallet_balance_divergence'
  | 'startup_reconciliation_failed'
  | 'unknown';

export interface KillSwitchStatus {
  halted: boolean;
  reason: KillReason | null;
  message: string | null;
  halted_at: Date | null;
}

class KillSwitch {
  private halted = false;
  private reason: KillReason | null = null;
  private message: string | null = null;
  private haltedAt: Date | null = null;

  halt(reason: KillReason, message?: string): void {
    if (this.halted) {
      // Already halted — preserve the first reason (most likely the root cause) and
      // log any follow-ups. Operators reading the logs during a cascade failure
      // should see the sequence of events, not just the last one.
      log.warn({ secondary_reason: reason, message }, 'Kill switch already halted — secondary halt logged');
      return;
    }
    this.halted = true;
    this.reason = reason;
    this.message = message ?? null;
    this.haltedAt = new Date();
    log.warn({ reason, message }, 'KILL SWITCH ACTIVATED');
    // G1 persistence: write the halt to SQLite so it survives process restart.
    // Wrapped in try/catch because the kill path MUST NOT throw — if the DB is
    // unavailable or the table is missing on an old build, we log and continue
    // with the in-memory halt (original behavior) rather than crash the halt.
    try {
      setKillSwitchState(reason, message ?? null, this.haltedAt);
    } catch (err) {
      log.error({ err }, 'Failed to persist kill-switch halt to SQLite — halt is in-memory only');
    }
    eventBus.emit('killswitch:activated', { reason, message: message ?? '', at: this.haltedAt });
  }

  resume(operator: string): void {
    if (!this.halted) {
      log.info({ operator }, 'Kill switch resume called but not halted — no-op');
      return;
    }
    const wasReason = this.reason;
    this.halted = false;
    this.reason = null;
    this.message = null;
    this.haltedAt = null;
    // G1 persistence: clear the halted row so the next restart does not
    // auto-re-halt. Wrapped in try/catch for the same reason as halt() —
    // the resume path must not throw.
    try {
      clearKillSwitchState();
    } catch (err) {
      log.error({ err }, 'Failed to clear persisted kill-switch state — next restart may re-halt');
    }
    log.info({ operator, wasReason }, 'Kill switch released');
    eventBus.emit('killswitch:released', { operator, at: new Date() });
  }

  /**
   * G1 (2026-04-15): re-apply a persisted halt on engine startup.
   *
   * Call this from engine.start() AFTER applySchema(db) but BEFORE any
   * strategy registration or clob-router wiring. If the kill_switch_state
   * table has a row with halted=1, we call halt() with the persisted
   * reason and message, which flips the in-memory flag and emits the
   * killswitch:activated event (so alerters can notify the operator that
   * the engine came up in halted state).
   *
   * If no row exists, or halted=0, this is a no-op — the in-memory flag
   * stays at its default (not halted) and the engine starts normally.
   *
   * This is the fix for the 4/13 prod root cause: a restart mid-halt used
   * to auto-resume trading. With this call in place, the restart re-halts
   * from the DB row and the operator still has to SIGUSR2 or dashboard
   * resume to re-arm live trading.
   */
  loadPersistedState(): void {
    let row: ReturnType<typeof getKillSwitchState> = null;
    try {
      row = getKillSwitchState();
    } catch (err) {
      log.error({ err }, 'Failed to read persisted kill-switch state on startup — starting un-halted (fail-open)');
      return;
    }
    if (!row || !row.halted) {
      log.info('Kill switch persistence: no active halt to restore');
      return;
    }
    // Re-hydrate the in-memory flag. We call halt() directly rather than
    // setting fields so that the event bus sees a fresh 'activated' event
    // and any alerter wired up later in start() sees the halted state.
    const reason = (row.reason ?? 'unknown') as KillReason;
    const persistedAt = row.halted_at ? new Date(row.halted_at) : new Date();
    log.warn(
      { reason, message: row.message, halted_at: row.halted_at },
      'KILL SWITCH RE-HALTED FROM PERSISTED STATE — operator must SIGUSR2 to release',
    );
    // Flip the fields manually so halt()'s "already halted" guard doesn't
    // fire and so we don't re-write the DB row with a new halted_at.
    this.halted = true;
    this.reason = reason;
    this.message = row.message;
    this.haltedAt = persistedAt;
    eventBus.emit('killswitch:activated', {
      reason,
      message: row.message ?? '(restored from persisted state)',
      at: persistedAt,
    });
  }

  /**
   * Throws if halted. Called at the top of every state-changing code path
   * (clob-router.routeOrder, neg-risk-redeemer.redeem, etc.). Fail-fast by design.
   */
  check(): void {
    if (this.halted) {
      throw new Error(`kill_switch_halted: ${this.reason ?? 'unknown'}${this.message ? ` — ${this.message}` : ''}`);
    }
  }

  isHalted(): boolean {
    return this.halted;
  }

  status(): KillSwitchStatus {
    return {
      halted: this.halted,
      reason: this.reason,
      message: this.message,
      halted_at: this.haltedAt,
    };
  }
}

// Singleton — one per process. Import { killSwitch } wherever needed.
export const killSwitch = new KillSwitch();

/**
 * Wire process signals so operators can halt the engine without killing it.
 * Call once from lifecycle.ts at process startup.
 *
 *   SIGUSR1 → halt (with reason=operator_sigusr1)
 *   SIGUSR2 → resume (operator=signal)
 *
 * SIGTERM/SIGINT still trigger graceful shutdown as before — this is a
 * PAUSE mechanism, not a SHUTDOWN mechanism.
 */
export function wireKillSwitchSignals(): void {
  process.on('SIGUSR1', () => {
    log.warn('SIGUSR1 received — activating kill switch');
    killSwitch.halt('operator_sigusr1', 'SIGUSR1 received');
  });

  process.on('SIGUSR2', () => {
    log.info('SIGUSR2 received — releasing kill switch');
    killSwitch.resume('signal');
  });
}
