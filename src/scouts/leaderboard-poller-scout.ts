// LeaderboardPollerScout — Phase C (2026-04-11), STAGED.
//
// The single highest-leverage whale detection signal we found across all
// six research agents: Polymarket publishes a public leaderboard at
// `data-api.polymarket.com/leaderboards?window=week`. Fredi9999 and the
// other election-2024 whales weren't detected via on-chain sleuthing —
// media scrutiny followed leaderboard rank.
//
// This scout hits that endpoint every ~10 minutes and upserts candidates
// into a `smart_money_candidates` table. A nightly filter job (separate
// module, Phase C2) will then evaluate each candidate against the
// Bravado Trade 4-threshold filter:
//
//   1. ≥200 settled markets (sample size floor)
//   2. ≥65% win rate
//   3. Varied position sizing (uniform = wash/leaderboard-farming)
//   4. Cross-category (single-topic = news-driven, not edge)
//
// Survivors get promoted to `whitelisted_whales` and — in Phase F4 — the
// on-chain whale tracker will alert on their `OrderFilled` events for
// copy-trade candidate generation.
//
// This scout is scaffold-only. It is NOT registered in the coordinator
// yet. Deploy path:
//   1. Create tables (SQL migration — NOT included here; do in a later commit)
//   2. Register in scout-coordinator.ts `registerDefaultScouts()`
//   3. Wire through config (default disabled until table exists)
//
// IMPORTANT: This file is committed for review and typecheck only. It is
// not imported anywhere. Activating it requires the table migration AND
// the coordinator registration AND a config flag.

import type { MarketCache } from '../market/market-cache.js';
import { ScoutBase, type ScoutRunResult } from './scout-base.js';
import { createChildLogger } from '../core/logger.js';

const LEADERBOARD_URL = 'https://data-api.polymarket.com/leaderboards?window=week';
const MIN_POLL_INTERVAL_MS = 10 * 60 * 1000; // 10 min — avoid hammering

export interface LeaderboardEntry {
  proxyWallet: string;
  pseudonym: string | null;
  amount: number;           // weekly profit in USD
  pnl: number;              // all-time realized PnL
  volume: number;           // total volume transacted
}

/**
 * Raw shape returned by the Polymarket leaderboards API. We only care
 * about a subset of fields; the rest are ignored.
 */
interface RawLeaderboardEntry {
  proxyWallet?: string;
  pseudonym?: string;
  amount?: number | string;
  pnl?: number | string;
  volume?: number | string;
}

export class LeaderboardPollerScout extends ScoutBase {
  readonly id = 'leaderboard-poller-scout';
  readonly description =
    'Polls data-api.polymarket.com/leaderboards every 10 min and upserts whale candidates';

  private lastPollAt = 0;

  constructor() {
    super();
    this.log = createChildLogger(`scout:${this.id}`);
  }

  /**
   * Synchronous run() is the wrong shape for this scout because it has
   * to do an HTTP round-trip. The ScoutBase.run() signature returns
   * ScoutRunResult directly, but we fire-and-forget the async work and
   * return an immediate empty result. When the async work completes it
   * logs separately.
   *
   * This is acceptable because:
   *   1. Scouts run on a 60s timer; a 2-3s fetch is fine async
   *   2. The coordinator doesn't aggregate return values for timing
   *   3. A failed fetch should NOT halt the whole scout tick
   */
  run(_marketCache: MarketCache): ScoutRunResult {
    const now = Date.now();
    if (now - this.lastPollAt < MIN_POLL_INTERVAL_MS) {
      // Respect minimum poll interval — the coordinator runs us every 60s
      // but the leaderboard doesn't change that fast.
      return this.emptyResult();
    }
    this.lastPollAt = now;

    // Fire-and-forget the async fetch. Errors are swallowed via the
    // internal catch — they go to logs but never bubble up to the
    // coordinator.
    void this.pollAsync();

    return this.emptyResult();
  }

  private async pollAsync(): Promise<void> {
    try {
      const response = await fetch(LEADERBOARD_URL, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        this.log.warn({ status: response.status }, 'Leaderboard fetch failed');
        return;
      }
      const raw = (await response.json()) as unknown;
      const entries = this.parseEntries(raw);
      if (entries.length === 0) {
        this.log.debug('Leaderboard returned zero entries');
        return;
      }

      // STAGED: upsert to smart_money_candidates table.
      // When Phase C1 tables are created, this will be:
      //   upsertCandidate({proxyWallet, pseudonym, weekly_profit_usd, ...})
      // For now we just log.
      this.log.info(
        {
          entries: entries.length,
          top_wallet: entries[0]?.proxyWallet?.substring(0, 12) ?? null,
          top_amount: entries[0]?.amount ?? null,
        },
        'Leaderboard polled (STAGED — upsert not yet wired)',
      );
    } catch (err) {
      this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Leaderboard poll error');
    }
  }

  /**
   * Parse the raw API response into a typed list. Drops rows missing
   * proxyWallet or amount. Clamps numeric fields.
   */
  private parseEntries(raw: unknown): LeaderboardEntry[] {
    if (!Array.isArray(raw)) return [];
    const out: LeaderboardEntry[] = [];
    for (const row of raw) {
      if (!row || typeof row !== 'object') continue;
      const r = row as RawLeaderboardEntry;
      if (!r.proxyWallet || typeof r.proxyWallet !== 'string') continue;

      const amount = typeof r.amount === 'string' ? parseFloat(r.amount) : r.amount ?? 0;
      const pnl = typeof r.pnl === 'string' ? parseFloat(r.pnl) : r.pnl ?? 0;
      const volume = typeof r.volume === 'string' ? parseFloat(r.volume) : r.volume ?? 0;

      out.push({
        proxyWallet: r.proxyWallet,
        pseudonym: r.pseudonym ?? null,
        amount: Number.isFinite(amount) ? amount : 0,
        pnl: Number.isFinite(pnl) ? pnl : 0,
        volume: Number.isFinite(volume) ? volume : 0,
      });
    }
    // Sort by weekly profit descending so downstream consumers see the
    // hottest wallets first.
    out.sort((a, b) => b.amount - a.amount);
    return out;
  }
}
