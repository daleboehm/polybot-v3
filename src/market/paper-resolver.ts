// Paper position resolver — closes resolved paper positions, credits cash, writes resolutions.
//
// Context (2026-04-10):
// The on-chain reconciler (src/market/on-chain-reconciler.ts) is live-mode only: it queries
// the Polymarket Data API against an entity's proxy wallet and matches DB positions to
// active/resolved on-chain positions. Paper-mode entities have no proxy wallet, so the
// reconciler skips them entirely. Without this file, paper positions open but never close,
// which means:
//   - no resolutions ever get written
//   - v_strategy_performance view never fills in wins/losses/realized_pnl
//   - strategy-advisor has zero data to compute Wilson lower bounds
//   - strategy-weighter never adjusts sub-strategy weights based on performance
// In short: no learn-and-evolve loop.
//
// This file closes that gap by polling the Polymarket CLOB `/markets/{condition_id}`
// endpoint for open paper positions whose market's end_date is near/past. The CLOB
// response includes `closed: boolean` and `tokens[].winner: boolean`, which is enough
// to compute payout and realized P&L for a paper fill.
//
// Why CLOB and not Gamma: Gamma's `/markets?condition_ids=X` accepts the plural param
// but quirky edge cases make single-market lookups on CLOB cleaner. CLOB returns a
// full `CLOBMarket` matching the rest of the codebase's type expectations.
//
// Cadence: called from the engine's scan cycle (every `scan_interval_ms`). Paper
// positions are filtered by `is_paper === 1` and by `market_end_date` being within
// the `[-24h, +1h]` window (catches early resolutions, skips positions still far
// from expiry to avoid unnecessary API calls). Non-paper positions are ignored —
// live resolution remains the reconciler's job.

import { getAllOpenPositions, closePosition } from '../storage/repositories/position-repo.js';
import { insertResolution } from '../storage/repositories/resolution-repo.js';
import type { EntityManager } from '../entity/entity-manager.js';
import type { DailyLossGuard } from '../risk/daily-loss-guard.js';
import type { Outcome } from '../types/index.js';
import { eventBus } from '../core/event-bus.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('paper-resolver');

const CLOB_BASE = 'https://clob.polymarket.com';
// Positions whose market end_date is in this window get checked each cycle.
// Start of window is deliberately generous (-24h) to catch markets that expired
// while the engine was stopped. End of window (+1h) catches early resolutions.
const WINDOW_START_MS = -24 * 60 * 60 * 1000;
const WINDOW_END_MS = 1 * 60 * 60 * 1000;

interface ClobMarketResponse {
  condition_id?: string;
  active?: boolean;
  closed?: boolean;
  tokens?: Array<{
    token_id: string;
    outcome?: string;
    price?: number;
    winner?: boolean;
  }>;
}

export interface PaperResolutionResult {
  scanned: number;      // open paper positions seen
  checked: number;      // positions inside the expiry window (CLOB call attempted)
  resolved: number;     // successfully closed
  errors: string[];
}

export class PaperResolver {
  constructor(
    private readonly entityManager: EntityManager,
    private readonly dailyLossGuard: DailyLossGuard,
    private readonly tradingRatio: number,
  ) {}

