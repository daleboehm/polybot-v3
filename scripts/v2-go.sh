#!/bin/bash
# Polymarket V2 Cutover Phase 2 — Execute AFTER exchange confirms V2 live
# Run manually: /opt/polybot-v3/scripts/v2-go.sh
# Or triggered by monitoring loop after April 28 11:00 UTC

set -euo pipefail
LOG=/var/log/polybot-v2-cutover.log
exec >> "$LOG" 2>&1

echo "=== V2 Cutover Phase 2 started at $(date -u) ==="

DB=/opt/polybot-v3/data/polybot.db
CONFIG=/opt/polybot-v3/config/default.yaml

# Step 1: Verify engine is halted
HALTED=$(sqlite3 "$DB" 'SELECT halted FROM kill_switch_state LIMIT 1')
if [ "$HALTED" != '1' ]; then
  echo "WARNING: Engine not halted. Halting now..."
  sqlite3 "$DB" "UPDATE kill_switch_state SET halted=1, reason='v2_cutover_phase2' WHERE id=1"
  sleep 10
fi

# Step 2: Wrap USDC.e -> pUSD
echo "[1/4] Wrapping USDC.e -> pUSD..."
CASH=$(sqlite3 "$DB" 'SELECT current_cash FROM entities WHERE slug="polybot"')
WRAP_AMT=$(echo "$CASH - 5" | bc 2>/dev/null || echo "0")  # keep  for gas buffer
echo "Current cash: $CASH. Wrapping: $WRAP_AMT"
cd /opt/polybot-v3
node dist/cli/index.js wrap-usdc --entity polybot --amount "$WRAP_AMT" 2>&1 | tee -a "$LOG" || echo "wrap-usdc failed — check manually"

# Step 3: Switch exchange_version v1 -> v2
echo "[2/4] Switching exchange_version v1 -> v2..."
cp "$CONFIG" "${CONFIG}.bak-$(date -u +%Y%m%d%H%M%S)"
sed -i 's/^  exchange_version: v1/  exchange_version: v2/' "$CONFIG"
grep 'exchange_version' "$CONFIG"

# Step 4: Reset HWM and daily PnL for fresh V2 start
echo "[3/4] Resetting HWM to current_cash for fresh V2 start..."
sqlite3 "$DB" "
  UPDATE entities
  SET daily_pnl=0, daily_pnl_reset=datetime('now'), high_water_mark=current_cash
  WHERE slug='polybot';
"

# Step 5: Rebuild and restart unhalted
echo "[4/4] Rebuilding and restarting..."
cd /opt/polybot-v3 && npm run build >> "$LOG" 2>&1
sqlite3 "$DB" "UPDATE kill_switch_state SET halted=0, reason=NULL WHERE id=1"
systemctl restart polybot-v3
sleep 5
STATUS=$(systemctl is-active polybot-v3)
echo "=== Phase 2 complete at $(date -u) — engine: $STATUS ==="
