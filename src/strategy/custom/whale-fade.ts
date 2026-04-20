// Whale-fade strategy — 2026-04-20 (04-19 report Finding 7, arXiv 2603.03136).
//
// Thesis: October 2024 whale activity (>$30M single-direction bets) generated
// predictable counter-trading surges — ~72% of traders bought the SAME direction
// as the whale, temporarily mean-reverting the price. After the surge subsides,
// the market retraces back toward the whale's side. Fading the crowd (= taking
// the OPPOSITE side to the whale AFTER the surge) captures that reversion.
//
// Difference from whale-copy:
//   - whale-copy: copy the whale's side immediately (assumes whale has edge).
//   - whale-fade: take the OPPOSITE side after a delay (fade the counter-trading
//     crowd that piled on, not the whale themselves).
//
// Only fires on LARGE whale trades (>= WHALE_FADE_SIZE_THRESHOLD shares) where
// the counter-trading surge effect is most pronounced per the paper.
//
// Gate: WHALE_FADE_ENABLED=true. Default OFF. Paper-test R&D first. If both
// whale-copy and whale-fade are enabled, they will claim separate rows based
// on the size threshold — large trades get faded, small trades get copied
// (whale-copy ignores size, whale-fade requires >= threshold).

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal } from '../../types/index.js';
import { listActiveWhales, isDuplicateWhaleTrade } from '../../storage/repositories/smart-money-repo.js';
import { getDatabase } from '../../storage/database.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger('strategy:whale-fade');

const FEATURE_FLAG = 'WHALE_FADE_ENABLED';
// Size threshold for fade-eligibility. 1000 shares = ~$50-$1000 notional
// depending on price. Large enough to generate a counter-trading surge
// but small enough to catch regular large whale trades (not just $30M outliers).
const DEFAULT_SIZE_THRESHOLD = 1000;
// Delay before fading: let the counter-trading crowd pile in first. Paper
// 2603.03136 observed the surge-then-revert pattern resolves within minutes.
// 3 minutes = conservative entry after the crowd has mostly arrived.
const FADE_DELAY_MS = 3 * 60 * 1000;
// Only act on whale trades observed in the last N minutes (the signal decays).
const RECENT_WINDOW_MS = 15 * 60 * 1000;
const DEDUP_WINDOW_MS = 10 * 60 * 1000;

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

export class WhaleFadeStrategy extends BaseStrategy {
  readonly id = 'whale_fade';
  readonly name = 'Whale Fade';
  readonly description = 'Fade the counter-trading crowd that piles on after a large whale trade (arXiv 2603.03136)';
  readonly version = '1.0.0';

  override getSubStrategies(): string[] {
    return ['counter_surge'];
  }

