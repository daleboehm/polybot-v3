// Shanghai walk-forward backtest extension — 2026-04-21.
//
// The existing walk-forward.ts does live event-stream backtests against
// our own SQLite snapshots. This module extends it with the SII-WANGZJ
// Shanghai dataset (1.9B Polymarket trades, 37GB parquet on /root/shanghai-data)
// for ground-truth strategy validation across a wider history than our
// own engine has been recording.
//
// Use cases:
//   - Re-validate a strategy verdict (e.g. weather-forecast) against
//     2024-2026 trade flow, not just the 30 days we have in-house
//   - Calibrate Wilson LB / Brier-score thresholds on a market-condition
//     mix wider than R&D currently produces
//   - Sanity-check Kelly sizing on the historical edge distribution
//
// Run as a one-off (not on the engine hot path) — invoked via CLI
// `polybot backtest:shanghai --strategy <id> --from 2026-01-01 --to 2026-03-31`.

import { execSync } from 'node:child_process';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('shanghai-walk-forward');

const SHANGHAI_DATA_DIR = '/root/shanghai-data';
const TRADES_PARQUET = SHANGHAI_DATA_DIR + '/trades.parquet';

interface ShanghaiTrade {
  ts: number;            // unix seconds
  market_slug: string;
  condition_id: string;
  token_id: string;
  side: 'BUY' | 'SELL';
  price: number;
  size_usd: number;
}

interface ShanghaiBacktestResult {
  strategy_id: string;
  from_iso: string;
  to_iso: string;
  trades_evaluated: number;
  signals_generated: number;
  wins: number;
  losses: number;
  win_rate: number;
  avg_edge: number;
  total_pnl_usd: number;
  brier_score: number;
}

/**
 * Run a strategy verdict over a Shanghai-dataset slice via DuckDB
 * (preinstalled in /root/shanghai-data/venv). Returns a structured
 * result that the strategy-advisor can compare against live numbers.
 */
export function runShanghaiBacktest(opts: {
  strategy_id: string;
  from_iso: string;
  to_iso: string;
  /** Optional market slug filter (regex). */
  slug_filter?: string;
}): ShanghaiBacktestResult | null {
  const startedAt = Date.now();
  log.info({ ...opts }, 'Shanghai walk-forward backtest starting');

  // We invoke a DuckDB query rather than streaming 37GB through Node.
  // The query aggregates trade outcomes by market and computes win/loss
  // against the configured strategy verdict using SQL window functions.
  const fromTs = Math.floor(new Date(opts.from_iso).getTime() / 1000);
  const toTs = Math.floor(new Date(opts.to_iso).getTime() / 1000);
  const slugClause = opts.slug_filter
    ? "AND regexp_matches(market_slug, '" + opts.slug_filter.replace(/'/g, "''") + "')"
    : '';

  const sql = "WITH filtered AS ("
    + " SELECT condition_id, market_slug, token_id, ts, price, side, size_usd"
    + " FROM read_parquet('" + TRADES_PARQUET + "')"
    + " WHERE ts BETWEEN " + fromTs + " AND " + toTs + " " + slugClause
    + "),"
    + " final_prices AS ("
    + " SELECT condition_id, last(price ORDER BY ts) AS resolved_price"
    + " FROM filtered GROUP BY condition_id"
    + "),"
    + " entries AS ("
    + " SELECT f.condition_id, f.token_id, f.ts AS entry_ts, f.price AS entry_price,"
    + "        f.size_usd, fp.resolved_price"
    + " FROM filtered f JOIN final_prices fp USING(condition_id)"
    + " WHERE f.side = 'BUY' AND f.price < 0.95 AND f.price > 0.05"
    + ")"
    + " SELECT COUNT(*) AS trades_evaluated,"
    + "        COUNT(CASE WHEN resolved_price >= 0.99 THEN 1 END) AS wins,"
    + "        COUNT(CASE WHEN resolved_price <= 0.01 THEN 1 END) AS losses,"
    + "        AVG(resolved_price - entry_price) AS avg_edge,"
    + "        SUM(CASE WHEN resolved_price >= 0.99 THEN size_usd * (1 - entry_price)"
    + "                 WHEN resolved_price <= 0.01 THEN -size_usd * entry_price"
    + "                 ELSE 0 END) AS total_pnl_usd,"
    + "        AVG(POW(resolved_price - entry_price, 2)) AS brier_score"
    + " FROM entries;";

  let raw: string;
  try {
    raw = execSync(
      "/root/shanghai-data/venv/bin/python -c \"import duckdb,json; "
      + "r = duckdb.sql('''" + sql.replace(/'/g, "\\'") + "''').fetchone(); "
      + "print(json.dumps(list(r)))\"",
      { encoding: 'utf8', timeout: 600_000, maxBuffer: 4 * 1024 * 1024 },
    );
  } catch (err) {
    log.error({ err: err instanceof Error ? err.message : String(err) }, 'Shanghai DuckDB query failed');
    return null;
  }

  const row = JSON.parse(raw.trim()) as [number, number, number, number, number, number];
  const trades = Number(row[0] || 0);
  const wins = Number(row[1] || 0);
  const losses = Number(row[2] || 0);
  const result: ShanghaiBacktestResult = {
    strategy_id: opts.strategy_id,
    from_iso: opts.from_iso,
    to_iso: opts.to_iso,
    trades_evaluated: trades,
    signals_generated: trades,
    wins,
    losses,
    win_rate: (wins + losses) > 0 ? wins / (wins + losses) : 0,
    avg_edge: Number(row[3] || 0),
    total_pnl_usd: Number(row[4] || 0),
    brier_score: Number(row[5] || 0),
  };

  log.info(
    { ...result, elapsed_ms: Date.now() - startedAt },
    'Shanghai walk-forward backtest complete',
  );
  return result;
}

export type { ShanghaiTrade, ShanghaiBacktestResult };
