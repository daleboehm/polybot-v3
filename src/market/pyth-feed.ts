// Pyth Network secondary oracle — 2026-04-21.
//
// Free public Hermes API at https://hermes.pyth.network. No auth required.
// Provides parsed price + EMA + confidence intervals for crypto, equities,
// commodities, FX, ETFs.
//
// Use cases:
//   - Secondary oracle alongside our RTDS feed for rtds_forecast
//   - Crypto-asset confirmation source for crypto_price (BTC/ETH/SOL/XRP)
//   - Resolution-source cross-check (Pyth is becoming Polymarket's
//     standard for non-crypto resolution per April 2026 announcement)
//
// Pull pattern: cached 30s per feed. Caller asks getPythPrice(symbol);
// we return last cached value if fresh, else fetch.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('pyth-feed');

// Pyth Hermes feed IDs (mainnet). Looked up via
// https://hermes.pyth.network/v2/price_feeds. Static map for the
// symbols we care about; expand as needed.
const PYTH_FEED_IDS: Record<string, string> = {
  // Crypto
  btcusd: 'e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  ethusd: 'ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  solusd: 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
  xrpusd: 'ec5d399846a9209f3fe5881d70aae9268c94339ff9817e8d18ff19fa05eea1c8',
  // Commodities — overlap with our RTDS feed for cross-validation
  xauusd: '765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2',
  xagusd: 'f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e',
  // FX
  eurusd: 'a995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b',
  gbpusd: '84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1',
  // ETFs / equities (added by Pyth April 2026 expansion)
  spy: '19e09bb805456ada3979a7d1cbb4b6d63babc3a0f8e8a9509f68afa5c4c11cd5',
};

interface PythPrice {
  symbol: string;
  feed_id: string;
  price: number; // human-readable (post-expo applied)
  conf: number; // confidence interval, same units as price
  publish_time: number; // unix seconds
  fetched_at: number;
}

const cache = new Map<string, PythPrice>();
const CACHE_TTL_MS = 30 * 1000; // 30s — Pyth updates ~1Hz

export async function getPythPrice(symbol: string): Promise<PythPrice | null> {
  const key = symbol.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) return cached;

  const feedId = PYTH_FEED_IDS[key];
  if (!feedId) return null;

  try {
    const url = 'https://hermes.pyth.network/v2/updates/price/latest?ids[]=' + feedId;
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;

    const data = await response.json() as {
      parsed?: Array<{
        id: string;
        price: { price: string; conf: string; expo: number; publish_time: number };
      }>;
    };
    const p = data.parsed?.[0]?.price;
    if (!p) return null;

    const expo = p.expo;
    const factor = Math.pow(10, expo); // expo is negative; price * factor gives human value
    const value: PythPrice = {
      symbol: key,
      feed_id: feedId,
      price: parseFloat(p.price) * factor,
      conf: parseFloat(p.conf) * factor,
      publish_time: p.publish_time,
      fetched_at: Date.now(),
    };
    cache.set(key, value);
    log.debug({ symbol: key, price: value.price, conf: value.conf }, 'Pyth price fetched');
    return value;
  } catch (err) {
    log.debug({ symbol: key, err: err instanceof Error ? err.message : String(err) }, 'Pyth fetch failed');
    return null;
  }
}

/** List symbols we have Pyth feeds configured for. */
export function getPythSymbols(): string[] {
  return Object.keys(PYTH_FEED_IDS);
}
