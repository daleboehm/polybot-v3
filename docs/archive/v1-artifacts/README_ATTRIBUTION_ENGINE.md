# Polymarket Strategy Attribution Engine

**Status**: ✓ Production Deployed (2026-03-30 05:15 UTC)

---

## Quick Start

### Check Attribution Now
```bash
curl http://178.62.225.235:5001/api/attribution | jq .
```

### View Latest Results
```bash
ssh -i armorstack_vps_key -p 2222 root@178.62.225.235 \
  "cat /opt/polybot/state/strategy_attribution.json" | jq .
```

---

## What Is It?

A **strategy attribution engine** that answers: **"Which strategy is making money and which is losing money?"**

- Classifies 22 open positions + 701 trades into 8 strategies
- Computes 18+ performance metrics per strategy
- Runs automatically every hour
- Serves real-time HTTP API
- Identifies underperformers and winners

---

## Current Findings (2026-03-30)

| Strategy | Positions | Capital | Total P&L | Status |
|----------|-----------|---------|-----------|--------|
| **weather-temp** | 12 | $93.46 | **-$27.04** | 🔴 CRITICAL |
| politics | 2 | $10.92 | -$1.18 | 🟠 Poor |
| other | 5 | $16.22 | +$0.14 | 🟢 Neutral |
| finance | 1 | $9.80 | +$0.15 | 🟢 Positive |
| crypto-price | 2 | $2.48 | +$0.06 | 🟢 Positive |

**Critical Issue**: weather-temp is losing 97% of portfolio losses with only 70% of capital.

---

## Documentation

### For Operators
- **[ATTRIBUTION_QUICK_REFERENCE.txt](ATTRIBUTION_QUICK_REFERENCE.txt)** — One-page cheat sheet with commands and current results

### For Engineers
- **[ATTRIBUTION_ENGINE.md](ATTRIBUTION_ENGINE.md)** — Complete technical reference (900+ lines)
- **[DEPLOYMENT_SUMMARY.md](DEPLOYMENT_SUMMARY.md)** — Deployment overview & next steps

### For Review
- **[DELIVERABLES.txt](DELIVERABLES.txt)** — Complete inventory of all files
- **[FINAL_REPORT.txt](FINAL_REPORT.txt)** — Executive summary

---

## Key Metrics

Per strategy, the engine computes:

**Position Metrics**:
- Total open positions
- Total capital deployed
- Average position size
- Unrealized P&L

**Trade Metrics**:
- Total closed trades
- Winning/losing trades
- Win rate (%)
- Average win/loss
- Profit factor

**Risk Metrics**:
- Sharpe ratio (annualized)
- Standard deviation of returns
- Maximum single loss
- Average trade duration

---

## Architecture

```
Portfolio Data                    P&L Database
(portfolio.json)                  (pnl.db)
     ↓                                 ↓
     └─────────────┬────────────────┘
                   ↓
         Strategy Attribution Engine
         (strategy_attribution.py)
                   ↓
     ┌─────────────┴──────────────┐
     ↓                            ↓
JSON Output              HTTP API Service
(state/attribution)      (port 5001)
     ↓                            ↓
   Cron                    Dashboard
  (hourly)                Integration
```

---

## Files

### Production (VPS)
- `/opt/polybot/strategy_attribution.py` — Main engine
- `/opt/polybot/attribution_service.py` — HTTP server
- `/opt/polybot/run_attribution.sh` — Cron wrapper
- `/opt/polybot/state/strategy_attribution.json` — Output (updated hourly)

### Local Backups
- `strategy_attribution.py` — Source backup
- `attribution_service.py` — Source backup
- `attribution_latest.json` — Latest output snapshot

### Documentation (This Directory)
- `ATTRIBUTION_ENGINE.md` — Full technical reference
- `ATTRIBUTION_QUICK_REFERENCE.txt` — Operator's guide
- `DEPLOYMENT_SUMMARY.md` — Delivery overview
- `DELIVERABLES.txt` — Inventory
- `FINAL_REPORT.txt` — Executive summary
- `README_ATTRIBUTION_ENGINE.md` — This file

---

## Automation

**Cron Job** (runs every hour at :30):
```
30 * * * * /opt/polybot/run_attribution.sh
```

**Systemd Service** (attribution-service):
- Status: active (running)
- Auto-restart: enabled
- Auto-start on boot: enabled

---

## API

### GET /api/attribution
Returns full strategy attribution JSON with all metrics.

