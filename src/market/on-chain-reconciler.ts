// On-chain position reconciler — v3 source of truth for resolved positions.
//
// Queries the Polymarket Data API's /positions?user=... endpoint for each entity's
// proxy wallet and reconciles its output against the v3 DB. This replaced a flawed
// Gamma-polling approach (4 compounding bugs per the 2026-04-09 audit: wrong plural
// param name, unvalidated response shape, silent null paths in parseGammaResolution,
// and divergence between the engine's DB view and the actual wallet state).
//
// The mechanism: query the Polymarket Data API's /positions?user=... endpoint for
// each entity's proxy wallet, which returns the wallet's on-chain position state
// directly. Any divergence from our DB is a fact we must reconcile:
//
//   • DB position is present in API as active  → still open, do nothing
//   • DB position is present in API as resolved → credit P&L and call the redeemer
//   • DB position is absent from API            → already redeemed off-chain (or never
//     existed on-chain). Close in DB with reason 'absent_from_api'.
//   • API position is NOT in DB                 → crash-window orphan. Insert a
//     reconstructed row so future cycles track it.
//
// Fail-closed: if the Data API is unreachable, the scan cycle skips this entity's
// reconciliation and refuses to place new trades for that entity. Per obra-defense-in-depth
// — we do NOT fall back to Gamma polling, because that's the path that was broken.

import type { DataApiClient, OpenPosition as ApiOpenPosition, ResolvedPosition as ApiResolvedPosition, FullPosition } from './data-api-client.js';
import type { NegRiskRedeemer } from '../execution/neg-risk-redeemer.js';
import type { PositionRow } from '../storage/repositories/position-repo.js';
import { closePosition, upsertPosition, getOpenPositions } from '../storage/repositories/position-repo.js';
import { insertResolution } from '../storage/repositories/resolution-repo.js';
import { insertTrade } from '../storage/repositories/trade-repo.js';
import { markMarketClosed } from '../storage/repositories/market-repo.js';
import { eventBus } from '../core/event-bus.js';
import { createChildLogger } from '../core/logger.js';
import type { Outcome, OrderFill } from '../types/index.js';
import { nanoid } from 'nanoid';

const log = createChildLogger('reconciler');

export interface ReconcileAction {
  kind: 'close_absent' | 'close_resolved' | 'insert_orphan' | 'keep_open';
  dbPosition?: PositionRow;
  apiPosition?: ApiOpenPosition | ApiResolvedPosition | FullPosition;
  payoutUsd?: number;
  realizedPnl?: number;
}

export interface ReconcileResult {
  entitySlug: string;
  actions: ReconcileAction[];
  redemptions: Array<{ conditionId: string; txHash?: string; claimedUsdc: number; error?: string }>;
  cashCredited: number;
  errors: string[];
  apiReachable: boolean;
}

export interface ReconcilerOptions {
  /** Minimum seconds between reconciliation runs per entity. Defaults to scan interval. */
  minIntervalMs?: number;
  /** If true, attempts on-chain redemption via NegRiskRedeemer when positions become redeemable. */
  redemptionEnabled?: boolean;
}

export class OnChainReconciler {
  private lastReconcile = new Map<string, number>();

  constructor(
    private readonly dataApi: DataApiClient,
    private readonly options: ReconcilerOptions = {},
  ) {}

