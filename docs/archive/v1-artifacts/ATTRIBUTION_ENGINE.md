# Polymarket Strategy Attribution Engine

**Purpose**: Classify every position and trade into strategy categories and compute comprehensive P&L metrics to identify which strategies are making money and which are losing money.

**Status**: Deployed and running
**Last Updated**: 2026-03-30
**Location**: `/opt/polybot/` (VPS)

---

## System Architecture

### Components

1. **strategy_attribution.py** (1000+ lines)
   - Core classification and metrics engine
   - Runs standalone via cron job or CLI
   - Generates JSON attribution report
   - Can serve HTTP API for dashboard consumption

2. **attribution_service.py**
   - HTTP server (port 5001)
   - Runs as systemd service
   - Serves `/api/attribution` endpoint (live data)
   - Includes `/health` endpoint for monitoring

3. **Cron Jobs**
   - Every hour at :30 minutes → runs attribution analysis
   - Updates `/opt/polybot/state/strategy_attribution.json`

4. **Systemd Service** (attribution-service)
   - Runs continuously
   - Auto-restart on failure
   - Manages HTTP API availability

---

## Strategy Classification Rules

The classifier uses keyword-based regex matching against question text:

### weather-temp
Matches: "temperature", "temp", "highest temp", "lowest temp", "high of", "low of", "°C", "°F"
Example: "Will the highest temperature in Hong Kong be 21°C on March 28?"

### weather-precip
Matches: "rain", "precipitation", "snow", "sleet", "hail", "wind", "humid", "moisture"
Example: "Will it rain in Seattle on April 1?"

### crypto-price
Matches: "BTC", "ETH", "Bitcoin", "Ethereum", "crypto", "Solana", "XRP", "Dogecoin"
Example: "Will Bitcoin close above $60,000 on March 31?"

### crypto-event
Matches: "fork", "upgrade", "hardfork", "merge", "Shanghai", "Ethereum upgrade", "Bitcoin halving"
Example: "Will Ethereum undergo the Shanghai upgrade before May 1?"

### politics
Matches: "Trump", "Biden", "election", "Congress", "Senate", "president", "governor", "voting"
Example: "Will Trump announce a 2028 campaign by April 1?"

### sports
Matches: "Superbowl", "World Cup", "Olympics", "NCAA", "NBA", "NFL", "MLB", "NHL", "tennis", "golf"
Example: "Will Kansas City Chiefs win Super Bowl LVII?"

### finance
Matches: "inflation", "interest rate", "CPI", "unemployment", "GDP", "earnings", "Fed", "jobs report"
Example: "Will the March CPI print above 3.5% YoY?"

### tail-bet (overlay)
Classification: Any position with entry_price < $0.10
Overlays the underlying strategy classification
Marks high-risk, low-probability bets

### other
Default fallback for unclassified positions

---

## Metrics Computed Per Strategy

### Position-Based Metrics (Open Positions)
- **total_positions**: Count of open positions
- **total_capital_deployed**: Sum of `amount_risked` across all open positions
- **avg_position_size**: Mean capital per position
- **largest_position_value**: Max current value
- **unrealized_pnl**: Sum of PnL for open positions

### Trade-Based Metrics (Closed Positions)
- **total_trades**: Count of closed trades
- **winning_trades**: Trades with PnL > 0
- **losing_trades**: Trades with PnL < 0
- **win_rate**: (winning_trades / total_trades) × 100%
- **avg_win**: Mean PnL for winning trades
- **avg_loss**: Mean absolute value for losing trades
- **profit_factor**: (gross_profit / gross_loss) — ratio of wins to losses
- **max_single_win**: Best single trade outcome
- **max_single_loss**: Worst single trade outcome
- **realized_pnl**: Sum of PnL for closed trades

### Risk Metrics
- **std_dev_returns**: Standard deviation of all trade PnL values
- **sharpe_ratio**: (mean_return / std_dev) × √252 — annualized return per unit risk
- **avg_duration_hours**: Average time to resolution

### Total Metrics
- **total_pnl**: unrealized_pnl + realized_pnl

---

## Data Flow

