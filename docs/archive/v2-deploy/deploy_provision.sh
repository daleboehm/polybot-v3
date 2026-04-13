#!/bin/bash
################################################################################
# DEPLOY & RUN ENTITY PROVISIONER
# Usage: ./deploy_provision.sh [--dry-run] [--skip-clob] [--entity NAME]
#
# Pushes provision_entities.py to VPS and runs it.
# SSH key: /mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key
################################################################################

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VPS_HOST="178.62.225.235"
VPS_USER="root"
SSH_KEY="${SCRIPT_DIR}/mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key"
REMOTE_PATH="/opt/polybot/provision_entities.py"
LOCAL_SCRIPT="${SCRIPT_DIR}/provision_entities.py"

# Pass through any args
ARGS="${@}"

# Detect SSH key location (try multiple paths)
if [[ ! -f "$SSH_KEY" ]]; then
    SSH_KEY="/sessions/clever-bold-johnson/mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key"
fi
if [[ ! -f "$SSH_KEY" ]]; then
    SSH_KEY="$HOME/armorstack_vps_key"
fi
if [[ ! -f "$SSH_KEY" ]]; then
    echo "ERROR: SSH key not found. Place armorstack_vps_key in working directory."
    exit 1
fi

chmod 600 "$SSH_KEY"

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=15 -i $SSH_KEY"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "DEPLOYING ENTITY PROVISIONER"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# [1] Upload script
echo "[1/3] Uploading provision_entities.py to VPS..."
scp $SSH_OPTS "$LOCAL_SCRIPT" "${VPS_USER}@${VPS_HOST}:${REMOTE_PATH}"
echo "  ✓ Uploaded"

# [2] Ensure py_clob_client is installed
echo "[2/3] Checking py_clob_client installation..."
ssh $SSH_OPTS ${VPS_USER}@${VPS_HOST} '
    source /opt/polybot/venv/bin/activate
    pip list 2>/dev/null | grep -i clob || pip install py_clob_client --quiet
    deactivate
'
echo "  ✓ py_clob_client ready"

# [3] Run provisioner
echo "[3/3] Running provisioner ${ARGS}..."
echo ""
ssh $SSH_OPTS ${VPS_USER}@${VPS_HOST} "
    /opt/polybot/venv/bin/python3 ${REMOTE_PATH} ${ARGS}
"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "DONE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