  /**
   * Reconcile a single entity. Call at engine startup + every scan cycle BEFORE signal
   * generation. If this throws or returns `apiReachable: false`, the caller MUST skip
   * trading for this entity on this cycle (fail-closed).
   *
   * @param entitySlug the engine's entity identifier (e.g. 'polybot')
   * @param proxyWallet the on-chain wallet address to query via Data API
   * @param redeemer optional per-entity NegRiskRedeemer for on-chain redemption. Pass
   *   null or omit for paper entities — reconciler will still close DB rows but won't
   *   attempt any on-chain transactions.
   */
  async reconcileEntity(
    entitySlug: string,
    proxyWallet: string,
    redeemer: NegRiskRedeemer | null = null,
  ): Promise<ReconcileResult> {
    const result: ReconcileResult = {
      entitySlug,
      actions: [],
      redemptions: [],
      cashCredited: 0,
      errors: [],
      apiReachable: false,
    };

    // Rate limit per entity
    const minInterval = this.options.minIntervalMs ?? 0;
    const last = this.lastReconcile.get(entitySlug) ?? 0;
    if (minInterval > 0 && Date.now() - last < minInterval) {
      result.apiReachable = true; // consider "skipped-for-interval" a success for caller logic
      return result;
    }
    this.lastReconcile.set(entitySlug, Date.now());

    // Phase -1 fix (2026-04-11): the reconciler now uses the UNFILTERED
    // `/positions` endpoint (getAllPositions) which returns BOTH active
    // AND redeemable positions plus `cashPnl` and `redeemable` fields.
    //
    // Root cause of the prior bug: the `status=active` filter used by
    // getOpenPositions() HIDES all redeemable (dead) positions. The
    // reconciler saw a DB position that was missing from active-API and
    // classified it as "closed off-chain, undetermined outcome → write
    // a push row with realized_pnl=0." Across prod this wrote 348 of
    // 360 resolutions as accounting-neutral zeros, which made the
    // StrategyAdvisor completely blind to actual prod edge — every
    // resolution was "0 wins, $0 P&L" regardless of whether the
    // underlying market won or lost.
    //
    // The fix: query the unfiltered endpoint. If a DB position shows up
    // in the full list with `currentValue === 0` (total loss) or
    // `redeemable === true` (market settled, cash waiting to redeem),
    // we use `cashPnl` directly as the authoritative realized P&L.
    // No more fake zeros.
    //
    // The `status=resolved` endpoint is STILL broken (returns active
    // rows), which is why we don't use it. The unfiltered endpoint with
    // `sizeThreshold=0.01` is the one that works.
    let apiAll: FullPosition[];
    try {
      apiAll = await this.dataApi.getAllPositions(proxyWallet);
      result.apiReachable = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`data_api_unreachable: ${msg}`);
      log.error({ entity: entitySlug, err: msg }, 'Data API fetch failed — fail-closed, skip entity this cycle');
      return result;
    }

    // Partition: anything redeemable=true or currentValue=0 is DEAD, anything
    // else is ACTIVE. Build two maps for fast lookup.
    const apiActiveByAsset = new Map<string, FullPosition>();
    const apiDeadByAsset = new Map<string, FullPosition>();
    for (const p of apiAll) {
      // Defensive: the API is supposed to return numeric fields numerically
      // on this endpoint, but we coerce in case of shape drift.
      const cv = Number(p.currentValue);
      const isDead = p.redeemable === true || (Number.isFinite(cv) && cv === 0);
      if (isDead) {
        apiDeadByAsset.set(p.asset, p);
      } else {
        apiActiveByAsset.set(p.asset, p);
      }
    }
    // Back-compat alias: older code below referred to `apiByAsset` as
    // "what's currently held." We keep that naming and point it at the
    // active subset (redeemable/dead are handled in the close-absent branch).
    const apiByAsset = apiActiveByAsset;

    // Pull our DB view of this entity's open positions.
    const dbPositions = getOpenPositions(entitySlug);

