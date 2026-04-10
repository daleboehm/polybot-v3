# AUTO_OPS ORCHESTRATOR — OPERATIONS GUIDE

**Date**: 2026-03-30
**Version**: 1.0
**Status**: PRODUCTION DEPLOYED

---

## EXECUTIVE SUMMARY

`auto_ops.py` is a production-grade self-healing orchestrator that runs **every 5 minutes** with **zero human intervention required**. It is the single source of truth for system health, trading engine monitoring, position management, and autonomous recovery.

**Key Achievement**: Replaces all manual monitoring, alerting, and restart procedures with deterministic, rate-limited, and fully logged operations.

---

## WHAT IT DOES (Every 5-Minute Cycle)

### Phase 1: HEALTH CHECK
- Monitors all 16 systemd dashboard services
- Automatically restarts any service that is not `active` (rate-limited: max 5 restarts/hour)
- Checks disk usage (alerts if >90%)
- Checks memory usage (alerts if >90%)
- Checks system load average and process count
- Logs all metrics to alert system

### Phase 2: TRADING ENGINE CHECK
- Verifies `auto_trader.py` imports successfully (catches syntax/import errors early)
- Checks if `auto_trader.py` has run within last 4 hours
- Checks if `sprint_trader.py` has activity in logs
- If import fails: attempts to restore from latest backup
- Critical alerts if trading engines are stalled

### Phase 3: POSITION MANAGEMENT
- Reads `portfolio.json` for all open positions
- For each position, calculates P&L and checks against thresholds:
  - **Stop Loss**: P&L < -20% → EXIT
  - **Hard Stop**: Loss > $5 USD → EXIT
  - **Profit Target**: P&L > +40% → EXIT
- Executes SELL orders via CLOB API (max 3 exits per cycle)
- Updates `portfolio.json` with exit confirmation
- Generates ACTION_TAKEN alerts for each exit

### Phase 4: MARKET AVAILABILITY
- Scans Gamma API for active market categories (weather, crypto, sports, politics)
- Tracks which market types are currently available
- Alerts when weather markets come back online or go offline
- Writes availability state to `/opt/polybot/state/market_availability.json`

### Phase 5: CAPITAL OPTIMIZATION
- Calculates capital utilization: (invested / equity) × 100
- Alerts if cash > 60% of equity ("UNDERDEPLOYED")
- Runs `auto_redeem.py` to claim resolved positions and free up USDC
- Makes freed capital available for next trades

### Phase 6: ALERT GENERATION & STATE PERSISTENCE
- Centralizes all alerts into `/opt/polybot/state/auto_ops_alerts.json`
- Maintains rolling list of last 200 alerts (rotating older ones out)
- Alert structure:
  ```json
  {
    "timestamp": "2026-03-30T06:29:23.516042",
    "severity": "CRITICAL|WARNING|INFO|ACTION_TAKEN",
    "category": "service|trading|position|market|capital|strategy|system",
    "title": "Brief title",
    "detail": "Extended detail",
    "action_taken": "What action was executed (if any)"
  }
  ```
- Persists cycle state to `/opt/polybot/state/auto_ops_state.json`:
  - Cycle count
  - Uptime
  - Services restarted today
  - Positions exited today
  - Current portfolio metrics
  - Market availability snapshot

---

## INSTALLATION & SETUP

### 1. Deploy Script
Script is located at: `/opt/polybot/auto_ops.py`

Verify:
```bash
ssh root@178.62.225.235 -p 2222 "ls -la /opt/polybot/auto_ops.py"
```

### 2. Cron Job (Every 5 Minutes)
Added to root crontab:
```
*/5 * * * * cd /opt/polybot && /opt/polybot/venv/bin/python3 /opt/polybot/auto_ops.py run >> /opt/polybot/logs/auto_ops.log 2>&1
```

Verify:
```bash
ssh root@178.62.225.235 -p 2222 "crontab -l | grep auto_ops"
```

### 3. Log Rotation
Create `/etc/logrotate.d/polybot-auto-ops`:
```
/opt/polybot/logs/auto_ops.log {
  daily
  missingok
  rotate 14
  compress
  delaycompress
  notifempty
  create 0640 polybot polybot
}
```

Then run:
```bash
sudo logrotate -f /etc/logrotate.d/polybot-auto-ops
```

---

## OPERATIONAL COMMANDS

### Run a Cycle (Manual)
```bash
cd /opt/polybot
/opt/polybot/venv/bin/python3 auto_ops.py run
```

Output: Full cycle execution with all phase logs.

### Test Mode (No Actions)
```bash
/opt/polybot/venv/bin/python3 auto_ops.py test
```

Output: Health checks without taking any action. Safe to run anytime.

### Status Check
```bash
/opt/polybot/venv/bin/python3 auto_ops.py status
```

Output: Current system state, last run time, cycle count, health status, etc.

---

## FILE LOCATIONS

| File | Purpose |
|------|---------|
| `/opt/polybot/auto_ops.py` | Main orchestrator script |
| `/opt/polybot/logs/auto_ops.log` | Detailed execution logs |
| `/opt/polybot/state/auto_ops_state.json` | Persistent cycle state |
| `/opt/polybot/state/auto_ops_alerts.json` | Rolling alert history (last 200) |
| `/opt/polybot/state/auto_ops.lock` | Lock file (prevents concurrent runs) |
| `/opt/polybot/state/market_availability.json` | Market category availability snapshot |

---

## ALERT SEVERITY LEVELS

| Severity | Meaning | Action |
|----------|---------|--------|
| `CRITICAL` | System integrity at risk | Immediate investigation required |
| `WARNING` | Degraded operation or approaching threshold | Monitor and investigate |
| `ACTION_TAKEN` | Orchestrator took autonomous action | Review for correctness |
| `INFO` | Informational state change | Log and track |

