# Weather Trading on Polymarket

Weather is one of the highest-edge categories on Polymarket. Daily volumes hit $2M+, resolution is objective and precise, and the information advantage is structural — weather models are public data that most traders don't monitor systematically. Top weather traders have extracted $1M+ in profit.

## Market Types

### Daily High Temperature
The dominant weather market type (~55.7% of weather trades). "Will the high temperature in [city] on [date] be above/below X°F?" Resolution is binary against a specific weather station reading.

**Active cities**: NYC, London, Los Angeles, Chicago, Shanghai, Hong Kong, and expanding.

### Monthly Precipitation
"Will precipitation in [city] in [month] exceed X inches?" Resolution against NOAA or equivalent official measurements. Longer duration, fewer markets, but less competition.

### Climate Records
"Will March 2026 be the hottest on record?" Resolution against global temperature anomaly datasets (NOAA, NASA GISS, Copernicus ERA5). These are longer-dated with larger position sizes.

### Extreme Weather Events
"Will a Category 4+ hurricane make US landfall in 2026?" Resolution against NHC classifications. Seasonal, lower frequency, but larger payouts.

## The Edge: Forecast Model Arbitrage

The core strategy is exploiting the lag between weather model updates and Polymarket price adjustments.

### Model Update Schedule

| Model | Operator | Update Frequency | Key Runs (UTC) | Availability Lag |
|-------|----------|-----------------|-----------------|------------------|
| **GFS** | NOAA (US) | Every 6 hours | 00, 06, 12, 18 | ~3.5 hours after init |
| **ECMWF (IFS)** | European Centre | Every 6 hours | 00, 06, 12, 18 | ~6-8 hours after init |
| **NAM** | NOAA (US) | Every 6 hours | 00, 06, 12, 18 | ~1.5 hours after init |
| **ICON** | DWD (Germany) | Every 6 hours | 00, 06, 12, 18 | ~4 hours after init |
| **HRRR** | NOAA (US) | Hourly | Every hour | ~45 min after init |

### The Trading Window

1. **New model run completes** — GFS 12z run finishes around 15:30 UTC
2. **Forecast shifts** — New run shows tomorrow's NYC high at 78°F, up from 72°F in previous run
3. **Polymarket hasn't repriced** — Shares for "High above 75°F" still trading at $0.35
4. **Buy** — Multiple models now support >75°F, fair value is $0.70+
5. **Market catches up** — Within 30-120 minutes, other traders notice and price moves to $0.65-0.75
6. **Exit or hold** — Sell for immediate profit or hold to resolution

The window is typically 30 minutes to 2 hours. Automation (even simple alerts) dramatically increases capture rate.

### Multi-Model Consensus

Don't trade on a single model flip. The edge strengthens when:

- **3+ models agree** on the same temperature range → 70-90% probability
- **Model spread narrows** as the forecast date approaches → higher confidence
- **Ensemble agreement** within a single model (GFS has 31 ensemble members) → tighter distribution = higher conviction

When models disagree, the market is efficiently uncertain — stay out.

## Resolution Sources & Precision

**Critical**: Know exactly what resolves the market before trading.

| City | Resolution Source | Station | Precision |
|------|------------------|---------|-----------|
| NYC | NOAA / NWS | Central Park (KNYC) | 0.1°F / 0.01" precip |
| London | Weather Underground | London City Airport (EGLC) | 0.1°C |
| LA | NOAA / NWS | Downtown LA (KCQT) | 0.1°F |
| Chicago | NOAA / NWS | O'Hare (KORD) | 0.1°F |

**Trap**: The forecast is for a region, but resolution is for a specific station. Microclimates, urban heat islands, and station elevation all create gaps between the forecast and the measured value. A forecast of 80°F for "NYC" might read 82°F at Central Park due to heat island effects.

## Tools for Weather Trading

| Tool | URL | Purpose |
|------|-----|---------|
| **Polyforecast.io** | polyforecast.io | Free daily trading signals based on model consensus |
| **Pivotal Weather** | pivotalweather.com | GFS/ECMWF/NAM forecast maps and model comparison |
| **Tropical Tidbits** | tropicaltidbits.com | Model soundings, ensemble spreads |
| **Weather.gov** | weather.gov | Official NWS forecasts and observations |
| **ECMWF Charts** | charts.ecmwf.int | European model output |
| **Windy** | windy.com | Multi-model visualization |
| **Weather Underground** | wunderground.com | Station-level observations (resolution source) |

## Position Sizing for Weather

Weather markets are high-frequency, low-edge-per-trade, high-volume strategy. Size accordingly:

- **Per-trade risk**: 1-2% of bankroll (not 5% — you're placing many trades per day)
- **Daily exposure cap**: 10-15% of bankroll across all open weather positions
- **Correlation awareness**: NYC and Central Park resolve from the same station — don't double up thinking they're independent

## Compounding Advantage

Weather markets are the best compounding vehicle on Polymarket because:
- **Short duration**: Most resolve within 24-48 hours
- **High frequency**: 5-15 tradeable opportunities per day across cities
- **Objective resolution**: No ambiguity, no disputes
- **Structural edge**: Model data is free and public, but most traders don't use it

At 1-3% daily return compounding across 20 trading days/month, the math is powerful:
- (1.02)^20 = 1.486 → 48.6% monthly return
- (1.01)^20 = 1.220 → 22.0% monthly return
- Even 0.5% daily: (1.005)^20 = 1.105 → 10.5% monthly

## Bot Architecture (Level 4+)

The GitHub repo `suislanchez/polymarket-kalshi-weather-bot` provides a working template:
- Fetches 31-member GFS ensemble forecasts
- Computes probability distributions for temperature ranges
- Compares against Polymarket/Kalshi prices
- Executes Kelly-sized orders when edge exceeds threshold
- Reports: $1,325 in profits as of March 2026

Build your own version:
1. **Data ingestion**: Pull GFS/ECMWF data via NOMADS or Open-Meteo API
2. **Probability engine**: Convert ensemble spread to probability distribution
3. **Price comparison**: Fetch Polymarket prices via Gamma API
4. **Edge detection**: Flag opportunities where model probability > market price by threshold
5. **Execution**: Place limit orders via CLOB API
6. **Monitoring**: Track P&L, calibration, and model accuracy over time
