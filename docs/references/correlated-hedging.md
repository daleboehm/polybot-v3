# Correlated Markets & Hedging

Holding positions in markets that share underlying drivers creates hidden aggregate exposure. Five "diversified" positions on related markets ≠ 5x diversification. This reference covers identification, measurement, and hedging of correlated prediction market risk.

## Identifying Correlated Markets

### Direct Correlation
Markets that resolve based on the same underlying event or closely linked events:
- "Will the Fed cut rates in June?" and "Will S&P 500 hit 6000 by July?" — both driven by monetary policy
- "Will candidate X win the primary?" and "Will candidate X win the general?" — conditional chain
- "Will Bitcoin hit $150K?" and "Will Ethereum hit $10K?" — crypto asset correlation

### Structural Correlation
Markets that share a common driver but aren't obviously linked:
- "Will airline X report record profits?" and "Will oil prices stay below $60?" — fuel costs
- "Will Congress pass AI regulation?" and "Will [AI company] IPO?" — regulatory environment
- Weather events and agricultural commodity prediction markets

### Inverse Correlation
Markets where one outcome mechanically reduces the probability of another:
- "Will candidate A win?" and "Will candidate B win?" in the same race
- "Will the merger go through?" and "Will the antitrust lawsuit succeed?"

## Measuring Portfolio Correlation

### Qualitative Assessment (Levels 1-3)
For each position in your portfolio, ask:
1. What is the primary driver of this outcome?
2. Which other positions share that driver?
3. If the driver moves against me, how many positions are affected simultaneously?

Group positions into "correlation clusters." Your real diversification = number of independent clusters, not number of positions.

### Quantitative Assessment (Levels 4-5)
Track price movements across your positions over time. Calculate rolling correlation coefficients between market prices. Markets that move together when news breaks are correlated, regardless of whether they look related on paper.

## Hedging Strategies

### 1. Offset Hedging
Hold opposing positions in correlated markets to reduce net exposure:
- Long "Fed cuts rates" + Short "S&P hits 6000" — if both are driven by economic weakness, they partially offset
- Cost: you give up some upside on the winning side

### 2. Conditional Position Sizing
Reduce position sizes in correlated markets so your aggregate exposure to any single driver stays within your risk budget:
- If max risk per driver = 5% of bankroll, and you hold 3 correlated positions, each should be ~1.7% max
- This is more practical than hedging for most traders

### 3. Temporal Diversification
Stagger entries and exits so not all correlated positions are at peak exposure simultaneously:
- Enter the highest-conviction correlated trade first
- Add others only if the first position moves favorably (confirming the thesis)
- Set staggered stop-losses

### 4. Cross-Platform Hedging
Use Polymarket for one side and a sportsbook or other prediction market for the offset:
- Works when pricing discrepancies exist across platforms
- Combines arbitrage with hedging — the best case scenario

## Portfolio Correlation Checklist

Before adding a new position, ask:
1. What correlation cluster does this belong to?
2. What is my total exposure to that cluster after adding this position?
3. If the shared driver moves 100% against me, what is my worst-case loss across all correlated positions?
4. Is my aggregate exposure within my risk budget?

If the answer to #4 is no, either reduce the new position size or exit an existing correlated position first.

## Common Correlation Traps

- **Election season**: Political markets are massively correlated. "Will X win state A?" and "Will X win state B?" share candidate quality, national mood, and polling error direction. One bad poll = all positions move.
- **Crypto markets**: Nearly all crypto price markets are correlated. BTC direction drives everything.
- **Macro events**: Fed decisions, employment data, GDP releases — these move dozens of markets simultaneously.
- **Cascade events**: "Will country X invade Y?" affects energy prices, defense stocks, currency markets, and diplomatic prediction markets all at once.
