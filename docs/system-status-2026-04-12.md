# Polybot V3 — System Status

> Generated: 2026-04-12 1:00 PM CT | VPS: 178.62.225.235:2222

## Operational State

| Engine | Status | Port | Dashboard | Mode |
|---|---|---|---|---|
| **Prod** | Active | 9100 | sageadvisors.ai | Live (USDC) |
| **R&D** | Active | 9200 | rd.sageadvisors.ai/rd | Paper |

## Prod Capital

| Metric | Value |
|---|---|
| On-chain USDC | $0.08 |
| Open positions | 19 |
| Open cost basis | $74.55 |
| Open mark-to-market | $77.10 |
| **Total equity** | **~$77** |
| Starting capital | $257.09 |
| Realized P&L (all-time) | -$18.74 |

**Cash is $0.08 because the engine deployed all available capital into
positions.** No new trades will fire until positions resolve and return
cash. This is expected steady-state at this bankroll level with the
5-share CLOB minimum — each position costs $3-5 and the engine runs
15-20 concurrent positions.

## Strategy Performance (Prod, all-time)

| Strategy.Sub | n | Wins | Losses | WR | P&L | Status |
|---|---|---|---|---|---|---|
| weather_forecast.single_forecast | 36 | 4 | 2 | 67% | +$2.25 | Active, AIFS model |
| favorites.compounding | 80 | 11 | 7 | 61% | +$2.23 | Active |
| convergence.long_term_grind | 81 | 0 | 0 | — | $0 | Active (pre-fix zeros) |
| longshot.bucketed_fade | 44 | 0 | 0 | — | $0 | Active, protected |
| longshot.news_overreaction_fade | 76 | 0 | 0 | — | $0 | Active |
| longshot.systematic_fade | 33 | 0 | 0 | — | $0 | Active |
| sportsbook_fade | 14 | 0 | 1 | — | -$1.05 | **DISABLED** (24h review) |
| favorites.stratified_bias | 23 | 1 | 3 | 25% | -$5.80 | **DISABLED** (config exclusion) |
| favorites.fan_fade | 4 | 0 | 0 | — | $0 | **DISABLED** (advisor auto-disable) |

Note: longshot and convergence resolutions showing 0 wins/0 losses
are pre-reconciler-fix artifacts. The reconciler fix landed 2026-04-11
and new resolutions now show real P&L. These counts will correct as
more positions resolve through the fixed path.

## Scout Fleet

| Scout | Status | Activity |
|---|---|---|
| volume-spike-scout | Active | Monitoring, low signal frequency |
| price-jump-scout | Active | Monitoring, low signal frequency |
| new-listing-scout | Active | Seeded 401 markets on last restart |
| llm-news-scout | **Active (FIXED)** | Completing in 3s per call, 0 catalysts detected (correct steady-state) |
| exchange-divergence-scout | Active | 0 flags (BTC within range of exchange consensus) |
| leaderboard-poller-scout | Dormant (disabled in config) | Awaiting whale pipeline activation |

## Feature Flags

| Flag | Value | Effect |
|---|---|---|
| ADVISOR_V2_ENABLED | true (prod systemd drop-in) | DSR/PSR shadow logging, non-voting |
| WHALE_COPY_ENABLED | not set | Whale pipeline dormant |
| scouts.disabled_scouts | [leaderboard-poller-scout] | All other scouts active |

## Phase B Shadow Data (24 hours)

| Classification | Count | % |
|---|---|---|
| insufficient_data | 2832 | 65% |
| agrees | 1288 | 30% |
| disagrees | 231 | 5% |

231 disagrees out of 1519 opinionated decisions = 15.2% disagreement
rate between Wilson LB and DSR/PSR. Continuing 7-day accumulation
before promoting v2 to a voting role.

## Recent Changes (last 48h, chronological)

1. **Reconciler fix** — switched from `status=active` Data API filter to unfiltered `getAllPositions()` + `cashPnl` as authoritative P&L. Fixed 348/360 phantom zero-P&L resolutions.
2. **$40.08 redeemed** — 22 negRisk positions cashed out via `polybot redeem-all` CLI.
3. **5-share CLOB minimum** — position sizer now clamps to Polymarket's minimum order size.
4. **AIFS weather model** — upgraded from GFS default to ECMWF AIFS 0.25° (20% more accurate, free).
5. **BTC-only crypto gate** — ETH/SOL markets filtered out.
6. **Phase A hardening** — tail-zone dead-band, tick-size-weighted pricing, wash-trading penalty, price-conditioned maker gate.
7. **Phase B advisor v2** — DSR/PSR shadow mode running on prod, 15.2% disagree rate.
8. **Scout fleet** — 5 active scouts + 1 dormant leaderboard poller.
9. **LLM news scout** — fixed silent hang (maxRetries 4→1), now completing in 3s.
10. **Exchange divergence scout** — deployed, 3-source BTC price tracking (Binance + Coinbase + CoinGecko/Chainlink).
11. **Whale tracking pipeline** — fully built, dormant behind 4-gate activation.
12. **sportsbook_fade disabled** — 24h review: 14 resolutions, 0 wins, -$1.05.
13. **favorites.fan_fade auto-disabled** — advisor Wilson gate fired.
14. **CLAUDE.md v3.7** — 4 partnership commitments added.

## Next Steps

1. **Wait for positions to resolve** — prod has $0.08 cash and 19 open positions. Cash returns as markets settle.
2. **48-hour bucketed_fade review** — due 2026-04-13. Check v_strategy_performance for n>=30 with real P&L.
3. **Phase B shadow data accumulation** — 7-day window ends ~2026-04-18. Then decide on Wilson vs DSR/PSR.
4. **Whale pipeline activation** — when ready: flip 4 gates per docs/todo.md playbook.
5. **Non-negRisk redemption** — 8 positions with ~$6.98 locked in CTF contract. Needs separate CTF Exchange redemption path.
