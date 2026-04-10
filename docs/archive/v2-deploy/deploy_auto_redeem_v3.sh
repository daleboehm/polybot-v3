#!/bin/bash
# ═══════════════════════════════════════════════════════════════════
# DEPLOY auto_redeem.py v3 → VPS (209.38.40.80)
#
# Usage: cd to your CLAUDE folder, then:
#   chmod +x Polymarket/deploy/deploy_auto_redeem_v3.sh
#   bash Polymarket/deploy/deploy_auto_redeem_v3.sh
# ═══════════════════════════════════════════════════════════════════

set -e

# ─── CONFIG ──────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLAUDE_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
VPS_IP="209.38.40.80"
VPS_USER="root"
SSH_KEY="$SCRIPT_DIR/armorstack_vps_key"
REMOTE_DIR="/opt/polybot"
LOCAL_SCRIPT="$CLAUDE_DIR/auto_redeem.py"

echo "═══════════════════════════════════════════════════════"
echo "  DEPLOY auto_redeem.py v3 → VPS"
echo "═══════════════════════════════════════════════════════"
echo ""

# ─── PREFLIGHT ───────────────────────────────────────────────────
if [ ! -f "$SSH_KEY" ]; then
    echo "❌ SSH key not found: $SSH_KEY"
    exit 1
fi

if [ ! -f "$LOCAL_SCRIPT" ]; then
    echo "❌ auto_redeem.py not found: $LOCAL_SCRIPT"
    echo "   Expected at: $CLAUDE_DIR/auto_redeem.py"
    exit 1
fi

chmod 600 "$SSH_KEY" 2>/dev/null || true

echo "  SSH Key:   $SSH_KEY"
echo "  Script:    $LOCAL_SCRIPT"
echo "  Target:    $VPS_USER@$VPS_IP:$REMOTE_DIR/"
echo ""

# ─── 1. BACKUP CURRENT VERSION ──────────────────────────────────
echo "[1/4] Backing up current auto_redeem.py on VPS..."
ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no "$VPS_USER@$VPS_IP" \
    "if [ -f $REMOTE_DIR/auto_redeem.py ]; then \
       cp $REMOTE_DIR/auto_redeem.py $REMOTE_DIR/auto_redeem.py.bak.$(date +%Y%m%d_%H%M%S); \
       echo '   Backup created'; \
     else \
       echo '   No existing file to back up'; \
     fi"

# ─── 2. UPLOAD V3 ───────────────────────────────────────────────
echo "[2/4] Uploading auto_redeem.py v3..."
scp -i "$SSH_KEY" -o StrictHostKeyChecking=no \
    "$LOCAL_SCRIPT" \
    "$VPS_USER@$VPS_IP:$REMOTE_DIR/auto_redeem.py"
echo "   ✅ Uploaded"

# ─── 3. ENSURE STATE DIR + PERMISSIONS ──────────────────────────
echo "[3/4] Ensuring state directory and permissions..."
ssh -i "$SSH_KEY" "$VPS_USER@$VPS_IP" \
    "mkdir -p $REMOTE_DIR/state && chmod +x $REMOTE_DIR/auto_redeem.py && echo '   ✅ Ready'"

# ─── 4. VERIFY + DRY RUN ────────────────────────────────────────
echo "[4/4] Verifying deployment..."
ssh -i "$SSH_KEY" "$VPS_USER@$VPS_IP" << 'VERIFY'
echo ""
echo "  File check:"
ls -la /opt/polybot/auto_redeem.py
echo ""
echo "  Version check:"
head -3 /opt/polybot/auto_redeem.py
echo ""
echo "  Dependencies check:"
source /opt/polybot/venv/bin/activate 2>/dev/null || source /opt/armorstack/venv/bin/activate 2>/dev/null
python3 -c "from web3 import Web3; import requests; print('   ✅ web3 + requests OK')" 2>/dev/null || echo "   ⚠️  Missing deps — installing..."
pip install web3 requests 2>/dev/null | tail -1
echo ""
echo "  api_keys.json check:"
if [ -f /opt/polybot/api_keys.json ]; then
    echo "   ✅ Found at /opt/polybot/api_keys.json"
elif [ -f /opt/polybot/state/api_keys.json ]; then
    echo "   ⚠️  Found at /opt/polybot/state/api_keys.json (script expects it in /opt/polybot/)"
    echo "   Creating symlink..."
    ln -sf /opt/polybot/state/api_keys.json /opt/polybot/api_keys.json
    echo "   ✅ Symlinked"
elif [ -f /opt/armorstack/polymarket/state/api_keys.json ]; then
    echo "   ⚠️  Found at /opt/armorstack/polymarket/state/api_keys.json"
    echo "   Creating symlink..."
    ln -sf /opt/armorstack/polymarket/state/api_keys.json /opt/polybot/api_keys.json
    echo "   ✅ Symlinked"
else
    echo "   ❌ NOT FOUND — you'll need to create /opt/polybot/api_keys.json"
fi
echo ""
echo "  Cron check:"
crontab -l 2>/dev/null | grep -i "redeem" || echo "   No auto_redeem cron entry yet"
VERIFY

echo ""
echo "═══════════════════════════════════════════════════════"
echo "  ✅ DEPLOYMENT COMPLETE"
echo ""
echo "  To run manually:"
echo "    ssh -i $SSH_KEY root@$VPS_IP"
echo "    source /opt/polybot/venv/bin/activate"
echo "    python3 /opt/polybot/auto_redeem.py"
echo ""
echo "  To add to cron (run every 30 min):"
echo "    ssh -i $SSH_KEY root@$VPS_IP"
echo "    crontab -e"
echo "    */30 * * * * /opt/polybot/venv/bin/python3 /opt/polybot/auto_redeem.py >> /opt/polybot/logs/redeem.log 2>&1"
echo "═══════════════════════════════════════════════════════"
