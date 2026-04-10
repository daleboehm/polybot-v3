// FRED (Federal Reserve Economic Data) client.
//
// R3a (2026-04-10). FRED is the St. Louis Fed's open economic data portal.
// It provides authoritative macro data (interest rates, CPI, unemployment,
// GDP) that drives Polymarket macro markets. Per design-decisions §N3:
// when a Polymarket market asks "Will the Fed cut rates in December?", FRED
// has the actual Fed Funds rate and the dot plot — retail traders don't
// look at those, so a simple Fed reaction function beats market consensus
// on 10-30 macro markets at any given time.
//
// API: free, requires a no-cost API key at https://fred.stlouisfed.org/docs/api/api_key.html
// Env var: FRED_API_KEY
//
// Refresh cadence: daily at 08:30 ET (after CPI/NFP release windows).
// Usage: ~30 requests/month. Trivially under any rate limit.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('fred');

const BASE_URL = 'https://api.stlouisfed.org/fred';

// Series we track for the macro-forecast strategy.
export const TRACKED_SERIES = {
  FED_FUNDS_TARGET: 'DFEDTARU',      // Federal Funds target (upper bound)
  FED_FUNDS_EFFECTIVE: 'DFF',        // Effective Federal Funds Rate (daily)
  FED_FUNDS_MONTHLY: 'FEDFUNDS',     // Monthly average
  CPI_ALL_URBAN: 'CPIAUCSL',         // Consumer Price Index, all urban
  UNEMPLOYMENT: 'UNRATE',            // U-3 Unemployment Rate
  TREASURY_10Y: 'DGS10',             // 10-Year Treasury yield
  TREASURY_2Y: 'DGS2',               // 2-Year Treasury yield (for curve inversion)
  GDP: 'GDP',                        // Gross Domestic Product
} as const;

export type FredSeriesKey = keyof typeof TRACKED_SERIES;

export interface FredObservation {
  date: string;   // ISO date
  value: number;
}

export interface FredSnapshot {
  seriesId: string;
  latest: FredObservation;
  previous: FredObservation | null;
  monthAgo: FredObservation | null;
  yearAgo: FredObservation | null;
  trailing3moChange: number;
  trailing12moChange: number;
  fetchedAt: number;
}

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000; // 1 day

export class FredClient {
  private readonly apiKey: string | null;
  private cache = new Map<string, FredSnapshot>();

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.FRED_API_KEY ?? null;
    if (!this.apiKey) {
      log.warn('FRED_API_KEY not set — FRED client will return null for all series');
    }
  }

  async getSeries(seriesKey: FredSeriesKey): Promise<FredSnapshot | null> {
    if (!this.apiKey) return null;

    const seriesId = TRACKED_SERIES[seriesKey];
    const cached = this.cache.get(seriesId);
    if (cached && Date.now() - cached.fetchedAt < REFRESH_INTERVAL_MS) return cached;

    try {
      // Pull trailing 13 months to compute 3mo + 12mo changes
      const observationStart = new Date(Date.now() - 395 * 24 * 60 * 60 * 1000)
        .toISOString()
        .split('T')[0];
      const url = `${BASE_URL}/series/observations?series_id=${seriesId}&api_key=${this.apiKey}&file_type=json&observation_start=${observationStart}`;
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        log.warn({ seriesId, status: res.status }, 'FRED fetch failed');
        return cached ?? null;
      }

      const raw = (await res.json()) as { observations?: Array<{ date: string; value: string }> };
      const obs = (raw.observations ?? [])
        .filter(o => o.value && o.value !== '.')
        .map(o => ({ date: o.date, value: Number(o.value) }));

      if (obs.length === 0) {
        log.warn({ seriesId }, 'FRED returned no observations');
        return null;
      }

      obs.sort((a, b) => a.date.localeCompare(b.date));
      const latest = obs[obs.length - 1];
      const previous = obs.length > 1 ? obs[obs.length - 2] : null;

      const nowTime = new Date(latest.date).getTime();
      const findClosest = (targetTime: number): FredObservation | null => {
        let closest: FredObservation | null = null;
        let bestDelta = Infinity;
        for (const o of obs) {
          const delta = Math.abs(new Date(o.date).getTime() - targetTime);
          if (delta < bestDelta) {
            bestDelta = delta;
            closest = o;
          }
        }
        return closest;
      };
      const monthAgo = findClosest(nowTime - 30 * 24 * 60 * 60 * 1000);
      const yearAgo = findClosest(nowTime - 365 * 24 * 60 * 60 * 1000);

      const quarterAgo = findClosest(nowTime - 91 * 24 * 60 * 60 * 1000);
      const trailing3moChange = quarterAgo ? latest.value - quarterAgo.value : 0;
      const trailing12moChange = yearAgo ? latest.value - yearAgo.value : 0;

      const snapshot: FredSnapshot = {
        seriesId,
        latest,
        previous,
        monthAgo,
        yearAgo,
        trailing3moChange,
        trailing12moChange,
        fetchedAt: Date.now(),
      };
      this.cache.set(seriesId, snapshot);
      return snapshot;
    } catch (err) {
      log.warn({ seriesId, err: err instanceof Error ? err.message : String(err) }, 'FRED request threw');
      return cached ?? null;
    }
  }

  /**
   * Simple Fed reaction function per design-decisions §N3. Returns the
   * implied probability of a rate cut in the next FOMC meeting, given
   * current fed funds, recent CPI, and unemployment trend.
   */
  async fedReactionProbCut(): Promise<number | null> {
    const [funds, cpi, unemp] = await Promise.all([
      this.getSeries('FED_FUNDS_EFFECTIVE'),
      this.getSeries('CPI_ALL_URBAN'),
      this.getSeries('UNEMPLOYMENT'),
    ]);

    if (!funds || !cpi || !unemp) return null;

    // Compute trailing 3mo CPI inflation rate (annualized)
    const cpiChange = cpi.trailing3moChange;
    const cpiPrior = cpi.latest.value - cpiChange;
    const annualizedCpi = cpiPrior > 0 ? (cpiChange / cpiPrior) * 4 * 100 : 0;

    // Base: 40% probability of "no change" as prior, adjust up/down
    let probCut = 0.35;

    // Cuts more likely if inflation trending down or unemployment trending up
    if (annualizedCpi < 2.5) probCut += 0.20;
    else if (annualizedCpi < 3.0) probCut += 0.10;
    else if (annualizedCpi > 4.5) probCut -= 0.20;

    if (unemp.trailing3moChange > 0.3) probCut += 0.15;
    else if (unemp.trailing3moChange > 0.1) probCut += 0.05;
    else if (unemp.trailing3moChange < -0.2) probCut -= 0.10;

    return Math.max(0.05, Math.min(0.95, probCut));
  }
}
