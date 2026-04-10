# AUTO_OPS TECHNICAL SPECIFICATION

**Document**: Technical Architecture & Implementation Details
**Date**: 2026-03-30
**Status**: PRODUCTION v1.0

---

## ARCHITECTURE OVERVIEW

```
┌─────────────────────────────────────────────────────────────────┐
│                        CRON (every 5 min)                       │
└────────────────┬────────────────────────────────────────────────┘
                 │
                 ▼
        ┌────────────────────┐
        │  FileLock (MUTEX)  │ ◄─── Prevents concurrent execution
        └────────┬───────────┘
                 │
                 ▼
    ┌────────────────────────────────────────┐
    │   ORCHESTRATOR (auto_ops.py)           │
    │                                        │
    │  Phase 1: ServiceMonitor               │
    │  ├─ Check 16 dashboard services       │
    │  ├─ Auto-restart (rate-limited)       │
    │  └─ System metrics (disk/mem/load)    │
    │                                        │
    │  Phase 2: TradingEngineMonitor         │
    │  ├─ Verify auto_trader.py import      │
    │  ├─ Check log timestamps (4h window)  │
    │  └─ Restore from backup if needed     │
    │                                        │
    │  Phase 3: PositionManager              │
    │  ├─ Load portfolio.json                │
    │  ├─ Evaluate P&L thresholds           │
    │  └─ Execute CLOB SELL orders          │
    │                                        │
    │  Phase 4: MarketAvailabilityMonitor    │
    │  ├─ Scan Gamma API for categories     │
    │  └─ Track weather/crypto/sports/etc   │
    │                                        │
    │  Phase 5: CapitalOptimizer             │
    │  ├─ Calculate utilization ratio       │
    │  └─ Trigger auto_redeem if needed     │
    │                                        │
    │  Phase 6: State & Alert Persistence    │
    │  ├─ Write auto_ops_state.json         │
    │  └─ Write auto_ops_alerts.json        │
    └────────────────┬───────────────────────┘
                     │
        ┌────────────┼────────────┐
        │            │            │
        ▼            ▼            ▼
    Logs        State Files    Alert Files
```

---

## CLASS STRUCTURE

### FileLock
**Purpose**: Mutual exclusion to prevent concurrent orchestrator runs.

```python
class FileLock:
    def __init__(self, lock_file: Path)
    def __enter__(self) -> FileLock      # Acquire lock or exit
    def __exit__(self, ...) -> None       # Release lock
```

**Usage**:
```python
with FileLock(LOCK_FILE):
    orch.run_cycle()  # Safe: only one cycle at a time
```

**Lock File**: `/opt/polybot/state/auto_ops.lock`

**Behavior**:
- Non-blocking lock (`fcntl.LOCK_NB`)
- If lock cannot be acquired, exits with log message
- Prevents accumulation of zombie processes

---

### AlertManager
**Purpose**: Centralized alert generation, persistence, and history.

```python
class AlertManager:
    def __init__(self, max_alerts: int = 200)
    def add(self, severity, category, title, detail, action_taken="")
    def save(self)
    def get_today_count(self, category: str) -> int
```

**Alert Structure**:
```json
{
  "timestamp": "2026-03-30T06:29:23.516042",
  "severity": "CRITICAL|WARNING|INFO|ACTION_TAKEN",
  "category": "service|trading|position|market|capital|strategy|system",
  "title": "Brief title",
  "detail": "Extended description",
  "action_taken": "What was done (if applicable)"
}
```

**Features**:
- Auto-timestamp in UTC ISO 8601
- Rolling history (keeps last 200 alerts)
- Today count for rate-limit checks
- Atomic save to JSON

**File**: `/opt/polybot/state/auto_ops_alerts.json`

---

### State
**Purpose**: Persistent system state tracking across cycles.

```python
class State:
    def __init__(self)
    def _load_state(self) -> Dict          # Read from disk
    def _default_state(self) -> Dict       # Default values
    def save(self)                         # Write to disk
    def increment_cycle(self)              # Increment cycle counter
```

