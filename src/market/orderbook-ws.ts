// WebSocket manager for real-time orderbook and trade feeds

import WebSocket from 'ws';
import type { OrderBookSnapshot, OrderBookLevel } from '../types/index.js';
import { eventBus } from '../core/event-bus.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('orderbook-ws');

const RECONNECT_DELAY_MS = 5000;
const PING_INTERVAL_MS = 30_000;

export class OrderbookWebSocket {
  private ws: WebSocket | null = null;
  private subscriptions = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private isShutdown = false;

  constructor(private wsUrl: string) {}

  async connect(): Promise<void> {
    if (this.ws) return;
    this.isShutdown = false;

    return new Promise((resolve, reject) => {
      log.info({ url: this.wsUrl }, 'Connecting WebSocket');

      this.ws = new WebSocket(this.wsUrl);

      this.ws.on('open', () => {
        log.info('WebSocket connected');
        this.startPing();
        // Re-subscribe after reconnect
        for (const tokenId of this.subscriptions) {
          this.sendSubscribe(tokenId);
        }
        resolve();
      });

      this.ws.on('message', (data) => {
        this.handleMessage(data.toString());
      });

      this.ws.on('error', (err) => {
        log.error({ err }, 'WebSocket error');
        reject(err);
      });

      this.ws.on('close', (code, reason) => {
        log.warn({ code, reason: reason.toString() }, 'WebSocket closed');
        this.stopPing();
        this.ws = null;
        if (!this.isShutdown) this.scheduleReconnect();
      });
    });
  }

  subscribe(tokenId: string): void {
    this.subscriptions.add(tokenId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(tokenId);
    }
  }

  unsubscribe(tokenId: string): void {
    this.subscriptions.delete(tokenId);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe', channel: 'book', assets_id: tokenId }));
    }
  }

  disconnect(): void {
    this.isShutdown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopPing();
    if (this.ws) {
      this.ws.close(1000, 'shutdown');
      this.ws = null;
    }
    this.subscriptions.clear();
    log.info('WebSocket disconnected');
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  get subscribedCount(): number {
    return this.subscriptions.size;
  }

  private sendSubscribe(tokenId: string): void {
    this.ws?.send(JSON.stringify({
      type: 'subscribe',
      channel: 'book',
      assets_id: tokenId,
    }));
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as WsMessage;
      if (msg.channel === 'book' && msg.data) {
        const book = this.parseOrderbook(msg.assets_id, msg.data);
        if (book) {
          eventBus.emit('orderbook:snapshot', { token_id: msg.assets_id, book });
        }
      }
    } catch {
      // ignore malformed messages
    }
  }

  private parseOrderbook(tokenId: string, data: WsBookData): OrderBookSnapshot | null {
    const bids: OrderBookLevel[] = (data.bids ?? []).map(([price, size]) => ({
      price: Number(price),
      size: Number(size),
    }));
    const asks: OrderBookLevel[] = (data.asks ?? []).map(([price, size]) => ({
      price: Number(price),
      size: Number(size),
    }));

    const bestBid = bids.length > 0 ? bids[0].price : null;
    const bestAsk = asks.length > 0 ? asks[0].price : null;
    const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
    const midpoint = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : null;

    return {
      token_id: tokenId,
      bids,
      asks,
      best_bid: bestBid,
      best_ask: bestAsk,
      spread,
      midpoint,
      timestamp: Date.now(),
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    log.info({ delay: RECONNECT_DELAY_MS }, 'Scheduling reconnect');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(err => {
        log.error({ err }, 'Reconnect failed');
        this.scheduleReconnect();
      });
    }, RECONNECT_DELAY_MS);
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

interface WsMessage {
  channel: string;
  assets_id: string;
  data?: WsBookData;
}

interface WsBookData {
  bids?: [string, string][];
  asks?: [string, string][];
}
