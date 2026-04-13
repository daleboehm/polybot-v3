#!/bin/bash
set -e
cd /opt/polybot-v3

echo "=== STOPPING ENGINES ==="
systemctl stop polybot-v3 polybot-v3-rd 2>/dev/null || true

echo "=== FIX 1: Entity repo — seed cash from starting_capital ==="
python3 /opt/polybot-v3/scripts/fix_entity_repo.py

echo "=== FIX 2: Engine — deduct cash on paper fills ==="
python3 /opt/polybot-v3/scripts/fix_engine_cash.py

echo "=== BUILDING ==="
npm run build 2>&1
echo "BUILD COMPLETE"

echo "=== COPY TO R&D ==="
rm -rf /opt/polybot-v3-rd/dist
cp -r /opt/polybot-v3/dist /opt/polybot-v3-rd/dist
ln -sf /opt/polybot-v3/node_modules /opt/polybot-v3-rd/node_modules

echo "=== FRESH R&D DB ==="
rm -f /opt/polybot-v3-rd/data/rd.db*

echo "=== STARTING PROD ==="
systemctl start polybot-v3
sleep 3
echo "Prod: $(systemctl is-active polybot-v3)"

echo "=== STARTING R&D ==="
systemctl start polybot-v3-rd
sleep 5
echo "R&D: $(systemctl is-active polybot-v3-rd)"

echo "=== SEED R&D CASH ==="
sqlite3 /opt/polybot-v3-rd/data/rd.db "UPDATE entities SET current_cash = 10000, trading_balance = 10000 WHERE slug = 'rd-engine';"
echo "Cash: $(sqlite3 /opt/polybot-v3-rd/data/rd.db 'SELECT current_cash FROM entities;')"
echo "Strategies: $(journalctl -u polybot-v3-rd --no-pager -n 5 | grep strategies | tail -1)"
echo ""
echo "=== REBUILD COMPLETE ==="
