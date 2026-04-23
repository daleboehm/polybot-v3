// Subgraph whale-overlay scout — 2026-04-23.
//
// Uses the Polymarket Goldsky pnl-subgraph to score every whitelisted
// whale on LIFETIME realized PnL. This replaces dune-whale-scout as the
// primary whale-quality gate because the subgraph data is:
//   - real-time (refreshes every few minutes vs Dune's manual cadence)
//   - free (no credit cost per query)
//   - directly queryable per-wallet (no shared dashboard dependency)
//
// Rules of the overlay (cheap, read-only):
//   - Whales with NEGATIVE lifetime realized PnL -> flag for review
//     (not auto-demoted; logged so we can manually prune the whitelist)
//   - Whales with top-quintile PnL and active open positions ->
//     higher conviction on future copy-trades
//   - Previously-inactive whales whose subgraph PnL has grown in the
//     last 24h are re-surfaced for consideration
//
// Runs every 4h. Does NOT write priorities or intel rows itself — it
// stamps a stats map that other scouts (smart-money, copy-trader) can
// consult via getSubgraphWhaleStats().

import { ScoutBase, type ScoutRunResult } from './scout-base.js';
import type { MarketCache } from '../market/market-cache.js';
import { listActiveWhales } from '../storage/repositories/smart-money-repo.js';
import { getUserPnlSummary, isSubgraphAvailable, type UserPnlSummary } from '../market/polymarket-subgraph.js';
import { createChildLogger } from '../core/logger.js';

const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;

const statsByWallet = new Map<string, UserPnlSummary>();

export function getSubgraphWhaleStats(wallet: string): UserPnlSummary | null {
  return statsByWallet.get(wallet.toLowerCase()) ?? null;
}

export class SubgraphWhaleScout extends ScoutBase {
  readonly id = 'subgraph-whale-scout';
  readonly description = 'Lifetime PnL overlay for whitelisted whales via Polymarket Goldsky pnl-subgraph';

  private lastRefreshAt = 0;
  protected log = createChildLogger('scout:' + this.id);

  run(_marketCache: MarketCache): ScoutRunResult {
    const now = Date.now();
    if (now - this.lastRefreshAt < REFRESH_INTERVAL_MS) return this.emptyResult();
    this.lastRefreshAt = now;

    if (!isSubgraphAvailable()) {
      this.log.debug('GOLDSKY_TOKEN missing — subgraph scout skipped');
      return this.emptyResult();
    }

    void this.refreshOverlay();
    return {
      scout_id: this.id,
      priorities_written: 0,
      intel_written: 0,
      markets_evaluated: 0,
      summary: 'subgraph overlay refresh dispatched',
    };
  }

  private async refreshOverlay(): Promise<void> {
    const whales = listActiveWhales();
    if (whales.length === 0) {
      this.log.info('no whitelisted whales — overlay skipped');
      return;
    }

    // Throttled sequential fetch: 10 concurrent, one query per whale
    const BATCH = 10;
    let negative_pnl = 0;
    let positive_pnl = 0;
    let missing = 0;
    let best: UserPnlSummary | null = null;
    let worst: UserPnlSummary | null = null;

    for (let i = 0; i < whales.length; i += BATCH) {
      const chunk = whales.slice(i, i + BATCH);
      const results = await Promise.all(chunk.map(w => getUserPnlSummary(w.proxy_wallet)));
      for (let j = 0; j < chunk.length; j++) {
        const summary = results[j];
        if (!summary) { missing++; continue; }
        statsByWallet.set(chunk[j].proxy_wallet.toLowerCase(), summary);
        if (summary.realized_pnl_usd >= 0) positive_pnl++; else negative_pnl++;
        if (!best || summary.realized_pnl_usd > best.realized_pnl_usd) best = summary;
        if (!worst || summary.realized_pnl_usd < worst.realized_pnl_usd) worst = summary;
      }
    }

    this.log.info(
      {
        whales_checked: whales.length,
        positive_pnl,
        negative_pnl,
        missing,
        best_wallet: best?.wallet ?? null,
        best_pnl_usd: best ? Math.round(best.realized_pnl_usd) : null,
        worst_wallet: worst?.wallet ?? null,
        worst_pnl_usd: worst ? Math.round(worst.realized_pnl_usd) : null,
      },
      'Subgraph whale overlay refreshed',
    );

    // Emit a warn line for any negative-PnL whitelisted whales so operators see it.
    for (const [wallet, summary] of statsByWallet) {
      if (summary.realized_pnl_usd < 0) {
        this.log.warn(
          { wallet, realized_pnl_usd: Math.round(summary.realized_pnl_usd), roi: summary.roi },
          'Whitelisted whale shows NEGATIVE lifetime PnL per subgraph',
        );
      }
    }
  }
}
