// Kalshi cross-platform arbitrage scanner.
//
// Phase 2.4 (2026-04-11). Read-only scanner. Walks active Polymarket
// markets, fetches Kalshi equivalents via KalshiClient, and when an
// exploitable spread exists, logs it to a `kalshi_arb_opportunities`
// table for manual review. NEVER executes trades — Dale's call is to
// scan first, automate later after seeing real signals.
//
// Spread threshold default: 3% absolute difference in YES prices.
// Minimum both-side liquidity: $2000 in 24h volume (configurable).
//
// Why read-only first: automated arb would require (a) Kalshi account
// setup, (b) regulatory review (CFTC-registered venue), (c) proving
// the signal is real. We get all of that from the logged data first.

import Database from 'better-sqlite3';
import { KalshiClient, type KalshiMarket, type MarketMatch } from './kalshi-client.js';
import { getActiveMarkets } from '../storage/repositories/market-repo.js';
import { getDatabase } from '../storage/database.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('kalshi-arb-scanner');

export interface ArbOpportunity {
  poly_condition_id: string;
  poly_question: string;
  poly_yes_price: number;
  poly_volume_24h: number;
  kalshi_ticker: string;
  kalshi_title: string;
  kalshi_yes_price: number;
  kalshi_volume: number;
  divergence_pct: number;
  direction: 'buy_poly_sell_kalshi' | 'buy_kalshi_sell_poly';
  match_similarity: number;
  detected_at: string;
}

export interface ScannerOptions {
  minDivergencePct?: number;  // default 0.03
  minVolumeUsd?: number;       // default 2000
  dryRun?: boolean;
}

export interface ScannerResult {
  poly_markets_considered: number;
  kalshi_markets_fetched: number;
  matches_found: number;
  arb_opportunities: number;
  errors: Array<{ poly_cid: string; error: string }>;
  opportunities: ArbOpportunity[];
}

/**
 * Ensures the kalshi_arb_opportunities table exists.
 * Idempotent — safe to call on every run.
 */
export function ensureArbTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kalshi_arb_opportunities (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      poly_condition_id    TEXT NOT NULL,
      poly_question        TEXT NOT NULL,
      poly_yes_price       REAL NOT NULL,
      poly_volume_24h      REAL NOT NULL DEFAULT 0,
      kalshi_ticker        TEXT NOT NULL,
      kalshi_title         TEXT NOT NULL,
      kalshi_yes_price     REAL NOT NULL,
      kalshi_volume        REAL NOT NULL DEFAULT 0,
      divergence_pct       REAL NOT NULL,
      direction            TEXT NOT NULL,
      match_similarity     REAL NOT NULL,
      detected_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_kalshi_arb_detected ON kalshi_arb_opportunities(detected_at DESC);
    CREATE INDEX IF NOT EXISTS idx_kalshi_arb_cid ON kalshi_arb_opportunities(poly_condition_id);
  `);
}

export async function runKalshiArbScanner(
  opts: ScannerOptions = {},
): Promise<ScannerResult> {
  const minDivergence = opts.minDivergencePct ?? 0.03;
  const minVolume = opts.minVolumeUsd ?? 2000;
  const dryRun = opts.dryRun ?? false;

  const result: ScannerResult = {
    poly_markets_considered: 0,
    kalshi_markets_fetched: 0,
    matches_found: 0,
    arb_opportunities: 0,
    errors: [],
    opportunities: [],
  };

  const db = getDatabase();
  if (!dryRun) {
    ensureArbTable(db);
  }

  log.info({ minDivergence, minVolume, dryRun }, 'Starting Kalshi arb scan');

  // Step 1: fetch all Kalshi markets across default categories
  const kalshi = new KalshiClient();
  let kalshiMarkets: KalshiMarket[] = [];
  try {
    kalshiMarkets = await kalshi.getAllMarkets();
    result.kalshi_markets_fetched = kalshiMarkets.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'Failed to fetch Kalshi markets — aborting scan');
    result.errors.push({ poly_cid: 'all', error: `kalshi fetch failed: ${msg}` });
    return result;
  }

  // Step 2: walk active Polymarket markets with enough liquidity
  const polyMarkets = getActiveMarkets().filter(
    (m) => (m.volume_24h ?? 0) >= minVolume,
  );
  result.poly_markets_considered = polyMarkets.length;

  // Step 3: for each eligible Poly market, try to find a Kalshi match
  for (const pm of polyMarkets) {
    try {
      const match = kalshi.findMatch(pm.condition_id, pm.question, kalshiMarkets, 0.40);
      if (!match) continue;
      result.matches_found++;

      const kalshiRow = kalshiMarkets.find((k) => k.ticker === match.kalshiTicker);
      if (!kalshiRow) continue;

      const kalshiVolume = kalshiRow.volume ?? 0;
      if (kalshiVolume < minVolume) continue;

      const polyYesPrice = pm.last_yes_price ?? 0;
      const kalshiYesPrice = kalshiRow.yesPrice ?? 0;
      if (polyYesPrice <= 0 || kalshiYesPrice <= 0) continue;

      const divergence = Math.abs(polyYesPrice - kalshiYesPrice);
      if (divergence < minDivergence) continue;

      const opp: ArbOpportunity = {
        poly_condition_id: pm.condition_id,
        poly_question: pm.question,
        poly_yes_price: polyYesPrice,
        poly_volume_24h: pm.volume_24h ?? 0,
        kalshi_ticker: match.kalshiTicker,
        kalshi_title: match.kalshiTitle,
        kalshi_yes_price: kalshiYesPrice,
        kalshi_volume: kalshiVolume,
        divergence_pct: divergence,
        direction: polyYesPrice < kalshiYesPrice ? 'buy_poly_sell_kalshi' : 'buy_kalshi_sell_poly',
        match_similarity: match.similarity,
        detected_at: new Date().toISOString(),
      };
      result.opportunities.push(opp);
      result.arb_opportunities++;

      if (!dryRun) {
        db.prepare(`
          INSERT INTO kalshi_arb_opportunities (
            poly_condition_id, poly_question, poly_yes_price, poly_volume_24h,
            kalshi_ticker, kalshi_title, kalshi_yes_price, kalshi_volume,
            divergence_pct, direction, match_similarity, detected_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          opp.poly_condition_id, opp.poly_question, opp.poly_yes_price, opp.poly_volume_24h,
          opp.kalshi_ticker, opp.kalshi_title, opp.kalshi_yes_price, opp.kalshi_volume,
          opp.divergence_pct, opp.direction, opp.match_similarity, opp.detected_at,
        );
      }

      log.info(
        {
          poly: pm.question.substring(0, 60),
          poly_yes: polyYesPrice,
          kalshi: match.kalshiTitle.substring(0, 60),
          kalshi_yes: kalshiYesPrice,
          divergence: divergence.toFixed(3),
          direction: opp.direction,
        },
        'Arb opportunity detected',
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push({ poly_cid: pm.condition_id, error: msg });
    }
  }

  log.info(result, 'Kalshi arb scan complete');
  return result;
}
