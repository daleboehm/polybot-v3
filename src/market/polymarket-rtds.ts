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

// 2026-04-24: market_prices topic DOES NOT EXIST on Polymarket RTDS. Server returns 401.
// New-listing detection stays on sampling-poller (now 20s cadence). Finding logged in docs.

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


  // 2026-04-24 diagnostic: log any unexpected topic we're receiving for protocol discovery
  if (m.topic && m.topic !== 'equity_prices' && m.topic !== 'market_prices') {
    if (Math.random() < 0.02) {  // 2% sample to avoid log flood
      log.info({ topic: m.topic, type: m.type, payload_keys: m.payload ? Object.keys(m.payload).slice(0, 6) : [] }, 'RTDS: unknown topic observed (protocol discovery)');
    }
    return;
  }
  // 2026-04-24: crypto_prices topic exists and streams e.g. xrpusdt @ ~6/sec.
  // Store in same priceMap so getRtdsPrice('btcusdt') / getRtdsPrice('ethusdt') etc. works.
  if (m.topic === 'crypto_prices' && m.type === 'update') {
    const cp = m.payload;
    if (!cp?.symbol || typeof cp.value !== 'number') return;
    const symC = cp.symbol.toLowerCase();
    priceMap.set(symC, {
      symbol: symC,
      value: cp.value,
      timestamp: typeof cp.timestamp === 'number' ? cp.timestamp : Date.now(),
      received_at: Date.now(),
    });
    if (!firstSeen.has(symC)) {
      firstSeen.add(symC);
      log.info({ symbol: symC, value: cp.value, total_symbols: firstSeen.size }, 'RTDS: new crypto symbol observed');
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
        { topic: 'crypto_prices', type: 'update' },   // 2026-04-24: real-time Polymarket crypto spot feed — replaces external Binance for oracle-lag checks
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
