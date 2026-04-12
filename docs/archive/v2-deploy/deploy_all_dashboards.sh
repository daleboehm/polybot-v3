#!/bin/bash
# Deploy matching dashboards to ALL sub-entities
# Clones the GC Caspian dashboard design with per-entity customization
# Run from VPS: bash /opt/polybot/deploy_all_dashboards.sh

set -e

ENTITIES_JSON="/opt/master-dashboard/entities.json"
CASPIAN_DASH="/opt/polybot/dashboard"
VENV="/opt/polybot/venv/bin/python3"

echo "=== Deploying Dashboards to All Entities ==="

# Read entities and deploy to each non-caspian entity
$VENV -c "
import json, os, sys, shutil, subprocess, re

with open('$ENTITIES_JSON') as f:
    config = json.load(f)

entities = [e for e in config['entities'] if e['slug'] != 'caspian']

print(f'Found {len(entities)} sub-entities to deploy')

for ent in entities:
    slug = ent['slug']
    name = ent['name']
    color = ent['color']
    port = ent['port']
    path = ent['path']
    dash_dir = os.path.join(path, 'dashboard')
    state_dir = os.path.join(path, 'state')
    logs_dir = os.path.join(path, 'logs')

    print(f'')
    print(f'--- [{slug}] {name} → port {port} ---')

    # Create directories
    for d in [dash_dir, state_dir, logs_dir]:
        os.makedirs(d, exist_ok=True)

    # Initialize empty state files if they don't exist
    for sf in ['portfolio.json', 'trade_history.json', 'auto_trade_log.json',
               'grinder_trades.json', 'open_orders.json', 'performance.json',
               'heat_log.json', 'calibration_history.json', 'ensemble_log.json',
               'model_scores.json', 'wallet_balance.json', 'reserve.json']:
        sfp = os.path.join(state_dir, sf)
        if not os.path.exists(sfp):
            if sf in ('trade_history.json', 'auto_trade_log.json', 'grinder_trades.json',
                       'heat_log.json', 'calibration_history.json', 'ensemble_log.json'):
                default = '[]'
            elif sf == 'portfolio.json':
                default = json.dumps({
                    'cash': 0, 'starting_capital': 100, 'positions': {},
                    'total_trades': 0, 'total_equity': 0, 'realized_pnl': 0
                }, indent=2)
            elif sf == 'open_orders.json':
                default = json.dumps({'total_locked': 0, 'order_count': 0, 'orders': []})
            elif sf == 'reserve.json':
                default = json.dumps({
                    'reserve_balance': 0, 'trading_balance': 0,
                    'high_water_mark': 0, 'daily_pnl': 0
                })
            elif sf == 'wallet_balance.json':
                default = json.dumps({'usdc': 0, 'pol': 0, 'updated': ''})
            else:
                default = '{}'
            with open(sfp, 'w') as f:
                f.write(default)
            print(f'  Created {sf}')

    # Read wallet address for this entity
    wallet_file = os.path.join(path, 'wallet.json')
    wallet_addr = ''
    if os.path.exists(wallet_file):
        with open(wallet_file) as f:
            wallet_addr = json.load(f).get('address', '')

    # ---------- dashboard_server.py ----------
    # Read Caspian's server and customize
    with open(os.path.join('$CASPIAN_DASH', 'dashboard_server.py')) as f:
        server_py = f.read()

    # Replace STATE_DIR default
    server_py = server_py.replace(
        'os.environ.get(\"POLYBOT_STATE_DIR\", \"/opt/polybot/state\")',
        f'os.environ.get(\"POLYBOT_STATE_DIR\", \"{state_dir}\")'
    )

    # Replace KEYS_FILE default
    keys_file = os.path.join(path, 'api_keys.json')
    server_py = server_py.replace(
        'os.environ.get(\"POLYBOT_KEYS\", \"/opt/polybot/api_keys.json\")',
        f'os.environ.get(\"POLYBOT_KEYS\", \"{keys_file}\")'
    )

    # Replace hardcoded wallet address in get_wallet_balance
    if wallet_addr:
        server_py = server_py.replace(
            'WALLET = \"0xF8d12267165da29C809dff3717Ddd04F0C121fd7\"',
            f'WALLET = \"{wallet_addr}\"'
        )

    # Replace grinder log path
    server_py = server_py.replace(
        'log_path = \"/opt/polybot/logs/grinder.log\"',
        f'log_path = \"{logs_dir}/grinder.log\"'
    )

    # Replace login template entity name
    server_py = server_py.replace('<h1>GC CASPIAN</h1>', f'<h1>{name.upper().replace(\"GC \", \"GC \")}</h1>')
    server_py = server_py.replace(
        'GC Caspian \\u2014 Gemini Capital Trading',
        f'{name} \\u2014 Gemini Capital Trading'
    )

    # Replace startup banner
    server_py = server_py.replace(
        'GC Caspian Dashboard Server',
        f'{name} Dashboard Server'
    )

    # Replace accent color in login template
    server_py = server_py.replace('#4A7FB5', color)

    with open(os.path.join(dash_dir, 'dashboard_server.py'), 'w') as f:
        f.write(server_py)
    print(f'  dashboard_server.py deployed')

    # ---------- index.html ----------
    with open(os.path.join('$CASPIAN_DASH', 'index.html')) as f:
        html = f.read()

    # Replace entity name throughout
    html = html.replace('GC Caspian', name)
    html = html.replace('GC CASPIAN', name.upper())

    # Replace accent color
    html = html.replace('--accent: #4A7FB5', f'--accent: {color}')
    html = html.replace('#4A7FB5', color)

    # Update page title
    html = html.replace(
        f'<title>{name} \\u2014 Gemini Capital Trading</title>',
        f'<title>{name} \\u2014 Gemini Capital Trading</title>'
    )
    # Fix title tag replacement (handle original)
    html = html.replace(
        '<title>GC Caspian \\u2014 Gemini Capital Trading</title>',
        f'<title>{name} \\u2014 Gemini Capital Trading</title>'
    )

    # Replace loading overlay text
    html = html.replace(f'Loading {name} Dashboard', f'Loading {name} Dashboard')

    # Replace footer
    html = html.replace('Gemini Capital &middot; GC Caspian', f'Gemini Capital &middot; {name}')

    # Copy SVG assets
    for svg in ['gc-favicon-32.svg', 'gc-horizontal-dark.svg']:
        src = os.path.join('$CASPIAN_DASH', svg)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(dash_dir, svg))

    with open(os.path.join(dash_dir, 'index.html'), 'w') as f:
        f.write(html)
    print(f'  index.html deployed (accent: {color})')

    # ---------- Create api_keys.json stub if missing ----------
    if not os.path.exists(keys_file):
        # NOTE: stub redacted 2026-04-10. Dashboard password must be set
        # via VPS-side env file or vault retrieval, not embedded in this script.
        stub = {
            'WALLET_ADDRESS': wallet_addr,
            'DASHBOARD_USER': 'dboehm@thinkcaspian.com',
            'DASHBOARD_PASS': '__SET_ON_VPS_AFTER_DEPLOY__',
            'POLY_RPC_URL': 'https://polygon-bor-rpc.publicnode.com',
            'NOTE': 'CLOB keys not yet provisioned. DASHBOARD_PASS must be set manually.'
        }
        with open(keys_file, 'w') as f:
            json.dump(stub, f, indent=2)
        print(f'  api_keys.json stub created (DASHBOARD_PASS placeholder — set manually)')

    print(f'  READY: {name} → port {port}')

