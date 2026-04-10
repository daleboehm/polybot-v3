// Telegram alerter — operator notifications for the R3b observability layer.
//
// R3b (2026-04-10). Per design-decisions §P: operator alerts go to Telegram
// via a bot created with @BotFather. The chat_id is captured via a one-time
// /start handshake (see `Polymarket/docs/rebuild-design-decisions-2026-04-10.md`
// §P2), then stored at `/etc/polybot-v3/telegram-chat-id` on the VPS.
//
// This module:
//   1. Auto-captures chat_id if the file is missing and a message arrives
//   2. Sends formatted alerts for engine events, kill-switch activations,
//      reconciliation drift, drawdown breaches, and budget quota warnings
//   3. Hooks into the event bus so components emit `alert:*` events without
//      needing to know about Telegram
//
// If TELEGRAM_BOT_TOKEN is unset, the alerter logs warnings but doesn't crash.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { eventBus } from '../core/event-bus.js';
import { killSwitch } from '../core/kill-switch.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('alerter');

const TELEGRAM_API = 'https://api.telegram.org/bot';
const CHAT_ID_FILE = process.env.TELEGRAM_CHAT_ID_FILE ?? '/etc/polybot-v3/telegram-chat-id';
const POLL_INTERVAL_MS = 30_000; // poll getUpdates every 30s for chat_id handshake
const MIN_ALERT_INTERVAL_MS = 5 * 60 * 1000; // 5 min minimum between duplicate alerts

export type AlertSeverity = 'info' | 'warn' | 'error' | 'critical';

export interface Alert {
  severity: AlertSeverity;
  component: string;
  title: string;
  details?: Record<string, unknown>;
  runbook?: string;
}

export class TelegramAlerter {
  private token: string | null;
  private chatId: string | null = null;
  private recentAlerts = new Map<string, number>(); // dedup key → last sent time
  private pollInterval: ReturnType<typeof setInterval> | null = null;

  constructor(token?: string) {
    this.token = token ?? process.env.TELEGRAM_BOT_TOKEN ?? null;
    this.loadChatId();
    if (!this.token) {
      log.warn('TELEGRAM_BOT_TOKEN not set — alerter disabled');
    }
  }

  start(): void {
    if (!this.token) return;

    // If we don't have a chat_id yet, start polling getUpdates for the handshake.
    // Once a message arrives, capture chat_id and stop polling.
    if (!this.chatId) {
      log.info('No chat_id yet — polling Telegram for /start handshake');
      this.pollInterval = setInterval(() => {
        void this.pollForChatId();
      }, POLL_INTERVAL_MS);
    }

    // Subscribe to interesting event bus events
    eventBus.on('killswitch:activated', ({ reason, message }) => {
      void this.send({
        severity: 'critical',
        component: 'kill-switch',
        title: `KILL SWITCH ACTIVATED: ${reason}`,
        details: { message },
        runbook: 'SIGUSR2 to resume after root-cause fix',
      });
    });

    eventBus.on('killswitch:released', ({ operator }) => {
      void this.send({
        severity: 'info',
        component: 'kill-switch',
        title: 'Kill switch released',
        details: { operator },
      });
    });

    eventBus.on('engine:started', () => {
      void this.send({ severity: 'info', component: 'engine', title: 'Engine started' });
    });

    eventBus.on('engine:stopped', ({ reason }) => {
      void this.send({ severity: 'info', component: 'engine', title: `Engine stopped: ${reason}` });
    });

    eventBus.on('engine:error', ({ error, context }) => {
      void this.send({
        severity: 'error',
        component: 'engine',
        title: `Engine error in ${context}`,
        details: { error: error.message },
      });
    });

    log.info('Telegram alerter started');
  }

  stop(): void {
    if (this.pollInterval) clearInterval(this.pollInterval);
    this.pollInterval = null;
  }

  async send(alert: Alert): Promise<boolean> {
    if (!this.token || !this.chatId) return false;

    const dedupKey = `${alert.severity}|${alert.component}|${alert.title}`;
    const last = this.recentAlerts.get(dedupKey) ?? 0;
    if (Date.now() - last < MIN_ALERT_INTERVAL_MS) {
      log.debug({ key: dedupKey }, 'Alert deduped');
      return false;
    }
    this.recentAlerts.set(dedupKey, Date.now());

    const text = this.format(alert);
    try {
      const res = await fetch(`${TELEGRAM_API}${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: this.chatId, text, parse_mode: 'Markdown' }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        log.warn({ status: res.status }, 'Telegram sendMessage failed');
        return false;
      }
      return true;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Telegram sendMessage threw');
      return false;
    }
  }

  private format(alert: Alert): string {
    const emoji = { info: 'ℹ️', warn: '⚠️', error: '❌', critical: '🚨' }[alert.severity];
    const lines: string[] = [];
    lines.push(`${emoji} *${alert.severity.toUpperCase()}* [${alert.component}]`);
    lines.push(`*${alert.title}*`);
    if (alert.details) {
      lines.push('');
      for (const [k, v] of Object.entries(alert.details)) {
        lines.push(`• ${k}: \`${String(v)}\``);
      }
    }
    if (alert.runbook) {
      lines.push('');
      lines.push(`_Action_: ${alert.runbook}`);
    }
    lines.push('');
    lines.push(`_${new Date().toISOString()}_`);
    return lines.join('\n');
  }

  private loadChatId(): void {
    try {
      if (existsSync(CHAT_ID_FILE)) {
        const id = readFileSync(CHAT_ID_FILE, 'utf8').trim();
        if (id) {
          this.chatId = id;
          log.info({ file: CHAT_ID_FILE }, 'Loaded Telegram chat_id');
        }
      }
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to load chat_id');
    }
  }

  private async pollForChatId(): Promise<void> {
    if (!this.token) return;
    try {
      const res = await fetch(`${TELEGRAM_API}${this.token}/getUpdates?limit=10`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { result?: Array<{ message?: { from?: { id?: number } } }> };
      const updates = data.result ?? [];
      for (const u of updates) {
        const id = u.message?.from?.id;
        if (typeof id === 'number') {
          this.chatId = String(id);
          log.info({ chat_id: this.chatId }, 'Captured Telegram chat_id from /start');
          try {
            writeFileSync(CHAT_ID_FILE, this.chatId, { mode: 0o600 });
            log.info({ file: CHAT_ID_FILE }, 'Persisted chat_id');
          } catch (err) {
            log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Failed to persist chat_id');
          }
          if (this.pollInterval) {
            clearInterval(this.pollInterval);
            this.pollInterval = null;
          }
          // Send welcome
          void this.send({
            severity: 'info',
            component: 'alerter',
            title: 'Polybot V3 alerter online',
            details: { bound_to: this.chatId },
          });
          return;
        }
      }
    } catch (err) {
      log.debug({ err: err instanceof Error ? err.message : String(err) }, 'getUpdates poll failed');
    }
  }
}
