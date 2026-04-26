/**
 * tick-recorder.ts — Polymarket CLOB tick recorder service
 *
 * Subscribes to the CLOB WebSocket market channel for all active token IDs,
 * writes every event to the `market_ticks` SQLite table, and applies
 * DataSanitizer rules before insert:
 *   - Reject stale events (ingestion lag > 50 ms)
 *   - Reject out-of-order events (server_ts < last seen for that token)
 *   - Reject price anomalies (>5% jump vs previous price in <500 ms)
 *
 * Runs as a long-lived daemon; systemd restarts on failure.
 * Uses its own SQLite connection (WAL mode, separate from engine singleton).
 *
 * Deploy: /opt/polybot-v3/src/services/tick-recorder.ts
 * Build:  included in tsconfig + bun build
 * Start:  systemd polybot-tick-recorder.service
 */

import { WebSocket } from 'ws';
import Database from 'better-sqlite3';
import { resolve, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import pino from 'pino';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DB_PATH = process.env.POLYBOT_DB ?? '/opt/polybot-v3/data/polybot.db';
const WS_URL  = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const RECONNECT_DELAY_MS    = 5_000;
const PING_INTERVAL_MS      = 30_000;
const RESUBSCRIBE_INTERVAL_MS = 5 * 60 * 1_000;  // refresh token list every 5 min
const MAX_STALE_MS          = 50;    // DataSanitizer: drop if ingest lag > 50 ms
const MAX_PRICE_JUMP_PCT    = 0.05;  // DataSanitizer: drop if >5% jump in <500 ms
const MAX_JUMP_WINDOW_MS    = 500;   // window for anomaly detection

const log = pino({
  transport: { target: 'pino-pretty', options: { colorize: false } },
  level: process.env.LOG_LEVEL ?? 'info',
  base: { svc: 'tick-recorder' },
});

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------
function openDb(): Database.Database {
  const path = resolve(DB_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -32000');
  db.exec(`
    CREATE TABLE IF NOT EXISTS market_ticks (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      token_id     TEXT    NOT NULL,
      condition_id TEXT,
      ts_ms        INTEGER NOT NULL,
      received_ms  INTEGER NOT NULL,
      event_type   TEXT    NOT NULL,
      price        REAL,
      side         TEXT,
      size         REAL,
      best_bid     REAL,
      best_ask     REAL,
      payload_json TEXT,
      created_at   TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_mt_token_ts ON market_ticks(token_id, ts_ms);
    CREATE INDEX IF NOT EXISTS idx_mt_cond_ts  ON market_ticks(condition_id, ts_ms);
  `);
  log.info({ path }, 'DB ready');
  return db;
}

// ---------------------------------------------------------------------------
// DataSanitizer state
// ---------------------------------------------------------------------------
interface TokenState {
  lastTs: number;
  lastPrice: number | null;
  lastPriceTs: number;
}
const tokenState = new Map<string, TokenState>();

function sanitize(
  tokenId: string,
  receivedMs: number,
  serverTs: number | null,
  price: number | null,
): { ok: boolean; reason?: string } {
  const now = receivedMs;
  const ts  = serverTs ?? now;

  // 1. Stale check (only when server provides a timestamp)
  if (serverTs !== null && now - serverTs > MAX_STALE_MS) {
    return { ok: false, reason: `stale: lag=${now - serverTs}ms > ${MAX_STALE_MS}ms` };
  }

  const st = tokenState.get(tokenId);

  // 2. Out-of-order check
  if (st && ts < st.lastTs) {
    return { ok: false, reason: `out-of-order: ts=${ts} < last=${st.lastTs}` };
  }

  // 3. Price anomaly check
  if (price !== null && st?.lastPrice !== null && st?.lastPrice !== undefined) {
    const dt = ts - st.lastPriceTs;
    if (dt >= 0 && dt < MAX_JUMP_WINDOW_MS) {
      const jump = Math.abs(price - st.lastPrice) / (st.lastPrice || 1);
      if (jump > MAX_PRICE_JUMP_PCT) {
        return { ok: false, reason: `anomaly: jump=${(jump * 100).toFixed(1)}% in ${dt}ms` };
      }
    }
  }

  // Update state
  const newSt: TokenState = {
    lastTs: Math.max(st?.lastTs ?? 0, ts),
    lastPrice: price ?? st?.lastPrice ?? null,
    lastPriceTs: price !== null ? ts : (st?.lastPriceTs ?? 0),
  };
  tokenState.set(tokenId, newSt);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Tick recorder
// ---------------------------------------------------------------------------
class TickRecorder {
  private db: Database.Database;
  private ws: WebSocket | null = null;
  private subscribed = new Map<string, string>(); // tokenId → conditionId
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private resubTimer: ReturnType<typeof setInterval> | null = null;
  private reconnTimer: ReturnType<typeof setTimeout> | null = null;
  private shutdown = false;
  private insertStmt: Database.Statement;

  // Stats
  private statsTotal  = 0;
  private statsDropped = 0;
  private statsInserted = 0;
  private statsWindow = 0;

  constructor(db: Database.Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT INTO market_ticks
        (token_id, condition_id, ts_ms, received_ms, event_type,
         price, side, size, best_bid, best_ask, payload_json)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `);
  }

  /** Load active token IDs from DB and (re)subscribe */
  refreshSubscriptions(): void {
    type Row = { token_yes_id: string; token_no_id: string; condition_id: string };
    const rows = this.db
      .prepare(`SELECT token_yes_id, token_no_id, condition_id
                FROM markets
                WHERE active = 1 AND closed = 0
                  AND end_date > datetime('now', '-2 hours')
                LIMIT 1000`)
      .all() as Row[];

    const wanted = new Map<string, string>();
    for (const r of rows) {
      if (r.token_yes_id) wanted.set(r.token_yes_id, r.condition_id);
      if (r.token_no_id)  wanted.set(r.token_no_id,  r.condition_id);
    }

    // Subscribe new tokens
    let newCount = 0;
    for (const [tid, cid] of Array.from(wanted)) {
      if (!this.subscribed.has(tid)) {
        this.subscribe(tid, cid);
        newCount++;
      }
    }

    // Unsubscribe gone tokens
    let goneCount = 0;
    for (const [tid] of Array.from(this.subscribed)) {
      if (!wanted.has(tid)) {
        this.unsubscribe(tid);
        goneCount++;
      }
    }

    if (newCount || goneCount) {
      log.info({ total: wanted.size, new: newCount, removed: goneCount }, 'Subscriptions refreshed');
    }
  }

  private subscribe(tokenId: string, conditionId: string): void {
    this.subscribed.set(tokenId, conditionId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        assets_ids: [tokenId],
        type: 'market',
      }));
    }
  }

  private unsubscribe(tokenId: string): void {
    this.subscribed.delete(tokenId);
    // CLOB WS doesn't support per-token unsubscribe; token just drifts silent
  }

  connect(): void {
    if (this.ws || this.shutdown) return;
    log.info({ url: WS_URL }, 'Connecting');
    this.ws = new WebSocket(WS_URL, { handshakeTimeout: 10_000 });

    this.ws.on('open', () => {
      log.info('Connected — resubscribing all tokens');
      this.startPing();
      // Send all subscriptions in batches of 100
      const tids = [...this.subscribed.keys()];
      for (let i = 0; i < tids.length; i += 100) {
        this.ws!.send(JSON.stringify({
          assets_ids: tids.slice(i, i + 100),
          type: 'market',
        }));
      }
    });

    this.ws.on('message', (data) => {
      this.handleMessage(data.toString());
    });

    this.ws.on('pong', () => {/* keep-alive confirmed */});

    this.ws.on('error', (err) => {
      log.warn({ err: err.message }, 'WebSocket error');
    });

    this.ws.on('close', (code, reason) => {
      log.warn({ code, reason: reason.toString() }, 'WebSocket closed');
      this.stopPing();
      this.ws = null;
      if (!this.shutdown) this.scheduleReconnect();
    });
  }

  private handleMessage(raw: string): void {
    const receivedMs = Date.now();
    this.statsTotal++;
    this.statsWindow++;

    let msg: RawMsg;
    try {
      msg = JSON.parse(raw) as RawMsg;
    } catch {
      return;
    }

    // CLOB sends an array of events OR a single event
    const events: RawMsg[] = Array.isArray(msg) ? msg : [msg];

    for (const ev of events) {
      const tokenId = ev.asset_id ?? ev.assets_id ?? '';
      if (!tokenId) continue;

      const conditionId = this.subscribed.get(tokenId) ?? null;
      const evType      = ev.event_type ?? ev.type ?? 'unknown';

      // Extract price from various event shapes
      let price: number | null = null;
      let side: string | null = null;
      let size: number | null = null;
      let bestBid: number | null = null;
      let bestAsk: number | null = null;
      let serverTs: number | null = null;

      if (ev.price !== undefined)           price = Number(ev.price);
      if (ev.last_trade_price !== undefined) price = Number(ev.last_trade_price);
      if (ev.outcome_price !== undefined)    price = Number(ev.outcome_price);
      if (ev.side !== undefined)             side  = ev.side;
      if (ev.size !== undefined)             size  = Number(ev.size);
      if (ev.timestamp !== undefined)        serverTs = Number(ev.timestamp);
      if (ev.timestampISO !== undefined)     serverTs = new Date(ev.timestampISO).getTime();

      // Orderbook snapshot
      if (ev.bids?.length) bestBid = Number(ev.bids[0][0]);
      if (ev.asks?.length) bestAsk = Number(ev.asks[0][0]);

      // DataSanitizer
      const { ok, reason } = sanitize(tokenId, receivedMs, serverTs, price);
      if (!ok) {
        this.statsDropped++;
        if (this.statsDropped % 500 === 0) {
          log.debug({ reason, dropped: this.statsDropped }, 'DataSanitizer drop');
        }
        continue;
      }

      // Write to DB
      try {
        this.insertStmt.run(
          tokenId,
          conditionId,
          serverTs ?? receivedMs,
          receivedMs,
          evType,
          price,
          side,
          size,
          bestBid,
          bestAsk,
          JSON.stringify(ev),
        );
        this.statsInserted++;
      } catch (err) {
        log.error({ err }, 'Insert error');
      }
    }
  }

  startTimers(): void {
    // Refresh subscription list every 5 min
    this.resubTimer = setInterval(() => this.refreshSubscriptions(), RESUBSCRIBE_INTERVAL_MS);

    // Stats log every 60 s
    setInterval(() => {
      log.info({
        total: this.statsTotal,
        inserted: this.statsInserted,
        dropped: this.statsDropped,
        window: this.statsWindow,
        tokens: this.subscribed.size,
      }, 'Tick stats');
      this.statsWindow = 0;
    }, 60_000);
  }

  stopAll(): void {
    this.shutdown = true;
    if (this.reconnTimer)  clearTimeout(this.reconnTimer);
    if (this.pingTimer)    clearInterval(this.pingTimer);
    if (this.resubTimer)   clearInterval(this.resubTimer);
    this.ws?.close(1000, 'shutdown');
    this.db.close();
    log.info('Tick recorder stopped');
  }

  private scheduleReconnect(): void {
    if (this.reconnTimer) return;
    log.info({ delay: RECONNECT_DELAY_MS }, 'Reconnecting in 5s');
    this.reconnTimer = setTimeout(() => {
      this.reconnTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.ping();
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }
}

// ---------------------------------------------------------------------------
// Raw WebSocket message shape (Polymarket CLOB market channel)
// ---------------------------------------------------------------------------
interface RawMsg {
  // Event identification
  event_type?: string;
  type?: string;
  // Token identification
  asset_id?: string;
  assets_id?: string;
  // Price data
  price?: string | number;
  last_trade_price?: string | number;
  outcome_price?: string | number;
  // Trade data
  side?: string;
  size?: string | number;
  // Orderbook
  bids?: [string, string][];
  asks?: [string, string][];
  // Timestamps
  timestamp?: string | number;
  timestampISO?: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
const db = openDb();
const recorder = new TickRecorder(db);

// Initial subscription load
recorder.refreshSubscriptions();

// Connect and start timers
recorder.connect();
recorder.startTimers();

log.info({ db: DB_PATH, ws: WS_URL }, 'Tick recorder started');

// Graceful shutdown
process.on('SIGTERM', () => { recorder.stopAll(); process.exit(0); });
process.on('SIGINT',  () => { recorder.stopAll(); process.exit(0); });
