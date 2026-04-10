#!/bin/bash
set -e
cd /opt/polybot-v3

echo "=== CLEAN REBUILD FROM TS SOURCE ==="

# Preserve DB and .env
echo "Preserving data/polybot.db and .env"

# Build from TypeScript source
npx tsc
cp -r src/dashboard/static dist/dashboard/
echo "TypeScript compiled"

# Apply dashboard fixes (these are HTML-only, not compiled JS patches)
python3 /opt/polybot-v3/scripts/fix_commas.py
python3 /opt/polybot-v3/scripts/fix_dashboard_final.py
python3 /opt/polybot-v3/scripts/fix_prod_dashboard.py

# Remove stale R&D artifact from dist
rm -f dist/dashboard/sse-server-rd.js dist/dashboard/sse-server-rd.js.map dist/dashboard/sse-server-rd.d.ts dist/dashboard/sse-server-rd.d.ts.map dist/dashboard/sse-server.js.bak

echo ""
echo "=== VERIFY DIST MATCHES SOURCE ==="
SRC_COUNT=$(find src -name "*.ts" | wc -l)
DIST_COUNT=$(find dist -name "*.js" -not -name "*.js.map" -not -name "*.d.ts" | wc -l)
echo "TS source files: $SRC_COUNT"
echo "JS compiled files: $DIST_COUNT"

echo ""
echo "=== VERIFY PROD DB NOT TOUCHED ==="
sqlite3 data/polybot.db "SELECT slug, current_cash, trading_balance FROM entities WHERE slug = 'polybot';"

echo ""
echo "=== RESTART PROD ==="
systemctl restart polybot-v3
sleep 3
echo "Prod: $(systemctl is-active polybot-v3)"

# Verify cash not overwritten
CASH=$(sqlite3 data/polybot.db "SELECT current_cash FROM entities WHERE slug = 'polybot';")
echo "Prod cash after restart: $CASH (should be 153.87)"

echo ""
echo "=== COPY FRESH DIST TO R&D ==="
rm -rf /opt/polybot-v3-rd/dist
cp -r dist /opt/polybot-v3-rd/dist

# Apply R&D-specific dashboard fixes (title, strategy list)
python3 -c "
path = '/opt/polybot-v3-rd/dist/dashboard/static/index.html'
with open(path) as f:
    html = f.read()
html = html.replace('Gemini Capital \u2014 Polymarket Trading Engine', 'Gemini Capital R&D')
html = html.replace('<h1>Gemini Capital</h1>', '<h1>Gemini Capital R&D</h1>')
# Fix the strategy table for R&D: all active
html = html.replace(\"var prodActive = ['favorites', 'complement', 'weather_forecast', 'crypto_price'];\", \"var prodActive = ['favorites','complement','weather_forecast','crypto_price','longshot','value','skew','convergence'];\")
with open(path, 'w') as f:
    f.write(html)
print('R&D dashboard: title + all strategies active')
"

# Apply R&D cookie name fix
python3 -c "
path = '/opt/polybot-v3-rd/dist/dashboard/sse-server.js'
with open(path) as f:
    code = f.read()
code = code.replace(\"getCookie(req, 'session')\", \"getCookie(req, 'session_rd')\")
code = code.replace(\"getCookie(req, 'csrf')\", \"getCookie(req, 'csrf_rd')\")
# Fix Set-Cookie headers
import re
code = re.sub(r'session=\\\$\{', 'session_rd=\${', code)
code = code.replace(\"'session=; HttpOnly\", \"'session_rd=; HttpOnly\")
code = re.sub(r'csrf=\\\$\{csrf\}', 'csrf_rd=\${csrf}', code)
with open(path, 'w') as f:
    f.write(code)
print('R&D: unique cookie names applied')
"

systemctl restart polybot-v3-rd
sleep 3
echo "R&D: $(systemctl is-active polybot-v3-rd)"
echo "R&D cash: $(sqlite3 /opt/polybot-v3-rd/data/rd.db 'SELECT current_cash FROM entities;' 2>/dev/null || echo 'initializing')"

echo ""
echo "=== REBUILD COMPLETE ==="
