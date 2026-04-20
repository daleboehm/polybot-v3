#!/bin/bash
# capabilities-summary.sh — 2026-04-20
#
# Generates the "what Polybot is already doing" markdown for the nightly
# research agents. Replaces the old STEP 0 (20 SSH queries pulling
# disconnected facts) with ONE rendered file so agents can see the full
# picture at a glance and search only for VARIANCE opportunities.
#
# Agents read this BEFORE doing any web/arxiv searches. If a finding
# duplicates something in here, it's wasted effort — research should
# flag NEW patterns, adversaries, mispricings, or improvements not yet
# built.
#
# Output: markdown to stdout. Research skill pipes this into its agent
# context. Can also be written to /opt/polybot-v3/dist/capabilities.md
# for dashboard serving.

set -e

PROD_DB=/opt/polybot-v3/data/polybot.db
RD_DB=/opt/polybot-v3-rd/data/rd.db
REPO=/opt/polybot-v3
MANUAL=$REPO/docs/capabilities-manual.md

TODAY=$(date -u +%Y-%m-%d)
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cat <<HDR
# Polybot Capabilities Summary — $TODAY

**Generated**: $NOW | **Source**: \`scripts/capabilities-summary.sh\` on VPS

Research agents: read this FIRST. Anything listed here is already built
and operating — do NOT re-propose it. Search for **variance** only:
adversaries we haven't considered, mispricings in markets we're not
scanning, execution gaps, new academic work, platform changes.

---

## 1. Engine State

### Prod (\`polybot\`)
\`\`\`
HDR
sqlite3 -header -column "$PROD_DB" "SELECT slug, mode, status, ROUND(current_cash,2) as cash, ROUND(starting_capital,2) as seed, (SELECT halted FROM kill_switch_state WHERE id=1) as kill_switch_halted FROM entities WHERE slug='polybot';"
echo '```'
echo ""
echo "### R&D (\`rd-engine\`)"
echo '```'
sqlite3 -header -column "$RD_DB" "SELECT slug, mode, status, ROUND(current_cash,2) as cash, ROUND(starting_capital,2) as seed FROM entities WHERE slug='rd-engine';"
echo '```'
echo ""
echo "Latest R&D equity snapshot:"
echo '```'
sqlite3 -header -column "$RD_DB" "SELECT timestamp_utc as ts, ROUND(total_equity,2) as equity, ROUND(cash_balance,2) as cash, ROUND(positions_value,2) as deployed, num_positions, ROUND(pnl_vs_deposit,2) as pnl_vs_seed FROM snapshots WHERE entity_slug='rd-engine' ORDER BY id DESC LIMIT 1;"
echo '```'
echo ""

echo "---"
echo ""
echo "## 2. Active Strategies (enabled per config)"
echo ""
echo "### polybot (prod) enabled strategies"
echo '```'
python3 -c "
import yaml
with open('$REPO/config/entities.yaml') as f:
    d = yaml.safe_load(f)
for e in d.get('entities', []):
    if e.get('slug') == 'polybot':
        print(f\"mode: {e.get('mode')}, status: {e.get('status')}, starting_capital: {e.get('starting_capital')}\")
        for s in e.get('strategies', []):
            if isinstance(s, str): print(f'  - {s}')
            else: print(f\"  - {s.get('strategy_id')}: {s.get('sub_strategy_ids', 'all')}\")
"
echo '```'
echo ""
echo "### rd-engine enabled strategies"
echo '```'
python3 -c "
import yaml
with open('$REPO/config/rd-entities.yaml') as f:
    d = yaml.safe_load(f)
for e in d.get('entities', []):
    if e.get('slug') == 'rd-engine':
        print(f\"mode: {e.get('mode')}, status: {e.get('status')}, starting_capital: {e.get('starting_capital')}\")
        for s in e.get('strategies', []):
            if isinstance(s, str): print(f'  - {s}')
            else: print(f\"  - {s.get('strategy_id')}: {s.get('sub_strategy_ids', 'all')}\")
"
echo '```'
echo ""
echo "### All strategies + sub-strategies registered in code"
echo '```'
grep -E "readonly id = '|return \[" $REPO/src/strategy/custom/*.ts 2>/dev/null | grep -v "//" | head -80 | awk -F: '{print $1 ":" $2}'
echo '```'
echo ""

echo "---"
echo ""
echo "## 3. Strategy Performance — R&D post-04-18 (current era)"
echo '```'
sqlite3 -header -column "$RD_DB" "SELECT strategy_id, sub_strategy_id, n, win_rate as wr, ROUND(avg_pnl_per_trade,3) as avg_trade, ROUND(total_pnl,2) as total FROM v_strategy_checkpoints WHERE entity_slug='rd-engine' AND checkpoint_label='T2_rd_back_2026-04-18' AND era='after' AND n >= 10 ORDER BY total_pnl DESC;"
echo '```'
echo ""
echo "### Strategy rolling windows (R&D, 24h/48h/72h)"
echo '```'
sqlite3 -header -column "$RD_DB" "SELECT strategy_id, sub_strategy_id, window_label, n, wins, losses, ROUND(win_rate,1) as wr, ROUND(total_pnl,2) as pnl FROM v_strategy_rolling WHERE entity_slug='rd-engine' AND window_label != 'all_time' AND n >= 5 ORDER BY strategy_id, sub_strategy_id, CASE window_label WHEN '24h' THEN 1 WHEN '48h' THEN 2 WHEN '72h' THEN 3 END;"
echo '```'
echo ""

echo "---"
echo ""
echo "## 4. Active Scouts (ScoutCoordinator registry)"
echo '```'
grep -E "new \w+Scout\(\)" $REPO/src/scouts/scout-coordinator.ts | sed 's/^[[:space:]]*//'
echo '```'
echo ""

echo "---"
echo ""
echo "## 5. Data Feeds Wired"
echo '```'
grep -E "export async function get\w+|^// ─── \d" $REPO/src/market/data-feeds.ts | head -20
echo '```'
echo ""
echo "Strategy data imports:"
echo '```'
grep -h "from '../../market/" $REPO/src/strategy/custom/*.ts 2>/dev/null | sort -u | head -20
echo '```'
echo ""

echo "---"
echo ""
echo "## 6. Risk + Sizing Config"
echo ""
echo "### Prod (config/default.yaml)"
echo '```yaml'
grep -E 'max_position|daily_loss|fractional_kelly|min_edge|max_hours_to_resolve|max_portfolio_exposure|max_strategy_envelope|max_cluster|trailing|hard_stop|stop_loss_pct|profit_target|min_hold|exchange_version' $REPO/config/default.yaml | head -25
echo '```'
echo ""
echo "### R&D (config/rd-default.yaml)"
echo '```yaml'
grep -E 'max_position|daily_loss|fractional_kelly|min_edge|max_hours_to_resolve|max_portfolio_exposure|exchange_version' $REPO/config/rd-default.yaml | head -15
echo '```'
echo ""

echo "---"
echo ""
echo "## 7. Recent Commits (last 7 days)"
echo '```'
cd $REPO && git log --oneline --since='7 days ago' | head -30
echo '```'
echo ""

echo "---"
echo ""
echo "## 8. Manually-Curated Capabilities (hypotheses, deferred, variance directions)"
echo ""
if [ -f "$MANUAL" ]; then
  cat "$MANUAL"
else
  echo "⚠️ Manual curation file not found at $MANUAL. Research variance directions missing."
fi
echo ""
echo "---"
echo ""
echo "*Generated $NOW. If you're a research agent: items above are **already built**. Report variance only.*"