```
portfolio.json (open positions)
        ↓
    Classifier
        ↓
    Metrics Engine
        ↓
    strategy_attribution.json
        ↓
    attribution_service.py (HTTP API)
        ↓
    /api/attribution endpoint (JSON)


pnl.db (closed trades)
        ↓
    Load & Classify
        ↓
    Metrics Engine (same)
        ↓
```

---

## Running the Attribution Engine

### Manual Execution
```bash
cd /opt/polybot
python3 strategy_attribution.py
```

**Output**:
1. Human-readable report to stdout (100+ lines)
2. JSON saved to `/opt/polybot/state/strategy_attribution.json`

### With Options
```bash
python3 strategy_attribution.py \
  --portfolio /opt/polybot/state/portfolio.json \
  --db /opt/polybot/state/pnl.db \
  --output /opt/polybot/state/strategy_attribution.json
```

### Serve HTTP API (Manual)
```bash
python3 strategy_attribution.py --serve
```
Starts HTTP server on port 5001 with `/api/attribution` endpoint.

---

## Cron Job Configuration

**Frequency**: Every hour at minute :30
```
30 * * * * /opt/polybot/run_attribution.sh
```

**Script**: `/opt/polybot/run_attribution.sh`
```bash
#!/bin/bash
cd /opt/polybot
/usr/bin/python3 strategy_attribution.py > /tmp/attribution_cron.log 2>&1
```

**Log**: `/tmp/attribution_cron.log`

---

## HTTP API Endpoints

### GET /api/attribution
Returns current strategy attribution data.

**Response** (application/json):
```json
{
  "timestamp": "2026-03-30T05:14:59.211459",
  "strategies": {
    "weather-temp": {
      "strategy": "weather-temp",
      "total_positions": 12,
      "total_capital_deployed": 93.46,
      "unrealized_pnl": -6.59,
      "realized_pnl": -20.45,
      "total_pnl": -27.04,
      "total_trades": 9,
      "winning_trades": 0,
      "losing_trades": 2,
      "win_rate": 0.0,
      "avg_win": 0.0,
      "avg_loss": 10.225,
      "profit_factor": 0.0,
      "max_single_loss": -11.07,
      "max_single_win": 0.0,
      "std_dev_returns": 1.195,
      "sharpe_ratio": -135.83,
      "avg_position_size": 7.79,
      "avg_duration_hours": 0.0,
      "largest_position_value": 20.12
    },
    ...
  }
}
```

### GET /health
Health check endpoint.

**Response**:
```json
{
  "status": "ok"
}
```

**CORS Headers**: `Access-Control-Allow-Origin: *`

---

## Systemd Service

**Unit File**: `/etc/systemd/system/attribution-service.service`

**Status**:
```bash
systemctl status attribution-service
```

**Manual Control**:
```bash
systemctl start attribution-service
systemctl stop attribution-service
systemctl restart attribution-service
systemctl enable attribution-service (auto-start on boot)
```

**Logs**:
```bash
journalctl -u attribution-service -f  # tail realtime
journalctl -u attribution-service -n 100  # last 100 lines
```

---

## Current Results (2026-03-30 05:14:59 UTC)

### Summary by Strategy

| Strategy | Positions | Capital | Unrealized | Realized | Total P&L | Win Rate |
|----------|-----------|---------|------------|----------|-----------|----------|
| weather-temp | 12 | $93.46 | -$6.59 | -$20.45 | **-$27.04** | 0.0% |
| politics | 2 | $10.92 | -$1.18 | $0.00 | **-$1.18** | 0.0% |
| other | 5 | $16.22 | $0.14 | $0.00 | **$0.14** | 0.0% |
| finance | 1 | $9.80 | $0.15 | $0.00 | **$0.15** | N/A |
| crypto-price | 2 | $2.48 | $0.06 | $0.00 | **$0.06** | 0.0% |
| **TOTAL** | **22** | **$132.88** | **-$7.42** | **-$20.45** | **-$27.87** | |

### Key Findings

**Biggest Loser**: weather-temp
- 12 open positions, $93.46 capital deployed
- Already lost $20.45 on 9 closed trades
- 2 losing trades, 0 winning trades
- Worst loss: -$11.07
- Sharpe ratio: -135.83 (extremely negative)

