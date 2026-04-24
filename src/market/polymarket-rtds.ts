// Polymarket RTDS (Real-Time Data Stream) client — 2026-04-21.
//
// Connects to wss://ws-live-data.polymarket.com and subscribes to
// equity_prices broadcasts. Maintains an in-memory symbol -> price
// map that other modules can query via getRtdsPrice(symbol).
//
// Protocol discovered by reverse-engineering the Polymarket frontend JS
// bundle (`NEXT_PUBLIC_LIVE_DATA_WEBSOCKET_URL` + subscribe logic in
// their `useWebSocket` hook). Subscription format:
//
//   {
//     "action": "subscribe",
//     "subscriptions": [
//       { "topic": "equity_prices", "type": "update" }
//     ]
//   }
//
// Sample server payload:
//   {
//     "topic": "equity_prices", "type": "update",
//     "payload": { "symbol": "xauusd", "value": 4729.245, "timestamp": ... }
//   }
//
// No auth, no filter required for equity_prices. ~28 updates/sec observed.
//
// Use cases (future):
//   - Oracle-lag arb vs Binance for gold/silver/FX markets
//   - Additional confirmation source for crypto_price strategy
//   - Resolution-source feed for commodity/equity markets
//
// v1 is OBSERVATION-ONLY: connects, caches, exposes read accessors.
// No strategy wiring yet — let Dale see what symbols come through first.

import { WebSocket } from 'ws';
import { createChildLogger } from '../core/logger.js';
import { insertPriority } from '../storage/repositories/market-priority-repo.js';

const log = createChildLogger('rtds-client');

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const RECONNECT_DELAY_MS = 5_000;
const MAX_RECONNECT_ATTEMPTS = 10;
const STALE_ENTRY_TTL_MS = 5 * 60 * 1000; // drop symbols not updated in 5 min

export interface RtdsPrice {
  symbol: string;
  value: number;
  timestamp: number; // unix ms
  received_at: number; // our wall clock on first ingest
}

const priceMap = new Map<string, RtdsPrice>();
const firstSeen = new Set<string>();
let ws: WebSocket | null = null;
let reconnectAttempts = 0;
let isShuttingDown = false;
let summaryTimer: NodeJS.Timeout | null = null;

let totalMessagesReceived = 0;
let messagesThisWindow = 0;

// 2026-04-24 market_prices topic — ALL Polymarket markets stream prices here.
// We track first-seen condition_ids to detect NEW LISTINGS and flag them as
// priority for the scout-coordinator, so new 5-min/15-min BTC markets get
// picked up in <30s instead of 20s sampling-poller + 30s priority-scan.
const seenConditionIds = new Set<string>();
let marketPricesReceived = 0;
let newListingsFlagged = 0;
const NEW_LISTING_PRIORITY_TTL_MS = 10 * 60 * 1000;  // 10 min priority window
const NEW_LISTING_PRIORITY_LEVEL = 8;

function handleMessage(raw: string): void {
  totalMessagesReceived++;
  messagesThisWindow++;
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  const m = msg as {
    topic?: string;
    type?: string;
    payload?: {
      symbol?: string; value?: number; timestamp?: number;
      condition_id?: string; market_slug?: string; price?: number; side?: string;
    }
  };

  // 2026-04-24: route market_prices price_change events for new-listing detection
  if (m.topic === 'market_prices' && m.payload?.condition_id) {
    marketPricesReceived++;
    const cid = m.payload.condition_id;
    if (!seenConditionIds.has(cid)) {
      seenConditionIds.add(cid);
      // Only flag as priority if this is truly new (seen for first time in this session)
      // AND the engine has been running for >60s (skip initial cache warm-up backlog)
      try {
        insertPriority({
          condition_id: cid,
          priority: NEW_LISTING_PRIORITY_LEVEL,
          reason: 'rtds-new-listing: first price_change event on ' + (m.payload.market_slug ?? cid.substring(0, 12)),
          created_by: 'rtds-client',
          ttl_ms: NEW_LISTING_PRIORITY_TTL_MS,
        });
        newListingsFlagged++;
        if (newListingsFlagged <= 20 || newListingsFlagged % 10 === 0) {
          log.info({ condition_id: cid.substring(0, 16), market_slug: m.payload.market_slug?.substring(0, 40), total_new: newListingsFlagged }, 'RTDS: new listing flagged');
        }
      } catch (err) {
        // Non-fatal — if insert fails (e.g. FK constraint because market not yet in DB), we'll pick it up via sampling-poller anyway
      }
    }
    return;
  }

  if (m.topic !== 'equity_prices' || m.type !== 'update') return;
  const p = m.payload;
  if (!p?.symbol || typeof p.value !== 'number') return;

  const sym = p.symbol.toLowerCase();
  const price: RtdsPrice = {
    symbol: sym,
    value: p.value,
    timestamp: typeof p.timestamp === 'number' ? p.timestamp : Date.now(),
    received_at: Date.now(),
  };
  priceMap.set(sym, price);

  if (!firstSeen.has(sym)) {
    firstSeen.add(sym);
    log.info({ symbol: sym, value: p.value, total_symbols: firstSeen.size }, 'RTDS: new symbol observed');
  }
}

