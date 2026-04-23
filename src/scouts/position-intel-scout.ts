// Position-intel scout — 2026-04-21.
//
// Polls Polymarket Data API for whale-position changes (positions/holdings/OI)
// to surface conviction signals NOT available from on-chain trade events alone.
//
// Pattern: every 5 min, fetch /positions for each whitelisted whale wallet.
// Compare to last-snapshot. If a whale opened a NEW position with size >
// $1K OR doubled existing size on a low-prob outcome (price < 0.20),
// write a market_priorities row with priority 8 + an intel row carrying
// the wallet pseudonym + size + outcome.
//
// Extends our existing whale tracking which is event-based (OrderFilled
// log subscriber). This scout sees STATE changes — whale built a position
// over multiple small fills that didn't individually trip the size threshold,
// but cumulatively reached significant exposure.
//
// Read-only: queries data-api.polymarket.com (no auth) for proxy_address
// of each whitelisted whale. Rate-limited via 5-min interval and per-cycle
// concurrency cap.

import { ScoutBase, type ScoutRunResult } from './scout-base.js';
import type { MarketCache } from '../market/market-cache.js';
import { listActiveWhales } from '../storage/repositories/smart-money-repo.js';
import { insertPriority } from '../storage/repositories/market-priority-repo.js';
import { insertIntel } from '../storage/repositories/scout-intel-repo.js';
import { DataApiClient } from '../market/data-api-client.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('scout:position-intel');

const POLL_INTERVAL_MS = 5 * 60 * 1000;
const MAX_WHALES_PER_TICK = 5; // process at most 5 whales per coordinator tick (60s)
const NEW_POSITION_USD_THRESHOLD = 1_000;
const LOW_PROB_PRICE_THRESHOLD = 0.20; // longshot — high conviction signal
const PRIORITY_TTL_MS = 15 * 60 * 1000;

interface WhaleSnapshot {
  // map of asset_id (token_id) -> current size in USD
  positions: Map<string, { size_usd: number; price: number }>;
  fetched_at: number;
}

const snapshots = new Map<string, WhaleSnapshot>(); // proxy_address -> last snapshot

let inflightWallets = 0; // simple concurrency cap

export class PositionIntelScout extends ScoutBase {
  readonly id = 'position-intel-scout';
  readonly description = 'Detect whale position-state changes via Polymarket Data API (size builds, low-prob bets)';

  private dataApi: DataApiClient;
  private whaleQueue: string[] = []; // round-robin through whales over multiple ticks
  private lastFullCycleAt = 0;

  constructor() {
    super();
    this.log = createChildLogger('scout:' + this.id);
    this.dataApi = new DataApiClient('https://data-api.polymarket.com');
  }

  run(_marketCache: MarketCache): ScoutRunResult {
    const now = Date.now();

    // Rebuild whale queue if it's empty or POLL_INTERVAL has elapsed since last full cycle
    if (this.whaleQueue.length === 0 || (now - this.lastFullCycleAt > POLL_INTERVAL_MS)) {
      const whales = listActiveWhales();
      const wallets = whales.map(w => w.proxy_wallet).filter(Boolean) as string[];
      this.whaleQueue = wallets;
      this.lastFullCycleAt = now;
      this.log.debug({ queued: wallets.length }, 'Position-intel: refilled whale queue');
    }

    // Take top N from queue this tick
    const batch: string[] = [];
    while (batch.length < MAX_WHALES_PER_TICK && this.whaleQueue.length > 0) {
      const wallet = this.whaleQueue.shift();
      if (wallet) batch.push(wallet);
    }
    if (batch.length === 0) return this.emptyResult();

    // Fire off async work; return immediate result
    void this.processBatch(batch);

    return {
      scout_id: this.id,
      priorities_written: 0, // async; will be reported in next tick
      intel_written: 0,
      markets_evaluated: batch.length,
      summary: 'batch dispatched: ' + batch.length + ' whales',
    };
  }

  private async processBatch(wallets: string[]): Promise<void> {
    inflightWallets += wallets.length;
    let prioritiesWritten = 0;
    let intelWritten = 0;

    for (const wallet of wallets) {
      try {
        const positions = await this.dataApi.getAllPositions(wallet);
        const newSnapshot: WhaleSnapshot = {
          positions: new Map(),
          fetched_at: Date.now(),
        };

        for (const p of positions) {
          if (!p.asset || typeof p.currentValue !== 'number') continue;
          const size = Math.abs(Number(p.currentValue));
          const price = Number(p.curPrice);
          if (!Number.isFinite(price)) continue;
          newSnapshot.positions.set(p.asset, { size_usd: size, price });
        }

        // Diff against previous snapshot
        const prev = snapshots.get(wallet);
        if (prev) {
          for (const [token, cur] of newSnapshot.positions) {
            const old = prev.positions.get(token);
            const delta_usd = cur.size_usd - (old?.size_usd ?? 0);
            const isNew = !old;
            const doubled = old && cur.size_usd >= old.size_usd * 2 && delta_usd >= NEW_POSITION_USD_THRESHOLD / 2;
            const lowProb = cur.price > 0 && cur.price < LOW_PROB_PRICE_THRESHOLD;

            if ((isNew && cur.size_usd >= NEW_POSITION_USD_THRESHOLD) || doubled) {
              // Find the condition_id that matches this token. Without a
              // reliable token_id->condition_id map we rely on the position
              // record itself (Data API returns conditionId on each row).
              const conditionId = (positions.find(p => p.asset === token)?.conditionId) as string | undefined;
              if (!conditionId) continue;

              const reason = (isNew ? 'NEW' : 'DOUBLED') + ' whale position '
                + '$' + cur.size_usd.toFixed(0) + ' @ ' + cur.price.toFixed(3)
                + ' (wallet ' + wallet.substring(0, 10) + '...)' + (lowProb ? ' [LOW-PROB]' : '');
              const priority = lowProb ? 9 : 7;
              insertPriority({
                condition_id: conditionId,
                priority,
                reason,
                created_by: this.id,
                ttl_ms: PRIORITY_TTL_MS,
              });
              prioritiesWritten++;

              insertIntel({
                condition_id: conditionId,
                side: 'YES', // whale BUY = directional bet on token's outcome resolving YES
                conviction: lowProb ? 0.75 : 0.5,
                reason: reason + ' | ' + JSON.stringify({
                  wallet: wallet.substring(0, 10),
                  token: token.substring(0, 12),
                  size_usd: Math.round(cur.size_usd),
                  price: Number(cur.price.toFixed(3)),
                  prev_size_usd: Math.round(old?.size_usd ?? 0),
                  is_new: isNew,
                  doubled,
                  low_prob: lowProb,
                }),
                created_by: this.id,
                ttl_ms: PRIORITY_TTL_MS,
              });
              intelWritten++;
            }
          }
        }

        snapshots.set(wallet, newSnapshot);
      } catch (err) {
        this.log.debug({ wallet, err: err instanceof Error ? err.message : String(err) }, 'Position-intel: per-wallet fetch failed');
      } finally {
        inflightWallets--;
      }
    }

    if (prioritiesWritten > 0 || intelWritten > 0) {
      this.log.info({ priorities: prioritiesWritten, intel: intelWritten, wallets: wallets.length }, 'Position-intel findings');
    }
  }
}
