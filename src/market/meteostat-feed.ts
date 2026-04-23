// Meteostat historical weather feed — 2026-04-21.
//
// Free tier: bulk Meteostat data via the public JSON API (no key
// required for low-volume access). Used for backtest ground-truth
// when validating weather-forecast strategy verdicts and for HRRR
// model-error calibration.
//
// Pull pattern: cached 24h per (station, date). Caller asks for
// daily summary → we hit /point/daily endpoint and return min/max
// temperature in Fahrenheit, plus precipitation if present.
//
// Note: the no-key public endpoint is rate-limited to a few req/sec.
// Strategy callers should batch (e.g. one prefetch at start of run)
// rather than per-market. We don't run this on the live hot path.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('meteostat-feed');

interface MeteostatDaily {
  station_lat: number;
  station_lon: number;
  date: string; // YYYY-MM-DD
  tmin_f: number | null;
  tmax_f: number | null;
  tavg_f: number | null;
  precip_mm: number | null;
  fetched_at: number;
}

const cache = new Map<string, MeteostatDaily>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cToF(c: number): number {
  return (c * 9) / 5 + 32;
}

/** Fetch daily summary for a lat/lon point on a given UTC date. */
export async function getMeteostatDaily(
  lat: number,
  lon: number,
  isoDate: string,
): Promise<MeteostatDaily | null> {
  const key = lat.toFixed(2) + ',' + lon.toFixed(2) + ',' + isoDate;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) return cached;

  // Public Meteostat endpoint via Open-Meteo's mirror of GHCN-D when key absent.
  // We use Open-Meteo archive API which sources Meteostat + GHCN-D bulk data
  // and requires no API key (Meteostat's own RapidAPI tier needs a key).
  const url = 'https://archive-api.open-meteo.com/v1/archive'
    + '?latitude=' + lat
    + '&longitude=' + lon
    + '&start_date=' + isoDate
    + '&end_date=' + isoDate
    + '&daily=temperature_2m_max,temperature_2m_min,temperature_2m_mean,precipitation_sum'
    + '&temperature_unit=celsius'
    + '&timezone=UTC';

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return null;
    const data = await response.json() as {
      daily?: {
        time?: string[];
        temperature_2m_max?: (number | null)[];
        temperature_2m_min?: (number | null)[];
        temperature_2m_mean?: (number | null)[];
        precipitation_sum?: (number | null)[];
      };
    };
    const d = data.daily;
    if (!d || !d.time || d.time.length === 0) return null;

    const tmaxC = d.temperature_2m_max?.[0] ?? null;
    const tminC = d.temperature_2m_min?.[0] ?? null;
    const tavgC = d.temperature_2m_mean?.[0] ?? null;
    const value: MeteostatDaily = {
      station_lat: lat,
      station_lon: lon,
      date: isoDate,
      tmin_f: tminC == null ? null : cToF(tminC),
      tmax_f: tmaxC == null ? null : cToF(tmaxC),
      tavg_f: tavgC == null ? null : cToF(tavgC),
      precip_mm: d.precipitation_sum?.[0] ?? null,
      fetched_at: Date.now(),
    };
    cache.set(key, value);
    log.debug({ lat, lon, isoDate, tmin_f: value.tmin_f, tmax_f: value.tmax_f }, 'Meteostat daily fetched');
    return value;
  } catch (err) {
    log.debug({ lat, lon, isoDate, err: err instanceof Error ? err.message : String(err) }, 'Meteostat fetch failed');
    return null;
  }
}

/** Convenience helper for Polymarket city-temperature markets. */
export async function getMeteostatDailyForCity(
  city: 'nyc' | 'mia' | 'chi' | 'lax' | 'dfw' | 'atl' | 'sea' | 'phx' | 'bos' | 'den',
  isoDate: string,
): Promise<MeteostatDaily | null> {
  const COORDS: Record<string, [number, number]> = {
    nyc: [40.7128, -74.0060],
    mia: [25.7617, -80.1918],
    chi: [41.8781, -87.6298],
    lax: [34.0522, -118.2437],
    dfw: [32.7767, -96.7970],
    atl: [33.7490, -84.3880],
    sea: [47.6062, -122.3321],
    phx: [33.4484, -112.0740],
    bos: [42.3601, -71.0589],
    den: [39.7392, -104.9903],
  };
  const c = COORDS[city];
  if (!c) return null;
  return getMeteostatDaily(c[0], c[1], isoDate);
}
