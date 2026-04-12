# Discord Alert System Deployment Summary

**Status:** DEPLOYED & READY FOR ACTIVATION

---

## What Was Built

A production-ready Discord webhook alert system for the Polymarket trading operation at:

- **Script:** `/opt/polybot/discord_alerts.py` (13 KB)
- **Config:** `/opt/polybot/state/discord_config.json`
- **Logs:** `/opt/polybot/logs/discord.log`
- **Cron:** Daily summary at 12:00 UTC (7:00 AM CT)

---

## Key Features

### Alert Categories (7 Types)

| Type | Color | Use Case |
|------|-------|----------|
| 🟢 TRADE_EXECUTED | Green | New position entered (market, side, size, price, confidence) |
| 🔴 STOP_LOSS_HIT | Red | Position hit stop loss (with P&L) |
| 🟡 PROFIT_TAKEN | Gold | Position hit profit target (with P&L) |
| 🔵 POSITION_RESOLVED | Blue | Market resolved (win/loss payout) |
| 🟠 SYSTEM_ALERT | Orange | Cron errors, API failures, health issues |
| ⚪ DAILY_SUMMARY | White | Morning brief: portfolio value, positions, capital utilization, top/worst performers |
| 🟣 INTELLIGENCE | Purple | Edge signals, arbitrage opportunities, mispricing alerts |

### Integration Points

The script is importable and callable from other Python modules:

```python
from discord_alerts import (
    send_trade_alert,          # New position
    send_exit_alert,           # Position closure
    send_health_alert,         # System issues
    send_intelligence_alert,   # Edge signals
    send_daily_summary,        # Manual portfolio brief
    send_alert                 # Generic alerts
)

# Example: Send trade alert from auto_trader.py
send_trade_alert(
    market="Will BTC exceed $100k?",
    side="YES",
    size=5.00,
    price=0.65,
    confidence_score=78
)
```

### Configuration

Stored in `/opt/polybot/state/discord_config.json`:

```json
{
  "webhook_url": "",          // Empty until configured
  "username": "Polymarket Bot",
  "enabled": false            // Disabled until webhook is set
}
```

### Automatic Daily Summary

Cron job runs every day at **12:00 UTC**:

```
0 12 * * * cd /opt/polybot && /opt/polybot/venv/bin/python3 discord_alerts.py summary >> /opt/polybot/logs/discord.log 2>&1
```

Reads from:
- `portfolio.json` — Portfolio value, cash, positions
- `strategy_attribution.json` — Performance metrics, top/worst performers

---

## Deployment Steps Completed

1. ✓ Script written (600+ lines, fully documented)
2. ✓ Uploaded to VPS: `/opt/polybot/discord_alerts.py`
3. ✓ Config file created: `/opt/polybot/state/discord_config.json` (disabled by default)
4. ✓ Python module tested (imports work, venv ready)
5. ✓ Cron job configured (daily summary at 12:00 UTC)
6. ✓ Logs directory created: `/opt/polybot/logs/`
7. ✓ Setup guide written: `discord_setup_guide.md`

---

## Next Steps: Activation (You)

To activate Discord alerts, follow the guide in `discord_setup_guide.md`:

### Quick Start (3 Steps)

1. **Create Discord Server**
   - Go to Discord.com → Create Server → Name it "Polymarket Trading"

2. **Create Webhook**
   - Server Settings → Integrations → Webhooks → New Webhook
   - Name: "Polymarket Bot"
   - Copy the webhook URL

3. **Configure Webhook URL**
   ```bash
   ssh -i /sessions/clever-bold-johnson/mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key \
       -p 2222 -o StrictHostKeyChecking=no \
       root@178.62.225.235 \
       "cd /opt/polybot && /opt/polybot/venv/bin/python3 discord_alerts.py configure 'YOUR_WEBHOOK_URL'"
   ```

4. **Test It**
   ```bash
   ssh -i /sessions/clever-bold-johnson/mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key \
       -p 2222 -o StrictHostKeyChecking=no \
       root@178.62.225.235 \
       "cd /opt/polybot && /opt/polybot/venv/bin/python3 discord_alerts.py test"
   ```

---

## Command Reference

### Configure webhook URL (one-time setup)
```bash
python3 /opt/polybot/discord_alerts.py configure https://discord.com/api/webhooks/...
```

