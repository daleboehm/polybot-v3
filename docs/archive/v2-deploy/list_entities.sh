#!/bin/bash
################################################################################
# LIST POLYMARKET ENTITIES SCRIPT v1.0
# Scans for all trading entities and displays their status
################################################################################

set -euo pipefail

readonly BASE_DIR="/opt"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "POLYMARKET TRADING ENTITIES"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

ENTITY_COUNT=0

# Find all api_keys.json files to locate entities
for KEYS_FILE in $(find "$BASE_DIR" -maxdepth 2 -name "api_keys.json" -type f 2>/dev/null); do
    ENTITY_DIR="$(dirname "$(dirname "$KEYS_FILE")")"
    ENTITY_NAME="$(basename "$ENTITY_DIR")"
    
    if [[ ! -f "$ENTITY_DIR/state/api_keys.json" ]]; then
        continue
    fi
    
    ENTITY_COUNT=$((ENTITY_COUNT + 1))
    
    # Extract wallet address
    WALLET_ADDR=$(grep -o '"WALLET_ADDRESS": "[^"]*' "$ENTITY_DIR/state/api_keys.json" | cut -d'"' -f4)
    
    # Find dashboard port from logs
    DASHBOARD_PORT="N/A"
    if [[ -f "$ENTITY_DIR/logs/dashboard_"*.log ]]; then
        DASHBOARD_PORT=$(ls "$ENTITY_DIR/logs/dashboard_"*.log | sed 's/.*dashboard_//' | sed 's/.log//' | head -1)
    fi
    
    # Get last reconcile equity if available
    LAST_EQUITY="N/A"
    if [[ -f "$ENTITY_DIR/state/portfolio.json" ]]; then
        LAST_EQUITY=$(grep -o '"total_equity": [^,]*' "$ENTITY_DIR/state/portfolio.json" | cut -d':' -f2 | xargs)
    fi
    
    # Check if dashboard is running
    DASHBOARD_PID_FILE="$ENTITY_DIR/logs/dashboard_${DASHBOARD_PORT}.pid"
    DASHBOARD_STATUS="STOPPED"
    if [[ -f "$DASHBOARD_PID_FILE" ]]; then
        PID=$(cat "$DASHBOARD_PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            DASHBOARD_STATUS="RUNNING (PID: $PID)"
        fi
    fi
    
    # Get last log timestamp
    LAST_LOG="N/A"
    if [[ -d "$ENTITY_DIR/logs" ]]; then
        LAST_LOG=$(ls -t "$ENTITY_DIR/logs/"*.log 2>/dev/null | head -1 | xargs stat -c "%y" 2>/dev/null || echo "N/A")
    fi
    
    # Display entity info
    echo "Entity:             $ENTITY_NAME"
    echo "  Wallet:           $WALLET_ADDR"
    echo "  Dashboard Port:   $DASHBOARD_PORT"
    echo "  Dashboard Status: $DASHBOARD_STATUS"
    echo "  Last Equity:      $LAST_EQUITY"
    echo "  Last Activity:    $LAST_LOG"
    echo ""
done

if [[ $ENTITY_COUNT -eq 0 ]]; then
    echo "No trading entities found."
    echo ""
    echo "To create a new entity:"
    echo "  /opt/deploy_entity.sh <name> <port> <cron_offset>"
    echo ""
    exit 1
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "Total Entities: $ENTITY_COUNT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

