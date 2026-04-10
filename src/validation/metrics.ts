// Risk-adjusted performance metrics for strategy evaluation.
//
// R2 PR#2 extensions (2026-04-10). Consumed by the advisor for risk-adjusted
// promotion decisions, by the dashboard for strategy scoreboards, and by the
// R3b metrics/monitoring layer for alerting.
//
// All metrics take a series of realized P&L values (one per resolved position)
// rather than raw returns, because Polymarket positions have binary outcomes
// and discrete cost bases — the "return" model from continuous markets doesn't
// map cleanly. We use P&L normalized by cost basis where a continuous return
// is needed.
//
// Conventions:
//   - pnl > 0 = win, pnl ≤ 0 = loss
//   - costBasis > 0 for every position (should never be zero)
//   - All annualization assumes 252 trading days (crypto/PM markets don't close
//     but 252 is the industry standard and it just affects the scale of the number)

export interface StrategyMetrics {
  n: number;                   // sample size
  totalPnl: number;            // sum of realized P&L
  meanPnl: number;             // arithmetic mean per trade
  stdPnl: number;              // population standard deviation
  downsideStd: number;         // std of negative P&L only (Sortino denominator)
  winRate: number;             // wins / n
  avgWin: number;              // mean of positive P&L
  avgLoss: number;             // mean of |negative P&L| (magnitude)
  profitFactor: number;        // sum(wins) / |sum(losses)|, Infinity if no losses
  maxDrawdown: number;         // peak-to-trough decline in the cumulative P&L curve (USD)
  maxDrawdownPct: number;      // same as fraction of peak cumulative P&L
  sharpe: number;              // annualized Sharpe (risk-free = 0)
  sortino: number;             // annualized Sortino
  calmar: number;              // annualized return / max drawdown pct
  expectancy: number;          // winRate * avgWin - (1-winRate) * avgLoss
}

const TRADES_PER_YEAR = 252;

/**
 * Compute all risk-adjusted metrics from a list of realized P&L values.
 * Pass resolved positions' `realized_pnl` in chronological order.
 *
 * Returns NaN-safe values — if n=0, most metrics default to 0 and ratios to 0
 * (not Infinity or NaN) so callers don't have to special-case empty history.
 */
export function computeStrategyMetrics(pnls: number[]): StrategyMetrics {
  const n = pnls.length;
  if (n === 0) {
    return {
      n: 0, totalPnl: 0, meanPnl: 0, stdPnl: 0, downsideStd: 0,
      winRate: 0, avgWin: 0, avgLoss: 0, profitFactor: 0,
      maxDrawdown: 0, maxDrawdownPct: 0,
      sharpe: 0, sortino: 0, calmar: 0, expectancy: 0,
    };
  }

  const totalPnl = pnls.reduce((s, x) => s + x, 0);
  const meanPnl = totalPnl / n;

  const variance = pnls.reduce((s, x) => s + (x - meanPnl) ** 2, 0) / n;
  const stdPnl = Math.sqrt(variance);

  const losses = pnls.filter(x => x < 0);
  const wins = pnls.filter(x => x > 0);
  const downsideVar = losses.length > 0
    ? losses.reduce((s, x) => s + x ** 2, 0) / n // using 0 as MAR (minimum acceptable return)
    : 0;
  const downsideStd = Math.sqrt(downsideVar);

  const winRate = wins.length / n;
  const avgWin = wins.length > 0 ? wins.reduce((s, x) => s + x, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, x) => s + x, 0) / losses.length) : 0;

  const totalWin = wins.reduce((s, x) => s + x, 0);
  const totalLoss = Math.abs(losses.reduce((s, x) => s + x, 0));
  const profitFactor = totalLoss > 0 ? totalWin / totalLoss : (totalWin > 0 ? Number.POSITIVE_INFINITY : 0);

  // Max drawdown on cumulative P&L curve
  let cum = 0;
  let peak = 0;
  let maxDd = 0;
  for (const p of pnls) {
    cum += p;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDd) maxDd = dd;
  }
  const maxDrawdown = maxDd;
  const maxDrawdownPct = peak > 0 ? maxDd / peak : 0;

  // Annualized Sharpe: mean / std * sqrt(tradesPerYear)
  const sharpe = stdPnl > 0 ? (meanPnl / stdPnl) * Math.sqrt(TRADES_PER_YEAR) : 0;
  // Annualized Sortino: mean / downsideStd * sqrt(tradesPerYear)
  const sortino = downsideStd > 0 ? (meanPnl / downsideStd) * Math.sqrt(TRADES_PER_YEAR) : 0;
  // Calmar: annualized mean / max drawdown pct
  const annualMean = meanPnl * TRADES_PER_YEAR;
  const calmar = maxDrawdownPct > 0 ? annualMean / (maxDrawdownPct * peak) : 0;

  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

  return {
    n, totalPnl, meanPnl, stdPnl, downsideStd,
    winRate, avgWin, avgLoss, profitFactor,
    maxDrawdown, maxDrawdownPct,
    sharpe, sortino, calmar, expectancy,
  };
}