  override shouldRun(_ctx: StrategyContext): boolean {
    return process.env[FEATURE_FLAG] === 'true';
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    if (process.env[FEATURE_FLAG] !== 'true') return [];

    const whales = listActiveWhales();
    if (whales.length === 0) return [];
    const whaleMap = new Map(whales.map(w => [w.proxy_wallet.toLowerCase(), w]));

    const sizeThreshold = Number(process.env.WHALE_FADE_SIZE_THRESHOLD ?? DEFAULT_SIZE_THRESHOLD);

    const signals: Signal[] = [];
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id),
    );

    // Pull recent large whale_trades observations that haven't been acted on.
    // We filter size >= sizeThreshold here so whale-copy (which ignores size)
    // doesn't double-claim small trades.
    const db = getDatabase();
    const windowStart = Date.now() - RECENT_WINDOW_MS;
    const delayCutoff = Date.now() - FADE_DELAY_MS;
    const rows = db
      .prepare(
        `SELECT id, proxy_wallet, condition_id, token_id, side, outcome, size, observed_at, tx_hash
         FROM whale_trades
         WHERE action = 'skipped_other'
           AND observed_at >= ?
           AND observed_at <= ?
           AND size >= ?
         ORDER BY observed_at DESC
         LIMIT 50`,
      )
      .all(windowStart, delayCutoff, sizeThreshold) as UnprocessedWhaleTrade[];

    if (rows.length === 0) return [];

    for (const row of rows) {
      const whale = whaleMap.get(row.proxy_wallet.toLowerCase());
      if (!whale) {
        this.markAction(row.id, 'skipped_not_whitelisted', 'wallet not in active whitelist');
        continue;
      }

      if (!row.condition_id || row.condition_id === '') {
        this.markAction(row.id, 'skipped_other', 'condition_id unresolved by subscriber');
        continue;
      }

      if (isDuplicateWhaleTrade(row.proxy_wallet, row.condition_id, row.token_id, DEDUP_WINDOW_MS)) {
        this.markAction(row.id, 'skipped_dedup', 'already processed within dedup window');
        continue;
      }

      if (existingPositions.has(row.condition_id)) {
        this.markAction(row.id, 'skipped_dedup', 'market already held by this entity');
        continue;
      }

      const market = ctx.getMarketData(row.condition_id);
      if (!market) {
        this.markAction(row.id, 'skipped_other', 'market not in cache');
        continue;
      }
      if (!market.active || market.closed) {
        this.markAction(row.id, 'skipped_other', 'market closed or inactive');
        continue;
      }

      // Determine the OPPOSITE side to the whale
      const whaleOutcome: 'YES' | 'NO' = row.outcome === 'NO' ? 'NO' : 'YES';
      const fadeOutcome: 'YES' | 'NO' = whaleOutcome === 'YES' ? 'NO' : 'YES';
      const tokenId = fadeOutcome === 'YES' ? market.token_yes_id : market.token_no_id;
      const marketPrice = fadeOutcome === 'YES' ? market.yes_price : market.no_price;

      if (!marketPrice || marketPrice <= 0 || marketPrice >= 1) {
        this.markAction(row.id, 'skipped_other', 'invalid fade-side market price');
        continue;
      }

      // Fade-side price gate: only fade when the counter-trading crowd has
      // moved OUR side (the fade side) meaningfully cheaper than 50/50. If
      // our side is still > 50¢, the crowd hasn't arrived yet and we have
      // no reversion to capture. If < 0.10, the tail is too thin.
      if (marketPrice > 0.48 || marketPrice < 0.10) {
        this.markAction(row.id, 'skipped_other', `fade-side price ${marketPrice.toFixed(3)} outside [0.10, 0.48]`);
        continue;
      }

      // Model probability: assume the true value is ~50/50 before the whale's
      // original move (the whale's entry price — which we don't know exactly —
      // approximated as 50¢). After the counter-trading surge, our side is
      // cheaper than the pre-surge fair value. Edge = deviation from the
      // "true" 50/50 anchor, haircut for uncertainty (we don't know the whale's
      // actual entry).
      const assumedFair = 0.50;
      const edge = Math.max(0, assumedFair - marketPrice - 0.05); // 5% haircut for uncertainty
      if (edge < 0.03) {
        this.markAction(row.id, 'skipped_other', `fade edge ${edge.toFixed(3)} below 3% floor`);
        continue;
      }

      const modelProb = marketPrice + edge; // e.g. fade side at 0.30 → modelProb 0.42

      signals.push({
        signal_id: nanoid(),
        entity_slug: ctx.entity.config.slug,
        strategy_id: this.id,
        sub_strategy_id: 'counter_surge',
        condition_id: row.condition_id,
        token_id: tokenId,
        side: 'BUY',
        outcome: fadeOutcome,
        strength: 0.60,
        edge,
        model_prob: modelProb,
        market_price: marketPrice,
        recommended_size_usd: 4, // smaller than copy — thesis-heavy, reversion not guaranteed
        metadata: {
          question: market.question,
          sub_strategy: 'counter_surge',
          whale_wallet: row.proxy_wallet,
          whale_pseudonym: whale.pseudonym,
          whale_size: row.size,
          whale_outcome: whaleOutcome,
          fade_outcome: fadeOutcome,
          whale_tx: row.tx_hash,
          minutes_since_whale: Math.round((Date.now() - row.observed_at) / 60000),
        },
        created_at: new Date(),
      });

      this.markAction(row.id, 'copied', `whale_fade fading ${whaleOutcome} from ${whale.pseudonym ?? row.proxy_wallet.substring(0, 10)} (size=${row.size})`);
    }

    if (signals.length > 0) {
      log.info({ count: signals.length, size_threshold: sizeThreshold }, 'Whale-fade signals generated');
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
