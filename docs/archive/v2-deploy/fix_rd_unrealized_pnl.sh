#!/bin/bash
# Fix: Add Unrealized P&L to R&D dashboard scoreboard
# Deploy: ssh to VPS, run this script, restart service
#
# The rd_template.html scoreboard is missing the unrealized_pnl field
# that read_rd_data() now provides. This adds it after the Net P&L card.

SSH_KEY="C:/Users/dboehm.CASPIANTEK/OneDrive - thinkcaspian.com/1-Working Files/CLAUDE/Polymarket/deploy/armorstack_vps_key"
VPS="root@178.62.225.235"
PORT=2222

ssh -i "$SSH_KEY" -p $PORT -o StrictHostKeyChecking=no -o ConnectTimeout=20 $VPS bash -s << 'REMOTE_EOF'
set -e

TEMPLATE="/opt/polybot/rd/rd_template.html"
BACKUP="/opt/polybot/rd/rd_template.html.bak.$(date +%Y%m%d%H%M%S)"

# Backup first
cp "$TEMPLATE" "$BACKUP"
echo "Backup created: $BACKUP"

# Use Python to do the replacement since it handles multiline better than sed
python3 << 'PYEOF'
import re

with open("/opt/polybot/rd/rd_template.html", "r") as f:
    content = f.read()

# Find the Net P&L scoreboard item and add Unrealized P&L after it
old_block = '''            <div class="scoreboard-item">
                <span class="scoreboard-label">Net P&L (Paper)</span>
                {% set net = rd.net_pnl %}
                <span class="scoreboard-value {% if net >= 0 %}pnl-positive{% else %}pnl-negative{% endif %}">${{ "%.2f"|format(net) }}</span>
            </div>'''

new_block = '''            <div class="scoreboard-item">
                <span class="scoreboard-label">Net P&L (Realized)</span>
                {% set net = rd.net_pnl %}
                <span class="scoreboard-value {% if net >= 0 %}pnl-positive{% else %}pnl-negative{% endif %}">${{ "%.2f"|format(net) }}</span>
            </div>
            <div class="scoreboard-item">
                <span class="scoreboard-label">Unrealized P&L</span>
                {% set upnl = rd.unrealized_pnl|default(0) %}
                <span class="scoreboard-value {% if upnl >= 0 %}pnl-positive{% else %}pnl-negative{% endif %}">${{ "%.2f"|format(upnl) }}</span>
            </div>
            <div class="scoreboard-item">
                <span class="scoreboard-label">Total P&L</span>
                {% set tpnl = (rd.net_pnl or 0) + (rd.unrealized_pnl|default(0)) %}
                <span class="scoreboard-value {% if tpnl >= 0 %}pnl-positive{% else %}pnl-negative{% endif %}">${{ "%.2f"|format(tpnl) }}</span>
            </div>'''

if old_block in content:
    content = content.replace(old_block, new_block)
    with open("/opt/polybot/rd/rd_template.html", "w") as f:
        f.write(content)
    print("SUCCESS: Added Unrealized P&L and Total P&L to scoreboard")
else:
    print("ERROR: Could not find Net P&L block to replace. Template may have changed.")
    exit(1)
PYEOF

# Restart the dashboard service
systemctl restart polybot-master-dashboard.service
echo "Service restarted. Check https://geminicap.net/rd"

REMOTE_EOF