    // Pass 1: walk every DB position, decide its fate based on active-API presence.
    for (const dbPos of dbPositions) {
      const api = apiByAsset.get(dbPos.token_id);

      if (!api) {
        // Position is NOT in the active set on-chain. Two sub-cases:
        //   (1) DEAD — it's in the redeemable/zero-value bucket. This is
        //       the happy path after the Phase -1 fix: the Data API tells
        //       us the actual cashPnl, we use it as the authoritative
        //       realized_pnl, and the DB resolution row now reflects
        //       reality instead of a zero-P&L placeholder.
        //   (2) GENUINELY MISSING — position isn't in the dead bucket
        //       either. Either redeemed off-chain by a separate flow,
        //       or the API has a consistency lag. Fall back to the CLOB
        //       winner lookup (legacy path), and if that's undetermined
        //       write a push row.
        const dead = apiDeadByAsset.get(dbPos.token_id);
        if (dead) {
          // Authoritative path: Data API already computed P&L. Use it.
          const cashPnl = Number(dead.cashPnl);
          const currentValue = Number(dead.currentValue);
          // currentValue is the cash we'd receive if we redeemed right now.
          // For a total-loss position this is 0. For a winning position
          // that's still waiting to be redeemed this is size * 1.0 = size.
          const payout = Number.isFinite(currentValue) ? currentValue : 0;
          // Realized PnL override: use the API's cashPnl directly when
          // finite, otherwise compute from payout - cost_basis (fallback).
          const realizedPnl = Number.isFinite(cashPnl) ? cashPnl : payout - dbPos.cost_basis;
          await this.closeDbPosition(
            dbPos,
            'absent_from_api',
            payout,
            realizedPnl,
          );
          log.info(
            {
              entity: entitySlug,
              condition: dbPos.condition_id.substring(0, 16),
              redeemable: dead.redeemable,
              current_value: currentValue,
              cash_pnl: cashPnl,
              cost_basis: dbPos.cost_basis,
              realized_pnl: realizedPnl,
            },
            'close_absent via Data API cashPnl (authoritative)',
          );
          result.actions.push({ kind: 'close_absent', dbPosition: dbPos, payoutUsd: payout });
          continue;
        }

        // Fallback: position is genuinely missing from both active AND
        // dead buckets. Ask CLOB about the winner. If CLOB doesn't know,
        // write a push row so we don't fabricate a loss.
        const payoutOutcome = await this.computeAbsentPayout(dbPos);
        if (payoutOutcome === null) {
          // Undetermined: write a push row (payout=cost_basis, pnl=0)
          await this.closeDbPosition(
            dbPos,
            'absent_from_api',
            dbPos.cost_basis,
            0, // realized_pnl override — force push
          );
          result.actions.push({ kind: 'close_absent', dbPosition: dbPos, payoutUsd: dbPos.cost_basis });
        } else {
          // Resolved via CLOB: real payout (0 for a loss, size for a win)
          await this.closeDbPosition(dbPos, 'absent_from_api', payoutOutcome);
          result.actions.push({ kind: 'close_absent', dbPosition: dbPos, payoutUsd: payoutOutcome });
        }
        continue;
      }

      // Position is still active on-chain. Keep it open.
      result.actions.push({ kind: 'keep_open', dbPosition: dbPos });
      apiByAsset.delete(dbPos.token_id);
    }

    // NOTE: we no longer attempt per-cycle on-chain redemption here. Positions that
    // resolve on-chain disappear from the active API list and get closed as
    // 'absent_from_api' in the next reconciliation cycle. If v3 owns redemption
    // end-to-end (R4), a separate periodic redemption check should run against the
    // active API to see which holdings are flagged redeemable — NOT based on the
    // broken status=resolved filter. Deferred until the Data API behavior is
    // verified or Polymarket CLOB SDK exposes a reliable redemption-status field.
    // `redeemer` parameter kept for future redemption wiring. Currently unused
    // because per-cycle on-chain redemption is disabled until the Data API
    // provides a reliable "redeemable" flag. Void to silence unused-param lint.
    void redeemer;