**State Keys**:
- `last_run`: ISO 8601 timestamp of last cycle
- `cycle_count`: Total number of cycles executed
- `uptime_hours`: Hours since orchestrator started
- `services_restarted_today`: Count of service restarts
- `trades_exited_today`: Count of position exits
- `current_equity`: Portfolio total equity
- `current_cash`: Available USDC
- `position_count`: Active positions
- `market_availability`: Dict of market category → bool
- `strategy_performance`: Dict of strategy → win_rate
- `health_status`: HEALTHY | ERROR | STARTING
- `last_error`: Last exception message (if any)

**File**: `/opt/polybot/state/auto_ops_state.json`

---

### ServiceMonitor
**Purpose**: Monitor systemd services and auto-restart when down.

```python
class ServiceMonitor:
    def __init__(self, alerts: AlertManager)
    def check_all(self) -> Tuple[int, List[str]]
    def _get_status(self, service: str) -> str
    def _restart_service(self, service: str) -> bool
    def check_system(self) -> Dict[str, Any]
```

**Monitored Services** (16 total):
- armorstack-dashboard.service
- armorstack-marketing-dashboard.service
- armorstack-tax-dashboard.service
- armorstack-te-dashboard.service
- caspian-intl-dashboard.service
- dh-debt-dashboard.service
- hr-dashboard.service
- jw-debt-dashboard.service
- ldb-education-dashboard.service
- legal-dashboard.service
- lilac-dashboard.service
- master-dashboard.service
- ms-debt-dashboard.service
- njb-education-dashboard.service
- parkside-dashboard.service

**Rate Limit**: Max 5 restarts per hour (checked via alert history)

**System Metrics Checked**:
- Disk usage % (alert if >90%)
- Disk free GB
- Memory usage % (alert if >90%)
- Memory free GB
- Process count
- Load average (1m, 5m, 15m)

---

### TradingEngineMonitor
**Purpose**: Detect trading engine stalls and verify code integrity.

```python
class TradingEngineMonitor:
    def __init__(self, alerts: AlertManager)
    def check_traders(self) -> bool
    def _verify_import(self, module_name: str) -> bool
    def _restore_from_backup(self, filename: str) -> bool
```

**Checks**:

1. **Import Validation**
   - Attempts to import `auto_trader.py` via subprocess
   - Catches syntax errors early
   - Captures error output for debugging

2. **Activity Detection**
   - Checks `/opt/polybot/logs/polybot_quick.log` modification time
   - Alerts if no activity in 4+ hours
   - Assumes cron would trigger every 10 minutes (max 24 missed cycles = 240 min)

3. **Backup Restoration**
   - Scans `/opt/polybot/backups/` for `*_backup_*.py` files
   - Restores latest matching backup
   - Logs restoration action

---

### PositionManager
**Purpose**: Monitor positions and execute exits based on P&L.

```python
class PositionManager:
    def __init__(self, alerts: AlertManager)
    def check_and_exit(self) -> Tuple[int, List[str]]
    def _load_portfolio(self) -> Dict
    def _execute_exit(self, pos_id: str, position: Dict, reason: str) -> bool
```

**Exit Thresholds**:
- **Stop Loss**: P&L ≤ -20% → Sell
- **Hard Stop**: USD Loss ≥ -$5 → Sell
- **Profit Target**: P&L ≥ +40% → Sell

**Rate Limit**: Max 3 exits per cycle

**Portfolio Structure**:
```json
{
  "positions": {
    "pos_id_1": {
      "quantity": 100,
      "entry_price": 0.50,
      "current_price": 0.45,
      "pnl_pct": -10.0,
      "pnl_usd": -5.00
    },
    ...
  },
  "total_equity": 10000.00,
  "cash": 2000.00,
  "total_invested": 8000.00
}
```

**Execution**:
- Calls `py_clob_client` to place SELL at 0.001 spread
- Gets token_id from Data API
- Updates `portfolio.json` with exit
- Logs confirmation

---

### MarketAvailabilityMonitor
**Purpose**: Track which market categories are active.

```python
class MarketAvailabilityMonitor:
    def __init__(self, alerts: AlertManager)
    def check_markets(self) -> Dict[str, bool]
    def _load_availability(self) -> Dict
    def _save_availability(self, availability: Dict)
    def _check_weather_markets(self) -> bool
```

**Categories Tracked**:
- Weather
- Crypto
- Sports
- Politics

**Alerts**:
- INFO: "Weather markets back online" (transition 0 → 1)
- WARNING: "Weather markets offline" (transition 1 → 0)