  async check(): Promise<PaperResolutionResult> {
    const result: PaperResolutionResult = { scanned: 0, checked: 0, resolved: 0, errors: [] };

    const allOpen = getAllOpenPositions();
    const paperOpen = allOpen.filter(p => p.is_paper === 1);
    result.scanned = paperOpen.length;
    if (paperOpen.length === 0) return result;

    const now = Date.now();

    // Filter to positions whose market end_date is within the expiry window.
    // Positions without an end_date are checked too (unknown expiry → treat as worth checking).
    const candidates = paperOpen.filter(pos => {
      if (!pos.market_end_date) return true;
      const endMs = new Date(pos.market_end_date).getTime();
      if (Number.isNaN(endMs)) return true;
      const delta = endMs - now;
      return delta >= WINDOW_START_MS && delta <= WINDOW_END_MS;
    });
    result.checked = candidates.length;
    if (candidates.length === 0) return result;

    // Dedupe by condition_id — multiple positions may share the same market
    // (different token_id for YES/NO or different entities).
    const uniqueConditions = [...new Set(candidates.map(p => p.condition_id))];

    // Map condition_id → resolved state (or null if unresolved/unreachable)
    const resolvedMap = new Map<string, { closed: boolean; winnerTokenId?: string }>();

    for (const cid of uniqueConditions) {
      try {
        const resp = await fetch(`${CLOB_BASE}/markets/${cid}`, {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) {
          if (resp.status === 404) {
            // Market doesn't exist (very old / purged). Mark closed with no winner
            // so the position gets closed with payout=0 rather than hanging forever.
            resolvedMap.set(cid, { closed: true, winnerTokenId: undefined });
          } else {
            result.errors.push(`clob ${cid.substring(0, 10)}…: ${resp.status}`);
          }
          continue;
        }
        const data = (await resp.json()) as ClobMarketResponse;
        if (!data.closed) {
          resolvedMap.set(cid, { closed: false });
          continue;
        }
        // Market is closed — find the winning token if CLOB has flagged one.
        const winnerToken = data.tokens?.find(t => t.winner === true);
        resolvedMap.set(cid, {
          closed: true,
          winnerTokenId: winnerToken?.token_id,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`clob ${cid.substring(0, 10)}…: ${msg}`);
      }
    }

    // Process each candidate position against the resolved map
    for (const pos of candidates) {
      const resolved = resolvedMap.get(pos.condition_id);
      if (!resolved || !resolved.closed) continue;

      // Payout: 1 USDC per share if this position's token won, else 0.
      // If CLOB didn't flag any winner (ambiguous state), payout = 0 (position is
      // closed as a loss rather than left hanging).
      const didWin = resolved.winnerTokenId !== undefined && resolved.winnerTokenId === pos.token_id;
      const payout = didWin ? pos.size : 0;
      const realizedPnl = payout - pos.cost_basis;
      const winningOutcome: Outcome = didWin
        ? (pos.side as Outcome)
        : pos.side === 'YES'
          ? ('NO' as Outcome)
          : ('YES' as Outcome);

      try {
        insertResolution({
          entity_slug: pos.entity_slug,
          condition_id: pos.condition_id,
          token_id: pos.token_id,
          winning_outcome: winningOutcome,
          position_side: pos.side as Outcome,
          size: pos.size,
          payout_usdc: payout,
          cost_basis_usdc: pos.cost_basis,
          sell_proceeds_usdc: 0,
          realized_pnl: realizedPnl,
          is_paper: true,
          strategy_id: pos.strategy_id ?? '',
          sub_strategy_id: pos.sub_strategy_id ?? undefined,
          market_question: pos.market_question ?? '',
          market_slug: pos.market_slug ?? '',
          tx_hash: null,
          resolved_at: new Date(),
        });

        closePosition(pos.entity_slug, pos.condition_id, pos.token_id, 'resolved');

        // Credit cash back to the entity (payout > 0 only increases cash;
        // payout = 0 still closes the DB row without crediting).
        const entity = this.entityManager.getEntity(pos.entity_slug);
        if (entity && payout > 0) {
          const newCash = entity.cash_balance + payout;
          this.entityManager.updateBalances(
            pos.entity_slug,
            newCash,
            entity.reserve_balance,
            newCash * this.tradingRatio,
          );
        }

        // Daily loss guard sees realized P&L (can be negative).
        this.dailyLossGuard.recordPnl(pos.entity_slug, realizedPnl);

        eventBus.emit('position:resolved', {
          resolution: {
            entity_slug: pos.entity_slug,
            condition_id: pos.condition_id,
            token_id: pos.token_id,
            winning_outcome: winningOutcome,
            position_side: pos.side as Outcome,
            size: pos.size,
            payout_usdc: payout,
            cost_basis_usdc: pos.cost_basis,
            sell_proceeds_usdc: 0,
            realized_pnl: realizedPnl,
            is_paper: true,
            strategy_id: pos.strategy_id ?? '',
            sub_strategy_id: pos.sub_strategy_id ?? undefined,
            market_question: pos.market_question ?? '',
            market_slug: pos.market_slug ?? '',
            tx_hash: null,
            resolved_at: new Date(),
          },
        });

        result.resolved++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`resolve ${pos.condition_id.substring(0, 10)}…: ${msg}`);
        log.error({ condition_id: pos.condition_id, err: msg }, 'Failed to resolve paper position');
      }
    }

    if (result.resolved > 0 || result.errors.length > 0) {
      log.info(
        {
          scanned: result.scanned,
          checked: result.checked,
          resolved: result.resolved,
          errors: result.errors.length,
        },
        'Paper resolution cycle complete',
      );
    }

    return result;
  }
}
