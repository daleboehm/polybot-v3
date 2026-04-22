// External data feeds — Weather.gov NWS, ECMWF ensemble, Binance crypto, orderbook depth
// These are utility functions called by strategies for edge calculation

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('data-feeds');

// ─── 1. WEATHER.GOV NWS (US cities — authoritative forecast) ─────────

interface NWSForecast {
  city: string;
  high_f: number;
  low_f: number;
  short_forecast: string;
  detailed_forecast: string;
  fetched_at: number;
}

// NWS gridpoint coordinates for major US cities
const NWS_GRIDPOINTS: Record<string, { office: string; gridX: number; gridY: number }> = {
  'new york':      { office: 'OKX', gridX: 33, gridY: 37 },
  'nyc':           { office: 'OKX', gridX: 33, gridY: 37 },
  'los angeles':   { office: 'LOX', gridX: 154, gridY: 44 },
  'chicago':       { office: 'LOT', gridX: 65, gridY: 76 },
  'miami':         { office: 'MFL', gridX: 110, gridY: 50 },
  'denver':        { office: 'BOU', gridX: 62, gridY: 60 },
  'seattle':       { office: 'SEW', gridX: 124, gridY: 67 },
  'san francisco': { office: 'MTR', gridX: 85, gridY: 105 },
  'boston':         { office: 'BOX', gridX: 71, gridY: 90 },
  'phoenix':       { office: 'PSR', gridX: 159, gridY: 57 },
  'las vegas':     { office: 'VEF', gridX: 122, gridY: 97 },
  'orlando':       { office: 'MLB', gridX: 27, gridY: 68 },
  'dallas':        { office: 'FWD', gridX: 80, gridY: 108 },
};

const nwsCache = new Map<string, NWSForecast>();
const NWS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

export async function getNWSForecast(city: string): Promise<NWSForecast | null> {
  const key = city.toLowerCase();
  const cached = nwsCache.get(key);
  if (cached && (Date.now() - cached.fetched_at) < NWS_CACHE_TTL) return cached;

  const grid = NWS_GRIDPOINTS[key];
  if (!grid) return null; // Not a US city with NWS data

  try {
    const url = `https://api.weather.gov/gridpoints/${grid.office}/${grid.gridX},${grid.gridY}/forecast`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/geo+json', 'User-Agent': 'GeminiCapital/2.0 (polymarket trading)' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;

    const data = await response.json() as NWSResponse;
    const periods = data.properties?.periods;
    if (!periods?.length) return null;

    // Find today's daytime period for high, tonight for low
    const daytime = periods.find(p => p.isDaytime);
    const nighttime = periods.find(p => !p.isDaytime);

    const forecast: NWSForecast = {
      city: key,
      high_f: daytime?.temperature ?? 0,
      low_f: nighttime?.temperature ?? 0,
      short_forecast: daytime?.shortForecast ?? '',
      detailed_forecast: daytime?.detailedForecast ?? '',
      fetched_at: Date.now(),
    };

    nwsCache.set(key, forecast);
    log.debug({ city: key, high: forecast.high_f, low: forecast.low_f }, 'NWS forecast fetched');
    return forecast;
  } catch (err) {
    log.debug({ city: key, err }, 'NWS fetch failed');
    return null;
  }
}

interface NWSResponse {
  properties?: {
    periods?: Array<{
      isDaytime: boolean;
      temperature: number;
      temperatureUnit: string;
      shortForecast: string;
      detailedForecast: string;
    }>;
  };
}

// ─── 2. ECMWF ENSEMBLE SPREAD (via Open-Meteo) ──────────────────────

interface EnsembleData {
  city: string;
  high_mean: number;
  high_min: number;   // Lowest ensemble member
  high_max: number;   // Highest ensemble member
  spread: number;     // Max - Min (tighter = more confident)
  confidence: number; // 0-1 based on spread
  fetched_at: number;
}

const ensembleCache = new Map<string, EnsembleData>();
const ENSEMBLE_CACHE_TTL = 30 * 60 * 1000;