    // Pass 2: any ACTIVE API positions left in the map are orphans (crash-window
    // inserts, or positions opened by another process). Reconstruct a DB row so
    // the advisor and stop-loss monitor can see them going forward.
    //
    // NOTE: apiByAsset here is the ACTIVE subset of FullPosition. We intentionally
    // do NOT insert orphans from the DEAD bucket — those are already-settled
    // positions and we don't need to track them going forward. They appear as
    // close_absent rows in the resolutions table via the matched-DB-position
    // close-absent path above, which is the correct accounting.
    for (const pos of apiByAsset.values()) {
      try {
        const size = Number(pos.size);
        const avgPrice = Number(pos.avgPrice);
        const costBasis = Number(pos.initialValue);
        upsertPosition({
          entity_slug: entitySlug,
          condition_id: pos.conditionId,
          token_id: pos.asset,
          side: this.outcomeFromString(pos.outcome),
          size: Number.isFinite(size) ? size : 0,
          avg_entry_price: Number.isFinite(avgPrice) ? avgPrice : 0,
          cost_basis: Number.isFinite(costBasis) ? costBasis : 0,
          current_price: Number.isFinite(avgPrice) ? avgPrice : 0,
          unrealized_pnl: 0,
          market_question: pos.title,
          market_slug: undefined,
          strategy_id: undefined,
          sub_strategy_id: undefined,
          is_paper: false,
        });
        result.actions.push({ kind: 'insert_orphan', apiPosition: pos });
        log.info(
          { entity: entitySlug, conditionId: pos.conditionId.substring(0, 16), question: pos.title?.substring(0, 50) },
          'Orphan position inserted from on-chain state',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        result.errors.push(`orphan_insert_failed ${pos.asset}: ${msg}`);
        log.error({ entity: entitySlug, asset: pos.asset, err: msg }, 'Failed to insert orphan position');
      }
    }

    // Summary log — one line per entity per cycle, keeps the operational view quiet.
    if (result.actions.length > 0 || result.redemptions.length > 0 || result.errors.length > 0) {
      log.info(
        {
          entity: entitySlug,
          closed_absent: result.actions.filter(a => a.kind === 'close_absent').length,
          closed_resolved: result.actions.filter(a => a.kind === 'close_resolved').length,
          orphans_inserted: result.actions.filter(a => a.kind === 'insert_orphan').length,
          still_open: result.actions.filter(a => a.kind === 'keep_open').length,
          cash_credited: result.cashCredited.toFixed(2),
          redemptions_attempted: result.redemptions.length,
          redemptions_ok: result.redemptions.filter(r => !r.error).length,
          errors: result.errors.length,
        },
        'Reconciliation complete',
      );
    }

    eventBus.emit('reconciler:complete', { result });
    return result;
  }

