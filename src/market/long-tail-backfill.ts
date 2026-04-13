// Long-tail market metadata backfill
//
// Problem: the sampling-poller only fetches markets inside the CLOB sampling
// horizon (~30-60 days). Positions held in markets outside that window
// (political elections months away, UMA-stuck resolutions, etc.) never get
// their metadata refreshed in the `markets` table, so `end_date` stays NULL
// and the dashboard can't tell if they're overdue, live, or already resolved.
//
// This module is the dedicated janitor that keeps long-tail positions truthful:
//   1. Walks every open position (via getAllOpenPositions)
//   2. Filters to the ones whose joined market row is missing end_date, has
//      an end_date outside the sampling horizon, or doesn't exist at all
//      (the sampling poller will never touch any of these)
//   3. Queries Gamma /markets?condition_ids=X for each, extracts endDate (with
//      events[0].endDate fallback — long-dated political markets only carry
//      the date on the event, not the market), closed/active flags,
//      umaResolutionStatus, and clobTokenIds
//   4. UPSERTs the markets row with fresh metadata via updateMarketMetadata
//      (or insertMinimalMarket when the row was missing entirely)
//   5. If the market is genuinely resolved (Gamma reports closed=true or
//      umaResolutionStatus=='resolved'), marks it closed so the on-chain
//      reconciler can finalize it on its next cycle
//
// This is a COMPLEMENT to sampling-poller, not a replacement. The sampling
// poller stays lean and fast for trading-decision-relevant markets; this job
// runs infrequently (hourly via systemd timer) and only touches the handful
// of positions outside the sampling horizon.
//
// Deploy: systemd oneshot service + timer. Runs independently for prod and
// R&D so each hits its own DATABASE_PATH via WorkingDirectory.

import { getAllOpenPositions } from '../storage/repositories/position-repo.js';
import {
  getMarketByCondition,
  updateMarketMetadata,
  insertMinimalMarket,
  markMarketClosed,
} from '../storage/repositories/market-repo.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('long-tail-backfill');

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

export interface BackfillOptions {
  /** Sampling horizon in days. Positions with end_date inside this window are
   *  skipped because the sampling poller is responsible for them. Default 60. */
  horizonDays?: number;
  /** If true, log actions but don't write to the database. */
  dryRun?: boolean;
  /** Optional: restrict backfill to a single condition_id (useful for debugging). */
  onlyConditionId?: string;
  /** Gamma request timeout in ms. Default 15 000. */
  fetchTimeoutMs?: number;
  /** Delay between Gamma requests in ms (client-side rate limiting). Default 250. */
  requestDelayMs?: number;
}

export interface BackfillResult {
  examined: number;
  skipped_inside_horizon: number;
  skipped_already_closed: number;
  needed_backfill: number;
  updated: number;
  inserted_new: number;
  marked_closed: number;
  errors: Array<{ conditionId: string; error: string }>;
}

