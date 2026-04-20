// RSI + MACD signals from Binance 5-min klines.
// 2026-04-20 (04-19 report, stacyonchain 2e): BTC Up/Down session-aware
// signal logic. Asia hours = range/reversal (fade extremes), NY = directional
// (follow momentum). crypto_price strategy had n=3 resolved trades with no
// edge signal — this gives it one.

import { createChildLogger } from '../core/logger.js';
const log = createChildLogger('rsi-macd');

export interface TaSignal {
  rsi: number;
  macd: number;
  macd_signal: number;
  macd_histogram: number;
  macd_histogram_shrinking: boolean;
  session: 'asia' | 'europe' | 'ny';
  suggested_side: 'BUY_UP' | 'BUY_DOWN' | 'NEUTRAL';
  rationale: string;
}

const BINANCE_KLINE_SYMBOLS: Record<string, string> = {
  bitcoin: 'BTCUSDT', btc: 'BTCUSDT',
  ethereum: 'ETHUSDT', eth: 'ETHUSDT',
  solana: 'SOLUSDT', sol: 'SOLUSDT',
};

function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [values[0]];
  for (let i = 1; i < values.length; i++) {
    out.push(values[i] * k + out[i - 1] * (1 - k));
  }
  return out;
}

function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gainSum = 0, lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change >= 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function classifySession(): 'asia' | 'europe' | 'ny' {
  const hUtc = new Date().getUTCHours();
  if (hUtc >= 0 && hUtc < 8) return 'asia';
  if (hUtc >= 8 && hUtc < 13) return 'europe';
  return 'ny';
}

export async function getTaSignal(asset: string): Promise<TaSignal | null> {
  const key = asset.toLowerCase();
  const symbol = BINANCE_KLINE_SYMBOLS[key];
  if (!symbol) return null;

  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=50`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return null;
    const data = (await resp.json()) as unknown[][];
    if (!Array.isArray(data) || data.length < 30) return null;

    const closes = data.map((c) => Number(c[4])).filter((n) => Number.isFinite(n));

    const rsiVal = rsi(closes, 14);
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const macdLine = ema12.map((v, i) => v - ema26[i]);
    const signalLine = ema(macdLine, 9);
    const histogram = macdLine.map((v, i) => v - signalLine[i]);
    const h = histogram.slice(-4);
    const shrinking =
      h.length >= 4 && Math.abs(h[1]) > Math.abs(h[2]) && Math.abs(h[2]) > Math.abs(h[3]);

    const session = classifySession();
    const lastHist = histogram[histogram.length - 1];

    let side: 'BUY_UP' | 'BUY_DOWN' | 'NEUTRAL' = 'NEUTRAL';
    let rationale = '';
    if (rsiVal > 70 && shrinking) {
      side = 'BUY_DOWN';
      rationale = `RSI ${rsiVal.toFixed(1)} overbought + MACD hist shrinking -> fade`;
    } else if (rsiVal < 30 && shrinking && lastHist > 0) {
      side = 'BUY_UP';
      rationale = `RSI ${rsiVal.toFixed(1)} oversold + MACD turning up -> reversal`;
    } else if (session === 'ny' && rsiVal > 55 && lastHist > 0 && !shrinking) {
      side = 'BUY_UP';
      rationale = `NY momentum: RSI ${rsiVal.toFixed(1)} + MACD expanding positive`;
    } else if (session === 'ny' && rsiVal < 45 && lastHist < 0 && !shrinking) {
      side = 'BUY_DOWN';
      rationale = `NY momentum: RSI ${rsiVal.toFixed(1)} + MACD expanding negative`;
    } else {
      rationale = `RSI ${rsiVal.toFixed(1)} session=${session} - no edge`;
    }

    log.debug({ asset: key, rsi: rsiVal.toFixed(1), macd_hist: lastHist.toFixed(2), session, side }, 'TA signal computed');
    return {
      rsi: rsiVal,
      macd: macdLine[macdLine.length - 1],
      macd_signal: signalLine[signalLine.length - 1],
      macd_histogram: lastHist,
      macd_histogram_shrinking: shrinking,
      session,
      suggested_side: side,
      rationale,
    };
  } catch (err) {
    log.debug({ asset: key, err }, 'TA signal fetch failed');
    return null;
  }
}
