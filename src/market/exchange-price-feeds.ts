// Exchange price feeds — Binance, Coinbase, and Polymarket Chainlink.
//
// R4 (2026-04-12). Adapted from KaustubhPatange/polymarket-trade-engine
// tracker/ticker.ts (MIT license). Simplified for our scout architecture:
// we poll HTTP endpoints on a 30-60s cadence rather than maintaining
// persistent WebSocket connections, because:
//
//   1. Our scout tick is 60s — sub-second WS latency doesn't help when
//      the consumer only runs once a minute
//   2. WS connections on free endpoints are flaky and require reconnect
//      logic + heartbeat monitoring
//   3. HTTP polls are stateless and fail cleanly (scout just skips the
//      tick if a feed is down)
//
// Each feed returns a BtcPriceSnapshot with price + timestamp. The
// divergence scout compares all three and flags when they disagree by
// more than a configurable threshold.
//
// Future upgrade: when we invest in WebSocket infrastructure for the
// Bayesian-Stoikov MM strategy (R5 research — needs 100-500ms refresh),
// these feeds should be upgraded to persistent WS connections that push
// price updates to an in-memory ring buffer. The scout would then read
// the buffer instead of polling.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('exchange-price-feeds');

export interface BtcPriceSnapshot {
  source: 'binance' | 'coinbase' | 'chainlink';
  price: number;
  timestamp: number; // unix ms
}

export interface ExchangePriceSet {
  binance: BtcPriceSnapshot | null;
  coinbase: BtcPriceSnapshot | null;
  chainlink: BtcPriceSnapshot | null;
  fetchedAt: number;
}

const TIMEOUT_MS = 5_000;

/**
 * Fetch BTC/USDT last price from Binance REST API.
 * Endpoint: GET /api/v3/ticker/price?symbol=BTCUSDT
 * Returns: { symbol: "BTCUSDT", price: "12345.67" }
 */
export async function fetchBinancePrice(): Promise<BtcPriceSnapshot | null> {
  try {
    const resp = await fetch(
      'https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT',
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { price?: string };
    const price = parseFloat(data.price ?? '');
    if (!Number.isFinite(price) || price <= 0) return null;
    return { source: 'binance', price, timestamp: Date.now() };
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err) }, 'Binance fetch failed');
    return null;
  }
}

/**
 * Fetch BTC-USD last trade price from Coinbase REST API.
 * Endpoint: GET /products/BTC-USD/ticker
 * Returns: { price: "12345.67", ... }
 */
export async function fetchCoinbasePrice(): Promise<BtcPriceSnapshot | null> {
  try {
    const resp = await fetch(
      'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
      {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; polybot-v3/1.0)' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      },
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { price?: string };
    const price = parseFloat(data.price ?? '');
    if (!Number.isFinite(price) || price <= 0) return null;
    return { source: 'coinbase', price, timestamp: Date.now() };
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err) }, 'Coinbase fetch failed');
    return null;
  }
}

/**
 * Fetch BTC price from Polymarket's Chainlink oracle relay.
 *
 * The relay endpoint is at wss://ws-live-data.polymarket.com — but
 * since we're polling (not maintaining a WS), we use CoinGecko as a
 * proxy for the Chainlink oracle price. CoinGecko aggregates Chainlink
 * + other oracles and updates every ~60s, which matches our scout cadence.
 *
 * If Polymarket ever exposes a REST endpoint for their Chainlink feed,
 * we should switch to that for a purer signal.
 */
export async function fetchChainlinkPrice(): Promise<BtcPriceSnapshot | null> {
  try {
    const resp = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd',
      { signal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { bitcoin?: { usd?: number } };
    const price = data.bitcoin?.usd;
    if (!price || !Number.isFinite(price) || price <= 0) return null;
    return { source: 'chainlink', price, timestamp: Date.now() };
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err) }, 'Chainlink/CoinGecko fetch failed');
    return null;
  }
}

/**
 * Fetch all three prices in parallel. Returns whatever succeeds.
 * At least 2 of 3 must succeed for a useful divergence comparison.
 */
export async function fetchAllPrices(): Promise<ExchangePriceSet> {
  const [binance, coinbase, chainlink] = await Promise.all([
    fetchBinancePrice(),
    fetchCoinbasePrice(),
    fetchChainlinkPrice(),
  ]);
  return { binance, coinbase, chainlink, fetchedAt: Date.now() };
}

/**
 * Compute the consensus price (mean of available sources) and the
 * maximum pairwise divergence as a percentage. Returns null if fewer
 * than 2 sources are available.
 */
export function computeDivergence(prices: ExchangePriceSet): {
  consensus: number;
  maxDivergencePct: number;
  sources: number;
  details: string;
} | null {
  const available: BtcPriceSnapshot[] = [];
  if (prices.binance) available.push(prices.binance);
  if (prices.coinbase) available.push(prices.coinbase);
  if (prices.chainlink) available.push(prices.chainlink);

  if (available.length < 2) return null;

  const sum = available.reduce((s, p) => s + p.price, 0);
  const consensus = sum / available.length;

  // Max pairwise divergence
  let maxDiv = 0;
  let maxPair = '';
  for (let i = 0; i < available.length; i++) {
    for (let j = i + 1; j < available.length; j++) {
      const a = available[i]!;
      const b = available[j]!;
      const div = Math.abs(a.price - b.price) / consensus;
      if (div > maxDiv) {
        maxDiv = div;
        maxPair = `${a.source}(${a.price.toFixed(2)}) vs ${b.source}(${b.price.toFixed(2)})`;
      }
    }
  }

  return {
    consensus,
    maxDivergencePct: maxDiv,
    sources: available.length,
    details: maxPair,
  };
}
