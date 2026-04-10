# Capital Lockup & Opportunity Cost Math

A $0.92 Yes share that resolves in 3 months looks like a safe 8.7% return. But your capital is locked for 90 days. Annualized, that's ~35% — which may or may not beat alternative deployments. This reference covers the math traders skip.

## The Core Problem

Prediction market returns are quoted as absolute return per share, but capital has a time cost. $100 locked in a 3-month market earning 8% cannot simultaneously be deployed in a 1-week market earning 3%. The 1-week trade, annualized, returns ~156%. The opportunity cost of the 3-month lock is enormous.

## Annualized Return Calculation

```
Absolute Return = (Payout – Entry Price) / Entry Price
Annualized Return = (1 + Absolute Return) ^ (365 / Days Locked) – 1
```

### Examples

| Entry Price | Payout | Absolute Return | Days to Resolution | Annualized Return |
|-------------|--------|-----------------|--------------------|--------------------|
| $0.92 | $1.00 | 8.7% | 90 | 39.4% |
| $0.92 | $1.00 | 8.7% | 30 | 185.6% |
| $0.92 | $1.00 | 8.7% | 7 | 3,547% |
| $0.98 | $1.00 | 2.0% | 90 | 8.3% |
| $0.98 | $1.00 | 2.0% | 7 | 178.5% |
| $0.75 | $1.00 | 33.3% | 180 | 80.4% |
| $0.75 | $1.00 | 33.3% | 14 | 26,569% |

The pattern is clear: short-duration trades at the same absolute return massively outperform long-duration trades on an annualized basis.

## When Long-Dated Positions Make Sense

Despite the opportunity cost, long-dated positions are justified when:

1. **Your edge is large and durable** — If you estimate 95% probability on a market priced at 75%, the EV is so high that time cost is secondary.
2. **No short-duration alternatives exist** — If your capital has nowhere better to go, a moderate annualized return beats cash.
3. **The position hedges other risk** — Long-dated positions can offset correlation risk in your short-term portfolio.
4. **You're providing liquidity** — Market-making rewards and spread capture on long-dated markets can supplement the absolute return.

## When to Avoid Long-Dated Positions

1. **High-probability, low-return** — Buying Yes at $0.95+ on a market that resolves in 6 months. Absolute return is 5%, annualized is ~10%. Your capital is dead for half a year earning barely above risk-free rates.
2. **Resolution date is uncertain** — "Will X happen by end of 2026?" markets lock capital for potentially 12+ months with no guarantee of early resolution.
3. **Better short-term opportunities exist** — If you can consistently find 3-5% absolute return trades that resolve in 1-2 weeks, your annualized return far exceeds any long-dated position.

## The Compounding Advantage of Short Duration

The real power of short-duration trading is compounding. Consider:

- **Strategy A**: One trade, $0.75 → $1.00, 180 days. Return: 33.3%.
- **Strategy B**: Six trades, each $0.95 → $1.00, 30 days each. Each return: 5.3%. Compounded over 6 cycles: (1.053)^6 – 1 = 36.2%.

Strategy B has lower per-trade return but matches Strategy A through compounding — and each individual trade carries less risk (higher probability of success).

## Capital Allocation Framework

Divide your bankroll into three buckets:

1. **Sprint capital (50-60%)** — Deployed in trades resolving within 1-2 weeks. High turnover, moderate per-trade return, maximum compounding.
2. **Swing capital (25-35%)** — Deployed in trades resolving within 1-3 months. Larger edges required to justify lockup. Kelly-sized.
3. **Reserve (10-20%)** — Cash held for sudden high-EV opportunities. This is your "dry powder" — the ability to act fast when a major mispricing appears.

## Adjusting EV Calculations for Time

When comparing trades with different durations, use annualized EV-adjusted return:

```
Time-Adjusted EV = EV / Days_to_Resolution × 365
```

A trade with $0.05 EV resolving in 7 days (annualized: $2.61 per dollar) beats a trade with $0.15 EV resolving in 180 days (annualized: $0.30 per dollar) by nearly 9x on a time-adjusted basis.

Always compare apples to apples. Absolute EV alone is misleading without the time dimension.
