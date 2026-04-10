# Risk Management System — Deployment Report

**Date**: 2026-03-28
**Deployed to**: VPS 178.62.225.235 at /opt/polybot/
**Status**: ✅ OPERATIONAL

---

## System Components

### 1. risk_manager.py
**Location**: `/opt/polybot/risk_manager.py`
**Size**: 9.5 KB
**Permissions**: rwxr-xr-x (polybot:polybot)

**Core Functions**:
- `is_trading_allowed()` — Returns (bool, reason) based on lockout rules
- `calculate_position_size(balance, edge, payout)` — Fractional Kelly sizing with caps
- `sweep_to_reserve(usdc_redeemed)` — 60/40 split on redemptions
- `get_trading_balance()` — Current tradeable USDC
- `get_reserve_balance()` — Current reserved USDC
- `get_status()` — Full risk manager dashboard
- `unlock_trading()` — Remove lockout file manually

**Configuration**:
```python
RESERVE_PCT = 0.60          # 60% of redemptions → reserve
MAX_DAILY_LOSS = 20.0       # Daily loss limit
MAX_POSITION_PCT = 0.10     # Max 10% of balance per trade
MAX_POSITION_USD = 20.0     # Absolute max $20 per trade
KELLY_FRACTION = 0.25       # 25% fractional Kelly
```

**State File**: `/opt/polybot/state/reserve.json`
```json
{
  "reserve_balance": 0.0,
  "trading_balance": 0.29,
  "high_water_mark": 100.0,
  "daily_pnl": 0.0,
  "last_reset": "2026-03-28",
  "total_reserved_ever": 0.0,
  "history": []
}
```

**Lockout File**: `/opt/polybot/state/trading_locked.json` (created only if locked)

---

### 2. sprint_trader.py (Modified)
**Location**: `/opt/polybot/sprint_trader.py`
**Size**: 32.5 KB
**Permissions**: rwxr-x--- (root:polybot)

**Key Changes**:
- Added import: `from risk_manager import is_trading_allowed, calculate_position_size, get_trading_balance, record_trade`
- Added trading lock check in `main()` after reconciliation
- Changed `MIN_EDGE` from 0.03 to 0.08 (8% minimum edge)
- Changed `MAX_TOTAL_RISK` from 20.0 to 25.0
- Modified `execute_trades()` to use `calculate_position_size(trading_bal, edge, payout)`

**Behavior**:
- Checks trading lock BEFORE market discovery
- If locked, exits with message pointing to unlock procedure
- Uses risk-managed position sizing instead of static Kelly

---

### 3. auto_redeem.py (Modified)
**Location**: `/opt/polybot/auto_redeem.py`
**Size**: 16.6 KB
**Permissions**: rwxr-x--- (root:polybot)

**Key Changes**:
- Added import: `from risk_manager import sweep_to_reserve`
- Added fallback function if risk_manager unavailable
- After redemption calculates `usdc_claimed`, calls `sweep_to_reserve(usdc_claimed)`
- Prints reserve sweep results: "💰 Reserve sweep: $X to reserve, $Y tradeable"

**Behavior**:
- Every time positions resolve and get redeemed, 60% is locked to reserve
- 40% is available for new trades
- Prevents the "leaky bucket" problem where all profits are immediately reinvested

---

### 4. run_sprint.sh (Modified)
**Location**: `/opt/polybot/run_sprint.sh`
**Size**: 438 bytes

**Key Changes**:
```bash
# OLD
timeout 720 python3 sprint_trader.py --execute --risk 75 --per-trade 20 --min-edge 0.03

# NEW
timeout 720 python3 sprint_trader.py --execute --risk 25 --per-trade 20 --min-edge 0.08
```

**Impact**:
- Reduced max total risk from $75 to $25
- Increased min edge requirement from 3% to 8%

---

## Testing & Verification

### Test 1: Import & Module Load
```bash
cd /opt/polybot && /opt/polybot/venv/bin/python3 -c "from risk_manager import *; print('✅ OK')"
```
**Result**: ✅ PASS

### Test 2: Trading Lock (Current State)
```bash
cd /opt/polybot && timeout 30 python3 sprint_trader.py
```
**Result**: ✅ PASS — Correctly blocked with message:
```
⛔ TRADING LOCKED: Equity below 50% of high-water mark: $0.29 < $50.00
```

### Test 3: Risk Manager Status
```bash
/opt/polybot/venv/bin/python3 risk_manager.py
```
**Result**: ✅ PASS — Returns full status with:
- trading_allowed: false (correct, equity is 99.71% in drawdown)
- lock_reason: "Equity below 50% of high-water mark"

### Test 4: Position Sizing
```bash
calculate_position_size(0.29, 0.10, 2.5)  # 10% edge, 2.5x payout
→ Returns $0.00 (correct: insufficient balance)

calculate_position_size(4.29, 0.10, 2.5)  # After $10 redemption
→ Returns appropriate size within Kelly bounds
```
**Result**: ✅ PASS

### Test 5: Reserve Sweep
```bash
sweep_to_reserve(10.0)
→ Returns (6.00, 4.00)  # 60% reserve, 40% tradeable
```
**Result**: ✅ PASS

---

## Lockout Conditions (When Trading is Blocked)

