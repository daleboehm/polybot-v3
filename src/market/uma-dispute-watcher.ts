// UMA dispute watcher — hourly poll of Gamma for every condition_id we hold,
// records umaResolutionStatus, alerts on any non-empty/non-resolved status.
//
// Policy (Dale 2026-04-11): HOLD AND WAIT — never auto-exit on a dispute.
// The NO-LOSE mantra applies; we flag and watch, we don't sell into a panic.
// The watcher's job is visibility, not automation.
//
// Mechanism:
//   1. Walk every distinct condition_id across all open positions (both prod
//      and R&D share this binary; each scoped by DB path).
//   2. For each, query Gamma /markets?condition_ids=X.
//   3. Parse umaResolutionStatus (and closed, for bonus dispute detection via
//      "resolved but we didn't see it" case).
//   4. UPDATE markets.uma_resolution_status via updateMarketMetadata.
//   5. If the status is newly non-empty and not "resolved", fire a Telegram
//      alert through TelegramAlerter. Deduplication is handled by the alerter
//      itself (5 min minimum between duplicates per dedup key).
//   6. If status is "resolved" but the position is still open, the on-chain
//      reconciler will pick it up next cycle — we don't force anything.
//
// Runs as a systemd oneshot service + hourly timer, same pattern as the
// long-tail backfill. Safe to run concurrently with the engine (read-only on
// positions, single-row updates on markets).

import { getAllOpenPositions } from '../storage/repositories/position-repo.js';
import {
  getMarketByCondition,
  updateMarketMetadata,
} from '../storage/repositories/market-repo.js';
import { TelegramAlerter } from '../metrics/alerter.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('uma-dispute-watcher');

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

export interface WatcherOptions {
  /** If true, log actions without writing to DB or alerting. */
  dryRun?: boolean;
  /** Gamma request timeout in ms. Default 15_000. */
  fetchTimeoutMs?: number;
  /** Delay between Gamma calls in ms (client-side rate limiting). Default 250. */
  requestDelayMs?: number;
  /** Optional alerter instance — if omitted, no alerts are sent. */
  alerter?: TelegramAlerter;
}

export interface WatcherResult {
  examined: number;
  updated: number;
  new_disputes: number;
  already_flagged: number;
  resolved_since_last_check: number;
  errors: Array<{ conditionId: string; error: string }>;
  disputes: Array<{
    conditionId: string;
    question: string;
    oldStatus: string;
    newStatus: string;
  }>;
}

// Classify a UMA status string. Anything that isn't empty and isn't
// "resolved" is a dispute/in-progress state we want visibility on.
function classifyStatus(status: string): 'empty' | 'resolved' | 'in_progress' {
  if (!status) return 'empty';
  const normalized = status.toLowerCase().trim();
  if (normalized === 'resolved' || normalized === 'settled') return 'resolved';
  return 'in_progress';
}

export async function runUmaDisputeWatcher(
  opts: WatcherOptions = {},
): Promise<WatcherResult> {
  const dryRun = opts.dryRun ?? false;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 15_000;
  const requestDelayMs = opts.requestDelayMs ?? 250;

  const result: WatcherResult = {
    examined: 0,
    updated: 0,
    new_disputes: 0,
    already_flagged: 0,
    resolved_since_last_check: 0,
    errors: [],
    disputes: [],
  };

  log.info({ dryRun }, 'Starting UMA dispute watcher');

  const positions = getAllOpenPositions();
  const uniqueConditions = new Set<string>();
  for (const p of positions) {
    uniqueConditions.add(p.condition_id);
  }
  result.examined = uniqueConditions.size;

  log.info({ positions: positions.length, unique_conditions: result.examined }, 'Scope determined');

  for (const cid of uniqueConditions) {
    try {
      const meta = await fetchGammaUmaStatus(cid, fetchTimeoutMs);
      if (meta === null) {
        result.errors.push({ conditionId: cid, error: 'gamma returned empty response' });
        continue;
      }

      const dbMarket = getMarketByCondition(cid);
      // dbMarket.uma_resolution_status may not exist on older rows — treat as empty
      const oldStatus = (dbMarket as unknown as { uma_resolution_status?: string })?.uma_resolution_status ?? '';
      const newStatus = meta.umaResolutionStatus;
      const oldClass = classifyStatus(oldStatus);
      const newClass = classifyStatus(newStatus);

      // Only write if actually changed (reduces DB churn + UPDATE noise in logs)
      if (oldStatus !== newStatus) {
        if (!dryRun) {
          updateMarketMetadata(cid, { uma_resolution_status: newStatus });
        }
        result.updated++;

        log.info(
          { cid: cid.substring(0, 16), old: oldStatus || '(empty)', new: newStatus || '(empty)', question: meta.question.substring(0, 60) },
          'UMA status changed',
        );

        // Fire alert ONLY on transition into in_progress (a new dispute)
        if (newClass === 'in_progress' && oldClass !== 'in_progress') {
          result.new_disputes++;
          result.disputes.push({
            conditionId: cid,
            question: meta.question,
            oldStatus,
            newStatus,
          });
          if (!dryRun && opts.alerter) {
            void opts.alerter.send({
              severity: 'warn',
              component: 'uma-watcher',
              title: `UMA dispute detected`,
              details: {
                market: meta.question.substring(0, 80),
                condition_id: cid,
                status: newStatus,
                policy: 'hold_and_wait',
              },
              runbook: 'No action required — policy is hold until resolution.',
            });
          }
        } else if (newClass === 'resolved' && oldClass === 'in_progress') {
          result.resolved_since_last_check++;
          if (!dryRun && opts.alerter) {
            void opts.alerter.send({
              severity: 'info',
              component: 'uma-watcher',
              title: `UMA dispute resolved`,
              details: {
                market: meta.question.substring(0, 80),
                condition_id: cid,
                previous: oldStatus,
              },
            });
          }
        }
      } else if (newClass === 'in_progress') {
        // Ongoing dispute, no change — just count it for the summary log
        result.already_flagged++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ cid: cid.substring(0, 16), err: msg }, 'UMA watcher failed for market');
      result.errors.push({ conditionId: cid, error: msg });
    }

    if (requestDelayMs > 0) await sleep(requestDelayMs);
  }

  log.info(
    {
      examined: result.examined,
      updated: result.updated,
      new_disputes: result.new_disputes,
      already_flagged: result.already_flagged,
      resolved: result.resolved_since_last_check,
      errors: result.errors.length,
    },
    'UMA watcher complete',
  );

  return result;
}

interface GammaUmaMetadata {
  umaResolutionStatus: string;
  question: string;
  closed: boolean;
}

async function fetchGammaUmaStatus(
  conditionId: string,
  timeoutMs: number,
): Promise<GammaUmaMetadata | null> {
  const url = `${GAMMA_BASE}/markets?condition_ids=${encodeURIComponent(conditionId)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Gamma returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as Array<{
    question?: string;
    umaResolutionStatus?: string | null;
    closed?: boolean;
  }>;
  if (!Array.isArray(body) || body.length === 0) return null;
  const m = body[0];
  return {
    umaResolutionStatus: (m.umaResolutionStatus ?? '').trim(),
    question: m.question ?? '',
    closed: m.closed ?? false,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