**File**: `/opt/polybot/state/market_availability.json`

---

### CapitalOptimizer
**Purpose**: Monitor capital utilization and trigger redemptions.

```python
class CapitalOptimizer:
    def __init__(self, alerts: AlertManager)
    def optimize(self)
    def _load_portfolio(self) -> Dict
    def _attempt_redeem(self)
```

**Metrics**:
- Utilization Ratio: (invested / equity) × 100
- Cash Percentage: (cash / equity) × 100

**Alerts**:
- INFO: "Capital underdeployed" if cash > 60% of equity

**Actions**:
- Runs `auto_redeem.py` subprocess to claim resolved positions
- Frees up USDC for next trading cycle
- Timeout: 30 seconds per run

---

### Orchestrator (Main)
**Purpose**: Orchestrate all phases and manage lifecycle.

```python
class Orchestrator:
    def __init__(self)
    def run_cycle(self)    # Full 5-minute cycle
    def test_mode(self)    # Check without action
    def status(self)       # Print current state
```

**Cycle Flow**:
1. Phase 1: Health Check (ServiceMonitor)
2. Phase 2: Trading Engine Check (TradingEngineMonitor)
3. Phase 3: Position Management (PositionManager)
4. Phase 4: Market Availability (MarketAvailabilityMonitor)
5. Phase 5: Capital Optimization (CapitalOptimizer)
6. Phase 6: State & Alert Persistence

**Error Handling**:
- Try/except around each phase
- Logs exception and traceback
- Sets health_status to ERROR
- Saves state before exiting
- Re-raises for cron to see exit code 1

---

## EXECUTION MODEL

### Cron Schedule
```
*/5 * * * * cd /opt/polybot && /opt/polybot/venv/bin/python3 /opt/polybot/auto_ops.py run >> /opt/polybot/logs/auto_ops.log 2>&1
```

**Timing**:
- Runs every 5 minutes (00:00, 00:05, 00:10, ... 23:55)
- Output appended to rolling log file
- Exit code 0 = success, 1 = failure

### Execution Time
- Typical: 20-30 seconds per cycle
- With API calls: 40-60 seconds
- Lock timeout: None (blocking until acquired)

### Process Lifecycle
```
cron spawns process → Acquire lock → Run cycle → Release lock → Process exits
    ↓                     ↑                                         ↓
  1-2ms                  ↑                                      ~50ms
                    If lock fails:
                    Log warning, exit(1)
```

---

## LOGGING

### Log Format
```
2026-03-30 06:28:56,863 [INFO] ORCHESTRATOR CYCLE START
2026-03-30 06:28:57,087 [WARNING] Service master-dashboard.service is activating
2026-03-30 06:29:23,515 [INFO] auto_redeem.py ran successfully
```

**Format**: `%(asctime)s [%(levelname)s] %(message)s`

**Levels**:
- INFO: Normal progress
- WARNING: Degraded state (but continuing)
- ERROR: Failure in subsystem (phase continues)
- CRITICAL: System integrity (phase stops)

**File**: `/opt/polybot/logs/auto_ops.log`

**Rotation** (recommended):
```
daily, rotate 14 days, compress, delaycompress
```

---

## CONFIGURATION CONSTANTS

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_RESTARTS_PER_HOUR` | 5 | Service restart rate limit |
| `MAX_EXITS_PER_CYCLE` | 3 | Position exit rate limit |
| `STOP_LOSS_PCT` | -20.0 | Auto-exit threshold (down) |
| `HARD_STOP_USD` | -5.0 | Auto-exit absolute loss |
| `PROFIT_TARGET_PCT` | 40.0 | Auto-exit threshold (up) |
| `MAX_ALERTS` | 200 | Rolling alert history size |

---

## IDEMPOTENCY & SAFETY

### Idempotent Operations
- **Service restart**: systemctl is idempotent (restart idempotent service N times = 1 restart)
- **Alert generation**: Checks "today" count, respects rate limit
- **Portfolio update**: Updates are atomic JSON writes
- **Lock file**: Binary lock, safe to retry

### Non-Idempotent Operations (Rate-Limited)
- **Position exits**: Could generate duplicate SELL orders (SOLUTION: rate-limit to 3/cycle)
- **Service restarts**: Could restart in loop (SOLUTION: max 5/hour via alert count)

### Recovery
- **Crashed cycle**: Lock file remains; next cycle acquires lock and continues
- **Hung process**: Manual: `rm /opt/polybot/state/auto_ops.lock`
- **Stale state**: Load from disk; always starts fresh

---

## TESTING STRATEGY

### Unit Tests (Recommended Future)
```python
def test_alert_manager_add():
    alerts = AlertManager()
    alerts.add("INFO", "test", "Test title", "Test detail")
    assert len(alerts.alerts) == 1
    assert alerts.alerts[0]["severity"] == "INFO"

