// Weather forecast strategy — uses Open-Meteo GFS/ECMWF data to find mispriced weather markets
// The edge: professional forecast models are extremely accurate 1-2 days out.
// Market prices set by casual bettors lag behind latest model runs.

import { BaseStrategy, type StrategyContext } from '../strategy-interface.js';
import type { Signal, MarketData } from '../../types/index.js';
import { nanoid } from 'nanoid';
import { createChildLogger } from '../../core/logger.js';
import { getNWSForecast, getEnsembleSpread, getMETARObservation, getHRRRForecast } from '../../market/data-feeds.js';
import { getFeeRateFromTags, feeAdjustedEdge } from '../../utils/math.js';
import { getDatabase } from '../../storage/database.js';

const log = createChildLogger('strategy:weather');

// 28 cities with lat/long for Open-Meteo lookups
const CITY_COORDS: Record<string, [number, number]> = {
  'new york': [40.7128, -74.0060], 'nyc': [40.7128, -74.0060],
  'los angeles': [34.0522, -118.2437], 'la': [34.0522, -118.2437],
  'miami': [25.7617, -80.1918], 'chicago': [41.8781, -87.6298],
  'london': [51.5074, -0.1278], 'paris': [48.8566, 2.3522],
  'tokyo': [35.6762, 139.6503], 'sydney': [-33.8688, 151.2093],
  'hong kong': [22.3193, 114.1694], 'singapore': [1.3521, 103.8198],
  'dubai': [25.2048, 55.2708], 'berlin': [52.5200, 13.4050],
  'warsaw': [52.2297, 21.0122], 'tel aviv': [32.0853, 34.7818],
  'mumbai': [19.0760, 72.8777], 'shanghai': [31.2304, 121.4737],
  'toronto': [43.6629, -79.3957], 'vancouver': [49.2827, -123.1207],
  'mexico city': [19.4326, -99.1332], 'denver': [39.7392, -104.9903],
  'seattle': [47.6062, -122.3321], 'san francisco': [37.7749, -122.4194],
  'boston': [42.3601, -71.0589], 'phoenix': [33.4484, -112.0742],
  'las vegas': [36.1699, -115.1398], 'orlando': [28.5421, -81.3723],
  'dallas': [32.7767, -96.7970], 'amsterdam': [52.3676, 4.9041],
  'madrid': [40.4168, -3.7038], 'rome': [41.9028, 12.4964],
  'seoul': [37.5665, 126.9780], 'beijing': [39.9042, 116.4074],
  'ankara': [39.9334, 32.8597], 'milan': [45.4642, 9.1900],
  'wuhan': [30.5928, 114.3055], 'athens': [37.9838, 23.7275],
  'chengdu': [30.5728, 104.0668],
};

// Celsius city names (non-US cities typically use Celsius on Polymarket)
const CELSIUS_CITIES = new Set([
  'london', 'paris', 'tokyo', 'sydney', 'hong kong', 'singapore', 'dubai',
  'berlin', 'warsaw', 'tel aviv', 'mumbai', 'shanghai', 'toronto', 'vancouver',
  'mexico city', 'amsterdam', 'madrid', 'rome', 'seoul', 'beijing', 'ankara',
  'milan', 'wuhan', 'athens',
]);

interface ForecastData {
  city: string;
  high_f: number;
  low_f: number;
  high_c: number;
  low_c: number;
  fetched_at: number;
}

const CONFIG = {
  min_edge: 0.05,           // 5% minimum edge to trade
  min_score: 35,            // Minimum score out of 100
  max_hours_to_resolve: 48,
  min_hours_to_resolve: 2,
  dedup_minutes: 240,
  forecast_cache_ttl_ms: 30 * 60 * 1000, // 30 min cache
  // 2026-04-16 Fix 4 allocation boost: weather is the top R&D P&L contributor
  // (+$316 all-time, +$180 on a single day 2026-04-16) and arXiv 2604.07355
  // (6 AI models, 57 days, real money) confirms weather as 71-97% of
  // profitable positions in comparable bot portfolios. Doubling to 2.0x
  // from the original 1.5x — the edge structure (forecast skill vs. market
  // pricing) is the binding constraint, not position count. Single
  // multiplier knob so the whole boost reverts in one diff if weather
  // degrades.
  allocation_multiplier: 2.0,
  // 2026-04-16 Fix 4: hold-to-settlement flag. When ECMWF ensemble
  // confidence is above this threshold the forecast is high-conviction
  // (model agreement across members), and the academic paper finds that
  // holding weather positions to settlement beats early exits. Stop-loss
  // monitor honors `metadata.hold_to_settlement=true` by suppressing
  // exit-signal generation for that position.
  hold_to_settlement_confidence: 0.65,
};