function connect(): void {
  if (isShuttingDown) return;
  try {
    log.info({ url: RTDS_URL }, 'RTDS: connecting');
    ws = new WebSocket(RTDS_URL);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'RTDS: WebSocket construction failed');
    scheduleReconnect();
    return;
  }

  ws.on('open', () => {
    log.info('RTDS: WebSocket open, sending subscription');
    reconnectAttempts = 0;
    const subMsg = {
      action: 'subscribe',
      subscriptions: [
        { topic: 'equity_prices', type: 'update' },
        { topic: 'market_prices', type: 'price_change' },   // 2026-04-24 added for sub-second new-listing detection
      ],
    };
    try {
      ws?.send(JSON.stringify(subMsg));
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'RTDS: send subscription failed');
    }
  });

  ws.on('message', (data: Buffer) => {
    handleMessage(data.toString());
  });

  ws.on('error', (err) => {
    log.warn({ err: err.message }, 'RTDS: WebSocket error');
  });

  ws.on('close', (code, reason) => {
    log.info({ code, reason: reason.toString().substring(0, 100) }, 'RTDS: WebSocket closed');
    ws = null;
    if (!isShuttingDown) scheduleReconnect();
  });
}

function scheduleReconnect(): void {
  if (isShuttingDown) return;
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log.warn({ attempts: reconnectAttempts }, 'RTDS: max reconnect attempts reached, giving up');
    return;
  }
  reconnectAttempts++;
  const delay = RECONNECT_DELAY_MS * Math.min(reconnectAttempts, 5);
  log.info({ attempt: reconnectAttempts, delay_ms: delay }, 'RTDS: scheduling reconnect');
  setTimeout(connect, delay);
}

/**
 * Start the RTDS client. Idempotent — safe to call multiple times.
 * Call once during engine.start().
 */
export function startRtds(): void {
  if (ws !== null) {
    log.debug('RTDS: already connected, start() is a no-op');
    return;
  }
  isShuttingDown = false;
  connect();

  // Periodic summary log + stale-entry GC every 60s
  if (!summaryTimer) {
    summaryTimer = setInterval(() => {
      // GC stale entries
      const cutoff = Date.now() - STALE_ENTRY_TTL_MS;
      let gcCount = 0;
      for (const [sym, p] of priceMap) {
        if (p.received_at < cutoff) {
          priceMap.delete(sym);
          gcCount++;
        }
      }
      if (messagesThisWindow > 0 || gcCount > 0) {
        log.info(
          {
            msgs_last_60s: messagesThisWindow,
            msgs_total: totalMessagesReceived,
            active_symbols: priceMap.size,
            total_symbols_seen: firstSeen.size,
            gc_count: gcCount,
          },
          'RTDS: heartbeat',
        );
      }
      messagesThisWindow = 0;
    }, 60_000);
  }
}

/**
 * Stop the RTDS client gracefully. Call during engine shutdown.
 */
export function stopRtds(): void {
  isShuttingDown = true;
  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
    ws = null;
  }
}

/**
 * Get the latest RTDS price for a symbol (e.g., 'xauusd', 'btcusd').
 * Returns null if symbol has never been observed or the last update
 * is older than STALE_ENTRY_TTL_MS (5 min).
 */
export function getRtdsPrice(symbol: string): RtdsPrice | null {
  const p = priceMap.get(symbol.toLowerCase());
  if (!p) return null;
  if (Date.now() - p.received_at > STALE_ENTRY_TTL_MS) return null;
  return p;
}

/**
 * List all symbols currently present in the cache (last 5 min of updates).
 * Use this to see what symbols the stream is delivering.
 */
export function getRtdsSymbols(): string[] {
  return Array.from(priceMap.keys()).sort();
}

/**
 * Diagnostic counters for dashboard / health endpoint.
 */
export function getRtdsStats(): {
  connected: boolean;
  messages_total: number;
  active_symbols: number;
  total_symbols_seen: number;
} {
  return {
    connected: ws !== null && ws.readyState === WebSocket.OPEN,
    messages_total: totalMessagesReceived,
    active_symbols: priceMap.size,
    total_symbols_seen: firstSeen.size,
  };
}