const CITY_COORDS: Record<string, [number, number]> = {
  'new york': [40.7128, -74.0060], 'nyc': [40.7128, -74.0060],
  'los angeles': [34.0522, -118.2437], 'chicago': [41.8781, -87.6298],
  'miami': [25.7617, -80.1918], 'london': [51.5074, -0.1278],
  'paris': [48.8566, 2.3522], 'tokyo': [35.6762, 139.6503],
  'berlin': [52.5200, 13.4050], 'seoul': [37.5665, 126.9780],
  'denver': [39.7392, -104.9903], 'seattle': [47.6062, -122.3321],
  'boston': [42.3601, -71.0589], 'phoenix': [33.4484, -112.0742],
  'dallas': [32.7767, -96.7970], 'amsterdam': [52.3676, 4.9041],
  'madrid': [40.4168, -3.7038], 'rome': [41.9028, 12.4964],
  'ankara': [39.9334, 32.8597], 'milan': [45.4642, 9.1900],
  'shanghai': [31.2304, 121.4737], 'tel aviv': [32.0853, 34.7818],
  'mumbai': [19.0760, 72.8777], 'warsaw': [52.2297, 21.0122],
  'san francisco': [37.7749, -122.4194], 'toronto': [43.6629, -79.3957],
  'mexico city': [19.4326, -99.1332], 'orlando': [28.5421, -81.3723],
  'las vegas': [36.1699, -115.1398], 'vancouver': [49.2827, -123.1207],
};

