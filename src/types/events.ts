// Typed event definitions for the engine event bus

import type { SamplingMarket, MarketData, OrderBookSnapshot } from './market.js';
import type { Signal, StrategyDecision } from './signal.js';
import type { Order, OrderFill } from './order.js';
import type { Position, Resolution } from './position.js';
import type { RiskViolation } from './risk.js';
import type { EntityMode, EntityStatus } from './entity.js';
import type { AdvisorCheckResult } from './advisor.js';

/**
 * Payload for reconciler:complete event. Inlined here (rather than imported from
 * market/on-chain-reconciler.ts) to avoid a circular dep: on-chain-reconciler.ts
 * imports eventBus, which imports EngineEvents, which would otherwise re-import
 * from on-chain-reconciler.ts.
 */
export interface ReconcileEventResult {
  entitySlug: string;
  actions: Array<{ kind: string }>;
  redemptions: Array<{ conditionId: string; txHash?: string; claimedUsdc: number; error?: string }>;
  cashCredited: number;
  errors: string[];
  apiReachable: boolean;
}

export interface EngineEvents {
  // Market events
  'market:discovered':     { market: SamplingMarket };
  'market:updated':        { condition_id: string; data: MarketData };
  'market:closed':         { condition_id: string };
  'orderbook:snapshot':    { token_id: string; book: OrderBookSnapshot };

  // Signal events
  'signal:generated':      { signal: Signal };
  'signal:approved':       { decision: StrategyDecision };
  'signal:rejected':       { signal: Signal; reason: string };

  // Order events
  'order:submitted':       { order: Order };
  'order:filled':          { fill: OrderFill };
  'order:partially_filled':{ order_id: string; filled_size: number; remaining: number };
  'order:cancelled':       { order_id: string; reason: string };
  'order:rejected':        { order_id: string; reason: string };

  // Position events
  'position:opened':       { position: Position };
  'position:updated':      { position: Position };
  'position:closed':       { position: Position; pnl: number };
  'position:resolved':     { resolution: Resolution };

  // Risk events
  'risk:violation':        { entity_slug: string; violation: RiskViolation };
  'risk:lockout':          { entity_slug: string; reason: string };
  'risk:unlocked':         { entity_slug: string };

  // Entity events
  'entity:mode_changed':   { entity_slug: string; from: EntityMode; to: EntityMode };
  'entity:status_changed': { entity_slug: string; from: EntityStatus; to: EntityStatus };
  'entity:balance_updated':{ entity_slug: string; cash: number; reserve: number; trading: number };
  'entity:strategies_changed': { entity_slug: string; from: string[]; to: string[] };

  // Advisor events
  'advisor:check_complete': { result: AdvisorCheckResult };

  // Reconciler events — emitted after every on-chain reconcile call (R1 PR#1, 2026-04-10)
  'reconciler:complete':   { result: ReconcileEventResult };

  // Kill switch events (R1 PR#2, 2026-04-10)
  'killswitch:activated':  { reason: string; message: string; at: Date };
  'killswitch:released':   { operator: string; at: Date };

  // R3c dormant fleet subsystem events (2026-04-10)
  'fleet:scheduler_activated':   { entities: number; effective_scan_density_ms: number };
  'fleet:scheduler_deactivated': Record<string, never>;
  'treasury:sweep':              { result: { totalInflow: number; poolBalanceAfter: number; refunds: number; sweptAt: Date } };

  // Engine lifecycle
  'engine:started':        { timestamp: Date };
  'engine:stopped':        { timestamp: Date; reason: string };
  'engine:error':          { error: Error; context: string };
  'engine:cycle_complete': { cycle: number; duration_ms: number; signals: number; orders: number };

  // Snapshots
  'snapshot:captured':     { entity_slug: string; equity: number; timestamp: Date };
}
