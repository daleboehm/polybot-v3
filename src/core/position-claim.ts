// Anti-self-bidding position claim coordinator — R3c dormant subsystem.
//
// R3c (2026-04-10). Problem: when 16 entities scan Polymarket in sequence,
// they'll each see the same opportunities and bid each other up on identical
// markets. Without coordination the fleet effectively competes with itself.
//
// Solution: a process-wide claim set. When entity 1 opens a position on
// market M during a scan window, entities 2-N see M as "claimed" and skip
// it until the window expires. The claim set is in-memory (no DB overhead)
// and expires after N scan cycles so a position can be rotated across
// entities over time.
//
// Additionally, a cross-entity exposure cap: if 3 entities already hold the
// same market simultaneously, entity 4 skips regardless of scan order. This
// prevents 16 entities from piling into the same trade.

import { getAllOpenPositions } from '../storage/repositories/position-repo.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('position-claim');

const DEFAULT_CLAIM_TTL_MS = 5 * 60 * 1000; // 5 min (one scan cycle)
const DEFAULT_MAX_ENTITIES_PER_MARKET = 3;

export class PositionClaimCoordinator {
  // key: condition_id → { entitySlug, expiresAt }
  private claims = new Map<string, { entitySlug: string; expiresAt: number }>();
  private active = false;

  constructor(
    private readonly claimTtlMs = DEFAULT_CLAIM_TTL_MS,
    private readonly maxEntitiesPerMarket = DEFAULT_MAX_ENTITIES_PER_MARKET,
  ) {}

  activate(): void {
    this.active = true;
    log.info({ ttl_ms: this.claimTtlMs, max_entities: this.maxEntitiesPerMarket }, 'Claim coordinator activated');
  }

  deactivate(): void {
    this.active = false;
    this.claims.clear();
  }

  isActive(): boolean {
    return this.active;
  }

  /**
   * Check if the entity may open a position on this market. Returns true
   * if cleared, false if claimed by another entity or capped out.
   */
  canClaim(entitySlug: string, conditionId: string): boolean {
    if (!this.active) return true;
    this.cleanupExpired();

    const existing = this.claims.get(conditionId);
    if (existing && existing.entitySlug !== entitySlug) return false;

    // Cross-entity exposure cap: count how many entities have an OPEN position
    // on this market in the DB. If >= maxEntitiesPerMarket, block.
    const openPositionsOnMarket = getAllOpenPositions().filter(p => p.condition_id === conditionId);
    const uniqueEntities = new Set(openPositionsOnMarket.map(p => p.entity_slug));
    if (uniqueEntities.has(entitySlug)) return true; // same entity already in this market → ok, de-dup elsewhere
    if (uniqueEntities.size >= this.maxEntitiesPerMarket) return false;

    return true;
  }

  /**
   * Called after a successful order submission. Records the claim so subsequent
   * scan cycles by other entities know this market is taken.
   */
  claim(entitySlug: string, conditionId: string): void {
    if (!this.active) return;
    this.claims.set(conditionId, { entitySlug, expiresAt: Date.now() + this.claimTtlMs });
  }

  /**
   * Release a claim early — called when the entity's position closes.
   */
  release(entitySlug: string, conditionId: string): void {
    const existing = this.claims.get(conditionId);
    if (existing && existing.entitySlug === entitySlug) {
      this.claims.delete(conditionId);
    }
  }

  snapshot(): Array<{ conditionId: string; entitySlug: string; expiresInMs: number }> {
    const now = Date.now();
    return Array.from(this.claims.entries()).map(([conditionId, c]) => ({
      conditionId,
      entitySlug: c.entitySlug,
      expiresInMs: Math.max(0, c.expiresAt - now),
    }));
  }

  private cleanupExpired(): void {
    const now = Date.now();
    for (const [k, c] of this.claims) {
      if (c.expiresAt < now) this.claims.delete(k);
    }
  }
}