export async function getEnsembleSpread(city: string): Promise<EnsembleData | null> {
  const key = city.toLowerCase();
  const cached = ensembleCache.get(key);
  if (cached && (Date.now() - cached.fetched_at) < ENSEMBLE_CACHE_TTL) return cached;

  const coords = CITY_COORDS[key];
  if (!coords) return null;

  try {
    // Open-Meteo ensemble endpoint — Phase R1.2 upgrade (2026-04-12):
    // switched from ecmwf_ifs025 (classical ECMWF IFS) to ecmwf_aifs025
    // (AI-powered ECMWF AIFS ENS, launched July 2025, 20% more accurate
    // on temperature per ECMWF benchmarks). Returns 50 ensemble members +
    // a control run. CC-BY-4.0 license, free, no API key.
    const url = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${coords[0]}&longitude=${coords[1]}&daily=temperature_2m_max&forecast_days=3&temperature_unit=fahrenheit&timezone=auto&models=ecmwf_aifs025`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;

    const data = await response.json() as EnsembleResponse;
    const members = data.daily?.temperature_2m_max;
    if (!members || !Array.isArray(members) || members.length === 0) return null;

    // Members is either an array of arrays (per member) or array of values
    // Open-Meteo ensemble returns member data differently — check format
    let allHighs: number[];
    if (Array.isArray(members[0])) {
      // Each member is an array of daily values — get day 0 from each
      allHighs = (members as number[][]).map(m => m[0]).filter(v => typeof v === 'number');
    } else {
      // Flat array — these are the values for one day across members
      allHighs = (members as number[]).filter(v => typeof v === 'number');
    }

    if (allHighs.length === 0) return null;

    const mean = allHighs.reduce((a, b) => a + b, 0) / allHighs.length;
    const min = Math.min(...allHighs);
    const max = Math.max(...allHighs);
    const spread = max - min;

    // Confidence: tight spread (< 5°F) = high, wide (> 15°F) = low
    const confidence = Math.max(0, Math.min(1, 1 - (spread - 3) / 15));

    const ensemble: EnsembleData = {
      city: key, high_mean: mean, high_min: min, high_max: max,
      spread, confidence, fetched_at: Date.now(),
    };

    ensembleCache.set(key, ensemble);
    log.debug({ city: key, mean: mean.toFixed(1), spread: spread.toFixed(1), confidence: confidence.toFixed(2) }, 'Ensemble data fetched');
    return ensemble;
  } catch (err) {
    log.debug({ city: key, err }, 'Ensemble fetch failed');
    return null;
  }
}

interface EnsembleResponse {
  daily?: {
    temperature_2m_max?: number[] | number[][];
  };
}

// ─── 2b. NOAA HRRR (High-Resolution Rapid Refresh, CONUS 3km hourly) ─
//
// NOAA HRRR via Open-Meteo proxy. 3km resolution over Continental US,
// hourly updates. Complements the AIFS ensemble (global, 50 members)
// with much tighter short-horizon resolution for US weather markets.
// Best signal for same-day and next-day US forecasts; falls through to
// AIFS for non-US or >48h horizons.
//
// Grok research 2026-04-21 + openclaw-weather GitHub ref.

interface HRRRForecast {
  city: string;
  high_f: number;
  low_f: number;
  hours_forecast: number[]; // next 24h hourly temps in F for diagnostics
  fetched_at: number;
}

const hrrrCache = new Map<string, HRRRForecast>();
const HRRR_CACHE_TTL = 30 * 60 * 1000; // 30 min — HRRR updates hourly

export async function getHRRRForecast(city: string): Promise<HRRRForecast | null> {
  const key = city.toLowerCase();
  const cached = hrrrCache.get(key);
  if (cached && (Date.now() - cached.fetched_at) < HRRR_CACHE_TTL) return cached;

  // HRRR is CONUS-only — use CITY_COORDS (already restricted to major US cities in NWS block)
  const coords = CITY_COORDS[key];
  if (!coords) return null;
  // Coarse US-bounding-box filter — lat 24.5-49.5, lon -125 to -66
  if (coords[0] < 24.5 || coords[0] > 49.5 || coords[1] < -125 || coords[1] > -66) return null;

  try {
    // Open-Meteo HRRR endpoint. Hourly temp_2m forecast next 48h.
    const url = "https://api.open-meteo.com/v1/forecast?latitude=" + coords[0] + "&longitude=" + coords[1] + "&hourly=temperature_2m&forecast_days=2&temperature_unit=fahrenheit&timezone=auto&models=noaa_hrrr";
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;

    const data = await response.json() as { hourly?: { temperature_2m?: number[] } };
    const hours = data.hourly?.temperature_2m;
    if (!hours || !Array.isArray(hours) || hours.length < 24) return null;

    // Today = first 24 hourly readings. High/low = extrema across them.
    const today = hours.slice(0, 24).filter(v => typeof v === 'number');
    if (today.length === 0) return null;
    const high_f = Math.max(...today);
    const low_f = Math.min(...today);

    const forecast: HRRRForecast = {
      city: key,
      high_f,
      low_f,
      hours_forecast: today,
      fetched_at: Date.now(),
    };
    hrrrCache.set(key, forecast);
    log.debug({ city: key, high_f, low_f, hours: today.length }, 'HRRR forecast fetched');
    return forecast;
  } catch (err) {
    log.debug({ city: key, err }, 'HRRR fetch failed');
    return null;
  }
}


// ─── 3. BINANCE CRYPTO PRICES (real-time via REST) ───────────────────

interface CryptoPrice {
  symbol: string;
  price: number;
  fetched_at: number;
}

const cryptoCache = new Map<string, CryptoPrice>();
const CRYPTO_CACHE_TTL = 60 * 1000; // 1 minute — much faster than CoinGecko's 5 min

const BINANCE_SYMBOLS: Record<string, string> = {
  'bitcoin': 'BTCUSDT', 'btc': 'BTCUSDT',
  'ethereum': 'ETHUSDT', 'eth': 'ETHUSDT',
  'solana': 'SOLUSDT', 'sol': 'SOLUSDT',
  'dogecoin': 'DOGEUSDT', 'doge': 'DOGEUSDT',
  'xrp': 'XRPUSDT', 'ripple': 'XRPUSDT',
  'cardano': 'ADAUSDT', 'ada': 'ADAUSDT',
};

export async function getBinancePrice(asset: string): Promise<number | null> {
  const key = asset.toLowerCase();
  const cached = cryptoCache.get(key);
  if (cached && (Date.now() - cached.fetched_at) < CRYPTO_CACHE_TTL) return cached.price;

  const symbol = BINANCE_SYMBOLS[key];
  if (!symbol) return null;

  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return null;

    const data = await response.json() as { price: string };
    const price = parseFloat(data.price);
    if (!price || price <= 0) return null;

    cryptoCache.set(key, { symbol, price, fetched_at: Date.now() });
    return price;
  } catch (err) {
    log.debug({ asset: key, err }, 'Binance price fetch failed');
    return null;
  }
}

// ─── 4. METAR/TAF AVIATION WEATHER (observed + short-range forecast) ─
//
// METAR = Meteorological Aerodrome Report: actual observed weather at an
// airport station (updated hourly or more). TAF = Terminal Aerodrome
// Forecast: 24-30h forecast issued every 6h. These are the ground truth
// that forecast models try to predict — observed temp at the exact moment.
//
// Edge thesis: whale traders (ColdMath $104K PnL, speeda $20.5K 99% WR)
// confirmed using airport station readings. METAR catches intra-day
// temperature spikes/dips that model forecasts miss by hours.
//
// Source: aviationweather.gov — free, no auth, JSON, worldwide, batch.

export interface METARObservation {
  icao: string;
  city: string;
  temp_c: number;
  temp_f: number;
  dewpoint_c: number;
  wind_speed_kt: number;
  wind_dir: number;
  altimeter_inhg: number;
  raw_text: string;
  observation_time: string;
  fetched_at: number;
}

// City → nearest ICAO station for METAR lookups
const CITY_ICAO: Record<string, string> = {
  'new york': 'KJFK', 'nyc': 'KJFK',
  'los angeles': 'KLAX', 'la': 'KLAX',
  'chicago': 'KORD',
  'miami': 'KMIA',
  'denver': 'KDEN',
  'seattle': 'KSEA',
  'san francisco': 'KSFO',
  'boston': 'KBOS',
  'phoenix': 'KPHX',
  'las vegas': 'KLAS',
  'orlando': 'KMCO',
  'dallas': 'KDFW',
  'london': 'EGLL',
  'paris': 'LFPG',
  'tokyo': 'RJTT',
  'berlin': 'EDDB',
  'amsterdam': 'EHAM',
  'madrid': 'LEMD',
  'rome': 'LIRF',
  'seoul': 'RKSI',
  'shanghai': 'ZSPD',
  'toronto': 'CYYZ',
  'vancouver': 'CYVR',
  'mexico city': 'MMMX',
  'mumbai': 'VABB',
  'tel aviv': 'LLBG',
  'dubai': 'OMDB',
  'singapore': 'WSSS',
  'hong kong': 'VHHH',
  'sydney': 'YSSY',
  'ankara': 'LTAC',
  'milan': 'LIMC',
  'warsaw': 'EPWA',
  'beijing': 'ZBAA',
  'athens': 'LGAV',
  'wuhan': 'ZHHH',
};

const metarCache = new Map<string, METARObservation>();
const METAR_CACHE_TTL = 15 * 60 * 1000; // 15 minutes — METAR updates hourly

export async function getMETARObservation(city: string): Promise<METARObservation | null> {
  const key = city.toLowerCase();
  const cached = metarCache.get(key);
  if (cached && (Date.now() - cached.fetched_at) < METAR_CACHE_TTL) return cached;

  const icao = CITY_ICAO[key];
  if (!icao) return null;

  try {
    // aviationweather.gov ADDS API — returns decoded METAR in JSON
    const url = `https://aviationweather.gov/api/data/metar?ids=${icao}&format=json&hours=2`;
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;

    const data = await response.json() as METARResponse[];
    if (!data?.length) return null;

    // Take the most recent observation
    const latest = data[0];
    const tempC = latest.temp ?? null;
    if (tempC === null) return null;

    const obs: METARObservation = {
      icao,
      city: key,
      temp_c: tempC,
      temp_f: tempC * 9 / 5 + 32,
      dewpoint_c: latest.dewp ?? 0,
      wind_speed_kt: latest.wspd ?? 0,
      wind_dir: latest.wdir ?? 0,
      altimeter_inhg: latest.altim ?? 0,
      raw_text: latest.rawOb ?? '',
      observation_time: latest.reportTime ?? '',
      fetched_at: Date.now(),
    };

    metarCache.set(key, obs);
    log.debug({ city: key, icao, temp_f: obs.temp_f.toFixed(1), obs_time: obs.observation_time }, 'METAR observation fetched');
    return obs;
  } catch (err) {
    log.debug({ city: key, err }, 'METAR fetch failed');
    return null;
  }
}

