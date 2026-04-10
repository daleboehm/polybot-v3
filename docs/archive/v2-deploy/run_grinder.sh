#!/bin/bash
# Armorstack Grinder Runner — executes every 10-15 minutes via cron
# Cron: */10 * * * * /opt/polybot/run_grinder.sh >> /opt/polybot/logs/grinder_cron.log 2>&1

cd /opt/polybot
source /opt/polybot/venv/bin/activate

echo "=== GRINDER $(date -u +'%Y-%m-%d %H:%M UTC') ==="

# Run grinder with conservative settings
# - $30 max risk per cycle, $10 max per trade
# - Only markets with >= 92% implied probability
# - Resolving within 48 hours (tighter window for faster compounding)
# - Minimum $500 volume for liquidity
timeout 300 python3 grinder.py \
    --execute \
    --risk 30 \
    --per-trade 10 \
    --min-prob 0.92 \
    --max-hours 48 \
    --min-volume 500

EXIT_CODE=$?
echo "Exit code: $EXIT_CODE"
echo "---"
