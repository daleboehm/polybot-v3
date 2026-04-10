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
//
// The kill switch is NOT persisted. On process restart it clears. Per obra-defense-in-
// depth, this is intentional: a halt caused by a runtime anomaly shouldn't permanently
// lock the engine out of recovery. Operators decide when to resume, and the 72h paper
// run (R1 verification gate) exercises both halt and resume paths.

import { eventBus } from './event-bus.js';
import { createChildLogger } from './logger.js';

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
    log.info({ operator, wasReason }, 'Kill switch released');
    eventBus.emit('killswitch:released', { operator, at: new Date() });
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