interface METARResponse {
  icaoId?: string;
  reportTime?: string;
  temp?: number;
  dewp?: number;
  wspd?: number;
  wdir?: number;
  altim?: number;
  rawOb?: string;
}

// ─── 5. ORDERBOOK DEPTH ANALYSIS ─────────────────────────────────────

export interface OrderbookSignal {
  token_id: string;
  bid_depth_usd: number;   // Total USD on bid side (top 5 levels)
  ask_depth_usd: number;   // Total USD on ask side
  imbalance: number;       // (bid - ask) / (bid + ask), positive = buy pressure
  spread_pct: number;      // Spread as percentage of midpoint
  large_bid: boolean;      // Is there a single bid > $500?
  large_ask: boolean;
}

export function analyzeOrderbook(book: { bids: Array<{price: number; size: number}>; asks: Array<{price: number; size: number}> }): OrderbookSignal | null {
  if (!book.bids?.length && !book.asks?.length) return null;

  const topBids = book.bids.slice(0, 5);
  const topAsks = book.asks.slice(0, 5);

  const bidDepth = topBids.reduce((sum, l) => sum + l.price * l.size, 0);
  const askDepth = topAsks.reduce((sum, l) => sum + l.price * l.size, 0);
  const total = bidDepth + askDepth;

  const bestBid = topBids[0]?.price ?? 0;
  const bestAsk = topAsks[0]?.price ?? 1;
  const mid = (bestBid + bestAsk) / 2;
  const spreadPct = mid > 0 ? (bestAsk - bestBid) / mid : 0;

  const largeBid = topBids.some(l => l.price * l.size > 500);
  const largeAsk = topAsks.some(l => l.price * l.size > 500);

  return {
    token_id: '',
    bid_depth_usd: bidDepth,
    ask_depth_usd: askDepth,
    imbalance: total > 0 ? (bidDepth - askDepth) / total : 0,
    spread_pct: spreadPct,
    large_bid: largeBid,
    large_ask: largeAsk,
  };
}