export class WeatherForecastStrategy extends BaseStrategy {
  readonly id = 'weather_forecast';
  readonly name = 'Weather Forecast';
  readonly description = 'Trade weather markets using Open-Meteo GFS/ECMWF forecast data';
  readonly version = '3.0.0';

  private forecastCache = new Map<string, ForecastData>();
  // calibration cache — refreshed every 30 min from weather_calibrations table (Python sidecar)
  private calibrationCache = new Map<string, { final_prob: number; emos_mu_c: number; emos_sigma_c: number; history_days: number }>();
  private calibrationCacheTime = 0;
  private recentTrades = new Map<string, number>();
  // F13: tracks whether we loaded the dedup window from DB after restart.
  private _recentTradesLoaded = false;

  /** Populate recentTrades from DB on first evaluate() call after startup. */
  private loadRecentTradesFromDb(entitySlug: string): void {
    if (this._recentTradesLoaded) return;
    this._recentTradesLoaded = true;
    try {
      const db = getDatabase();
      const rows = db.prepare(
        `SELECT condition_id, CAST(strftime('%s', MAX(created_at)) AS INTEGER) * 1000 AS last_ts
         FROM trades
         WHERE entity_slug = ? AND strategy_id = ?
           AND created_at > datetime('now', '-' || ? || ' minutes')
         GROUP BY condition_id`
      ).all(entitySlug, this.id, CONFIG.dedup_minutes) as Array<{ condition_id: string; last_ts: number }>;
      const cutoff = Date.now() - CONFIG.dedup_minutes * 60 * 1000;
      for (const row of rows) {
        if (row.last_ts > cutoff) this.recentTrades.set(row.condition_id, row.last_ts);
      }
      log.info({ count: rows.length, entity: entitySlug }, 'weather-forecast: recentTrades restored from DB after restart');
    } catch (err) {
      log.warn({ err }, 'weather-forecast: failed to restore recentTrades from DB — empty cache on restart');
    }
  }

  override getSubStrategies(): string[] {
    // 2026-04-10 expansion: added same_day_snipe, next_day_horizon,
    // ensemble_spread_fade so the advisor has real variants to compare.
    // All four subs share the same forecast + scoring pipeline; they differ
    // only in gating (time window, score threshold, edge threshold, side).
    return [
      'single_forecast',         // Baseline: 2-48h, score≥35, edge≥5%
      'same_day_snipe',          // <6h to resolve, high-confidence (score≥70)
      'next_day_horizon',        // 18-30h, confidence-focused (score≥50)
      'ensemble_spread_fade',    // Fade market extremes when ECMWF says uncertain
    ];
  }

  private refreshCalibrations(): void {
    if (Date.now() - this.calibrationCacheTime < 30 * 60 * 1000) return;
    try {
      const db = getDatabase();
      const rows = db.prepare(
        "SELECT condition_id, final_prob, emos_mu_c, emos_sigma_c, history_days FROM weather_calibrations WHERE calibrated_at > datetime('now', '-8 hours')"
      ).all() as Array<{ condition_id: string; final_prob: number; emos_mu_c: number; emos_sigma_c: number; history_days: number }>;
      this.calibrationCache.clear();
      for (const row of rows) {
        this.calibrationCache.set(row.condition_id, {
          final_prob: row.final_prob,
          emos_mu_c: row.emos_mu_c,
          emos_sigma_c: row.emos_sigma_c,
          history_days: row.history_days,
        });
      }
      this.calibrationCacheTime = Date.now();
      if (rows.length > 0) log.info({ count: rows.length }, 'Weather calibrations loaded from DB');
    } catch (err) {
      log.debug({ err }, 'Calibration read failed — using raw scoring');
    }
  }

