// Scout overlay — qualitative size adjustment on top of statistical signals.
//
// Phase 3 (2026-04-11). Strategies call this during signal build to check
// whether any scout has recently posted qualitative intel on a market. If
// yes, the overlay returns a size multiplier (and a reason string for
// logging). If no intel exists, the overlay is a no-op (returns 1.0).
//
// Contract:
//   - Scouts CANNOT create signals — they can only weight existing ones.
//   - The strategy's statistical math (Wilson LB + Markov grid + min_edge
//     gate) is always primary. The overlay runs AFTER the strategy has
//     decided to fire a signal.
//   - Multiplier is bounded by [BOOST_DOWN_MIN, BOOST_UP_MAX] so a single
//     scout can never push a position 10x its intended size.
//   - The risk engine's position caps remain the final gate — the overlay
//     cannot bypass max_position_pct or max_position_usd.
//
// Agreement logic:
//   scout side == strategy side, high conviction → boost up
//   scout side != strategy side, high conviction → shrink down
//   low conviction → ignore (too close to neutral to act on)
//
// This is the "scout-as-boost" pattern from the 2026-04-11 session plan
// (Option B). The "scout-as-attention-router" pattern (Option C) lives
// in src/core/priority-scanner.ts and does not go through this module.

import { getActiveIntel, markUsed } from '../storage/repositories/scout-intel-repo.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('scout-overlay');

// Tunable parameters — can be moved to config later if Dale wants dashboard control.
const BOOST_UP_MAX = 1.25;      // agree + max conviction → 1.25x
const BOOST_DOWN_MIN = 0.50;    // disagree + max conviction → 0.50x
const MIN_CONVICTION_TO_ACT = 0.60; // below this, treat as neutral

export interface OverlayResult {
  /** Multiplier to apply to the strategy's recommended size. 1.0 = no change. */
  multiplier: number;
  /** Short text describing what the overlay did. Logged + stored in signal metadata. */
  reason: string | null;
  /** True if any active intel was found for this market, regardless of action. */
  hadIntel: boolean;
  /** The scout whose intel was applied, if any. */
  scoutId: string | null;
  /** The intel conviction score, if any. */
  conviction: number | null;
}

const NEUTRAL: OverlayResult = {
  multiplier: 1.0,
  reason: null,
  hadIntel: false,
  scoutId: null,
  conviction: null,
};

/**
 * Given a market and the strategy's intended side, return an OverlayResult
 * describing how (if at all) scout intel should modify the position size.
 *
 * @param conditionId - The market's condition ID
 * @param strategySide - Which outcome the strategy is betting on ('YES' or 'NO')
 */
export function applyScoutOverlay(
  conditionId: string,
  strategySide: 'YES' | 'NO',
): OverlayResult {
  const intel = getActiveIntel(conditionId);
  if (!intel) return NEUTRAL;

  // Intel exists but conviction is too low to act on. Report hadIntel=true
  // so signal metadata reflects the scout was aware of this market, but
  // leave size unchanged.
  if (intel.conviction < MIN_CONVICTION_TO_ACT) {
    return {
      multiplier: 1.0,
      reason: `low-conviction (${intel.conviction.toFixed(2)}) — no-op`,
      hadIntel: true,
      scoutId: intel.created_by,
      conviction: intel.conviction,
    };
  }

  const agreement = intel.side === strategySide;
  // Linear interpolation from MIN_CONVICTION_TO_ACT to 1.0.
  // At 0.60 conviction → 0% of the way toward the bound.
  // At 1.00 conviction → 100% of the way toward the bound.
  const span = 1.0 - MIN_CONVICTION_TO_ACT;
  const t = (intel.conviction - MIN_CONVICTION_TO_ACT) / span; // 0..1

  let multiplier: number;
  let reason: string;
  if (agreement) {
    // Agree: scale from 1.0 → BOOST_UP_MAX
    multiplier = 1.0 + (BOOST_UP_MAX - 1.0) * t;
    reason = `${intel.created_by}: agree ${intel.side} (${intel.conviction.toFixed(2)}): ${intel.reason}`;
  } else {
    // Disagree: scale from 1.0 → BOOST_DOWN_MIN
    multiplier = 1.0 - (1.0 - BOOST_DOWN_MIN) * t;
    reason = `${intel.created_by}: disagree (${intel.side} vs strategy ${strategySide}, ${intel.conviction.toFixed(2)}): ${intel.reason}`;
  }

  // Account for the usage — helps dashboard see which intel is actually
  // flowing through to real sizing decisions.
  try {
    markUsed(intel.id);
  } catch (err) {
    log.warn({ err, intel_id: intel.id }, 'Failed to mark intel as used');
  }

  log.debug(
    {
      condition_id: conditionId,
      strategy_side: strategySide,
      intel_side: intel.side,
      conviction: intel.conviction,
      multiplier,
      scout: intel.created_by,
    },
    'Scout overlay applied',
  );

  return {
    multiplier,
    reason,
    hadIntel: true,
    scoutId: intel.created_by,
    conviction: intel.conviction,
  };
}
