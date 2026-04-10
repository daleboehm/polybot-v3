# Polybot State Backup System — VPS Setup Complete

## Summary
Automated daily backups of Polybot trading state, scripts, and dashboards have been configured on the VPS (178.62.225.235). Backups run at **03:00 UTC daily** via root cron, with 30-day rolling retention.

---

## Configuration Details

### Backup Script
- **Location**: `/opt/polybot/backup_state.sh`
- **Size**: 2.7K
- **Permissions**: `rwx--x--x` (executable)
- **Language**: Bash

### What Gets Backed Up
1. **State Directory** (`/opt/polybot/state/`)
   - portfolio.json
   - reserve.json
   - open_orders.json
   - All trading state files

2. **Core Scripts**
   - sprint_trader.py
   - auto_redeem.py
   - auto_trader.py
   - risk_manager.py
   - reconcile.py
   - check_redeem.py

3. **Dashboard**
   - `/opt/polybot/dashboard/` (entire directory)

### Backup Retention
- **Retention Period**: 30 days (rolling window)
- **Storage Location**: `/opt/polybot/backups/`
- **Format**: gzip-compressed tar archive (`.tar.gz`)
- **Naming**: `polybot-backup-YYYYMMDD-HHMMSS.tar.gz`
- **Retention Logic**: Automatic deletion of backups older than 30 days

### Logging
- **Backup Log**: `/opt/polybot/logs/backup.log` (all backup runs)
- **Cron Log**: `/opt/polybot/logs/backup_cron.log` (stdout/stderr from cron)
- **Logging Level**: Detailed (timestamps, file counts, sizes, retention actions)

---

## Cron Job Configuration

### Crontab Entry
```
# Polybot state backup - 03:00 UTC daily
0 3 * * * /opt/polybot/backup_state.sh >> /opt/polybot/logs/backup_cron.log 2>&1
```

### Schedule
- **Time**: 03:00 UTC (every day)
- **Day**: All 7 days per week
- **Output**: Redirected to `/opt/polybot/logs/backup_cron.log`

### Verification
```bash
# SSH to VPS and check:
crontab -l | grep backup_state
```

---

## Manual Execution

### Run a backup immediately (for testing):
```bash
ssh -i ~/.ssh/armorstack_vps_key -p 2222 root@178.62.225.235 /opt/polybot/backup_state.sh
```

### Monitor backup logs in real-time:
```bash
ssh -i ~/.ssh/armorstack_vps_key -p 2222 root@178.62.225.235 tail -f /opt/polybot/logs/backup.log
```

---

## Verification Results (2026-03-28 18:49:40 UTC)

### Test Run Output
```
[2026-03-28 18:49:40] ========== BACKUP START ==========
[2026-03-28 18:49:40] Collecting state files...
[2026-03-28 18:49:40] Copied sprint_trader.py
[2026-03-28 18:49:40] Copied auto_redeem.py
[2026-03-28 18:49:40] Copied auto_trader.py
[2026-03-28 18:49:41] Copied risk_manager.py
[2026-03-28 18:49:41] Copied reconcile.py
[2026-03-28 18:49:41] Copied check_redeem.py
[2026-03-28 18:49:41] Copied dashboard/
[2026-03-28 18:49:41] Compressing backup...
[2026-03-28 18:49:42] Backup created: /opt/polybot/backups/polybot-backup-20260328-184940.tar.gz (272K)
[2026-03-28 18:49:42] Applying retention policy (keep 30 days)...
[2026-03-28 18:49:42] Retention cleanup complete (0 old backups deleted)
[2026-03-28 18:49:42] Current backups retained: 1
[2026-03-28 18:49:42] ========== BACKUP COMPLETE ==========
```

### First Backup Created
- **Filename**: `polybot-backup-20260328-184940.tar.gz`
- **Size**: 272K
- **Location**: `/opt/polybot/backups/`
- **Status**: ✓ SUCCESS

---

## Disaster Recovery

### To restore a backup:
```bash
# 1. SSH to VPS
ssh -i ~/.ssh/armorstack_vps_key -p 2222 root@178.62.225.235

# 2. List available backups
ls -lh /opt/polybot/backups/

# 3. Extract to temporary location (DO NOT overwrite live state yet)
mkdir -p /tmp/polybot-restore
cd /tmp/polybot-restore
tar xzf /opt/polybot/backups/polybot-backup-YYYYMMDD-HHMMSS.tar.gz

# 4. Review restored files
ls -la

# 5. Stop running processes (if necessary)
# [Stop trading bots, dashboards, etc.]

# 6. Restore state
cp -r state/* /opt/polybot/state/

# 7. Restart services
systemctl restart caspian-dashboard
# ... other services as needed
```

---

## Notes

- **No encryption**: Current backups are NOT encrypted. Consider adding age/gpg encryption if sensitive data is present.
- **Local only**: Backups are stored on the same VPS. Consider adding offsite backup (e.g., S3, cloud storage) for redundancy.
- **No compression limit**: Retention cleanup uses 30-day sliding window; no size limit is enforced.
- **Cron timezone**: All times are UTC (server timezone).
- **Error handling**: Script exits on critical errors (missing state directory); non-critical errors (missing optional files) log warnings and continue.

---

## Files Modified/Created

- `/opt/polybot/backup_state.sh` — New backup script (2.7K)
- `/opt/polybot/backups/` — Backup storage directory (exists; populated with test backup)
- `/opt/polybot/logs/backup.log` — Backup execution log (created automatically)
- `/opt/polybot/logs/backup_cron.log` — Cron execution log (created on first scheduled run)
- Root crontab — Added one entry for daily backup at 03:00 UTC

---

**Setup Date**: 2026-03-28  
**Verified**: Yes (manual test run successful)  
**Status**: ✓ Ready for production