  async evaluate(ctx: StrategyContext): Promise<Signal[]> {
    // F13: restore dedup cache from DB on first call after restart
    this.loadRecentTradesFromDb(ctx.entity.config.slug);

    const signals: Signal[] = [];
    // At least one weather sub must be enabled — cheap short-circuit.
    const anyEnabled =
      this.isSubStrategyEnabled(ctx, 'single_forecast') ||
      this.isSubStrategyEnabled(ctx, 'same_day_snipe') ||
      this.isSubStrategyEnabled(ctx, 'next_day_horizon') ||
      this.isSubStrategyEnabled(ctx, 'ensemble_spread_fade');
    if (!anyEnabled) return signals;
    this.refreshCalibrations();
    const markets = ctx.getActiveMarkets();
    const now = Date.now();
    const existingPositions = new Set(
      ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id)
    );

    for (const market of markets) {
      if (existingPositions.has(market.condition_id)) continue;
      if (!market.active || market.closed) continue;

      // Must have valid end_date within 2-48 hours
      const endTime = market.end_date.getTime();
      if (!endTime || isNaN(endTime)) continue;
      const hoursToResolve = (endTime - now) / (1000 * 60 * 60);
      if (isNaN(hoursToResolve) || hoursToResolve < CONFIG.min_hours_to_resolve || hoursToResolve > CONFIG.max_hours_to_resolve) continue;

      // Dedup
      const lastTrade = this.recentTrades.get(market.condition_id);
      if (lastTrade && (now - lastTrade) < CONFIG.dedup_minutes * 60 * 1000) continue;

      // Is this a weather market?
      const question = market.question.toLowerCase();
      const isWeather = ['temperature', 'highest temp', 'lowest temp', 'high temp', 'will the high',
        'rain', 'precipitation', '°f', '°c', 'celsius', 'fahrenheit'].some(kw => question.includes(kw));
      if (!isWeather) continue;

      // Extract city and temperature range
      const parsed = this.parseWeatherQuestion(market.question);
      if (!parsed) continue;

      // Claim market BEFORE any async yield to prevent concurrent evaluate()
      // calls from both passing the dedup check (race condition: both see
      // recentTrades empty, both await getForecast, both produce signals).
      this.recentTrades.set(market.condition_id, now);

      // Fetch forecast from Open-Meteo (primary)
      const forecast = await this.getForecast(parsed.city);
      if (!forecast) {
        // F12 FIX: release the dedup claim on fetch failure so a transient
        // Open-Meteo outage does not lock the market out for 240 minutes.
        // Back-date so retry is allowed after 5 minutes.
        this.recentTrades.set(market.condition_id, now - (CONFIG.dedup_minutes - 5) * 60 * 1000);
        continue;
      }

      // Enhance with NWS data for US cities (more authoritative)
      const nws = await getNWSForecast(parsed.city);
      if (nws && nws.high_f > 0) {
        // Average Open-Meteo and NWS for better estimate
        forecast.high_f = (forecast.high_f + nws.high_f) / 2;
        forecast.low_f = (forecast.low_f + nws.low_f) / 2;
        forecast.high_c = (forecast.high_f - 32) * 5 / 9;
        forecast.low_c = (forecast.low_f - 32) * 5 / 9;
      }

      // Get ECMWF ensemble spread for confidence adjustment
      const ensemble = await getEnsembleSpread(parsed.city);

      // Get METAR airport observation (actual ground truth temperature)
      // METAR is the single most valuable data source for <6h markets —
      // it tells us the CURRENT temp, which narrows the forecast window
      // dramatically. For same-day markets, if current temp is already
      // above/below the threshold, the probability shifts hard.
      const metar = await getMETARObservation(parsed.city);
      if (metar && metar.temp_f > 0 && hoursToResolve < 12) {
        // Blend METAR actual temp with forecast — weight METAR higher for
        // shorter horizons because current temp constrains the range.
        const metarWeight = hoursToResolve < 3 ? 0.7 : hoursToResolve < 6 ? 0.5 : 0.3;
        forecast.high_f = forecast.high_f * (1 - metarWeight) + metar.temp_f * metarWeight;
        forecast.high_c = (forecast.high_f - 32) * 5 / 9;
      }

      // 2026-04-21: HRRR (NOAA High-Resolution Rapid Refresh, CONUS 3km).
      // Free via Open-Meteo. Better short-horizon precision than AIFS for
      // US cities. Blend for <48h US forecasts; falls through if non-US.
      const hrrr = await getHRRRForecast(parsed.city);
      if (hrrr && hrrr.high_f > 0 && hoursToResolve < 48) {
        const hrrrWeight = hoursToResolve < 12 ? 0.4 : hoursToResolve < 24 ? 0.3 : 0.2;
        forecast.high_f = forecast.high_f * (1 - hrrrWeight) + hrrr.high_f * hrrrWeight;
        forecast.low_f = forecast.low_f * (1 - hrrrWeight) + hrrr.low_f * hrrrWeight;
        forecast.high_c = (forecast.high_f - 32) * 5 / 9;
        forecast.low_c = (forecast.low_f - 32) * 5 / 9;
      }

      // Score the market (shared across all sub-strategies)
      const score = this.scoreMarket(market, parsed, forecast, hoursToResolve);

      // Fee-adjusted edge: subtract taker fee drag from raw edge.
      // Weather category feeRate = 0.050 → max 1.25% at p=0.50.
      const feeRate = getFeeRateFromTags(market.tags ?? []);
      const adjEdge = feeAdjustedEdge(
        score.edge > 0 ? score.yesProbability : (1 - score.yesProbability),
        score.edge > 0 ? market.yes_price : market.no_price,
        feeRate,
      );

      // Determine trade side from scoring model
      const scoredSide = score.edge > 0 ? 'YES' : 'NO';
      const scoredTokenId = scoredSide === 'YES' ? market.token_yes_id : market.token_no_id;
      const scoredMarketPrice = scoredSide === 'YES' ? market.yes_price : market.no_price;
      const scoredModelProb = scoredSide === 'YES' ? score.yesProbability : (1 - score.yesProbability);

      if (scoredMarketPrice < 0.05 || scoredMarketPrice > 0.95) continue; // Don't trade extremes

      // 2026-04-16 Fix 4: hold-to-settlement gate. High-conviction
      // forecasts (ensemble_confidence > threshold) are flagged so the
      // stop-loss monitor skips exits on them — weather resolves in hours,
      // not days, and early exit on a confident forecast was the
      // single biggest P&L leak per arXiv 2604.07355. Directional subs
      // only (single_forecast, same_day_snipe, next_day_horizon);
      // ensemble_spread_fade is explicitly a low-confidence trade and
      // gets normal exits.
      const holdToSettlement =
        (ensemble?.confidence ?? 0) >= CONFIG.hold_to_settlement_confidence;

      const baseMetadata = {
        question: market.question,
        city: parsed.city,
        temp_range: parsed.tempRange,
        forecast_high: forecast.high_f,
        forecast_low: forecast.low_f,
        score_total: score.total,
        score_breakdown: score.components,
        rationale: score.rationale,
        hours_to_resolve: Math.round(hoursToResolve * 10) / 10,
        nws_high: nws?.high_f,
        nws_low: nws?.low_f,
        ensemble_spread: ensemble?.spread,
        ensemble_confidence: ensemble?.confidence,
        metar_temp_f: metar?.temp_f,
        metar_icao: metar?.icao,
        metar_obs_time: metar?.observation_time,
        fee_rate: feeRate,
        raw_edge: Math.abs(score.edge),
        fee_adjusted_edge: adjEdge,
        hrrr_high: hrrr?.high_f, hrrr_low: hrrr?.low_f, data_sources: [nws ? 'NWS' : null, 'Open-Meteo', ensemble ? 'ECMWF-Ensemble' : null, metar ? 'METAR' : null, hrrr ? 'HRRR' : null].filter(Boolean),
        hold_to_settlement: holdToSettlement,
      };

      // L1-L6 calibration override
      const _cal = this.calibrationCache.get(market.condition_id);
      if (_cal && _cal.history_days >= 7) {
        const _rawP = score.yesProbability;
        score.yesProbability = _cal.final_prob;
        score.edge = score.yesProbability - market.yes_price;
        log.debug({ city: parsed.city, raw: _rawP.toFixed(3), cal: _cal.final_prob.toFixed(3), days: _cal.history_days }, 'L1-L6 override');
      }

      // ─── sub: single_forecast (baseline: 2-48h, score≥35, edge≥5%) ───
      // Dynamic score threshold when ensemble is wide (low confidence).
      let singleMinScore = CONFIG.min_score;
      if (ensemble) {
        if (ensemble.confidence < 0.3) singleMinScore = 999; // skip
        else if (ensemble.confidence < 0.5) singleMinScore = 50;
      }
      if (
        this.isSubStrategyEnabled(ctx, 'single_forecast') &&
        hoursToResolve >= 2 && hoursToResolve <= 48 &&
        score.total >= singleMinScore &&
        adjEdge >= CONFIG.min_edge
      ) {
        signals.push({
          signal_id: nanoid(),
          entity_slug: ctx.entity.config.slug,
          strategy_id: this.id,
          sub_strategy_id: 'single_forecast',
          condition_id: market.condition_id,
          token_id: scoredTokenId,
          side: 'BUY',
          outcome: scoredSide as 'YES' | 'NO',
          strength: Math.min(1, score.total / 100),
          edge: adjEdge,
          model_prob: scoredModelProb,
          market_price: scoredMarketPrice,
          recommended_size_usd: Math.round(15 * CONFIG.allocation_multiplier),
          metadata: { ...baseMetadata, sub_strategy: 'single_forecast', allocation_multiplier: CONFIG.allocation_multiplier },
          created_at: new Date(),
        });
        this.recentTrades.set(market.condition_id, now);
      }

      // ─── sub: same_day_snipe (<6h, very confident forecast) ───
      // Near-expiry forecasts are the most accurate (model error decays sharply
      // as the forecast horizon shrinks). We only fire on high-score markets and
      // accept a lower edge bar because confidence is correspondingly higher.
      if (
        this.isSubStrategyEnabled(ctx, 'same_day_snipe') &&
        hoursToResolve >= 0.5 && hoursToResolve < 6 &&
        score.total >= 70 &&
        adjEdge >= 0.03
      ) {
        signals.push({
          signal_id: nanoid(),
          entity_slug: ctx.entity.config.slug,
          strategy_id: this.id,
          sub_strategy_id: 'same_day_snipe',
          condition_id: market.condition_id,
          token_id: scoredTokenId,
          side: 'BUY',
          outcome: scoredSide as 'YES' | 'NO',
          strength: 0.95,
          edge: adjEdge,
          model_prob: scoredModelProb,
          market_price: scoredMarketPrice,
          recommended_size_usd: Math.round(8 * CONFIG.allocation_multiplier),
          metadata: { ...baseMetadata, sub_strategy: 'same_day_snipe', allocation_multiplier: CONFIG.allocation_multiplier },
          created_at: new Date(),
        });
      }

      // ─── sub: next_day_horizon (18-30h, confidence-focused) ───
      // The sweet spot where GFS/ECMWF is still highly accurate but Polymarket
      // hasn't priced the latest model runs yet — biggest systematic mispricings
      // historically land in this window.
      if (
        this.isSubStrategyEnabled(ctx, 'next_day_horizon') &&
        hoursToResolve >= 18 && hoursToResolve <= 30 &&
        score.total >= 50 &&
        adjEdge >= 0.04
      ) {
        signals.push({
          signal_id: nanoid(),
          entity_slug: ctx.entity.config.slug,
          strategy_id: this.id,
          sub_strategy_id: 'next_day_horizon',
          condition_id: market.condition_id,
          token_id: scoredTokenId,
          side: 'BUY',
          outcome: scoredSide as 'YES' | 'NO',
          strength: Math.min(1, score.total / 100),
          edge: adjEdge,
          model_prob: scoredModelProb,
          market_price: scoredMarketPrice,
          recommended_size_usd: Math.round(12 * CONFIG.allocation_multiplier),
          metadata: { ...baseMetadata, sub_strategy: 'next_day_horizon', allocation_multiplier: CONFIG.allocation_multiplier },
          created_at: new Date(),
        });
      }

      // ─── sub: ensemble_spread_fade (fade when market disagrees with model uncertainty) ───
      // Thesis: when ECMWF ensemble spread is WIDE (confidence < 0.4), the
      // true distribution is flatter than either tail of the market. If the
      // market is priced at an extreme (<15% or >85%), it's overconfident.
      // Fade the extreme by buying the opposite side — bet the market returns
      // toward the true uncertainty. Size conservatively.
      if (
        this.isSubStrategyEnabled(ctx, 'ensemble_spread_fade') &&
        ensemble && ensemble.confidence < 0.4 &&
        hoursToResolve >= 2 && hoursToResolve <= 48
      ) {
        const extremeYes = market.yes_price >= 0.85;
        const extremeNo = market.no_price >= 0.85;
        if (extremeYes || extremeNo) {
          // Fade the over-confident side: buy the discounted opposite.
          const fadeSide: 'YES' | 'NO' = extremeYes ? 'NO' : 'YES';
          const fadeTokenId = fadeSide === 'YES' ? market.token_yes_id : market.token_no_id;
          const fadePrice = fadeSide === 'YES' ? market.yes_price : market.no_price;
          if (fadePrice >= 0.05 && fadePrice <= 0.30) {
            signals.push({
              signal_id: nanoid(),
              entity_slug: ctx.entity.config.slug,
              strategy_id: this.id,
              sub_strategy_id: 'ensemble_spread_fade',
              condition_id: market.condition_id,
              token_id: fadeTokenId,
              side: 'BUY',
              outcome: fadeSide,
              strength: 0.5,
              // Edge: if ensemble says 50/50 and market prices discounted side at 10%,
              // naive fair value is 50%, so edge ~40%. We apply a haircut because
              // ensemble confidence <40% doesn't mean true prob is 50%. Then subtract fee drag.
              edge: Math.max(0, Math.max(0.05, 0.5 - fadePrice) * (1 - ensemble.confidence) - (feeRate * (1 - fadePrice))),
              model_prob: Math.min(0.5, fadePrice + 0.15),
              market_price: fadePrice,
              recommended_size_usd: Math.round(6 * CONFIG.allocation_multiplier),
              metadata: { ...baseMetadata, sub_strategy: 'ensemble_spread_fade', faded_extreme: extremeYes ? 'YES' : 'NO', allocation_multiplier: CONFIG.allocation_multiplier },
              created_at: new Date(),
            });
          }
        }
      }

      log.debug({
        market: market.question.substring(0, 60),
        city: parsed.city,
        score: score.total,
        raw_edge: (score.edge * 100).toFixed(1) + '%',
        fee_adj_edge: (adjEdge * 100).toFixed(1) + '%',
        fee_rate: feeRate,
        hours_to_resolve: hoursToResolve.toFixed(1),
      }, 'Weather market scored');
    }

