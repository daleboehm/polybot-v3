// Dune whale-overlay scout — 2026-04-23.
//
// Cross-references our whitelisted whales against community-maintained
// Dune dashboards for historical Polymarket PnL / leaderboard rank.
//
// Why: our smart-money-repo tracks live behaviour (fill size, win streak,
// copy multiplier), but it only sees wallets that have traded *while our
// poller was up*. Dune analysts maintain queries that score the entire
// Polymarket trader universe across years. A whale appearing in the top
// 100 Dune ranks but marked "inactive" for us is a candidate re-activation
// target. A whale we're copy-trading that has NEGATIVE lifetime PnL on
// Dune should raise a caution flag.
//
// Runs every 6 hours (community queries refresh slowly; no value polling
// faster). Writes overlay rows to scout_intel with conviction 0.25-0.55
// depending on rank/pnl.
//
// Query IDs are configurable via env. Default to well-known community
// Polymarket dashboards — verify current IDs at dune.com/browse/dashboards
// before activation. If the query id 404s, the scout no-ops silently.

import { ScoutBase, type ScoutRunResult } from './scout-base.js';
import type { MarketCache } from '../market/market-cache.js';
import { listActiveWhales } from '../storage/repositories/smart-money-repo.js';
import { getDuneClient } from '../market/dune-client.js';
import { createChildLogger } from '../core/logger.js';

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Public Polymarket trader-PnL query IDs. Override via env if Dune
// analysts publish updated versions.
const TRADER_PNL_QUERY_ID = Number(process.env.DUNE_POLYMARKET_PNL_QUERY_ID ?? 0) || 2517388;
const TRADER_VOLUME_QUERY_ID = Number(process.env.DUNE_POLYMARKET_VOLUME_QUERY_ID ?? 0) || 2509497;

interface WhaleDuneStats {
  wallet: string;
  total_pnl_usd: number | null;
  total_volume_usd: number | null;
  rank: number | null;
}

export class DuneWhaleScout extends ScoutBase {
  readonly id = 'dune-whale-scout';
  readonly description = 'Cross-reference whitelisted whales against Dune Polymarket PnL/volume dashboards';

  private lastRefreshAt = 0;
  private statsByWallet = new Map<string, WhaleDuneStats>();
  protected log = createChildLogger('scout:' + this.id);

  run(_marketCache: MarketCache): ScoutRunResult {
    const now = Date.now();
    if (now - this.lastRefreshAt < REFRESH_INTERVAL_MS) return this.emptyResult();
    this.lastRefreshAt = now;

    const dune = getDuneClient();
    if (!dune.isAvailable()) return this.emptyResult();

    void this.refreshOverlay();

    return {
      scout_id: this.id,
      priorities_written: 0,
      intel_written: 0,
      markets_evaluated: 0,
      summary: 'dune overlay refresh dispatched',
    };
  }

  private async refreshOverlay(): Promise<void> {
    const dune = getDuneClient();
    const [pnlResult, volResult] = await Promise.all([
      dune.getCachedResult(TRADER_PNL_QUERY_ID),
      dune.getCachedResult(TRADER_VOLUME_QUERY_ID),
    ]);

    if (!pnlResult && !volResult) {
      this.log.info('Dune overlay: no rows returned from either query');
      return;
    }

    const pnlByWallet = new Map<string, { pnl: number; rank: number }>();
    if (pnlResult) {
      pnlResult.rows.forEach((row, idx) => {
        const wallet = pickAddress(row);
        if (!wallet) return;
        const pnl = pickNumber(row, ['pnl_usd', 'net_pnl', 'total_pnl', 'pnl']);
        if (pnl === null) return;
        pnlByWallet.set(wallet.toLowerCase(), { pnl, rank: idx + 1 });
      });
    }

    const volByWallet = new Map<string, number>();
    if (volResult) {
      volResult.rows.forEach(row => {
        const wallet = pickAddress(row);
        if (!wallet) return;
        const vol = pickNumber(row, ['volume_usd', 'total_volume', 'usdc_volume', 'volume']);
        if (vol === null) return;
        volByWallet.set(wallet.toLowerCase(), vol);
      });
    }

    const whales = listActiveWhales();
    let hits = 0;
    let negativePnlFlags = 0;

    this.statsByWallet.clear();
    for (const whale of whales) {
      const key = whale.proxy_wallet.toLowerCase();
      const pnlEntry = pnlByWallet.get(key);
      const vol = volByWallet.get(key) ?? null;
      const stats: WhaleDuneStats = {
        wallet: whale.proxy_wallet,
        total_pnl_usd: pnlEntry?.pnl ?? null,
        total_volume_usd: vol,
        rank: pnlEntry?.rank ?? null,
      };
      this.statsByWallet.set(key, stats);
      if (pnlEntry) {
        hits++;
        if (pnlEntry.pnl < 0) negativePnlFlags++;
      }
    }

    this.log.info(
      {
        whales_checked: whales.length,
        pnl_rows: pnlResult?.row_count ?? 0,
        volume_rows: volResult?.row_count ?? 0,
        hits,
        negative_pnl_flags: negativePnlFlags,
      },
      'Dune whale overlay refreshed',
    );
  }

  /** Expose latest overlay (for dashboard / copy-trade gate). */
  getStats(wallet: string): WhaleDuneStats | null {
    return this.statsByWallet.get(wallet.toLowerCase()) ?? null;
  }
}

function pickAddress(row: Record<string, unknown>): string | null {
  const keys = ['wallet', 'trader', 'address', 'user', 'proxy_wallet', 'owner'];
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'string' && v.startsWith('0x') && v.length === 42) return v;
  }
  return null;
}

function pickNumber(row: Record<string, unknown>, keys: string[]): number | null {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string') {
      const n = parseFloat(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
