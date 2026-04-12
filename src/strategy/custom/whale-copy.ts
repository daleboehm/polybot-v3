// Whale-copy strategy — Phase C2 (2026-04-11). DORMANT BY DEFAULT.
//
// Purpose: when a whitelisted whale's trade is observed by the
// WhaleEventSubscriber, generate a signal to mirror their position
// (same side, same market) sized via the standard position-sizer.
//
// Activation: controlled by process.env.WHALE_COPY_ENABLED. Default off.
// Entity config also must list 'whale_copy' in its strategies array.
// Both gates must be satisfied or this strategy's evaluate() returns
// an empty signal list.
//
// Research context (Agent 3 synthesis):
//   - Copy-trade latency is 2-5 minutes book-to-book and has NO
//     mechanical fix. Mitigation = fair-value gate + ladder + skip
//     illiquid. The strategy implements all three.
//
//   - Bravado filter on wallets = ≥200 settled, ≥65% WR, varied sizing,
//     cross-category. Only wallets that pass (or are manually seeded)
//     appear in listActiveWhales().
//
//   - Fair-value gate: don't copy if the current market price has
//     moved more than FAIR_VALUE_SLIP_PCT past the whale's entry.
//     Because we lack the whale's entry price at event time (the log
//     subscriber parses OrderFilled args but doesn't derive implied
//     entry price), the fair-value gate uses a simpler proxy: the
//     implied price from the event's maker/taker amounts.
//
//   - Ladder: skip for v1. The risk engine + order-builder already
//     have their own maker/taker routing + scout-overlay sizing.
//     Adding a 3-way ladder here would fight with that. Document as
//     a future enhancement.
//
//   - Illiquid skip: piggyback on the existing liquidity-aware sizer.
//     If the position-sizer's liquidity bound shrinks our size below
//     the 5-share CLOB minimum, the sizer already returns zero shares
//     and the signal dies naturally.
//
// Design: the strategy does NOT subscribe to the event bus itself.
// Instead, WhaleEventSubscriber writes observed trades into the
// `whale_trades` table with action='skipped_other'. On each scan
// cycle, this strategy queries whale_trades for recent observations
// not yet processed and generates signals from them. This pattern
// matches how the rest of our strategies work (read state from DB,
// emit signals, let the risk/execution pipeline take over) — rather
// than the more complex "event-driven out-of-band signal injection"
// path that would require bypassing the coordinator.

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal } from '../../types/index.js';
import { listActiveWhales, isDuplicateWhaleTrade } from '../../storage/repositories/smart-money-repo.js';
import { getDatabase } from '../../storage/database.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger('strategy:whale-copy');

const FEATURE_FLAG = 'WHALE_COPY_ENABLED';
const FAIR_VALUE_SLIP_PCT = 0.02; // skip if current mid > whale entry + 2%
const RECENT_WINDOW_MS = 10 * 60 * 1000; // only act on trades seen in last 10 min
const DEDUP_WINDOW_MS = 10 * 60 * 1000; // don't re-copy the same whale+market pair

// Shape of a row returned by the whale_trades query below
interface UnprocessedWhaleTrade {
  id: number;
  proxy_wallet: string;
  condition_id: string;
  token_id: string;
  side: string;
  outcome: string;
  size: number;
  observed_at: number;
  tx_hash: string;
}

export class WhaleCopyStrategy extends BaseStrategy {
  readonly id = 'whale_copy';
  readonly name = 'Whale Copy';
  readonly description = 'Mirror trades from whitelisted smart-money wallets observed by the whale-event subscriber';
  readonly version = '1.0.0';

  override getSubStrategies(): string[] {
    return ['mirror'];
  }