### Test connectivity
```bash
python3 /opt/polybot/discord_alerts.py test
```

### Send daily summary (manual)
```bash
python3 /opt/polybot/discord_alerts.py summary
```

### Check logs
```bash
tail -50 /opt/polybot/logs/discord.log
```

### View config
```bash
cat /opt/polybot/state/discord_config.json
```

### Verify cron job
```bash
crontab -l | grep discord_alerts
```

---

## Integration Examples

Once activated, use in your trading scripts:

### auto_trader.py — Send when entering position
```python
from discord_alerts import send_trade_alert

# After opening a position
send_trade_alert(
    market="Will BTC exceed $100k by 2026-12-31?",
    side="YES",
    size=10.00,
    price=0.72,
    confidence_score=85
)
```

### auto_redeem.py — Send on successful redemption
```python
from discord_alerts import send_exit_alert

# After cashing out position
send_exit_alert(
    market="Will BTC exceed $100k?",
    reason="POSITION_RESOLVED",
    pnl=245.75,
    side="YES"
)
```

### Health monitoring — Send on errors
```python
from discord_alerts import send_health_alert

# If API fails or cron encounters an issue
send_health_alert(
    component="auto_redeem",
    issue="Rate limit exceeded - retrying in 60s",
    urgent=False
)
```

---

## Architecture

```
Discord Server (Your Account: geminicap)
    ├── #trades (trade execution & exits)
    ├── #alerts (system health, urgent issues)
    └── #daily-summary (morning portfolio brief)
         │
         └─→ Webhook URL (POST embeds here)
              │
              └─→ VPS: 178.62.225.235:2222
                   └─→ /opt/polybot/discord_alerts.py
                        ├── Reads: portfolio.json, strategy_attribution.json
                        ├── Sends: Rich Discord embeds (7 types)
                        └── Logs: /opt/polybot/logs/discord.log
```

---

## File Locations

| Path | Purpose |
|------|---------|
| `/opt/polybot/discord_alerts.py` | Main alert script (executable) |
| `/opt/polybot/state/discord_config.json` | Webhook URL config (json) |
| `/opt/polybot/logs/discord.log` | Alert logs (append mode) |
| `/opt/polybot/state/portfolio.json` | Portfolio state (read by summary) |
| `/opt/polybot/state/strategy_attribution.json` | Strategy metrics (read by summary) |
| `/sessions/clever-bold-johnson/mnt/CLAUDE/Polymarket/discord_setup_guide.md` | Full setup instructions |

---

## Troubleshooting Quick Links

**Webhook not sending?**
- Verify webhook URL is correct in config
- Check Discord webhook still exists (not deleted)
- Run test: `python3 discord_alerts.py test`
- Review logs: `tail /opt/polybot/logs/discord.log`

**Cron not running daily summary?**
- Verify cron: `crontab -l | grep discord`
- Check venv exists: `ls /opt/polybot/venv/bin/python3`
- Check logs: `tail /opt/polybot/logs/discord.log`

**Import errors in trading scripts?**
- Ensure discord_alerts.py is in `/opt/polybot/`
- Add to sys.path: `sys.path.insert(0, '/opt/polybot')`
- Import: `from discord_alerts import send_trade_alert`

---

## Production Checklist

Before going live, ensure:

- [ ] Discord server created and webhook copied
- [ ] Webhook URL configured: `python3 discord_alerts.py configure WEBHOOK_URL`
- [ ] Test successful: `python3 discord_alerts.py test` (message appears in Discord)
- [ ] Channels created: #trades, #alerts, #daily-summary
- [ ] Cron verified: `crontab -l | grep discord`
- [ ] Logs monitored: Check `/opt/polybot/logs/discord.log` daily
- [ ] Trading scripts updated: Add `send_trade_alert()` calls where needed
- [ ] Exit handlers added: Call `send_exit_alert()` on position close
- [ ] Health checks configured: Use `send_health_alert()` for errors

---

## Support

**Setup Guide:** See `discord_setup_guide.md` (comprehensive 12-section walkthrough)

**Script Documentation:** Inline docstrings in `/opt/polybot/discord_alerts.py`

**Logs Location:** `/opt/polybot/logs/discord.log`

---

**Deployed:** 2026-03-30  
**VPS:** 178.62.225.235:2222  
**Status:** Ready for activation  
**Discord Username:** geminicap