**Positive Strategies**:
- finance: +$0.15 unrealized (1 position, no closed trades yet)
- crypto-price: +$0.06 unrealized (2 positions, 129 closed trades with $0 impact)
- other: +$0.14 unrealized (5 positions, minimal closed trades)

**Weak Signal**:
- politics: -$1.18 unrealized (2 positions, mostly underwater)

---

## Integration Points

### Dashboard
The `/api/attribution` endpoint feeds strategy attribution data to the Polymarket dashboard.

**Dashboard URL** (if configured):
```
GET http://178.62.225.235:5001/api/attribution
```

### Trading System
The attribution data informs:
1. Capital allocation decisions (weight winning strategies higher)
2. Position sizing (scale down losing strategies)
3. Exit criteria (tighter stops for underperforming strategies)

---

## File Locations

| File | Location | Purpose |
|------|----------|---------|
| strategy_attribution.py | /opt/polybot/ | Main engine (executable) |
| attribution_service.py | /opt/polybot/ | HTTP server |
| strategy_attribution.json | /opt/polybot/state/ | Output data (JSON) |
| run_attribution.sh | /opt/polybot/ | Cron job wrapper |
| attribution-service.service | /etc/systemd/system/ | Systemd unit |

---

## Troubleshooting

### Attribution report missing recent trades
**Check**: Has pnl.db been updated?
```bash
sqlite3 /opt/polybot/state/pnl.db "SELECT COUNT(*) FROM trades;"
```

**Check**: Recent cron execution
```bash
tail -20 /tmp/attribution_cron.log
```

### HTTP API not responding
**Check**: Service status
```bash
systemctl status attribution-service
```

**Check**: Port 5001 listening
```bash
netstat -tuln | grep 5001
```

**Check**: Logs
```bash
journalctl -u attribution-service -n 50
```

### Classifier not categorizing trades correctly
Review the STRATEGY CLASSIFICATION RULES above. Keywords are case-insensitive regex patterns. Test classification:
```python
from strategy_attribution import StrategyClassifier
classifier = StrategyClassifier()
print(classifier.classify("Will Bitcoin close above $60k?"))  # → crypto-price
```

---

## Future Enhancements

1. **Dynamic Allocation**: Automatically adjust capital allocation based on Sharpe ratios
2. **Tail-Bet Detection**: Separate ultra-high-risk positions for enhanced risk management
3. **Correlation Analysis**: Identify correlated positions within strategies
4. **Drawdown Tracking**: Add max drawdown and recovery metrics per strategy
5. **Strategy Rotation**: Implement systematic strategy switching based on performance decay
6. **Monte Carlo Simulation**: Extend Sharpe ratio to full risk distribution modeling
7. **Attribution by Timeframe**: Break down results by entry/exit hour-of-day
8. **Multi-Asset Overlay**: If expanding to other assets, classification will extend naturally

---

## Questions Answered by Attribution Engine

1. **Which strategy is making money?** → Total P&L column (weather-temp: -$27, finance: +$0.15)
2. **Which strategy is losing money?** → Weather-temp and politics (combined -$28.22)
3. **What's the win rate by strategy?** → Win Rate column (weather-temp: 0%, others: N/A or 0%)
4. **How much capital is at risk?** → Total Capital Deployed (weather-temp: $93.46)
5. **Which strategy has best risk-adjusted returns?** → Sharpe Ratio (all negative except N/A strategies)
6. **What's the biggest single loss?** → Max Single Loss (weather-temp: -$11.07)
7. **Where should we reduce exposure?** → Weather-temp (underperforming dramatically)
8. **Which strategy has tightest risk?** → Std Dev Returns (weather-temp: 1.195, others: 0.0)

---

## Version & Maintenance

- **Version**: 1.0
- **Python**: 3.8+
- **Dependencies**: sqlite3 (stdlib), json (stdlib), dataclasses (stdlib)
- **No external packages required**

Last verified: 2026-03-30 05:15 UTC
Next cron run: 2026-03-30 06:30 UTC
