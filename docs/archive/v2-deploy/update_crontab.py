#!/usr/bin/env python3
"""Update crontab: remove old disabled traders, add paused prod engine entries."""
import re
import subprocess
import sys

# Get current crontab
result = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
lines = result.stdout.splitlines(keepends=True)

# Patterns to remove (old disabled/paused trading jobs)
remove_patterns = [
    r"sprint_trader",
    r"edge_trader",
    r"edge_detector",
    r"run_sprint",
    r"run_edge_if_funded",
    r"auto_trader.*quick",
    r"market_maker\.py",
    r"grinder\.py",
    r"orchestrator\.py",
    r"capital_router",
    r"auto_deposit.*execute",
    r"fund_armorstack",
    r"round1_sweep",
    r"correlation_tracker",
]

new_lines = []
removed = 0
for line in lines:
    skip = False
    for pat in remove_patterns:
        if re.search(pat, line, re.IGNORECASE):
            skip = True
            removed += 1
            break
    if not skip:
        new_lines.append(line)

# Add new prod trading block (ALL PAUSED)
prod_block = [
    "\n",
    "# --- PROD TRADING ENGINE (rd_trader_v3 promoted from R&D 2026-04-06) ---\n",
    "# STATUS: PAUSED -- uncomment to activate prod trading\n",
    "# All entries use flock to prevent overlap, same pattern as R&D\n",
    "#PAUSED# */5  * * * * flock -n /tmp/rd_prod_scan.lock bash -c 'cd /opt/polybot && /opt/polybot/venv/bin/python3 rd_trader_v3.py >> /opt/polybot/logs/rd_prod_cron.log 2>&1'\n",
    "#PAUSED# */10 * * * * flock -n /tmp/rd_prod_resolve.lock bash -c 'cd /opt/polybot && /opt/polybot/venv/bin/python3 rd_trader_v3.py --resolve >> /opt/polybot/logs/rd_prod_cron.log 2>&1'\n",
    "#PAUSED# */15 * * * * flock -n /tmp/rd_prod_stoploss.lock bash -c 'cd /opt/polybot && /opt/polybot/venv/bin/python3 rd_trader_v3.py --stop-loss >> /opt/polybot/logs/rd_prod_cron.log 2>&1'\n",
    "#PAUSED# */30 * * * * flock -n /tmp/rd_prod_mtm.lock bash -c 'cd /opt/polybot && /opt/polybot/venv/bin/python3 rd_trader_v3.py --mtm >> /opt/polybot/logs/rd_prod_cron.log 2>&1'\n",
    "#PAUSED# 0    * * * * flock -n /tmp/rd_prod_report.lock bash -c 'cd /opt/polybot && /opt/polybot/venv/bin/python3 rd_trader_v3.py --report >> /opt/polybot/logs/rd_prod_reports.log 2>&1'\n",
    "#PAUSED# 0    6 * * * cd /opt/polybot && /opt/polybot/venv/bin/python3 rd_analytics.py --report >> /opt/polybot/logs/rd_prod_analytics.log 2>&1\n",
    "# -------------------------------------------------------------------\n",
]

new_lines.extend(prod_block)

# Write to temp file and install
with open("/tmp/cron_new.txt", "w") as f:
    f.writelines(new_lines)

subprocess.run(["crontab", "/tmp/cron_new.txt"], check=True)

print(f"Removed {removed} old trading job lines")
print(f"Added PAUSED prod trading block (6 entries)")
print("Crontab updated successfully")