export async function runLongTailBackfill(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const horizonDays = opts.horizonDays ?? 60;
  const dryRun = opts.dryRun ?? false;
  const fetchTimeoutMs = opts.fetchTimeoutMs ?? 15_000;
  const requestDelayMs = opts.requestDelayMs ?? 250;

  const horizonCutoffMs = Date.now() + horizonDays * 24 * 60 * 60 * 1000;
  const horizonCutoffIso = new Date(horizonCutoffMs).toISOString();

  const result: BackfillResult = {
    examined: 0,
    skipped_inside_horizon: 0,
    skipped_already_closed: 0,
    needed_backfill: 0,
    updated: 0,
    inserted_new: 0,
    marked_closed: 0,
    errors: [],
  };

  log.info(
    { horizonDays, dryRun, horizonCutoff: horizonCutoffIso },
    'Starting long-tail backfill',
  );

  const positions = getAllOpenPositions();
  const uniqueConditions = new Set<string>();
  for (const p of positions) {
    if (opts.onlyConditionId && p.condition_id !== opts.onlyConditionId) continue;
    uniqueConditions.add(p.condition_id);
  }
  result.examined = uniqueConditions.size;

  const needsBackfill: string[] = [];
  for (const cid of uniqueConditions) {
    const market = getMarketByCondition(cid);

    // Case 1: no row → definitely backfill (also allows initial insert)
    if (!market) {
      needsBackfill.push(cid);
      continue;
    }

    // Case 2: row exists and is already closed → nothing to do
    if (market.closed === 1) {
      result.skipped_already_closed++;
      continue;
    }

    // Case 3: row exists but end_date is NULL → backfill
    if (!market.end_date) {
      needsBackfill.push(cid);
      continue;
    }

    // Case 4: end_date is unparseable → backfill
    const endDateMs = Date.parse(market.end_date);
    if (Number.isNaN(endDateMs)) {
      needsBackfill.push(cid);
      continue;
    }

    // Case 5: end_date is inside the sampling horizon → sampling-poller owns it
    if (endDateMs <= horizonCutoffMs) {
      result.skipped_inside_horizon++;
      continue;
    }

    // Case 6: end_date is outside the sampling horizon → we own it.
    // Refresh closed/active/umaResolutionStatus state in case UMA resolved
    // or Polymarket closed it behind our back.
    needsBackfill.push(cid);
  }
  result.needed_backfill = needsBackfill.length;

  log.info(
    {
      examined: result.examined,
      needs: result.needed_backfill,
      inside_horizon: result.skipped_inside_horizon,
      already_closed: result.skipped_already_closed,
    },
    'Backfill scope determined',
  );

  for (const cid of needsBackfill) {
    try {
      const meta = await fetchGammaMarketMetadata(cid, fetchTimeoutMs);
      if (!meta) {
        result.errors.push({ conditionId: cid, error: 'gamma returned empty response' });
        continue;
      }

      if (dryRun) {
        log.info({ cid, meta }, 'DRY RUN — would update');
      } else {
        const existing = getMarketByCondition(cid);
        if (existing) {
          updateMarketMetadata(cid, {
            end_date: meta.endDate,
            question: meta.question,
            market_slug: meta.slug,
            active: meta.active ? 1 : 0,
            closed: meta.closed ? 1 : 0,
          });
          result.updated++;
        } else {
          // Insert minimal row. Requires clobTokenIds from Gamma — without them
          // we can't satisfy the NOT NULL token_yes_id/token_no_id constraints.
          if (meta.clobTokenIds && meta.clobTokenIds.length === 2) {
            insertMinimalMarket({
              condition_id: cid,
              question: meta.question || '(unknown)',
              market_slug: meta.slug,
              end_date: meta.endDate,
              active: meta.active ? 1 : 0,
              closed: meta.closed ? 1 : 0,
              neg_risk: meta.negRisk ? 1 : 0,
              neg_risk_market_id: meta.negRiskMarketId,
              token_yes_id: meta.clobTokenIds[0],
              token_no_id: meta.clobTokenIds[1],
            });
            result.inserted_new++;
          } else {
            result.errors.push({
              conditionId: cid,
              error: 'no clobTokenIds from gamma, cannot insert minimal row',
            });
            continue;
          }
        }

        // If market is genuinely resolved, flip closed so the reconciler finalizes it.
        const isResolved =
          meta.closed === true ||
          (meta.umaResolutionStatus ?? '').toLowerCase() === 'resolved';
        if (isResolved) {
          markMarketClosed(cid);
          result.marked_closed++;
          log.info({ cid, umaStatus: meta.umaResolutionStatus }, 'Market marked closed');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ cid, err: msg }, 'Backfill failed for market');
      result.errors.push({ conditionId: cid, error: msg });
    }

    if (requestDelayMs > 0) await sleep(requestDelayMs);
  }

  log.info({ result }, 'Backfill complete');
  return result;
}

interface GammaMetadata {
  endDate: string;
  question: string;
  slug: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  negRisk: boolean;
  negRiskMarketId: string | null;
  clobTokenIds: string[] | null;
  umaResolutionStatus: string | null;
}

async function fetchGammaMarketMetadata(
  conditionId: string,
  timeoutMs: number,
): Promise<GammaMetadata | null> {
  const url = `${GAMMA_BASE}/markets?condition_ids=${encodeURIComponent(conditionId)}`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    throw new Error(`Gamma returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as GammaMarketRaw[];
  if (!Array.isArray(body) || body.length === 0) return null;
  const m = body[0];

  // Prefer market-level endDate, fall back to events[0].endDate. Long-dated
  // political markets (Nov 2026 elections) only carry the date on the event,
  // not the market, which is what made this whole problem visible.
  let endDate: string = m.endDate ?? '';
  if (!endDate && Array.isArray(m.events) && m.events.length > 0) {
    endDate = m.events[0]?.endDate ?? '';
  }

  // clobTokenIds is sometimes a JSON-encoded string, sometimes an array.
  let clobTokenIds: string[] | null = null;
  if (Array.isArray(m.clobTokenIds)) {
    clobTokenIds = m.clobTokenIds;
  } else if (typeof m.clobTokenIds === 'string') {
    try {
      const parsed = JSON.parse(m.clobTokenIds);
      if (Array.isArray(parsed)) clobTokenIds = parsed;
    } catch {
      /* ignore — leave as null */
    }
  }

  return {
    endDate,
    question: m.question ?? '',
    slug: m.slug ?? '',
    active: m.active ?? true,
    closed: m.closed ?? false,
    acceptingOrders: m.acceptingOrders ?? false,
    negRisk: m.negRisk ?? false,
    negRiskMarketId: m.negRiskMarketId ?? null,
    clobTokenIds,
    umaResolutionStatus: m.umaResolutionStatus ?? null,
  };
}

interface GammaMarketRaw {
  question?: string;
  slug?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  negRisk?: boolean;
  negRiskMarketId?: string | null;
  clobTokenIds?: string | string[] | null;
  umaResolutionStatus?: string | null;
  events?: Array<{ endDate?: string }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
