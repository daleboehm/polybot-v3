#!/bin/bash
# Polymarket V2 Cutover Script — Phase 1: HALT ONLY
# Fires at 2026-04-27 23:00 UTC via polybot-v2-cutover.timer
#
# Phase 1 (this script, April 27 23:00 UTC):
#   Step 1 — Halt the engine cleanly
#   Step 2 — Do NOT switch config or restart yet
#   Reason: Polymarket V2 exchange goes live ~April 28 11:00 UTC.
#   Running V2 clob-client against V1 exchange for 12h risks order failures.
#   Phase 2 (v2-go.sh) fires AFTER April 28 11:00 UTC confirmation.
#
# Phase 2 (scripts/v2-go.sh, executed manually or by monitoring loop):
#   Step 1 — Verify V2 exchange is live
#   Step 2 — wrap-usdc (convert USDC.e -> pUSD)
#   Step 3 — Switch config v1 -> v2
#   Step 4 — Rebuild + restart

set -euo pipefail
LOG=/var/log/polybot-v2-cutover.log
exec >> "$LOG" 2>&1

echo "=== V2 Cutover Phase 1 started at $(date -u) ==="

DB=/opt/polybot-v3/data/polybot.db

# Step 1: Halt the engine via kill switch
echo "[1/2] Halting engine via kill switch..."
sqlite3 "$DB" "
  UPDATE kill_switch_state
  SET halted=1, reason='v2_cutover_phase1', halted_at=datetime('now'), updated_at=datetime('now')
  WHERE id=1;
"
PID=$(systemctl show polybot-v3 --property=MainPID --value 2>/dev/null || echo '0')
[ "$PID" != '0' ] && kill -SIGUSR1 "$PID" 2>/dev/null && echo "SIGUSR1 sent to PID $PID"
echo "Engine halted. kill_switch_state = halted=1 reason=v2_cutover_phase1"

# Step 2: Wait for in-flight orders to drain
echo "[2/2] Waiting 60s for in-flight orders to drain..."
sleep 60

echo "=== Phase 1 complete at $(date -u) ==="
echo "=== NEXT: After Polymarket V2 exchange goes live (~April 28 11:00 UTC) ==="
echo "=== Run: /opt/polybot-v3/scripts/v2-go.sh ==="
echo "=== OR: monitoring loop will auto-detect and run v2-go.sh ==="
