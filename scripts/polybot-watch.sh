#!/usr/bin/env bash
# polybot-watch.sh — live snapshot of Prod + R&D position state and PnL.
# Usage: bash scripts/polybot-watch.sh [prod|rd|both]   (default: both)
set -euo pipefail
mode="${1:-both}"
PROD_DB=/opt/polybot-v3/data/polybot.db
RD_DB=/opt/polybot-v3-rd/data/rd.db

show() {
  local label="$1" db="$2" entity="$3"
  [ -r "$db" ] || return
  echo "==================================================================="
  echo "  $label   db=$db   entity=$entity"
  echo "==================================================================="
  echo "  Cash:" $(sqlite3 "$db" "SELECT ROUND(COALESCE(trading_balance,0),2) FROM entities WHERE slug='$entity';")
  if sqlite3 "$db" ".tables" | grep -qw kill_switch_state; then
    sqlite3 "$db" "SELECT '  Kill: halted='||halted||' reason='||reason FROM kill_switch_state LIMIT 1;" 2>/dev/null || true
  elif sqlite3 "$db" ".tables" | grep -qw kill_switch; then
    sqlite3 "$db" "SELECT '  Kill: halted='||halted||' reason='||reason FROM kill_switch LIMIT 1;" 2>/dev/null || true
  fi
  echo
  echo "  --- Realized PnL ---"
  sqlite3 -column -header "$db" "
    SELECT
      ROUND(COALESCE(SUM(CASE WHEN closed_at >= datetime('now','-1 hour')  THEN unrealized_pnl END),0),2) AS pnl_1h,
      ROUND(COALESCE(SUM(CASE WHEN closed_at >= datetime('now','-4 hour')  THEN unrealized_pnl END),0),2) AS pnl_4h,
      ROUND(COALESCE(SUM(CASE WHEN closed_at >= datetime('now','-24 hour') THEN unrealized_pnl END),0),2) AS pnl_24h,
      COUNT(CASE WHEN closed_at >= datetime('now','-24 hour') THEN 1 END)                              AS res_24h
    FROM positions WHERE entity_slug='$entity' AND status IN ('closed','resolved');"
  echo
  echo "  --- Open positions ---"
  sqlite3 -column -header "$db" "
    SELECT
      substr(condition_id,1,12)||'..' AS cid,
      side,
      ROUND(size,2)                                                       AS sz,
      ROUND(avg_entry_price,3)                                            AS entry,
      ROUND(COALESCE(current_price,avg_entry_price),3)                    AS mark,
      ROUND(cost_basis,2)                                                 AS cost,
      ROUND(COALESCE(unrealized_pnl,0),2)                                 AS upnl,
      strategy_id                                                         AS strat,
      substr(COALESCE(market_slug,'?'),1,32)                        AS slug
    FROM positions WHERE entity_slug='$entity' AND status='open'
    ORDER BY opened_at DESC;"
  echo
}

[ "$mode" = "prod" -o "$mode" = "both" ] && show "PROD"  "$PROD_DB" "polybot"
[ "$mode" = "rd"   -o "$mode" = "both" ] && show "R&D"   "$RD_DB"   "rd-engine"
echo "==================================================================="
TZ=America/Chicago date "+ Snapshot %Y-%m-%d %H:%M:%S %Z"
echo "==================================================================="