  private async closeDbPosition(
    dbPos: PositionRow,
    reason: 'absent_from_api' | 'resolved',
    payoutUsd: number,
    realizedPnlOverride?: number,
    resolvedApiPos?: ApiResolvedPosition,
  ): Promise<void> {
    const realizedPnl = realizedPnlOverride ?? (payoutUsd - dbPos.cost_basis);

    // 2026-04-10: derive winning_outcome from the actual outcome, not from
    // position_side. Previously this always wrote winning_outcome = position_side,
    // which displayed nonsense like "position=NO, winning=NO, payout=0" for
    // losses (looks like the position side won but got nothing). Now:
    //   - push (realized_pnl = 0, explicit override) → empty string
    //   - win (payout > 0)                           → winning = position_side
    //   - loss (payout = 0 and !push)                → winning = opposite side
    const posSide = this.outcomeFromString(dbPos.side);
    const oppositeSide: Outcome = posSide === 'YES' ? ('NO' as Outcome) : ('YES' as Outcome);
    const isPush = realizedPnlOverride === 0;
    const derivedWinningOutcome: Outcome | '' = isPush
      ? ''
      : payoutUsd > 0
        ? posSide
        : oppositeSide;

    // 2026-04-10: synthetic SELL trade row for audit-trail completeness.
    //
    // The reconciler's close_absent path is the only close-a-position path
    // that doesn't go through clob-router → insertTrade. That left cash
    // movements with no matching trade row: downstream queries like
    // `starting + SUM(SELL) - SUM(BUY) = current_cash` would silently
    // under-count the SELL side by the close_absent volume.
    //
    // Rule: write a synthetic SELL only when we have a VERIFIED outcome from
    // computeAbsentPayout (win → payout=size, loss → payout=0). These rows
    // honestly describe cash flow (full redemption for wins, zero-value
    // redemption for losses). The cash-balance side is still managed by the
    // wallet-sync step, but the trades table now has a corresponding row
    // instead of a hole.
    //
    // For undetermined PUSHES (realizedPnlOverride===0), we do NOT write a
    // synthetic SELL: we don't know what cash actually moved for that
    // position, and writing a zero-valued or cost-basis-valued row would be
    // fabricating data. The resolution row stays in place as a push; the
    // aggregate wallet-sync delta covers the accounting without pretending
    // we know the per-position outcome.
    //
    // Ordered BEFORE insertResolution: a trade-insert failure aborts the
    // whole close (throws), leaving the position open for retry next cycle
    // rather than ending up with a resolution row but no trade row.
    if (!isPush) {
      try {
        const sellPrice = dbPos.size > 0 ? payoutUsd / dbPos.size : 0;
        const nowSec = Math.floor(Date.now() / 1000);
        const syntheticFill: OrderFill = {
          trade_id: `synth-${nanoid(12)}`,
          order_id: `synth-${nanoid(12)}`,
          entity_slug: dbPos.entity_slug,
          condition_id: dbPos.condition_id,
          token_id: dbPos.token_id,
          tx_hash: null,
          side: 'SELL',
          size: dbPos.size,
          price: sellPrice,
          usdc_size: payoutUsd,
          fee_usdc: 0,
          net_usdc: payoutUsd,
          is_paper: dbPos.is_paper === 1,
          strategy_id: dbPos.strategy_id ?? '',
          sub_strategy_id: dbPos.sub_strategy_id ?? undefined,
          outcome: posSide,
          market_question: dbPos.market_question ?? '',
          market_slug: dbPos.market_slug ?? '',
          timestamp: nowSec,
        };
        insertTrade(syntheticFill);
        log.info(
          {
            entity: dbPos.entity_slug,
            condition: dbPos.condition_id.substring(0, 16),
            side: 'SELL',
            net_usdc: payoutUsd,
            outcome: payoutUsd > 0 ? 'win' : 'loss',
          },
          'Synthetic SELL trade recorded for close_absent',
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error(
          { entity: dbPos.entity_slug, condition: dbPos.condition_id.substring(0, 16), err: msg },
          'Failed to write synthetic SELL trade for close_absent — aborting close to retry next cycle',
        );
        throw err;
      }
    }

    insertResolution({
      entity_slug: dbPos.entity_slug,
      condition_id: dbPos.condition_id,
      token_id: dbPos.token_id,
      winning_outcome: (derivedWinningOutcome || posSide) as Outcome,
      position_side: posSide,
      size: dbPos.size,
      payout_usdc: payoutUsd,
      cost_basis_usdc: dbPos.cost_basis,
      sell_proceeds_usdc: 0,
      realized_pnl: realizedPnl,
      is_paper: dbPos.is_paper === 1,
      strategy_id: dbPos.strategy_id ?? '',
      sub_strategy_id: dbPos.sub_strategy_id ?? undefined,
      market_question: dbPos.market_question ?? resolvedApiPos?.title ?? '',
      market_slug: dbPos.market_slug ?? '',
      tx_hash: null,
      resolved_at: new Date(),
    });

    closePosition(dbPos.entity_slug, dbPos.condition_id, dbPos.token_id, 'resolved');
    markMarketClosed(dbPos.condition_id);

    eventBus.emit('position:resolved', {
      resolution: {
        entity_slug: dbPos.entity_slug,
        condition_id: dbPos.condition_id,
        token_id: dbPos.token_id,
        winning_outcome: (derivedWinningOutcome || posSide) as Outcome,
        position_side: posSide,
        size: dbPos.size,
        payout_usdc: payoutUsd,
        cost_basis_usdc: dbPos.cost_basis,
        sell_proceeds_usdc: 0,
        realized_pnl: realizedPnl,
        is_paper: dbPos.is_paper === 1,
        strategy_id: dbPos.strategy_id ?? '',
        market_question: dbPos.market_question ?? '',
        market_slug: dbPos.market_slug ?? '',
        tx_hash: null,
        resolved_at: new Date(),
      },
    });
  }

  private safeParseFloat(s: string | undefined): number {
    if (!s) return 0;
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : 0;
  }

  private outcomeFromString(s: string): Outcome {
    const upper = (s ?? '').toUpperCase();
    if (upper === 'YES') return 'YES' as Outcome;
    if (upper === 'NO') return 'NO' as Outcome;
    // Data API sometimes returns outcome NAMES (e.g. "Trump") for multi-outcome markets.
    // Binary markets are our R1 scope — default any non-YES/NO string to 'YES' with a
    // debug log. Multi-outcome support comes in R2 when we drop the positions.side CHECK.
    log.debug({ raw: s }, 'Non-binary outcome string — defaulting to YES');
    return 'YES' as Outcome;
  }

  /**
   * Determine the payout for a position being closed as absent_from_api.
   *
   * Return contract (2026-04-10 v2):
   *   number  → market is resolved, payout is verified from CLOB. Either
   *             `dbPos.size` (position won) or `0` (position lost).
   *   null    → undetermined. Market is still open on CLOB, or CLOB doesn't
   *             know a winner, or the fetch failed. Caller should write a
   *             PUSH row instead of a fake -cost_basis loss.
   *
   * The caller uses the null vs number distinction to decide whether to
   * record the close as a real loss (realized_pnl = -cost_basis) or as an
   * accounting-neutral push (realized_pnl = 0). Fake losses were the root
   * cause of the "0 wins / 53 losses" bug — every undetermined close used
   * to be recorded as a 100% loss, which made the dashboard useless.
   */
  private async computeAbsentPayout(dbPos: PositionRow): Promise<number | null> {
    try {
      const resp = await fetch(
        `https://clob.polymarket.com/markets/${encodeURIComponent(dbPos.condition_id)}`,
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) },
      );
      if (!resp.ok) {
        log.warn(
          { entity: dbPos.entity_slug, condition: dbPos.condition_id.substring(0, 16), status: resp.status },
          'CLOB winner lookup returned non-200 — recording as push (undetermined)',
        );
        return null;
      }
      const data = (await resp.json()) as { closed?: boolean; tokens?: Array<{ token_id: string; winner?: boolean }> };
      if (!data.closed) {
        log.warn(
          { entity: dbPos.entity_slug, condition: dbPos.condition_id.substring(0, 16) },
          'Position absent from API but CLOB says market still open — recording as push (undetermined)',
        );
        return null;
      }
      const winnerToken = data.tokens?.find((t) => t.winner === true);
      if (!winnerToken) {
        log.warn(
          { entity: dbPos.entity_slug, condition: dbPos.condition_id.substring(0, 16) },
          'Market closed but CLOB reports no winner token — recording as push (undetermined)',
        );
        return null;
      }
      const didWin = winnerToken.token_id === dbPos.token_id;
      const payout = didWin ? dbPos.size : 0;
      log.info(
        {
          entity: dbPos.entity_slug,
          condition: dbPos.condition_id.substring(0, 16),
          didWin,
          payout,
          costBasis: dbPos.cost_basis,
          realizedPnl: payout - dbPos.cost_basis,
        },
        'close_absent payout computed from CLOB winner',
      );
      return payout;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        { entity: dbPos.entity_slug, condition: dbPos.condition_id.substring(0, 16), err: msg },
        'CLOB winner lookup threw — recording as push (undetermined)',
      );
      return null;
    }
  }
}
