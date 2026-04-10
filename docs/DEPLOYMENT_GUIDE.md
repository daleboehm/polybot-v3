# Polymarket Multi-Entity Deployment Guide

## Overview

Two scripts have been deployed to `/opt/` on the VPS (178.62.225.235) to enable rapid spinning up of isolated trading entities on the same server:

1. **`/opt/deploy_entity.sh`** — Creates a new isolated trading entity
2. **`/opt/list_entities.sh`** — Lists all active trading entities and their status

## Architecture

Each entity is completely isolated:
- **Own directory**: `/opt/<entity_name>/`
- **Own wallet**: Auto-generated Polygon wallet with unique private key
- **Own portfolio state**: Separate `state/` and `logs/` directories
- **Shared Python venv**: Symlink to `/opt/polybot/venv` to save disk space
- **Shared code templates**: All .py files copied then path-substituted
- **Dedicated dashboard port**: Each entity gets its own web port (e.g., 8081, 8082)
- **Staggered cron jobs**: Offset scheduling prevents resource contention

## Deployment Script

### Usage

```bash
/opt/deploy_entity.sh <entity_name> <dashboard_port> <cron_offset>
```

### Parameters

| Parameter      | Type    | Example       | Notes                                                  |
|----------------|---------|---------------|--------------------------------------------------------|
| entity_name    | string  | lilac         | Unique identifier; becomes directory name             |
| dashboard_port | int     | 8081          | Must be unique; 1024-65535; higher than armorstack    |
| cron_offset    | int     | 2             | Minutes (0-59); stagger jobs to avoid resource spikes |

### Example Deployments

```bash
# Deploy "lilac" entity with dashboard on 8081, cron offset 2 min
/opt/deploy_entity.sh lilac 8081 2

# Deploy "caspian-intl" entity with dashboard on 8082, cron offset 4 min
/opt/deploy_entity.sh caspian-intl 8082 4

# Deploy "arbitrage-bot" entity with dashboard on 8090, cron offset 10 min
/opt/deploy_entity.sh arbitrage-bot 8090 10
```

## What the Script Does (9 Steps)

1. **Create directories**: `/opt/<entity_name>/{state,logs}`
2. **Copy Python scripts**: All 11 core trading files with path substitution
3. **Copy dashboard**: Web UI with path and port updates
4. **Copy shell runners**: `run_sprint.sh`, `run_auto.sh`, `run_quick_cycle.sh` updated
5. **Symlink venv**: Link to shared `/opt/polybot/venv` (conserves ~500MB)
6. **Generate wallet**: Creates new Polygon wallet using eth_account library
7. **Initialize state**: Creates blank `portfolio.json` with zero balances
8. **Add cron jobs**: 11 scheduled tasks with offset minute timing
9. **Start dashboard**: Launches web dashboard on dedicated port via nohup

## Cron Job Scheduling

All jobs are offset by `<cron_offset>` minutes to prevent thundering herd:

| Job                | Frequency | Offset Pattern                                   |
|--------------------|-----------|--------------------------------------------------|
| reconcile.py       | Every 5m  | Runs at minute: `OFFSET`                        |
| sprint_trader.py   | Every 5m  | Runs at minute: `OFFSET`                        |
| quick_cycle.sh     | Every 5m  | Runs at minute: `OFFSET`                        |
| arb_executor.py    | Every 5m  | Runs at minute: `OFFSET`                        |
| position_monitor   | Every 5m  | Runs at minute: `OFFSET`                        |
| auto_deposit.py    | Hourly ×2 | Runs at min: `OFFSET+5, OFFSET+35`              |
| health_monitor.py  | Hourly    | Runs at minute: `50` (fixed, not offset)        |
| auto_redeem.py     | Every 30m | Runs at min: `OFFSET, OFFSET+30`                |
| correctness_verifier | Every 5m | Runs at minute: `OFFSET`                        |
| open_orders_cache  | Every 5m  | Runs at minute: `OFFSET`                        |
| auto_trader.py     | Every 5m  | Runs at minute: `OFFSET`                        |

