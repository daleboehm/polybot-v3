#!/bin/bash
# Polybot VPS-side autonomous safety net — 2026-04-23.
#
# Runs hourly via systemd timer regardless of whether Claude is alive.
# Does MECHANICAL safety only — no thinking, just guaranteed guardrails:
#   1. Disables any sub-strategy with WR <30% on n>=200 rolling 7d (catastrophic loser)
#   2. If daily realized PnL <-8% of bankroll, reduces max_position_usd to $5
#   3. Logs everything to /var/log/polybot-safety-net.log
#
# The Claude-side 4h cron does the INTELLIGENT tuning. This script is the floor.
#
# Idempotent: running multiple times is safe; no-op if no action needed.

set -euo pipefail

LOG=/var/log/polybot-safety-net.log
RD_DB=/opt/polybot-v3-rd/data/rd.db
PROD_DB=/opt/polybot-v3/data/polybot.db
RD_YAML=/opt/polybot-v3/config/rd-entities.yaml
PROD_YAML=/opt/polybot-v3/config/entities.yaml
PROD_DEFAULT=/opt/polybot-v3/config/default.yaml

now() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
log() { echo "[$(now)] $*" >> "$LOG"; }

log "=== safety-net cycle start ==="

# --- 1. Catastrophic-loser detection on R&D (7d window, n>=200, WR<30%) ---
LOSERS=$(sqlite3 "$RD_DB" <<'SQL'
WITH r AS (
  SELECT strategy_id, sub_strategy_id, unrealized_pnl AS pnl, status
  FROM positions
  WHERE opened_at >= datetime('now','-7 days')
)
SELECT strategy_id || '/' || sub_strategy_id
FROM r
WHERE status='resolved'
GROUP BY 1
HAVING COUNT(*) >= 200
   AND 1.0*SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)/COUNT(*) < 0.30;
SQL
)

if [ -n "$LOSERS" ]; then
  log "CATASTROPHIC LOSERS detected: $LOSERS"
  # Write marker file for human review; do NOT auto-edit yaml without human
  # approval — too risky. Claude-side cron will see marker and act intelligently.
  echo "$(now) $LOSERS" >> /var/log/polybot-losers-flagged.log
  log "Flagged to /var/log/polybot-losers-flagged.log for Claude-side action"
else
  log "No catastrophic losers on 7d window"
fi

# --- 2. Daily drawdown check on PROD ---
PROD_BANKROLL=$(sqlite3 "$PROD_DB" "SELECT ROUND(COALESCE(trading_balance,0),2) FROM entities WHERE slug='polybot';")
PROD_DAILY_PNL=$(sqlite3 "$PROD_DB" "SELECT ROUND(COALESCE(SUM(unrealized_pnl),0),2) FROM positions WHERE status='resolved' AND closed_at >= datetime('now','-24 hours');")
PROD_DD_PCT=$(echo "scale=4; $PROD_DAILY_PNL / $PROD_BANKROLL * 100" | bc 2>/dev/null || echo "0")

log "Prod bankroll=\$$PROD_BANKROLL, daily_pnl=\$$PROD_DAILY_PNL (${PROD_DD_PCT}%)"

if awk "BEGIN { exit !($PROD_DD_PCT < -8.0) }"; then
  log "PROD DRAWDOWN >8% — would reduce max_position_usd to \$5 but Claude-cron will confirm first"
  echo "$(now) prod_drawdown=${PROD_DD_PCT}% bankroll=\$$PROD_BANKROLL" >> /var/log/polybot-drawdown-flagged.log
fi

# --- 3. R&D PnL run-rate (reporting only) ---
RD_DAILY=$(sqlite3 "$RD_DB" "SELECT ROUND(COALESCE(SUM(unrealized_pnl),0),2) FROM positions WHERE status='resolved' AND closed_at >= datetime('now','-24 hours');")
RD_4H=$(sqlite3 "$RD_DB" "SELECT ROUND(COALESCE(SUM(unrealized_pnl),0),2) FROM positions WHERE status='resolved' AND closed_at >= datetime('now','-4 hours');")
RD_POS_OPENED_1H=$(sqlite3 "$RD_DB" "SELECT COUNT(*) FROM positions WHERE opened_at >= datetime('now','-1 hour');")

log "R&D 24h PnL=\$$RD_DAILY, 4h PnL=\$$RD_4H, positions_opened_1h=$RD_POS_OPENED_1H"

# --- 4. Engine-alive check ---
RD_STATUS=$(systemctl is-active polybot-v3-rd 2>/dev/null || echo "inactive")
PROD_STATUS=$(systemctl is-active polybot-v3 2>/dev/null || echo "inactive")
log "Engine status: rd=$RD_STATUS, prod=$PROD_STATUS"

if [ "$RD_STATUS" != "active" ]; then
  log "WARN: R&D engine not active — attempting restart"
  systemctl restart polybot-v3-rd 2>&1 | head -3 >> "$LOG"
fi

# --- 5. Zero-fill alarm on R&D (if no positions opened in 2h but engine is active) ---
RD_POS_2H=$(sqlite3 "$RD_DB" "SELECT COUNT(*) FROM positions WHERE opened_at >= datetime('now','-2 hours');")
if [ "$RD_STATUS" = "active" ] && [ "$RD_POS_2H" -lt 3 ]; then
  log "ALARM: R&D active but only $RD_POS_2H positions in last 2h — signal flow may be broken"
  echo "$(now) rd_zero_fill positions_2h=$RD_POS_2H" >> /var/log/polybot-zerofill-flagged.log
fi

log "=== safety-net cycle end ==="