---

## RATE LIMITS (Safety Guardrails)

| Limit | Purpose |
|-------|---------|
| **5 service restarts/hour** | Prevents restart loops on flaky services |
| **3 position exits/cycle** | Limits market impact and slippage |
| **Max 200 alerts in memory** | Prevents unbounded memory growth |
| **Lock file** | Ensures only one cycle runs at a time |

---

## ERROR HANDLING & SELF-HEALING

### Service Down
- **Detection**: Service status != `active`
- **Action**: Attempt `systemctl restart`
- **Limit**: Max 5 restarts/hour
- **Alert**: Logs action or threshold breach

### Trading Engine Stall
- **Detection**: auto_trader.py hasn't run in 4+ hours
- **Action**: Triggers manual investigation alert
- **Recovery**: Can be restarted via cron or manual command

### Import Errors
- **Detection**: Python syntax error or missing import
- **Action**: Attempts to restore from latest backup
- **Alert**: CRITICAL alert with error details

### Disk/Memory Critical
- **Detection**: Disk >90% or Memory >90%
- **Action**: Generates CRITICAL alert
- **Recovery**: Manual cleanup required

---

## MONITORING THE ORCHESTRATOR

### Watch Real-Time Logs
```bash
ssh root@178.62.225.235 -p 2222 "tail -f /opt/polybot/logs/auto_ops.log"
```

### Check Alert History
```bash
ssh root@178.62.225.235 -p 2222 "cat /opt/polybot/state/auto_ops_alerts.json | python3 -m json.tool | tail -100"
```

### Check State
```bash
ssh root@178.62.225.235 -p 2222 "cat /opt/polybot/state/auto_ops_state.json | python3 -m json.tool"
```

### Verify Cron Is Running
```bash
ssh root@178.62.225.235 -p 2222 "systemctl status cron"
```

---

## TROUBLESHOOTING

### "Another auto_ops instance is running"
**Cause**: Lock file still exists from previous run (crashed or hung).

**Fix**:
```bash
ssh root@178.62.225.235 -p 2222 "rm /opt/polybot/state/auto_ops.lock && /opt/polybot/venv/bin/python3 /opt/polybot/auto_ops.py run"
```

### Services Repeatedly Restarting
**Cause**: Service is flaky or has underlying issue.

**Fix**:
1. Check service logs: `systemctl status SERVICE_NAME`
2. Increase restart limit if known/temporary
3. Or disable auto-restart for that service in `auto_ops.py`

### Trading Engine Import Fails
**Cause**: `auto_trader.py` has syntax error.

**Fix**:
1. Check latest logs: `tail -50 /opt/polybot/logs/auto_ops.log`
2. Restore from backup: `/opt/polybot/auto_trader.py.bak`
3. Fix the underlying issue and redeploy

### Disk Space Critical
**Cause**: Log files or state files too large.

**Fix**:
1. Compress old logs: `gzip /opt/polybot/logs/*.log.1`
2. Delete old backups: `rm /opt/polybot/backups/*.py.bak*` (keep 2-3 most recent)
3. Clean state archives if needed

---

## DESIGN PRINCIPLES

### 1. **Fail-Safe**
- If orchestrator crashes, other systems (traders, dashboards) keep running
- Lock file prevents zombie processes
- Every action is idempotent (safe to re-run)

### 2. **Deterministic**
- All decisions based on observable system state
- Rate limits prevent cascading failures
- Alert history is immutable and auditable

### 3. **Observable**
- Every action logged with timestamp
- Alert system centralizes all state changes
- Status command shows current health

### 4. **Autonomous**
- Requires zero human intervention for normal operation
- Self-healing for transient failures
- Alerts for issues requiring investigation

### 5. **Rate-Limited**
- Prevents restart loops
- Limits position exits to avoid market impact
- Bounded memory for alerts

---

## FUTURE ENHANCEMENTS

1. **Email Alerts**: Send CRITICAL alerts to ops@armorstack.ai
2. **Slack Integration**: Post ACTION_TAKEN and WARNING alerts to #polybot-ops
3. **Strategy Adaptation**: Dynamically adjust allocations based on market availability
4. **Predictive Maintenance**: Monitor service health trends to predict failures
5. **Dashboard Widget**: Real-time orchestrator status on monitoring dashboard
6. **Detailed P&L Export**: Daily summary of exits and their attribution

---

## QUICK REFERENCE CARD

```bash
# View logs
tail -f /opt/polybot/logs/auto_ops.log

# Manual cycle
/opt/polybot/venv/bin/python3 /opt/polybot/auto_ops.py run

# Test without action
/opt/polybot/venv/bin/python3 /opt/polybot/auto_ops.py test

# Check status
/opt/polybot/venv/bin/python3 /opt/polybot/auto_ops.py status

# View alerts
cat /opt/polybot/state/auto_ops_alerts.json

# View state
cat /opt/polybot/state/auto_ops_state.json

# Verify cron job
crontab -l | grep auto_ops

# Check for lock file (if stuck)
ls -la /opt/polybot/state/auto_ops.lock
rm /opt/polybot/state/auto_ops.lock  # Only if known to be stale
```

---

## SUPPORT & ESCALATION

- **Normal Operation**: Auto-alerts in `/opt/polybot/state/auto_ops_alerts.json`
- **Investigation**: Run `auto_ops.py test` and review logs
- **Emergency**: Kill cron, fix issue, restart orchestrator: `systemctl restart cron`

---

*Last Updated: 2026-03-30*
*Orchestrator Version: 1.0*
*Maintenance: Check logs weekly; review alerts daily*