**Response**:
```json
{
  "timestamp": "2026-03-30T05:14:59.211459",
  "strategies": {
    "weather-temp": {
      "total_positions": 12,
      "total_capital_deployed": 93.46,
      "unrealized_pnl": -6.59,
      "realized_pnl": -20.45,
      "total_pnl": -27.04,
      "total_trades": 9,
      "winning_trades": 0,
      "losing_trades": 2,
      "win_rate": 0.0,
      ...
    }
  }
}
```

### GET /health
Health check endpoint.

**Response**:
```json
{"status": "ok"}
```

---

## Strategy Classification

The engine classifies each position/trade using keyword-based pattern matching:

| Strategy | Keywords | Example |
|----------|----------|---------|
| **weather-temp** | temperature, temp, °C, °F | "Will the highest temperature in Miami be 82°F?" |
| **weather-precip** | rain, precipitation, snow, wind | "Will it rain in Seattle on April 1?" |
| **crypto-price** | BTC, ETH, Bitcoin, Ethereum, crypto | "Will Bitcoin close above $60k?" |
| **crypto-event** | fork, upgrade, merge, Shanghai | "Will Ethereum undergo the Shanghai upgrade?" |
| **politics** | Trump, Biden, election, Congress, Senate | "Will Trump announce a 2028 campaign?" |
| **sports** | Superbowl, World Cup, NBA, NFL, Olympics | "Will the Chiefs win the Super Bowl?" |
| **finance** | inflation, CPI, unemployment, GDP, Fed | "Will the March CPI print above 3.5%?" |
| **other** | (default) | Unclassified |

---

## Commands

### Run Manual Attribution
```bash
ssh -i armorstack_vps_key -p 2222 root@178.62.225.235 \
  "cd /opt/polybot && python3 strategy_attribution.py"
```

### Check Service Status
```bash
ssh -i armorstack_vps_key -p 2222 root@178.62.225.235 \
  "systemctl status attribution-service"
```

### View Cron Logs
```bash
ssh -i armorstack_vps_key -p 2222 root@178.62.225.235 \
  "tail -50 /tmp/attribution_cron.log"
```

### Test HTTP API
```bash
curl -s http://178.62.225.235:5001/health | jq .
curl -s http://178.62.225.235:5001/api/attribution | jq . | less
```

---

## Critical Finding

**Weather-Temp Strategy Underperformance**:
- 70% of portfolio capital ($93.46)
- 97% of total losses (-$27.04)
- 0% win rate on closed trades
- Worst single loss: -$11.07
- Sharpe ratio: -135.83

**Immediate Action Required**:
1. Close positions with >-$3 loss
2. Implement $5-$10 stop losses
3. Reduce capital allocation to <$30
4. Review temperature selection algorithm

---

## Next Steps

**Immediate (Today)**:
- [ ] Review weather-temp findings
- [ ] Implement exit rules for underperformers
- [ ] Monitor attribution via HTTP API

**Short-term (This Week)**:
- [ ] Integrate attribution into trading logic
- [ ] Implement capital reallocation based on Sharpe
- [ ] Add tail-bet detection (<$0.10 entry)

**Medium-term (This Month)**:
- [ ] Build attribution visualization dashboard
- [ ] Add correlation analysis between strategies
- [ ] Implement automatic strategy rotation

---

## Support

**Technical Questions**: See [ATTRIBUTION_ENGINE.md](ATTRIBUTION_ENGINE.md)
**Operational Cheat Sheet**: See [ATTRIBUTION_QUICK_REFERENCE.txt](ATTRIBUTION_QUICK_REFERENCE.txt)
**Deployment Details**: See [DEPLOYMENT_SUMMARY.md](DEPLOYMENT_SUMMARY.md)

**VPS Access**:
```bash
ssh -i armorstack_vps_key -p 2222 root@178.62.225.235
```

**API Endpoint**:
```
http://178.62.225.235:5001/api/attribution
```

---

## Verification

All systems operational as of 2026-03-30 05:16 UTC:

- ✓ Core engine: running
- ✓ HTTP service: active (responding on port 5001)
- ✓ Cron job: scheduled (30 * * * *)
- ✓ Output file: updated hourly
- ✓ Documentation: complete (4 documents)

Next cron execution: 2026-03-30 06:30 UTC

---

**Delivered**: Production-ready strategy attribution system
**Status**: ✓ Live and Operational
**Maintenance**: Zero manual intervention (fully automated)
