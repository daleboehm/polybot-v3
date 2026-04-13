#!/bin/bash
# Deploy grinder to VPS and configure cron
# Run from local machine: bash deploy_grinder.sh

VPS="root@178.62.225.235"
KEY="/sessions/funny-exciting-keller/mnt/CLAUDE/Polymarket/deploy/armorstack_vps_key"
SSH="ssh -i $KEY -o StrictHostKeyChecking=no -o ConnectTimeout=15 -p 2222"
SCP="scp -i $KEY -o StrictHostKeyChecking=no -o ConnectTimeout=15 -P 2222"

echo "=== Deploying Grinder to VPS ==="

# 1. Upload files
echo "[1/4] Uploading grinder.py and run_grinder.sh..."
$SCP /sessions/funny-exciting-keller/grinder.py $VPS:/opt/polybot/grinder.py
$SCP /sessions/funny-exciting-keller/run_grinder.sh $VPS:/opt/polybot/run_grinder.sh

# 2. Set permissions
echo "[2/4] Setting permissions..."
$SSH $VPS "chmod +x /opt/polybot/run_grinder.sh && chmod +x /opt/polybot/grinder.py"

# 3. Create grinder state file and log directory
echo "[3/4] Initializing state..."
$SSH $VPS "mkdir -p /opt/polybot/logs && touch /opt/polybot/state/grinder_trades.json && [ ! -s /opt/polybot/state/grinder_trades.json ] && echo '[]' > /opt/polybot/state/grinder_trades.json"

# 4. Add cron — replace paused quick_cycle with grinder
echo "[4/4] Configuring cron..."
$SSH $VPS "
# Get current crontab
CURRENT=\$(crontab -l 2>/dev/null)

# Check if grinder cron already exists
if echo \"\$CURRENT\" | grep -q 'run_grinder.sh'; then
    echo 'Grinder cron already exists'
else
    # Add grinder cron (every 10 minutes)
    (echo \"\$CURRENT\"; echo '*/10 * * * * /opt/polybot/run_grinder.sh >> /opt/polybot/logs/grinder_cron.log 2>&1') | crontab -
    echo 'Grinder cron added (every 10 min)'
fi

# Show final crontab
echo ''
echo '=== Current crontab ==='
crontab -l
"

# 5. Test dry run
echo ""
echo "=== Testing dry run ==="
$SSH $VPS "cd /opt/polybot && source venv/bin/activate && timeout 120 python3 grinder.py --min-prob 0.92 --max-hours 48 2>&1 | tail -40"

echo ""
echo "=== Deployment complete ==="
