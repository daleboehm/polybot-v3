#!/bin/bash
################################################################################
# POLYMARKET MULTI-ENTITY DEPLOYMENT SCRIPT v1.0
# Usage: ./deploy_entity.sh <entity_name> <dashboard_port> <cron_offset>
################################################################################

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly BASE_DIR="/opt"
readonly TEMPLATE_DIR="${BASE_DIR}/polybot"

if [[ $# -lt 3 ]]; then
    echo "Usage: $0 <entity_name> <dashboard_port> <cron_offset>"
    echo "Example: $0 lilac 8081 2"
    exit 1
fi

ENTITY_NAME="$1"
DASHBOARD_PORT="$2"
CRON_OFFSET="$3"
ENTITY_DIR="${BASE_DIR}/${ENTITY_NAME}"

if [[ ! -d "$TEMPLATE_DIR" ]]; then
    echo "ERROR: Template directory $TEMPLATE_DIR not found"
    exit 1
fi

if [[ -d "$ENTITY_DIR" ]]; then
    echo "ERROR: Entity directory $ENTITY_DIR already exists"
    exit 1
fi

if ! [[ "$DASHBOARD_PORT" =~ ^[0-9]+$ ]] || [[ $DASHBOARD_PORT -lt 1024 || $DASHBOARD_PORT -gt 65535 ]]; then
    echo "ERROR: dashboard_port must be valid (1024-65535)"
    exit 1
fi

if ! [[ "$CRON_OFFSET" =~ ^[0-9]+$ ]] || [[ $CRON_OFFSET -gt 59 ]]; then
    echo "ERROR: cron_offset must be 0-59"
    exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "DEPLOYING TRADING ENTITY: $ENTITY_NAME"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# [1] CREATE DIRECTORY STRUCTURE
echo "[1/9] Creating entity directory..."
mkdir -p "$ENTITY_DIR"/{state,logs}
chmod 750 "$ENTITY_DIR" "$ENTITY_DIR/state" "$ENTITY_DIR/logs"

# [2] COPY PYTHON FILES & UPDATE PATHS
echo "[2/9] Copying Python scripts..."
PYTHON_FILES=(
    "sprint_trader.py"
    "auto_trader.py"
    "reconcile.py"
    "open_orders_cache.py"
    "arb_executor.py"
    "position_monitor.py"
    "auto_deposit.py"
    "health_monitor.py"
    "auto_redeem.py"
    "correctness_verifier.py"
    "config.py"
)

for file in "${PYTHON_FILES[@]}"; do
    if [[ -f "${TEMPLATE_DIR}/${file}" ]]; then
        cp "${TEMPLATE_DIR}/${file}" "${ENTITY_DIR}/${file}"
        sed -i "s|/opt/polybot|/opt/${ENTITY_NAME}|g" "${ENTITY_DIR}/${file}"
        chmod 750 "${ENTITY_DIR}/${file}"
    fi
done

# [3] COPY DASHBOARD
echo "[3/9] Copying dashboard..."
if [[ -d "${TEMPLATE_DIR}/dashboard" ]]; then
    cp -r "${TEMPLATE_DIR}/dashboard" "${ENTITY_DIR}/"
    find "${ENTITY_DIR}/dashboard" -type f -exec \
        sed -i "s|/opt/polybot|/opt/${ENTITY_NAME}|g; s|8080|${DASHBOARD_PORT}|g" {} \;
fi

# [4] COPY & UPDATE SHELL SCRIPTS
echo "[4/9] Copying shell scripts..."
for script in "run_sprint.sh" "run_auto.sh" "run_quick_cycle.sh"; do
    if [[ -f "${TEMPLATE_DIR}/${script}" ]]; then
        cp "${TEMPLATE_DIR}/${script}" "${ENTITY_DIR}/${script}"
        sed -i "s|/opt/polybot|/opt/${ENTITY_NAME}|g" "${ENTITY_DIR}/${script}"
        chmod 755 "${ENTITY_DIR}/${script}"
    fi
done

# [5] SYMLINK VENV
echo "[5/9] Symlinking shared Python venv..."
if [[ -d "${TEMPLATE_DIR}/venv" ]]; then
    ln -s "${TEMPLATE_DIR}/venv" "${ENTITY_DIR}/venv"
fi

# [6] GENERATE NEW WALLET
echo "[6/9] Generating new Polygon wallet..."

source "${TEMPLATE_DIR}/venv/bin/activate"

WALLET_JSON=$("${TEMPLATE_DIR}/venv/bin/python3" -c "
import json
from eth_account import Account
account = Account.create()
wallet_data = {
    'POLY_PRIVATE_KEY': account.key.hex(),
    'WALLET_ADDRESS': account.address,
    'POLY_API_KEY': '',
    'POLY_SECRET': '',
    'POLY_PASSPHRASE': '',
    'POLY_RPC_URL': 'https://polygon-bor-rpc.publicnode.com'
}
print(json.dumps(wallet_data, indent=2))
")

echo "$WALLET_JSON" > "${ENTITY_DIR}/state/api_keys.json"
chmod 600 "${ENTITY_DIR}/state/api_keys.json"

WALLET_ADDR=$(echo "$WALLET_JSON" | grep '"WALLET_ADDRESS"' | cut -d'"' -f4)

# [7] CREATE PORTFOLIO STATE
echo "[7/9] Initializing portfolio state..."

cat > "${ENTITY_DIR}/state/portfolio.json" << 'PORTFOLIO_EOF'
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
PORTFOLIO_EOF

chmod 600 "${ENTITY_DIR}/state/portfolio.json"

# [8] ADD CRON JOBS
echo "[8/9] Adding cron jobs with offset..."

CURRENT_CRON=$(crontab -l 2>/dev/null | grep -v "^# ===" | grep -v "# $ENTITY_NAME" || echo "")

CRON_MIN=$((CRON_OFFSET % 60))
CRON_MIN_DEPOSIT_0=$(((CRON_OFFSET + 5) % 60))
CRON_MIN_DEPOSIT_1=$(((CRON_OFFSET + 35) % 60))
CRON_MIN_HALF_0=$CRON_MIN
CRON_MIN_HALF_1=$(((CRON_OFFSET + 30) % 60))

NEW_CRON="
# === $ENTITY_NAME TRADING ENTITY ===
$CRON_MIN * * * * /opt/${ENTITY_NAME}/venv/bin/python3 /opt/${ENTITY_NAME}/reconcile.py >> /opt/${ENTITY_NAME}/logs/reconcile.log 2>&1
$CRON_MIN * * * * . /etc/environment && /bin/bash /opt/${ENTITY_NAME}/run_sprint.sh
$CRON_MIN * * * * . /etc/environment && /bin/bash /opt/${ENTITY_NAME}/run_quick_cycle.sh
$CRON_MIN * * * * /opt/${ENTITY_NAME}/venv/bin/python3 /opt/${ENTITY_NAME}/arb_executor.py --execute >> /opt/${ENTITY_NAME}/logs/arb.log 2>&1
$CRON_MIN * * * * /opt/${ENTITY_NAME}/venv/bin/python3 /opt/${ENTITY_NAME}/position_monitor.py --execute >> /opt/${ENTITY_NAME}/logs/exits.log 2>&1
$CRON_MIN_DEPOSIT_0,$CRON_MIN_DEPOSIT_1 * * * * /opt/${ENTITY_NAME}/venv/bin/python3 /opt/${ENTITY_NAME}/auto_deposit.py --execute >> /opt/${ENTITY_NAME}/logs/deposit.log 2>&1
50 * * * * /opt/${ENTITY_NAME}/venv/bin/python3 /opt/${ENTITY_NAME}/health_monitor.py >> /opt/${ENTITY_NAME}/logs/health.log 2>&1
$CRON_MIN_HALF_0,$CRON_MIN_HALF_1 * * * * /opt/${ENTITY_NAME}/venv/bin/python3 /opt/${ENTITY_NAME}/auto_redeem.py >> /opt/${ENTITY_NAME}/logs/redeem.log 2>&1
$CRON_MIN * * * * /opt/${ENTITY_NAME}/venv/bin/python3 /opt/${ENTITY_NAME}/correctness_verifier.py >> /opt/${ENTITY_NAME}/logs/correctness.log 2>&1
$CRON_MIN * * * * /opt/${ENTITY_NAME}/venv/bin/python3 /opt/${ENTITY_NAME}/open_orders_cache.py >> /opt/${ENTITY_NAME}/logs/open_orders.log 2>&1
$CRON_MIN * * * * . /etc/environment && /bin/bash /opt/${ENTITY_NAME}/run_auto.sh
"

{
    echo "$CURRENT_CRON"
    echo "$NEW_CRON"
} | crontab -

deactivate

# [9] START DASHBOARD
echo "[9/9] Starting dashboard on port $DASHBOARD_PORT..."

source "${ENTITY_DIR}/venv/bin/activate"
cd "$ENTITY_DIR"
export PYTHONUNBUFFERED=1
nohup python3 dashboard.py --port "$DASHBOARD_PORT" > "${ENTITY_DIR}/logs/dashboard_${DASHBOARD_PORT}.log" 2>&1 &
DASHBOARD_PID=$!
echo $DASHBOARD_PID > "${ENTITY_DIR}/logs/dashboard_${DASHBOARD_PORT}.pid"

sleep 2
deactivate

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✓ ENTITY DEPLOYMENT COMPLETE"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Entity Name:        $ENTITY_NAME"
echo "Entity Directory:   $ENTITY_DIR"
echo "Wallet Address:     $WALLET_ADDR"
echo "Dashboard Port:     $DASHBOARD_PORT"
echo "Cron Offset:        ${CRON_OFFSET} minutes"
echo "Dashboard PID:      $DASHBOARD_PID"
echo ""
echo "NEXT STEPS:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "1. Fund wallet with USDC on Polygon: $WALLET_ADDR"
echo "2. View dashboard: http://178.62.225.235:${DASHBOARD_PORT}"
echo "3. Monitor logs: tail -f $ENTITY_DIR/logs/*.log"
echo "4. Check cron: grep $ENTITY_NAME /var/log/syslog | tail -20"
echo "5. List all entities: /opt/list_entities.sh"
echo ""

