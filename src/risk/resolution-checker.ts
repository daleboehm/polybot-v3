// DEPRECATED — replaced by OnChainReconciler in R1 PR#1 (2026-04-10).
//
// The previous Gamma-polling implementation had 4 compounding bugs per the 2026-04-09
// audit §4.1:
//   R-1: Gamma query used non-standard plural `condition_ids` param (likely ignored)
//   R-2: Response cast to GammaMarket[] with zero validation
//   R-3: parseGammaResolution had 3 silent `return null` paths that swallowed errors
//   R-4: v1 auto_redeem.py cron silently drained the wallet, v2 DB never reconciled
//
// The replacement lives at `src/market/on-chain-reconciler.ts` and queries the
// Polymarket Data API `/positions?user=...` endpoint for each entity's proxy wallet,
// which returns the authoritative on-chain state directly. v1 `auto_redeem.py` has
// been retired — v3 owns redemption via `src/execution/neg-risk-redeemer.ts`.
//
// This stub remains so any lingering import paths throw loudly during transition,
// rather than silently restoring the broken behaviour. It will be deleted in R3c
// cleanup along with the rest of the v1→v3 migration debt.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('resolution-checker');

export class ResolutionChecker {
  constructor() {
    log.warn(
      'ResolutionChecker is DEPRECATED — use OnChainReconciler from src/market/on-chain-reconciler.ts. ' +
        'Constructing this class is a no-op; resolution flow is now driven by the reconciler in the scan cycle.',
    );
  }

  async checkResolutions(_updateEntityCash: (slug: string, pnl: number) => void): Promise<void> {
    // Intentionally empty — reconciler handles this. Safe to call (no throws)
    // so old scan-cycle code can be removed incrementally.
  }
}
