# Polymarket Strategy Overhaul — April 2, 2026

## Situation Assessment

**400 resolved trades. 2 wins. 0.5% win rate. -$910 P&L. -104% return on volume.**

Every strategy, entry bucket, side, and category showed negative expected value. The Kelly criterion returned "DO NOT TRADE" for every combination tested. The system had no measurable edge and was systematically donating money to the market.

## Root Cause Analysis

### Old Strategy Failures

1. **Grinder (NO at 92-98¢)**: Bought near-certain outcomes to collect 2-8% profit per trade. Problem: one loss wipes out 9-50 wins. 0% win rate on the NO 0.90-0.95 bucket (-$173 on 20 trades).

2. **Sprint Trader (weather markets)**: Exact-temperature bets using GFS weather ensemble. Problem: multi-outcome markets with 10-15 temperature bins. Even with a weather model, the market is efficiently priced. 283 weather trades → -$527.

3. **Kelly Engine**: Zero data. All trades tagged "unknown" strategy. Insufficient trade history for any edge estimation. Running in shadow mode with no actual influence on sizing.

4. **Structural Issue**: The entire approach was high-entry (0.90+) buying, which guarantees catastrophic risk/reward. At 95¢ entry, you risk $0.95 to make $0.05 — requiring >95% accuracy just to break even.

## Backtest Results

| Entry Bucket | Trades | Win Rate | EV/Trade | Net P&L | Verdict |
|---|---|---|---|---|---|
| 0.01-0.10 | 191 | 0.0% | -$0.90 | -$171 | NO EDGE |
| 0.10-0.20 | 19 | 0.0% | -$1.58 | -$30 | NO EDGE |
| 0.90-0.95 | 20 | 0.0% | -$8.66 | -$173 | NO EDGE |
| 0.95-1.00 | 34 | 5.9% | -$4.02 | -$137 | NO EDGE |

If the new rules (no weather, no entry >0.55, minimum 1.5x payoff) had been applied historically, we would have avoided 103 of 400 trades and saved $458 — but the remaining 297 still lost $452.

## Actions Taken

### Immediate (April 2, 2026)

1. **Killed all trading cron jobs**: grinder, sprint_trader, edge_trader, round1_sweep, auto_deposit, fund_armorstack — all PAUSED with crontab backup.

2. **Preserved operational systems**: position_monitor, auto_redeem, resolution_scan, db_writer, reconcile, pnl_engine, email_report, health checks — all still running.

3. **Deployed new arb_scanner_v2.py** in PAPER-TRADE mode (dry run, no execution). Runs every 30 minutes, logs all opportunities to `/opt/polybot/logs/paper_trades.jsonl`.

4. **Deployed backtest_engine.py** for ongoing performance analysis.

### Open Positions (Let Ride)

18 positions, $167 at risk, $4 unrealized gain. Mostly weather NO bets at 0.87-0.98 entry. These will resolve naturally — most should win (they're correct-direction bets), but the net gain will be small relative to risk.

## New Strategy Framework

### Strategy 1: Sum-to-One Arbitrage
- Buy YES + NO when order book prices sum to < 1.00 after fees
- Risk: ~0% (guaranteed profit on resolution)
- Reality: Gamma midpoints always sum to 1.00. Arb exists only in order book spread, which is tight on high-volume markets. Viable but opportunities are rare.

### Strategy 2: Value Directional
- Buy ONLY when estimated true probability > market price by ≥10%
- Entry price cap: 0.55 (ensures ≥1.8x payoff ratio)
- Probability estimation via external data (crypto current price vs target, expired deadlines)
- Blacklisted: all exact-outcome weather markets, all narrow-range temperature bets

### Strategy 3: Favorable Skew
- Buy cheap outcomes (<0.35) on near-term markets where data supports direction
- Payoff: 2.8x+ (risk $0.35 to make $0.65). One win covers 2-3 losses.
- Only markets resolving within 48 hours with verifiable probability estimates.

### Hard Rules
- NEVER trade exact-outcome weather markets
- NEVER buy above 0.55 for directional trades
- NEVER trade without measured edge (estimated probability must diverge from price by ≥10%)
- Kelly sizing caps at 25% of balance per trade
- All strategies paper-traded for minimum 7 days before live execution

## Market Assessment (April 2, 2026)

The Polymarket market is highly efficient:
- Crypto binary markets (BTC above $X) are priced within 1-3% of true probability
- Expired deadline markets are already at 0.0005/0.9995
- Only 7.6% of Polymarket wallets are profitable (industry research)
- Fee structure: 0-1.8% taker fees depending on category

## Roadmap

### Week 1 (Apr 2-9): Paper Trade
- Scanner runs every 30 min in dry-run mode
- Log all opportunities to paper_trades.jsonl
- Existing positions resolve naturally
- Analyze paper trade results daily

### Week 2 (Apr 9-16): Validate
- Run backtest_engine.py on paper trade data
- Measure hypothetical edge per strategy
- If any strategy shows positive EV: proceed to live
- If no strategy shows edge: research additional data sources (sports odds APIs, sentiment analysis)

### Week 3+ (Apr 16+): Selective Live Trading
- Enable live execution ONLY for strategies with demonstrated positive EV
- Start with $5 max risk per cycle
- Scale based on measured results
- Weekly performance review

## Current State

| Metric | Value |
|---|---|
| USDC Balance | $11.20 |
| Open Positions | 18 |
| Capital at Risk | $167.07 |
| Unrealized P&L | +$4.00 |
| Trading Status | PAUSED (paper-trade only) |
| Scanner Mode | DRY RUN (every 30 min) |

## Files Deployed

- `/opt/polybot/arb_scanner_v2.py` — New strategy scanner (paper-trade mode)
- `/opt/polybot/backtest_engine.py` — Historical performance analyzer
- `/opt/polybot/crontab_backup_*.txt` — Pre-change crontab backup