**Example**: If `OFFSET=2`, reconcile.py runs at :02, :07, :12, :17, etc. each hour.

## Wallet Generation

Each entity gets a fresh Ethereum wallet auto-generated from `eth_account`:

```json
{
  "POLY_PRIVATE_KEY": "0x...",  // Random 256-bit hex
  "WALLET_ADDRESS": "0x...",    // Corresponding address
  "POLY_API_KEY": "",           // Empty; not needed for on-chain
  "POLY_SECRET": "",            // Empty; not needed for on-chain
  "POLY_PASSPHRASE": "",        // Empty; not needed for on-chain
  "POLY_RPC_URL": "https://polygon-bor-rpc.publicnode.com"
}
```

**Action Required**: Fund each wallet with USDC on Polygon to begin trading. Wallets start with zero balance.

## Portfolio Initialization

Each entity starts with:

```json
{
  "starting_capital": 100.0,
  "cash": 0.0,
  "total_equity": 0.0,
  "realized_pnl": 0.0,
  "total_invested_ever": 0.0,
  "total_trades": 0,
  "live_mode": true,
  "paper_mode": false,
  "positions": {},
  "redeemable_value": 0.0,
  "onchain_usdc": 0.0,
  "sprint_start": "2026-03-25",
  "sprint_goal": 350000,
  "year_end_goal": 2500000
}
```

This is populated by `reconcile.py` once the wallet is funded.

## Directory Structure

After deploying entity "lilac":

```
/opt/lilac/
├── sprint_trader.py           # Copied & path-updated
├── auto_trader.py
├── reconcile.py
├── arb_executor.py
├── position_monitor.py
├── auto_deposit.py
├── health_monitor.py
├── auto_redeem.py
├── correctness_verifier.py
├── open_orders_cache.py
├── config.py
├── run_sprint.sh              # Copied & path-updated
├── run_auto.sh
├── run_quick_cycle.sh
├── dashboard.py               # NOT copied; part of dashboard/ dir
├── dashboard/                 # Web UI (path-updated for port)
│   ├── index.html
│   ├── app.js
│   └── styles.css
├── venv -> /opt/polybot/venv  # Symlink to shared venv
├── state/
│   ├── api_keys.json          # Generated wallet
│   ├── portfolio.json         # Initial state
│   ├── sprint_*.log           # Sprint execution logs
│   └── ...
└── logs/
    ├── reconcile.log
    ├── arb.log
    ├── exits.log
    ├── dashboard_8081.log     # Dashboard startup
    ├── dashboard_8081.pid     # Dashboard process ID
    └── ...
```

## List Entities Script

### Usage

```bash
/opt/list_entities.sh
```

### Output Example

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
POLYMARKET TRADING ENTITIES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Entity:             armorstack
  Wallet:           0xF8d12267165da29C809dff3717Ddd04F0C121fd7
  Dashboard Port:   8080
  Dashboard Status: RUNNING (PID: 12345)
  Last Equity:      133.22
  Last Activity:    2026-03-25 20:39:15

Entity:             lilac
  Wallet:           0x1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b
  Dashboard Port:   8081
  Dashboard Status: RUNNING (PID: 12346)
  Last Equity:      0.0
  Last Activity:    2026-03-25 20:40:30