Trading will be automatically locked if ANY of these occur:

1. **Daily Loss Limit** — Daily P&L drops below -$20
   - Reset daily at midnight UTC
   - Tracks intra-day losses

2. **Equity Decline** — Total equity falls below 50% of high-water mark
   - High-water mark: $100.00
   - Current total equity: $0.29
   - Threshold for lockout: $50.00
   - **Currently LOCKED** because $0.29 << $50.00

3. **Explicit Lockout File** — File `/opt/polybot/state/trading_locked.json` exists
   - Contains reason and timestamp
   - Must be manually deleted to unlock

---

## Recovery Path

To unlock trading and resume operations:

### Option 1: Restore Equity (Recommended)
- The high-water mark of $100 suggests the account needs to recover from current $0.29
- Can only be unlocked by:
  1. Getting winning trades to rebuild equity to > $50, OR
  2. Depositing capital to reach $50+ total equity, OR
  3. Manually resetting high-water mark (requires code change)

### Option 2: Manual Unlock
1. SSH to VPS: `ssh -i key -p 2222 root@178.62.225.235`
2. Remove lockout file: `rm /opt/polybot/state/trading_locked.json`
3. Restart trading: Cron will resume (or run manually)

### Option 3: Reset for Testing
To reset the system with fresh state:
```bash
rm /opt/polybot/state/reserve.json /opt/polybot/state/trading_locked.json
cat > /opt/polybot/state/reserve.json << 'EOF'
{
  "reserve_balance": 0.0,
  "trading_balance": 100.0,
  "high_water_mark": 100.0,
  "daily_pnl": 0.0,
  "last_reset": "2026-03-28",
  "total_reserved_ever": 0.0,
  "history": []
}
EOF
chown polybot:polybot /opt/polybot/state/reserve.json
```

---

## Revenue Leakage Prevention

### The Problem
- Bot redeemed $21,682 in winning positions but ended at $2.34
- **Root cause**: 100% of profits were immediately reinvested into new low-probability bets
- **Result**: Each win funded multiple losses on a compounding basis

### The Solution
**Reserve System** (60/40 Split):
- Redemption of $100 → $60 to lockup, $40 to trade
- $40 trades and wins $25 → $15 to lockup, $10 to trade
- Exponential decay in trading capital allocation
- Forces profit-taking and prevents the leaky bucket

**Position Sizing with Kelly Criterion**:
- Fractional Kelly (0.25x) with hard caps ($20 max)
- Prevents over-leveraging even on high-edge opportunities
- Respects bet size limits as a function of available balance

**Daily Loss Limit**:
- $20 max daily loss triggers lockout
- Forces review if a single day's trading turns red
- Prevents cascading losses into a death spiral

---

## Monitoring

### Key Metrics to Track
```
Daily P&L:           /opt/polybot/state/reserve.json → daily_pnl
Reserve Balance:     /opt/polybot/state/reserve.json → reserve_balance
Trading Balance:     /opt/polybot/state/reserve.json → trading_balance
Total Equity:        reserve_balance + trading_balance
Drawdown %:          (high_water_mark - total_equity) / high_water_mark
Trading Locked:      /opt/polybot/state/trading_locked.json exists?
```

### Dashboard Command
```bash
ssh -i key -p 2222 root@178.62.225.235 "cd /opt/polybot && /opt/polybot/venv/bin/python3 risk_manager.py"
```

---

## Files Deployed

| File | Location | Size | Owner:Group | Perms |
|------|----------|------|-------------|-------|
| risk_manager.py | /opt/polybot/ | 9.5 KB | polybot:polybot | 755 |
| sprint_trader.py | /opt/polybot/ | 32.5 KB | root:polybot | 750 |
| auto_redeem.py | /opt/polybot/ | 16.6 KB | root:polybot | 750 |
| run_sprint.sh | /opt/polybot/ | 438 B | root:polybot | 750 |
| reserve.json | /opt/polybot/state/ | 181 B | polybot:polybot | 644 |

---

## Next Steps

1. **Trading is PAUSED** until recovery or manual intervention
2. **Cron jobs will not execute** (trading is locked)
3. **Monitor reserve.json** for automatic recovery
4. **Once equity > $50**: Trading automatically unlocks
5. **Do NOT modify high-water mark** without understanding implications

---

## Critical Notes

⚠️ **High-Water Mark Logic**:
- Currently set to $100 (the initial deposit)
- This is intentional — it prevents gaming the system
- To unlock now requires either:
  - Actual profit (rebuild from $0.29 → $50+)
  - Manual reset (requires code change + restart)
  - New capital injection

⚠️ **Reserve Lock is Permanent**:
- Once funds go to reserve via `sweep_to_reserve()`, they don't auto-unlock
- Only available for trade if:
  - New redemptions happen (add tradeable capital)
  - Total equity crosses high-water mark (raises threshold)
  - Manual code modification

⚠️ **No Auto-Upgrade to Trading**:
- Must explicitly remove trading_locked.json or reach recovery threshold
- This is intentional — prevents accidental resume of losing strategy

---

**Deployed by**: Claude Agent
**Deployment Time**: 2026-03-28 16:49-16:51 UTC
**Verification**: All tests passed ✅