def test_rate_limit():
    alerts = AlertManager()
    for i in range(10):
        alerts.add("INFO", "service", f"Test {i}", "")
    today_count = alerts.get_today_count("service")
    assert today_count == 10
```

### Integration Tests (Recommended Future)
```python
def test_orchestrator_cycle():
    orch = Orchestrator()
    orch.run_cycle()
    state = orch.state.data
    assert state["health_status"] == "HEALTHY"
    assert state["cycle_count"] > 0
```

### Manual Tests (Current)
```bash
# Test mode (no actions)
/opt/polybot/venv/bin/python3 auto_ops.py test

# Full cycle
/opt/polybot/venv/bin/python3 auto_ops.py run

# Status check
/opt/polybot/venv/bin/python3 auto_ops.py status
```

---

## PERFORMANCE CHARACTERISTICS

| Metric | Value | Notes |
|--------|-------|-------|
| Lock acquisition | <1ms | Binary lock, instant |
| Service check (1) | ~20ms | systemctl is-active call |
| Service check (16) | ~300ms | 16 parallel-able checks (sequential in current impl) |
| Import verify | ~150ms | Python startup + compile |
| Portfolio load | ~10ms | JSON read from disk |
| Cycle total | 30-60s | Includes subprocess calls |
| Memory usage | ~50MB | Python + psutil + JSON in memory |

**Optimization Opportunity**: Parallelize service checks (currently sequential).

---

## SECURITY CONSIDERATIONS

1. **Lock File Permissions**: Mode 644 (world-readable) — Consider restricting
2. **API Keys**: Loaded from `/dev/shm/polybot-secrets/api_keys.json` (tmpfs, encrypted)
3. **Subprocess Calls**: No shell injection (uses list args, not string)
4. **Log Sensitivity**: Logs contain market data but NOT credentials
5. **Alert History**: Stored in JSON, world-readable (consider restricting)

**Recommended Hardening**:
```bash
chmod 600 /opt/polybot/state/auto_ops_alerts.json
chmod 600 /opt/polybot/state/auto_ops_state.json
chmod 600 /opt/polybot/logs/auto_ops.log
```

---

## FUTURE ENHANCEMENTS

### Short-term (v1.1)
- [ ] Parallelize 16 service checks
- [ ] Add Slack alert integration
- [ ] Email CRITICAL alerts to ops@
- [ ] Dashboard widget for orchestrator status
- [ ] Detailed P&L attribution per exit

### Medium-term (v1.2)
- [ ] Strategy-based capital reallocation
- [ ] Predictive maintenance (failure forecasting)
- [ ] Health trending (6-month metrics)
- [ ] Multi-VPS orchestration (failover)

### Long-term (v2.0)
- [ ] Machine learning for anomaly detection
- [ ] Automated playbook execution (incident response)
- [ ] Advanced position lifecycle (not just exits)
- [ ] Full observability stack (Prometheus + Grafana)

---

## DEPLOYMENT CHECKLIST

- [x] Script created: `/opt/polybot/auto_ops.py`
- [x] Cron job installed: `*/5 * * * * ...`
- [x] First cycle executed successfully
- [x] State files created and persisted
- [x] Alert system verified
- [ ] Log rotation configured
- [ ] Team trained on operations
- [ ] Dashboard widget created (future)
- [ ] Alert routing configured (future)

---

## REFERENCES

- **Cron Specification**: `/etc/crontab` man pages
- **Polymarket APIs**: https://clob.polymarket.com/, https://gamma-api.polymarket.com/
- **Python fsync**: https://docs.python.org/3/library/fcntl.html
- **Systemd Management**: https://www.freedesktop.org/software/systemd/man/systemctl.html

---

*Document Version: 1.0*
*Last Updated: 2026-03-30*
*Maintainer: Infrastructure Team*
