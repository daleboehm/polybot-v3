# Discord Webhook Alert System Setup Guide

**Polymarket Trading Operation**

This guide walks through setting up Discord alerts for the Polymarket trading bot. The system sends rich embed messages for trades, exits, daily summaries, and system health alerts.

---

## 1. Discord Server & Channels Setup

### Create a Discord Server (if needed)

1. Go to [Discord.com](https://discord.com)
2. Log in or create an account
3. Click the **+** button in the left sidebar → **Create a Server**
4. Name it "Polymarket Trading" (or your preferred name)
5. Accept the default settings

### Create Alert Channels

Once your server is created, add three dedicated channels for bot alerts:

1. **#trades** — Trade execution alerts (entry, exit, profit/loss)
2. **#alerts** — System health and urgent alerts
3. **#daily-summary** — Morning portfolio briefs

To create channels:
1. In your Discord server, right-click the server name or look for **+** next to "TEXT CHANNELS"
2. Click **Create Channel**
3. Name: `trades`, Channel Type: `Text`
4. Repeat for `alerts` and `daily-summary`

---

## 2. Create a Discord Webhook

### Generate a Webhook URL

1. **Open Server Settings**
   - Right-click your server name → **Server Settings**
   - Or click the server name dropdown

2. **Navigate to Integrations**
   - Left sidebar → **Integrations** (or **Apps**)
   - Click **Webhooks**

3. **Create a New Webhook**
   - Click **New Webhook**
   - Name: `Polymarket Bot`
   - Channel: Select **#trades** (or choose one; you can send to multiple channels via API)
   - Click **Copy Webhook URL**
   - Keep this URL safe — you'll use it in step 3

Example webhook URL format:
```
https://discord.com/api/webhooks/1234567890123456789/abcdefghijklmnopqrstuvwxyz
```

---

## 3. Configure the Webhook on VPS

### Set the Webhook URL

Once you have your webhook URL from step 2, run this command from your local machine:

```bash
ssh -i /sessions/clever-bold-johnson/mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key \
    -p 2222 -o StrictHostKeyChecking=no \
    root@178.62.225.235 \
    "cd /opt/polybot && /opt/polybot/venv/bin/python3 discord_alerts.py configure 'YOUR_WEBHOOK_URL_HERE'"
```

Replace `YOUR_WEBHOOK_URL_HERE` with the actual webhook URL you copied in step 2.

Example:
```bash
ssh -i /sessions/clever-bold-johnson/mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key \
    -p 2222 -o StrictHostKeyChecking=no \
    root@178.62.225.235 \
    "cd /opt/polybot && /opt/polybot/venv/bin/python3 discord_alerts.py configure 'https://discord.com/api/webhooks/1234567890123456789/abcdefghijklmnopqrstuvwxyz'"
```

Expected output:
```
[OK] Webhook configured and alerts enabled
```

---

## 4. Test the Webhook

To verify the webhook is working correctly, send a test message:

```bash
ssh -i /sessions/clever-bold-johnson/mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key \
    -p 2222 -o StrictHostKeyChecking=no \
    root@178.62.225.235 \
    "cd /opt/polybot && /opt/polybot/venv/bin/python3 discord_alerts.py test"
```

Expected output:
```
[OK] Test alert sent successfully!
```

You should see a test message appear in your Discord channel. If it doesn't appear:
- Verify the webhook URL is correct
- Check that the webhook is still active in Discord (may have been deleted/regenerated)
- Review logs: `ssh -p 2222 root@178.62.225.235 "tail -20 /opt/polybot/logs/discord.log"`

---

## 5. Send a Daily Summary (Manual Test)

To manually trigger the daily portfolio summary:

```bash
ssh -i /sessions/clever-bold-johnson/mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key \
    -p 2222 -o StrictHostKeyChecking=no \
    root@178.62.225.235 \
    "cd /opt/polybot && /opt/polybot/venv/bin/python3 discord_alerts.py summary"
```

This reads from:
- `/opt/polybot/state/portfolio.json` — Portfolio value, positions, cash
- `/opt/polybot/state/strategy_attribution.json` — Top/worst performers

The message will show:
- Portfolio Value
- Available Cash
- Active Positions
- Capital Utilization %
- 24h P&L (if tracked)
- Top Performer
- Worst Performer
- System Health Status

---

## 6. Integration with Trading Scripts

To integrate Discord alerts into your trading scripts, import and use the functions:

```python
from discord_alerts import send_trade_alert, send_exit_alert, send_health_alert

# Send a trade execution alert
send_trade_alert(
    market="Will BTC exceed $100k by end of 2026?",
    side="YES",
    size=5.00,
    price=0.65,
    confidence_score=78
)

# Send an exit alert
send_exit_alert(
    market="Will BTC exceed $100k by end of 2026?",
    reason="PROFIT_TAKEN",
    pnl=125.50,
    side="YES"
)

# Send a system health alert
send_health_alert(
    component="auto_redeem",
    issue="Failed to redeem position: API rate limit exceeded"
)
```

---

## 7. Automatic Daily Summary Cron

A cron job runs automatically every day at **12:00 UTC (7:00 AM Central Time)** to send the portfolio summary:

```
0 12 * * * cd /opt/polybot && /opt/polybot/venv/bin/python3 discord_alerts.py summary >> /opt/polybot/logs/discord.log 2>&1
```

Logs are stored at `/opt/polybot/logs/discord.log`.

To check if the cron ran successfully:
```bash
ssh -i /sessions/clever-bold-johnson/mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key \
    -p 2222 -o StrictHostKeyChecking=no \
    root@178.62.225.235 \
    "tail -50 /opt/polybot/logs/discord.log"
```

---

## 8. Alert Categories & Colors

The bot sends colored embeds for different alert types:

| Category | Color | Emoji | Meaning |
|----------|-------|-------|---------|
| TRADE_EXECUTED | Green (#00ff00) | 🟢 | New position entered |
| STOP_LOSS_HIT | Red (#ff0000) | 🔴 | Position hit stop loss |
| PROFIT_TAKEN | Gold (#ffd700) | 🟡 | Position hit profit target |
| POSITION_RESOLVED | Blue (#0099ff) | 🔵 | Market resolved, win/loss |
| SYSTEM_ALERT | Orange (#ff6600) | 🟠 | Health check failure, errors |
| DAILY_SUMMARY | White (#ffffff) | ⚪ | Morning portfolio brief |
| INTELLIGENCE | Purple (#9900ff) | 🟣 | Edge signal detected |

---

## 9. Configuration File Reference

The webhook URL and settings are stored in `/opt/polybot/state/discord_config.json`:

```json
{
  "webhook_url": "https://discord.com/api/webhooks/...",
  "username": "Polymarket Bot",
  "enabled": true
}
```

- **webhook_url**: Discord webhook URL (empty until configured)
- **username**: Bot display name in Discord
- **enabled**: Set to `true` when webhook is configured; set to `false` to disable alerts

To manually edit:
```bash
ssh -i /sessions/clever-bold-johnson/mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key \
    -p 2222 -o StrictHostKeyChecking=no \
    root@178.62.225.235 \
    "cat /opt/polybot/state/discord_config.json"
```

---

## 10. Troubleshooting

### Webhook Test Failed
- Verify the webhook URL is correct
- Check that the webhook hasn't been deleted in Discord
- Ensure Discord server still exists
- Check logs: `tail -20 /opt/polybot/logs/discord.log`

### Alerts Not Sending
- Verify `enabled: true` in `discord_config.json`
- Check webhook is still active in Discord settings
- Review logs for error messages

### Alerts Sending but Not Appearing
- Verify you're looking in the correct channel
- Check Discord notification settings aren't muted
- Confirm the webhook has permissions in that channel

### Cron Job Not Running
- Verify cron is set up: `ssh -p 2222 root@178.62.225.235 "crontab -l | grep discord"`
- Check system logs: `ssh -p 2222 root@178.62.225.235 "journalctl -u cron"`
- Verify Python venv exists at `/opt/polybot/venv/bin/python3`

---

## 11. Discord Permissions

Ensure the webhook has the following permissions in your Discord channel:

- ✓ Send Messages
- ✓ Embed Links
- ✓ Manage Webhooks (already granted)

To check/update:
1. Server Settings → **Roles**
2. Look for roles that can manage this channel
3. Ensure "Send Messages" and "Embed Links" are enabled

---

## 12. Next Steps

Once configured and tested:

1. **Monitor the daily summaries** — Review at 12:00 UTC each day
2. **Set up trading integration** — Add `send_trade_alert()` calls to your trading bot
3. **Configure exit hooks** — Call `send_exit_alert()` when positions close
4. **Add health checks** — Use `send_health_alert()` for cron/API failures
5. **Review logs weekly** — Check `/opt/polybot/logs/discord.log` for errors

---

## Command Reference

| Command | Effect |
|---------|--------|
| `configure WEBHOOK_URL` | Set webhook URL and enable alerts |
| `test` | Send a test message to verify connectivity |
| `summary` | Send daily portfolio summary |

Full usage:
```bash
python3 /opt/polybot/discord_alerts.py configure https://discord.com/api/webhooks/...
python3 /opt/polybot/discord_alerts.py test
python3 /opt/polybot/discord_alerts.py summary
```

---

**Script Location:** `/opt/polybot/discord_alerts.py`
**Config Location:** `/opt/polybot/state/discord_config.json`
**Log Location:** `/opt/polybot/logs/discord.log`
**VPS Address:** `178.62.225.235:2222`
**Your Discord Username:** `geminicap`

---

*Last Updated: 2026-03-30*
