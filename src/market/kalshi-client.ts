// Kalshi read-only price feed.
//
// R3a (2026-04-10). Kalshi is a CFTC-regulated prediction market. We do NOT
// trade on Kalshi (Polymarket is our venue); we READ Kalshi prices as a
// secondary probability estimator for ensemble blending with Polymarket.
// Per design-decisions §N2: when both venues have liquid markets on the same
// question and disagree by >4%, one of them is wrong and the divergence is
// an exploitable signal.
//
// API: Kalshi public endpoints, no auth required for market data.
//   Base URL:    https://api.elections.kalshi.com/trade-api/v2
//   Markets:     GET /markets?status=open&category={category}
//
// Matching Kalshi ↔ Polymarket: Jaccard token similarity on the question text,
// plus a category filter and close-date proximity. The matching table is
// cached for 24h per design-decisions §N2.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('kalshi');

const BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';
const DEFAULT_CATEGORIES = ['POLITICS', 'ECONOMICS', 'FINANCE', 'CLIMATE', 'WORLD'] as const;
const MIN_REQUEST_INTERVAL_MS = 10 * 60 * 1000; // 10 min per category
const MATCHING_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Exponential backoff on 429/5xx: base delay × 2^attempt, capped.
// 2026-04-10: R&D was hitting Kalshi 429s every scan because 5 categories
// got fetched in parallel and Kalshi rate-limits per IP. Backoff + jitter
// keeps the client polite even under bursty polling.
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;
const MAX_RETRIES = 4;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface KalshiMarket {
  ticker: string;
  title: string;
  subtitle: string;
  yesPrice: number;   // 0-1 (normalized)
  noPrice: number;    // 0-1 (normalized)
  yesBid: number;
  yesAsk: number;
  volume: number;     // trailing 24h
  openInterest: number;
  closeTime: string;  // ISO
  category: string;
  status: string;
}

export interface MarketMatch {
  polyConditionId: string;
  polyQuestion: string;
  kalshiTicker: string;
  kalshiTitle: string;
  similarity: number;      // Jaccard [0, 1]
  matchedAt: number;
}

export class KalshiClient {
  private cache = new Map<string, { markets: KalshiMarket[]; at: number }>();
  private lastRequest = new Map<string, number>();
  private matchingCache = new Map<string, MarketMatch>();

  constructor(private readonly baseUrl: string = BASE_URL) {}

