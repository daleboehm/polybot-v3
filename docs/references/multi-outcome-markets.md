# Multi-Outcome Market Strategy

Binary Yes/No markets are straightforward. Multi-outcome markets — elections with 5+ candidates, award categories, "which country will X first" — have entirely different dynamics and unique arbitrage opportunities.

## Mechanics

In a multi-outcome market, each outcome has its own Yes/No order book. The fundamental constraint: all outcome probabilities should sum to 100% (all Yes shares should sum to ~$1.00). When they don't, the spread is exploitable.

### The Overround
If all Yes prices sum to more than $1.00 (e.g., $1.08 across 5 candidates), the market has an "overround" of 8%. This is like the vig in sports betting — it's the cost of liquidity. In multi-outcome markets on Polymarket, the overround fluctuates and occasionally inverts.

### The Underround (Free Money Signal)
If all Yes prices sum to less than $1.00 (e.g., $0.94), buying Yes on every outcome guarantees a profit — one of them must resolve Yes, paying $1.00 for $0.94 in total cost. This is pure arbitrage. It's rare in liquid markets but appears briefly during high-volatility events or when new outcomes are added.

## Strategy Patterns

### 1. Synthetic Position Construction
Instead of buying Yes on Candidate A at $0.40, you can sell No on Candidate A. Or you can buy No on all other candidates. These are functionally equivalent but may have different liquidity and pricing — check all paths before executing.

### 2. Pair Trading Within Multi-Outcome
If you believe Candidate A will beat Candidate B but aren't sure either will win:
- Buy Yes on A, sell Yes on B (or buy No on B)
- Your exposure is to the relative performance, not the absolute outcome
- This reduces variance and works when you have relative conviction but not absolute conviction

### 3. Field Compression
As an event approaches and information resolves, long-tail candidates compress toward $0.00. If you hold No on multiple long-shots, they all pay $1.00 — but your capital was spread across many positions. The math: buying No at $0.97 on 10 candidates costs $9.70; if 9 resolve correctly, you get $9.00 back and lose $0.97 on the winner. Net: -$0.70. This only works if you can identify long-shots that are truly overpriced.

### 4. Late-Addition Arbitrage
When Polymarket adds a new outcome to an existing multi-outcome market, the existing prices don't instantly adjust. The new outcome absorbs probability from the field, but existing Yes prices may take hours to reprice. This creates a brief window where the total overround/underround is exploitable.

## Multi-Outcome EV Calculation

For a single outcome in a multi-outcome market:

```
EV = (your_prob × $1.00) – yes_price
```

For the full portfolio across a multi-outcome market, also calculate:

```
Total Yes Cost = sum of all Yes prices you hold
Guaranteed Payout = $1.00 (one must win)
Net Edge = $1.00 – Total Yes Cost (if buying all outcomes)
```

For pair trades:

```
Net Cost = Yes_A price – (1.00 – No_B price)
Profit if A wins and B loses = $1.00 – Net Cost
```

## Risk Considerations

- **Liquidity is thinner** on individual outcomes in multi-outcome markets. Slippage matters more.
- **Correlation is structural** — if A goes up, others must go down. Your positions are inherently correlated.
- **Resolution ambiguity increases** with more outcomes. What if a candidate drops out? What if two candidates tie? Read the resolution rules for these specific edge cases.
- **Capital efficiency** is lower — you may need to hold multiple positions simultaneously to express a single view.