    if (signals.length > 0) {
      log.info({ count: signals.length }, 'Weather signals generated');
    }

    return signals;
  }

  private parseWeatherQuestion(question: string): { city: string; tempRange: [number, number]; isCelsius: boolean } | null {
    const q = question.toLowerCase();

    // Find city
    let city: string | null = null;
    for (const cityName of Object.keys(CITY_COORDS)) {
      if (q.includes(cityName)) {
        city = cityName;
        break;
      }
    }
    if (!city) return null;

    // Detect unit
    const isCelsius = q.includes('°c') || q.includes('celsius') || (!q.includes('°f') && !q.includes('fahrenheit') && CELSIUS_CITIES.has(city));

    // Extract temperature range: "80-84°F" or "be 22°C" or "between 68-69°F"
    let tempRange: [number, number] | null = null;

    // Pattern: "X-Y°F" or "X-Y°C"
    const rangeMatch = q.match(/(\d+)\s*[-–]\s*(\d+)\s*°?[fc]?/);
    if (rangeMatch) {
      tempRange = [parseInt(rangeMatch[1]), parseInt(rangeMatch[2])];
    }

    // Pattern: "be X°C" (exact temp — treat as X to X)
    if (!tempRange) {
      const exactMatch = q.match(/be\s+(\d+)\s*°?[fc]/);
      if (exactMatch) {
        const t = parseInt(exactMatch[1]);
        tempRange = [t, t];
      }
    }

    if (!tempRange) return null;

    return { city, tempRange, isCelsius };
  }

  private async getForecast(city: string): Promise<ForecastData | null> {
    // Check cache
    const cached = this.forecastCache.get(city);
    if (cached && (Date.now() - cached.fetched_at) < CONFIG.forecast_cache_ttl_ms) {
      return cached;
    }

    const coords = CITY_COORDS[city];
    if (!coords) return null;

    try {
      // Phase R1.2 (2026-04-12): upgraded from the default GFS model to
      // ECMWF AIFS 0.25° — the AI-powered weather model launched July 2025,
      // CC-BY-4.0 licensed since Oct 2025. Per Vvtentt101 research: 20%
      // better temperature accuracy than classical ECMWF IFS.
      //
      // Using the ENSEMBLE endpoint as the primary source (not the forecast
      // endpoint, which returns nulls for AIFS). The ensemble endpoint gives
      // 50 members + a control run. We use the control run as the point
      // forecast and compute min/max across members for spread (which the
      // ensemble_spread_fade sub-strategy consumes separately via
      // getEnsembleSpread in data-feeds.ts).
      //
      // Fallback: if AIFS returns nulls (model run not yet available for
      // this forecast cycle), fall back to the default model which is
      // always populated.
      const aifsUrl = `https://ensemble-api.open-meteo.com/v1/ensemble?latitude=${coords[0]}&longitude=${coords[1]}&daily=temperature_2m_max,temperature_2m_min&forecast_days=3&temperature_unit=fahrenheit&timezone=auto&models=ecmwf_aifs025`;
      const defaultUrl = `https://api.open-meteo.com/v1/forecast?latitude=${coords[0]}&longitude=${coords[1]}&daily=temperature_2m_max,temperature_2m_min&forecast_days=3&temperature_unit=fahrenheit&timezone=auto`;
      let url = aifsUrl;
      let useAifs = true;
      let response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) {
        // AIFS endpoint failed — fall back to default
        if (useAifs) {
          url = defaultUrl;
          useAifs = false;
          response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
          if (!response.ok) return null;
        } else {
          return null;
        }
      }

      const data = await response.json() as OpenMeteoResponse;
      const daily = data.daily;
      if (!daily?.temperature_2m_max?.length || !daily?.temperature_2m_min?.length) return null;

      // AIFS ensemble returns the control member as the non-suffixed key.
      // If the control value is null (model run not published yet), fall
      // back to the default endpoint.
      let high_f = daily.temperature_2m_max[0];
      let low_f = daily.temperature_2m_min[0];
      if ((high_f === null || high_f === undefined) && useAifs) {
        // AIFS not available for this cycle — fallback
        try {
          const fallbackResp = await fetch(defaultUrl, { signal: AbortSignal.timeout(10_000) });
          if (fallbackResp.ok) {
            const fallbackData = await fallbackResp.json() as OpenMeteoResponse;
            const fbHigh = fallbackData.daily?.temperature_2m_max?.[0] ?? null;
            const fbLow = fallbackData.daily?.temperature_2m_min?.[0] ?? null;
            if (fbHigh !== null && fbLow !== null) {
              high_f = fbHigh;
              low_f = fbLow;
              useAifs = false;
            }
          }
        } catch {
          // Double fallback failed — use whatever we got
        }
      }
      if (high_f === null || high_f === undefined || low_f === null || low_f === undefined) return null;

      const forecast: ForecastData = {
        city,
        high_f,
        low_f,
        high_c: (high_f - 32) * 5 / 9,
        low_c: (low_f - 32) * 5 / 9,
        fetched_at: Date.now(),
      };

      this.forecastCache.set(city, forecast);
      return forecast;
    } catch (err) {
      log.debug({ city, err }, 'Forecast fetch failed');
      return null;
    }
  }

  private scoreMarket(
    market: MarketData,
    parsed: { city: string; tempRange: [number, number]; isCelsius: boolean },
    forecast: ForecastData,
    hoursToResolve: number,
  ): { total: number; edge: number; yesProbability: number; components: Record<string, number>; rationale: string[] } {
    const rationale: string[] = [];
    const components: Record<string, number> = {};

    // Convert forecast to market's unit
    const forecastHigh = parsed.isCelsius ? forecast.high_c : forecast.high_f;
    const forecastLow = parsed.isCelsius ? forecast.low_c : forecast.low_f;
    const [rangeMin, rangeMax] = parsed.tempRange;
    const unit = parsed.isCelsius ? '°C' : '°F';

    // 1. Forecast confidence (0-40 points)
    // Is the forecast INSIDE or OUTSIDE the market's temperature range?
    let forecastScore = 0;
    let yesProbability = 0.5; // Default: uncertain

    const forecastMid = (forecastHigh + forecastLow) / 2;

    if (rangeMin === rangeMax) {
      // Exact temp market (e.g., "be 22°C")
      // YES probability based on how close forecast is to exact value
      const diff = Math.abs(forecastHigh - rangeMin);
      if (diff <= 1) { yesProbability = 0.35; forecastScore = 15; rationale.push(`Forecast ${forecastHigh.toFixed(0)}${unit} close to target ${rangeMin}${unit}`); }
      else if (diff <= 3) { yesProbability = 0.15; forecastScore = 30; rationale.push(`Forecast ${forecastHigh.toFixed(0)}${unit} moderately far from target ${rangeMin}${unit}`); }
      else { yesProbability = 0.05; forecastScore = 40; rationale.push(`Forecast ${forecastHigh.toFixed(0)}${unit} far from target ${rangeMin}${unit} — strong NO`); }
    } else {
      // Range market (e.g., "68-69°F")
      if (forecastHigh < rangeMin - 3 || forecastLow > rangeMax + 3) {
        // Forecast completely outside range
        yesProbability = 0.05;
        forecastScore = 40;
        rationale.push(`Strong: forecast ${forecastLow.toFixed(0)}-${forecastHigh.toFixed(0)}${unit} well outside ${rangeMin}-${rangeMax}${unit}`);
      } else if (forecastHigh < rangeMin || forecastLow > rangeMax) {
        yesProbability = 0.15;
        forecastScore = 30;
        rationale.push(`Moderate: forecast ${forecastLow.toFixed(0)}-${forecastHigh.toFixed(0)}${unit} outside ${rangeMin}-${rangeMax}${unit}`);
      } else if (forecastHigh >= rangeMin && forecastLow <= rangeMax) {
        // Forecast spans the range — could go either way
        const rangeWidth = rangeMax - rangeMin;
        const overlapMin = Math.max(forecastLow, rangeMin);
        const overlapMax = Math.min(forecastHigh, rangeMax);
        const overlap = Math.max(0, overlapMax - overlapMin);
        const forecastSpan = forecastHigh - forecastLow || 1;
        yesProbability = Math.min(0.8, overlap / forecastSpan);
        forecastScore = 10;
        rationale.push(`Forecast overlaps range: ${yesProbability.toFixed(2)} YES prob`);
      } else {
        yesProbability = 0.25;
        forecastScore = 20;
        rationale.push(`Partial overlap between forecast and range`);
      }
    }
    components['forecast'] = forecastScore;

    // 2. Edge calculation
    const yesPrice = market.yes_price;
    const noPrice = market.no_price;
    // Positive edge = YES is underpriced (model > market), negative = NO is underpriced
    const edge = yesProbability - yesPrice;
    components['edge_bps'] = Math.round(Math.abs(edge) * 10000);

    // 3. Time score (0-15)
    let timeScore = 0;
    if (hoursToResolve >= 6 && hoursToResolve <= 48) { timeScore = 15; }
    else if (hoursToResolve >= 2 && hoursToResolve < 6) { timeScore = 10; }
    components['time'] = timeScore;

    // 4. Price attractiveness (0-15) — prefer markets where our side is cheaper (more upside)
    let priceScore = 0;
    const ourPrice = edge > 0 ? yesPrice : noPrice;
    if (ourPrice < 0.30) priceScore = 15;
    else if (ourPrice < 0.50) priceScore = 12;
    else if (ourPrice < 0.70) priceScore = 8;
    else priceScore = 3;
    components['price'] = priceScore;

    const total = forecastScore + timeScore + priceScore;

    return { total, edge, yesProbability, components, rationale };
  }

  shouldRun(_ctx: StrategyContext): boolean {
    const cutoff = Date.now() - (8 * 60 * 60 * 1000);
    for (const [key, ts] of this.recentTrades) {
      if (ts < cutoff) this.recentTrades.delete(key);
    }
    return true;
  }
}

interface OpenMeteoResponse {
  daily?: {
    temperature_2m_max?: number[];
    temperature_2m_min?: number[];
    time?: string[];
  };
}