print('')
print('=== All entity dashboards deployed ===')
"

echo ""
echo "=== Starting entity dashboard processes ==="

# Kill old dashboard.py on 8081 (being replaced by dashboard_server.py)
pkill -f "python3 /opt/polybot/dashboard.py" 2>/dev/null || true
pkill -f "python3 dashboard.py" 2>/dev/null || true
sleep 1

# Read entity config and start each dashboard
$VENV -c "
import json, subprocess, os, time

with open('$ENTITIES_JSON') as f:
    config = json.load(f)

entities = [e for e in config['entities'] if e['slug'] != 'caspian']

for ent in entities:
    slug = ent['slug']
    name = ent['name']
    port = ent['port']
    path = ent['path']
    dash_dir = os.path.join(path, 'dashboard')
    log_file = os.path.join(path, 'logs', 'dashboard.log')

    # Kill any existing process on this port
    os.system(f'fuser -k {port}/tcp 2>/dev/null')
    time.sleep(0.3)

    # Start dashboard
    cmd = f'cd {dash_dir} && nohup /opt/polybot/venv/bin/python3 dashboard_server.py --port {port} > {log_file} 2>&1 &'
    os.system(cmd)
    print(f'Started {name} on port {port}')

time.sleep(3)

# Verify all are running
import urllib.request
for ent in entities:
    port = ent['port']
    name = ent['name']
    try:
        r = urllib.request.urlopen(f'http://127.0.0.1:{port}/login', timeout=5)
        status = r.getcode()
        print(f'  ✓ {name} (:{port}) → HTTP {status}')
    except Exception as e:
        print(f'  ✗ {name} (:{port}) → FAILED: {e}')
"

echo ""
echo "=== Deployment complete ==="
