// On-chain position reconciler — v3 source of truth for resolved positions.
//
// Replaces the Gamma-polling resolution-checker (which had 4 compounding bugs per the
// 2026-04-09 audit: wrong plural param name, unvalidated response shape, silent null
// paths in parseGammaResolution, and v1 cron wallet drainage divergence).
//
// The new mechanism: query the Polymarket Data API's /positions?user=... endpoint for
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

import type { DataApiClient, OpenPosition as ApiOpenPosition, ResolvedPosition as ApiResolvedPosition } from './data-api-client.js';
import type { NegRiskRedeemer } from '../execution/neg-risk-redeemer.js';
import type { PositionRow } from '../storage/repositories/position-repo.js';
import { closePosition, upsertPosition, getOpenPositions } from '../storage/repositories/position-repo.js';
import { insertResolution } from '../storage/repositories/resolution-repo.js';
import { markMarketClosed } from '../storage/repositories/market-repo.js';
import { eventBus } from '../core/event-bus.js';
import { createChildLogger } from '../core/logger.js';
import type { Outcome } from '../types/index.js';

const log = createChildLogger('reconciler');

export interface ReconcileAction {
  kind: 'close_absent' | 'close_resolved' | 'insert_orphan' | 'keep_open';
  dbPosition?: PositionRow;
  apiPosition?: ApiOpenPosition | ApiResolvedPosition;
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

    // CRITICAL NOTE (2026-04-10): the Polymarket Data API's `status=resolved` filter
    // is BROKEN — it returns the SAME positions as `status=active`. The earlier
    // reconciler version used both endpoints and treated the `resolved` bucket as
    // "closed positions with currentValue as payout," which phantom-closed 5 still-
    // active positions and credited their mark-to-market as phantom cash.
    //
    // Fix: use ONLY `getOpenPositions(status=active)` as the authoritative list of
    // what the wallet currently holds. Anything in the DB open set that isn't in
    // the active API list is treated as "already redeemed off-chain" — we don't
    // know how much cash was credited by that off-chain redemption, but the
    // startup wallet-sync step reads the on-chain USDC balance as ground truth
    // so the accounting stays consistent. Per-cycle reconciliation does NOT touch
    // cash_balance — it only manages position state.
    let apiActive: ApiOpenPosition[];
    try {
      apiActive = await this.dataApi.getOpenPositions(proxyWallet);
      result.apiReachable = true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      result.errors.push(`data_api_unreachable: ${msg}`);
      log.error({ entity: entitySlug, err: msg }, 'Data API fetch failed — fail-closed, skip entity this cycle');
      return result;
    }

    // Index active API positions by asset (token_id) for O(1) lookup.
    const apiByAsset = new Map<string, ApiOpenPosition>();
    for (const p of apiActive) apiByAsset.set(p.asset, p);

    // Pull our DB view of this entity's open positions.
    const dbPositions = getOpenPositions(entitySlug);

    // Pass 1: walk every DB position, decide its fate based on active-API presence.
    for (const dbPos of dbPositions) {
      const api = apiByAsset.get(dbPos.token_id);

      if (!api) {
        // Not in active API → the on-chain position no longer exists.
        // It was either redeemed off-chain (v1 auto_redeem cron or manual
        // Polymarket redemption) or never existed. Close in DB with payout=0;
        // the actual cash credit already happened on-chain and will be reflected
        // in the wallet's USDC balance at the next wallet sync.
        await this.closeDbPosition(dbPos, 'absent_from_api', 0);
        result.actions.push({ kind: 'close_absent', dbPosition: dbPos, payoutUsd: 0 });
        apiByAsset.delete(dbPos.token_id);
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

    // Pass 2: any API positions left in the map are orphans (crash-window inserts,
    // or positions opened by another process). Reconstruct a DB row so the advisor
    // and stop-loss monitor can see them going forward.
    for (const pos of apiByAsset.values()) {
      try {
        const size = this.safeParseFloat(pos.size);
        const avgPrice = this.safeParseFloat(pos.avgPrice);
        const costBasis = this.safeParseFloat(pos.initialValue);
        upsertPosition({
          entity_slug: entitySlug,
          condition_id: pos.conditionId,
          token_id: pos.asset,
          side: this.outcomeFromString(pos.outcome),
          size,
          avg_entry_price: avgPrice,
          cost_basis: costBasis,
          current_price: avgPrice,
          unrealized_pnl: 0,
          market_question: pos.title,
          market_slug: undefined,
          strategy_id: undefined,
          sub_strategy_id: undefined,
          is_paper: false,
        });
        result.actions.push({ kind: 'insert_orphan', apiPosition: pos });
        // Info level — orphan insertion is the expected path on first startup
        // after a deploy (positions that were open on-chain but absent from DB
        // because v2 never wrote them, or because we wiped DB state during a fix).
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

    insertResolution({
      entity_slug: dbPos.entity_slug,
      condition_id: dbPos.condition_id,
      token_id: dbPos.token_id,
      winning_outcome: this.outcomeFromString(dbPos.side),
      position_side: this.outcomeFromString(dbPos.side),
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
        winning_outcome: this.outcomeFromString(dbPos.side),
        position_side: this.outcomeFromString(dbPos.side),
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
}
