#!/bin/bash
# safe-deploy.sh — the ONLY correct way to deploy code changes
#
# NEVER do: git pull && npm run build && systemctl restart
#   That runs the OLD engine during the build and races on restart.
#
# ALWAYS use this script. It:
#   1. Stops BOTH engines before building (eliminates the dual-engine window)
#   2. git pull
#   3. npm run build
#   4. Restarts only the engines that were running before (prod + R&D if both active)
#
# Usage:
#   /opt/polybot-v3/scripts/safe-deploy.sh         # normal deploy
#   /opt/polybot-v3/scripts/safe-deploy.sh --dry-run  # show what would happen
set -euo pipefail

DRY_RUN=false
[[ "${1:-}" == '--dry-run' ]] && DRY_RUN=true

log() { echo "[safe-deploy] $*"; }

PROD_ACTIVE=$(systemctl is-active polybot-v3 2>/dev/null || echo 'inactive')
RD_ACTIVE=$(systemctl is-active polybot-v3-rd 2>/dev/null || echo 'inactive')

log "Current state: prod=$PROD_ACTIVE rd=$RD_ACTIVE"

if $DRY_RUN; then
  log 'DRY RUN — no changes made'
  log 'Would stop: polybot-v3 polybot-v3-rd'
  log 'Would: git pull && npm run build'
  log "Would restart: prod=$PROD_ACTIVE, rd=$RD_ACTIVE"
  exit 0
fi

# STEP 1: Hard stop before ANY code changes
log '[1/5] Stopping engines (prevents dual-engine window)...'
systemctl stop polybot-v3 polybot-v3-rd 2>/dev/null || true
sleep 2
RUNNING=$(pgrep -f 'node.*dist/index' 2>/dev/null | wc -l)
if [ "$RUNNING" -gt 0 ]; then
  log 'WARNING: engine processes still running after systemctl stop, force-killing...'
  pkill -9 -f 'node.*dist/index' 2>/dev/null || true
  sleep 2
fi
log 'Engines stopped.'

# STEP 2: Pull latest code
log '[2/5] git pull...'
cd /opt/polybot-v3
git pull origin main

# STEP 3: Build
log '[3/5] npm run build...'
npm run build 2>&1 | tail -5
log 'Build complete.'

# STEP 4: Copy dist to R&D
log '[4/5] Syncing dist to R&D...'
rm -rf /opt/polybot-v3-rd/dist
cp -r dist /opt/polybot-v3-rd/dist
log 'Dist synced.'

# STEP 5: Restart what was running
log '[5/5] Restarting engines...'
[ "$PROD_ACTIVE" = 'active' ] && systemctl start polybot-v3 && sleep 3
[ "$RD_ACTIVE" = 'active' ] && systemctl start polybot-v3-rd && sleep 3

PROD_NOW=$(systemctl is-active polybot-v3 2>/dev/null || echo 'inactive')
RD_NOW=$(systemctl is-active polybot-v3-rd 2>/dev/null || echo 'inactive')
log "Done. prod=$PROD_NOW rd=$RD_NOW"

PIDS=$(pgrep -f 'node.*dist/index' | wc -l)
log "Engine processes: $PIDS (expected: $(([ $PROD_NOW = active ] && echo 1 || echo 0) + ([ $RD_NOW = active ] && echo 1 || echo 0))"