Total Entities: 2
```

The script scans for all `api_keys.json` files and reports:
- Wallet address
- Dashboard port
- Dashboard process status
- Last reconciled equity
- Last log timestamp

## Accessing Dashboards

Each entity's dashboard is accessible via HTTP:

```
http://178.62.225.235:8080/    # armorstack (template entity)
http://178.62.225.235:8081/    # lilac (example new entity)
http://178.62.225.235:8082/    # caspian-intl (example new entity)
```

Dashboards are auto-generated and show:
- Real-time portfolio equity
- Open positions
- PnL
- Recent trades
- Wallet balance
- Cron job status

## Monitoring & Troubleshooting

### View Logs

```bash
# Follow real-time logs for an entity
tail -f /opt/lilac/logs/*.log

# View only sprint trades
tail -f /opt/lilac/state/sprint_*.log

# View reconciliation
tail -f /opt/lilac/logs/reconcile.log

# View dashboard startup
tail -f /opt/lilac/logs/dashboard_8081.log
```

### Check Cron Execution

```bash
# View recent cron runs for entity
grep lilac /var/log/syslog | tail -50

# Or use journalctl
journalctl -u cron -f | grep lilac
```

### Restart Dashboard

```bash
# Kill existing dashboard
kill $(cat /opt/lilac/logs/dashboard_8081.pid)

# Restart manually
cd /opt/lilac
source venv/bin/activate
python3 dashboard.py --port 8081 > logs/dashboard_8081.log 2>&1 &
echo $! > logs/dashboard_8081.pid
```

### Force Reconciliation

```bash
# Manually sync portfolio with blockchain
source /opt/lilac/venv/bin/activate
cd /opt/lilac
python3 reconcile.py
```

## Resource Utilization

- **Disk**: Each entity ~50-100MB (mostly logs)
  - Shared venv saves ~500MB per entity
  - Old logs auto-rotate (keeps last 50)
  
- **Memory**: ~100-200MB per entity runtime
  - Idle dashboard: ~20MB
  
- **CPU**: Minimal; jobs are I/O bound
  - 5-minute intervals prevent overload
  - Offset scheduling distributes load
  
- **Network**: API calls to Polygon RPC, Polymarket CLOB

## Disk Usage Tracking

To see all entities' disk space:

```bash
du -sh /opt/*/  | sort -h
```

To cleanup old logs:

```bash
find /opt/*/logs -name "*.log" -mtime +30 -delete
find /opt/*/state -name "sprint_*.log" -mtime +30 -delete
```

## Operational Checklist

When deploying a new entity:

- [ ] Decide on entity name (unique, lowercase, alphanumeric + hyphen)
- [ ] Choose dashboard port (not in use; check with `netstat -tulpn | grep LISTEN`)
- [ ] Choose cron offset (2, 4, 6, 10, etc.; avoid conflicts)
- [ ] Run deploy script: `/opt/deploy_entity.sh <name> <port> <offset>`
- [ ] Wait for success message (should see "✓ ENTITY DEPLOYMENT COMPLETE")
- [ ] Note the wallet address from the output
- [ ] Fund wallet with USDC on Polygon (mainnet)
- [ ] Verify dashboard is running: `http://178.62.225.235:<port>`
- [ ] Check first reconciliation in logs: `tail -f /opt/<name>/logs/reconcile.log`
- [ ] Monitor first few trades for correctness

## Limitations & Notes

1. **No automatic backup** — Each entity's state is local to the VPS. Implement Google Drive sync if needed.

2. **No multi-machine replication** — All entities run on one server (178.62.225.235). Scale horizontally by deploying to additional servers.

3. **Shared venv risk** — If venv is corrupted, all entities are affected. Implement versioned venv snapshots if needed.

4. **No automatic failover** — If dashboard crashes, manually restart (see Troubleshooting).

5. **API rate limits** — All entities share the same Polygon RPC endpoint. High entity count may hit rate limits.

6. **Cron precision** — Not guaranteed to ±1 second; clock drift may occur over long periods.

## Future Enhancements

- [ ] Healthcheck loop to auto-restart dead dashboards
- [ ] Automated wallet funding via Kraken API
- [ ] Multi-server deployment (AWS Lambda, Docker)
- [ ] Centralized observability (ELK stack for logs)
- [ ] Auto-scaling based on equity threshold
- [ ] A/B testing framework (A/B entity pairs)
- [ ] Disaster recovery (backup state to S3)

---

**Created**: 2026-03-25  
**VPS**: 178.62.225.235 (DigitalOcean AMS3)  
**Scripts**: Verified syntax with `bash -n`