  /**
   * Fetch all active markets in the given category. Cached for 10 minutes
   * per category to stay well under any rate limit.
   */
  async getMarkets(category: string): Promise<KalshiMarket[]> {
    const last = this.lastRequest.get(category) ?? 0;
    const cached = this.cache.get(category);
    if (Date.now() - last < MIN_REQUEST_INTERVAL_MS && cached) {
      return cached.markets;
    }

    const url = `${this.baseUrl}/markets?status=open&category=${category}&limit=500`;

    // Retry with exponential backoff on 429/5xx. Use cached data when all
    // attempts fail so the rest of the engine keeps moving.
    let raw: { markets?: Array<Record<string, unknown>> } | null = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
        if (res.ok) {
          raw = (await res.json()) as { markets?: Array<Record<string, unknown>> };
          break;
        }
        // Retry on 429 (rate limit) and 5xx; give up on 4xx other than 429.
        const shouldRetry = res.status === 429 || (res.status >= 500 && res.status < 600);
        if (!shouldRetry || attempt === MAX_RETRIES) {
          log.warn({ category, status: res.status, attempt }, 'Kalshi fetch failed (final)');
          return cached?.markets ?? [];
        }
        // Honor Retry-After header if present, else exponential + jitter.
        const retryAfterHeader = res.headers.get('Retry-After');
        const retryAfterMs = retryAfterHeader ? Math.min(BACKOFF_MAX_MS, parseInt(retryAfterHeader, 10) * 1000) : 0;
        const backoff = Math.min(
          BACKOFF_MAX_MS,
          BACKOFF_BASE_MS * Math.pow(2, attempt) + Math.floor(Math.random() * 500),
        );
        const delay = Math.max(retryAfterMs, backoff);
        log.debug({ category, status: res.status, attempt, delay }, 'Kalshi backoff');
        await sleep(delay);
      } catch (err) {
        if (attempt === MAX_RETRIES) {
          log.warn({ category, err: err instanceof Error ? err.message : String(err) }, 'Kalshi request threw (final)');
          return cached?.markets ?? [];
        }
        const backoff = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, attempt));
        await sleep(backoff);
      }
    }
    if (!raw) return cached?.markets ?? [];

    try {
      const markets: KalshiMarket[] = (raw.markets ?? []).map(m => ({
        ticker: String(m.ticker ?? ''),
        title: String(m.title ?? ''),
        subtitle: String(m.subtitle ?? ''),
        yesPrice: Number(m.last_price ?? m.yes_price ?? 0) / 100,
        noPrice: 1 - Number(m.last_price ?? m.yes_price ?? 0) / 100,
        yesBid: Number(m.yes_bid ?? 0) / 100,
        yesAsk: Number(m.yes_ask ?? 0) / 100,
        volume: Number(m.volume_24h ?? 0),
        openInterest: Number(m.open_interest ?? 0),
        closeTime: String(m.close_time ?? ''),
        category: String(m.category ?? category),
        status: String(m.status ?? 'open'),
      }));
      this.cache.set(category, { markets, at: Date.now() });
      this.lastRequest.set(category, Date.now());
      return markets;
    } catch (err) {
      log.warn({ category, err: err instanceof Error ? err.message : String(err) }, 'Kalshi request threw');
      return cached?.markets ?? [];
    }
  }

  /**
   * Fetch markets across all tracked categories, return as a flat list.
   */
  async getAllMarkets(categories: readonly string[] = DEFAULT_CATEGORIES): Promise<KalshiMarket[]> {
    const results = await Promise.all(categories.map(c => this.getMarkets(c)));
    return results.flat();
  }

  /**
   * Find a Kalshi market that matches a Polymarket question via Jaccard
   * similarity on title tokens. Returns null if no good match exists.
   *
   * Caches matches for 24h so we don't re-do the O(N*M) matching every cycle.
   */
  findMatch(
    polyConditionId: string,
    polyQuestion: string,
    kalshiMarkets: KalshiMarket[],
    threshold = 0.40,
  ): MarketMatch | null {
    const cacheKey = polyConditionId;
    const cached = this.matchingCache.get(cacheKey);
    if (cached && Date.now() - cached.matchedAt < MATCHING_CACHE_TTL_MS) {
      return cached;
    }

    const polyTokens = tokenize(polyQuestion);
    if (polyTokens.size === 0) return null;

    let best: MarketMatch | null = null;
    for (const km of kalshiMarkets) {
      const kTokens = tokenize(km.title);
      if (kTokens.size === 0) continue;
      const sim = jaccardSimilarity(polyTokens, kTokens);
      if (sim < threshold) continue;
      if (!best || sim > best.similarity) {
        best = {
          polyConditionId,
          polyQuestion,
          kalshiTicker: km.ticker,
          kalshiTitle: km.title,
          similarity: sim,
          matchedAt: Date.now(),
        };
      }
    }

    if (best) this.matchingCache.set(cacheKey, best);
    return best;
  }

  /**
   * Cross-market divergence signal: given a matched (Polymarket, Kalshi) pair
   * and their current prices, return the ensemble-blended probability and the
   * absolute divergence between the two venues.
   */
  computeEnsemble(polyPrice: number, kalshiYesPrice: number, polyVolume24h = 0, kalshiVolume = 0): {
    blendedProb: number;
    divergence: number;
    polyWeight: number;
    kalshiWeight: number;
  } {
    const MIN_LIQUID_VOL = 2000; // below this Kalshi side contributes less
    let kalshiWeight = 0.5;
    if (kalshiVolume < MIN_LIQUID_VOL) kalshiWeight = 0.3;
    if (polyVolume24h < MIN_LIQUID_VOL) kalshiWeight = Math.max(kalshiWeight, 0.5); // poly thin → lean kalshi
    const polyWeight = 1 - kalshiWeight;
    const blendedProb = polyWeight * polyPrice + kalshiWeight * kalshiYesPrice;
    const divergence = Math.abs(polyPrice - kalshiYesPrice);
    return { blendedProb, divergence, polyWeight, kalshiWeight };
  }
}

// ─── Helpers ────────────────────────────────────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'by', 'with',
  'will', 'be', 'is', 'are', 'was', 'were', 'has', 'have', 'had',
  'and', 'or', 'but', 'if', 'than', 'that', 'this', 'these', 'those',
  'at', 'from', 'as', 'its', 'it', 'do', 'does', 'did',
]);

function tokenize(text: string): Set<string> {
  const lowered = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
  const tokens = lowered.split(/\s+/).filter(t => t.length > 2 && !STOPWORDS.has(t));
  return new Set(tokens);
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