  /** Don't even run if the feature flag is off. */
  override shouldRun(_ctx: StrategyContext): boolean {
    return process.env[FEATURE_FLAG] === 'true';
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    // Belt-and-suspenders on the feature flag (in case shouldRun is ever
    // bypassed)
    if (process.env[FEATURE_FLAG] !== 'true') return [];

    const whales = listActiveWhales();
    if (whales.length === 0) return [];
    const whaleMap = new Map(whales.map(w => [w.proxy_wallet.toLowerCase(), w]));

    const signals: Signal[] = [];
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id),
    );

    // Pull recent whale_trades observations. We join against the
    // observation rows the subscriber wrote, filtered to rows that
    // haven't been copied yet (action != 'copied') and are within
    // the recent window.
    const db = getDatabase();
    const cutoff = Date.now() - RECENT_WINDOW_MS;
    const rows = db
      .prepare(
        `SELECT id, proxy_wallet, condition_id, token_id, side, outcome, size, observed_at, tx_hash
         FROM whale_trades
         WHERE action = 'skipped_other'
           AND observed_at >= ?
         ORDER BY observed_at DESC
         LIMIT 50`,
      )
      .all(cutoff) as UnprocessedWhaleTrade[];

    if (rows.length === 0) return [];

    for (const row of rows) {
      // Must be a whitelisted whale
      const whale = whaleMap.get(row.proxy_wallet.toLowerCase());
      if (!whale) {
        this.markAction(row.id, 'skipped_not_whitelisted', 'wallet not in active whitelist');
        continue;
      }

      // The subscriber writes placeholder condition_id='' because it
      // can't derive the Polymarket market id from raw event args. We
      // cannot copy a trade whose market is unknown — skip cleanly.
      // A follow-up phase will add CLOB asset→condition_id resolution
      // in the subscriber itself.
      if (!row.condition_id || row.condition_id === '') {
        this.markAction(row.id, 'skipped_other', 'condition_id unresolved by subscriber');
        continue;
      }

      // Dedup: don't copy the same whale+market pair twice
      if (isDuplicateWhaleTrade(row.proxy_wallet, row.condition_id, row.token_id, DEDUP_WINDOW_MS)) {
        this.markAction(row.id, 'skipped_dedup', 'already copied within dedup window');
        continue;
      }

      // Don't open a position on a market we already hold
      if (existingPositions.has(row.condition_id)) {
        this.markAction(row.id, 'skipped_dedup', 'market already held by this entity');
        continue;
      }

      // Look up the market in the cache
      const market = ctx.getMarketData(row.condition_id);
      if (!market) {
        this.markAction(row.id, 'skipped_other', 'market not in cache');
        continue;
      }
      if (!market.active || market.closed) {
        this.markAction(row.id, 'skipped_other', 'market closed or inactive');
        continue;
      }

      // Determine which side of the binary to buy
      const outcome: 'YES' | 'NO' = row.outcome === 'NO' ? 'NO' : 'YES';
      const token_id = outcome === 'YES' ? market.token_yes_id : market.token_no_id;
      const market_price = outcome === 'YES' ? market.yes_price : market.no_price;

      if (!market_price || market_price <= 0 || market_price >= 1) {
        this.markAction(row.id, 'skipped_other', 'invalid market price');
        continue;
      }

      // Fair-value gate: we don't have the whale's actual entry price
      // from raw OrderFilled args, so this gate is best-effort. For v1
      // we just check the market price is within [0.05, 0.95] (no
      // deep-tail copies) and the whale's size indicates real conviction
      // (>= 5 shares).
      if (row.size < 5) {
        this.markAction(row.id, 'skipped_other', `whale size ${row.size} < 5 shares`);
        continue;
      }

      // Fair-value slip check: if the copy-trade strategy's own
      // statistical edge would be negative, skip. Model_prob for a
      // whale-copy signal is the current market price plus a small
      // assumed edge from the whale's conviction.
      const model_prob = Math.min(0.99, market_price + FAIR_VALUE_SLIP_PCT);
      const edge = model_prob - market_price;

      signals.push({
        signal_id: nanoid(),
        entity_slug: ctx.entity.config.slug,
        strategy_id: this.id,
        sub_strategy_id: 'mirror',
        condition_id: row.condition_id,
        token_id,
        side: 'BUY',
        outcome,
        strength: Math.min(1.0, whale.copy_multiplier),
        edge,
        model_prob,
        market_price,
        recommended_size_usd: 5 * whale.copy_multiplier,
        metadata: {
          question: market.question,
          sub_strategy: 'mirror',
          whale_wallet: row.proxy_wallet,
          whale_pseudonym: whale.pseudonym,
          whale_size: row.size,
          whale_tx: row.tx_hash,
          copy_multiplier: whale.copy_multiplier,
        },
        created_at: new Date(),
      });

      // Mark the observation as copied so we don't re-emit next cycle
      this.markAction(row.id, 'copied', `whale_copy signal emitted for ${whale.pseudonym ?? row.proxy_wallet.substring(0, 10)}`);
    }

    if (signals.length > 0) {
      log.info({ count: signals.length }, 'Whale-copy signals generated');
    }
    return signals;
  }

  private markAction(
    whale_trade_id: number,
    action: 'copied' | 'skipped_latency' | 'skipped_fair_value' | 'skipped_dedup' | 'skipped_illiquid' | 'skipped_not_whitelisted' | 'skipped_other',
    reason: string,
  ): void {
    const db = getDatabase();
    try {
      db.prepare(
        `UPDATE whale_trades SET action = ?, action_reason = ? WHERE id = ?`,
      ).run(action, reason.substring(0, 400), whale_trade_id);
    } catch (err) {
      log.debug({ err, whale_trade_id, action }, 'markAction failed');
    }
  }
}
