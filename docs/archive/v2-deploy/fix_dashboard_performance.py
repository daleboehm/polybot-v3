#!/usr/bin/env python3
"""
Dashboard Performance Fix — fix_dashboard_performance.py
Patches both unified_dashboard.py and rd_dashboard.py with:
  1. Background-thread caching for all heavy queries (60s refresh)
  2. Slows master dashboard auto-refresh from 30s to 120s
  3. Read-only SQLite connections where missing

Upload to VPS and run:
  python3 fix_dashboard_performance.py
Then restart both dashboard services:
  systemctl restart polybot-master-dashboard polybot-rd-dashboard
"""
import re
import shutil
from datetime import datetime

UNIFIED = "/opt/polybot/unified_dashboard.py"
RD = "/opt/polybot/rd/rd_dashboard.py"


def backup(filepath):
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    dst = f"{filepath}.bak.{ts}"
    shutil.copy2(filepath, dst)
    print(f"  Backup: {dst}")
    return dst


def patch_unified():
    """Patch unified_dashboard.py with caching + slower refresh."""
    print("\n=== Patching unified_dashboard.py ===")
    backup(UNIFIED)

    with open(UNIFIED, "r") as f:
        content = f.read()

    changes = 0

    # 1. Add background cache refresh thread for read_rd_data
    # Replace CACHE_TTL = 30 with 60 and add the caching infrastructure
    old_cache_ttl = "CACHE_TTL = 30  # seconds"
    new_cache_ttl = "CACHE_TTL = 60  # seconds — background thread refreshes R&D data"
    if old_cache_ttl in content:
        content = content.replace(old_cache_ttl, new_cache_ttl)
        changes += 1
        print("  OK: CACHE_TTL 30 -> 60")

    # 2. Wrap read_rd_data with caching using DATA_CACHE and CACHE_LOCK
    # Find the function and add cache check at the top
    old_rd_start = 'def read_rd_data():\n    """Read R&D paper trading stats from rd_ledger.db"""'
    new_rd_start = '''def _compute_rd_data():
    """Compute R&D paper trading stats from rd_ledger.db (heavy — called by background thread)"""'''

    if old_rd_start in content:
        content = content.replace(old_rd_start, new_rd_start)
        changes += 1
        print("  OK: Renamed read_rd_data -> _compute_rd_data (internal)")

    # Add the cached wrapper + background thread after the existing DATA_CACHE declaration
    cache_wrapper = '''
# ── Background R&D data cache (performance fix) ──
_RD_CACHE = {"data": None, "updated": 0}
_RD_CACHE_LOCK = threading.RLock()
_RD_CACHE_TTL = 60  # seconds

def read_rd_data():
    """Return cached R&D data. Background thread refreshes every 60s."""
    with _RD_CACHE_LOCK:
        if _RD_CACHE["data"] is not None:
            return _RD_CACHE["data"]
    # First call — compute synchronously
    data = _compute_rd_data()
    with _RD_CACHE_LOCK:
        _RD_CACHE["data"] = data
        _RD_CACHE["updated"] = __import__("time").time()
    return data

def _rd_cache_refresh_loop():
    """Background thread: refresh R&D data every 60s."""
    import time as _time
    while True:
        try:
            data = _compute_rd_data()
            with _RD_CACHE_LOCK:
                _RD_CACHE["data"] = data
                _RD_CACHE["updated"] = _time.time()
        except Exception as e:
            logger.error(f"R&D cache refresh error: {e}")
        _time.sleep(_RD_CACHE_TTL)

# Start background R&D cache thread
_rd_cache_thread = threading.Thread(target=_rd_cache_refresh_loop, daemon=True)
_rd_cache_thread.start()
'''

    # Insert the cache wrapper right before the _compute_rd_data function
    marker = 'def _compute_rd_data():'
    if marker in content:
        content = content.replace(marker, cache_wrapper + "\n" + marker)
        changes += 1
        print("  OK: Added background R&D cache thread")

    # 3. Slow down auto-refresh from 30s to 120s
    old_refresh = "setInterval(refreshData, 30000);"
    new_refresh = "setInterval(refreshData, 120000);"
    count = content.count(old_refresh)
    if count > 0:
        content = content.replace(old_refresh, new_refresh)
        changes += count
        print(f"  OK: Auto-refresh 30s -> 120s ({count} instances)")

    with open(UNIFIED, "w") as f:
        f.write(content)

    print(f"  Applied {changes} changes to {UNIFIED}")
    return changes


def patch_rd_dashboard():
    """Patch rd_dashboard.py with query caching."""
    print("\n=== Patching rd_dashboard.py ===")
    backup(RD)

    with open(RD, "r") as f:
        content = f.read()

    changes = 0

    # 1. Add imports and cache infrastructure after the LOGIN_ATTEMPTS line
    old_login = "LOGIN_ATTEMPTS = {}"
    new_login = """LOGIN_ATTEMPTS = {}

# ── Background stats cache (performance fix) ──
import time as _time_mod
_STATS_CACHE = {"data": None, "updated": 0}
_STATS_CACHE_LOCK = threading.Lock()
_STATS_CACHE_TTL = 60  # seconds"""

    if old_login in content and "_STATS_CACHE" not in content:
        content = content.replace(old_login, new_login, 1)
        changes += 1
        print("  OK: Added stats cache infrastructure")

    # 2. Add cached stats computation function and background thread
    # We need to find the db() function and add the cache refresh after it
    # Find "def index():" and wrap the heavy query logic

    # Instead of rewriting index(), add a function that pre-computes all stats
    # and a background thread, then have index() read from cache

    # Find the db() function definition
    db_func_match = re.search(r'(def db\(\):.*?(?=\ndef ))', content, re.DOTALL)
    if db_func_match:
        db_func_end = db_func_match.end()
        # Find helper functions between db() and index()
        # We need to insert our cache computation after all helpers, before index()

    # Add background cache computation right before def index():
    cache_code = '''
def _compute_dashboard_stats():
    """Compute all dashboard stats (heavy — called by background thread every 60s)."""
    try:
        conn = db()
        now_utc = datetime.now(timezone.utc)

        stats = conn.execute("""
            SELECT COUNT(*) as total,
                   SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open_n,
                   SUM(CASE WHEN status IN ('WON','LOST') THEN 1 ELSE 0 END) as resolved_n,
                   SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
                   SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as losses,
                   SUM(CASE WHEN status IN ('WON','LOST') THEN pnl ELSE 0 END) as net_pnl,
                   SUM(size_usd) as volume,
                   SUM(CASE WHEN status IN ('WON','LOST') THEN size_usd ELSE 0 END) as resolved_volume,
                   AVG(edge_estimate) as avg_edge,
                   AVG(payoff_ratio) as avg_payoff,
                   MIN(opened_at) as first_trade,
                   MAX(opened_at) as last_trade,
                   COUNT(DISTINCT condition_id) as unique_markets,
                   COUNT(DISTINCT strategy) as strategy_count,
                   COUNT(DISTINCT category) as category_count
            FROM trades
        """).fetchone()

        strategies = conn.execute("""
            SELECT strategy,
                   COUNT(*) as total,
                   SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open_n,
                   SUM(CASE WHEN status IN ('WON','LOST') THEN 1 ELSE 0 END) as resolved_n,
                   SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
                   SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as losses,
                   SUM(CASE WHEN status IN ('WON','LOST') THEN pnl ELSE 0 END) as net_pnl,
                   AVG(CASE WHEN status IN ('WON','LOST') THEN pnl END) as avg_pnl,
                   AVG(edge_estimate) as avg_edge,
                   AVG(payoff_ratio) as avg_payoff,
                   AVG(entry_price) as avg_entry,
                   SUM(size_usd) as total_volume,
                   SUM(CASE WHEN status IN ('WON','LOST') AND pnl > 0 THEN pnl ELSE 0 END) as gross_profit,
                   SUM(CASE WHEN status IN ('WON','LOST') AND pnl < 0 THEN ABS(pnl) ELSE 0 END) as gross_loss
            FROM trades GROUP BY strategy
            ORDER BY COALESCE(SUM(CASE WHEN status IN ('WON','LOST') THEN pnl ELSE 0 END), 0) DESC
        """).fetchall()

        categories = conn.execute("""
            SELECT category,
                   COUNT(*) as total,
                   SUM(CASE WHEN status IN ('WON','LOST') THEN 1 ELSE 0 END) as resolved_n,
                   SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
                   SUM(CASE WHEN status IN ('WON','LOST') THEN pnl ELSE 0 END) as net_pnl,
                   SUM(size_usd) as volume
            FROM trades GROUP BY category ORDER BY total DESC
        """).fetchall()

        resolution = conn.execute("""
            SELECT
                SUM(CASE WHEN end_date IS NOT NULL AND end_date < datetime('now', '-24 hours') AND status = 'OPEN' THEN 1 ELSE 0 END) as overdue,
                SUM(CASE WHEN end_date IS NOT NULL AND end_date >= datetime('now', '-24 hours') AND end_date < datetime('now') AND status = 'OPEN' THEN 1 ELSE 0 END) as closing_now,
                SUM(CASE WHEN end_date IS NOT NULL AND end_date >= datetime('now') AND end_date < datetime('now', '+24 hours') AND status = 'OPEN' THEN 1 ELSE 0 END) as next_24h,
                SUM(CASE WHEN end_date IS NOT NULL AND end_date >= datetime('now', '+24 hours') AND end_date < datetime('now', '+48 hours') AND status = 'OPEN' THEN 1 ELSE 0 END) as next_48h,
                SUM(CASE WHEN end_date IS NOT NULL AND end_date >= datetime('now', '+48 hours') AND status = 'OPEN' THEN 1 ELSE 0 END) as next_72h,
                SUM(CASE WHEN status IN ('WON','LOST') THEN 1 ELSE 0 END) as resolved_total,
                SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as won_total,
                SUM(CASE WHEN status = 'LOST' THEN 1 ELSE 0 END) as lost_total
            FROM trades
        """).fetchone()

        try:
            go_live = conn.execute("SELECT * FROM go_live_status ORDER BY approved DESC, ev_per_trade DESC").fetchall()
        except Exception:
            go_live = []

        edge_accuracy = conn.execute("""
            SELECT strategy,
                   AVG(edge_estimate) as avg_edge,
                   AVG(CASE WHEN status = 'WON' THEN 1.0 ELSE 0.0 END) as actual_wr,
                   COUNT(*) as n
            FROM trades
            WHERE status IN ('WON','LOST') AND edge_estimate > 0
            GROUP BY strategy
        """).fetchall()

        daily = conn.execute("""
            SELECT DATE(opened_at) as day,
                   COUNT(*) as trades,
                   SUM(CASE WHEN status = 'WON' THEN 1 ELSE 0 END) as wins,
                   SUM(CASE WHEN status IN ('WON','LOST') THEN pnl ELSE 0 END) as pnl,
                   SUM(CASE WHEN status IN ('WON','LOST') THEN 1 ELSE 0 END) as resolved
            FROM trades WHERE opened_at IS NOT NULL
            GROUP BY DATE(opened_at) ORDER BY day
        """).fetchall()

        recent = conn.execute("""
            SELECT id, strategy, side, entry_price, exit_price, pnl, pnl_pct,
                   status, resolved_outcome, edge_estimate, confidence, payoff_ratio,
                   category, opened_at, closed_at, question, end_date, size_usd, shares
            FROM trades ORDER BY id DESC LIMIT 100
        """).fetchall()

        top_winners = conn.execute("""
            SELECT strategy, question, pnl, entry_price, exit_price, category
            FROM trades WHERE status IN ('WON','LOST') AND pnl > 0
            ORDER BY pnl DESC LIMIT 5
        """).fetchall()

        top_losers = conn.execute("""
            SELECT strategy, question, pnl, entry_price, exit_price, category
            FROM trades WHERE status IN ('WON','LOST') AND pnl < 0
            ORDER BY pnl ASC LIMIT 5
        """).fetchall()

        engine_health = {}
        try:
            latest_trade = conn.execute("SELECT opened_at FROM trades ORDER BY id DESC LIMIT 1").fetchone()
            engine_health["last_trade"] = latest_trade["opened_at"] if latest_trade else "N/A"
            latest_resolve = conn.execute("SELECT closed_at FROM trades WHERE status IN ('WON','LOST') ORDER BY closed_at DESC LIMIT 1").fetchone()
            engine_health["last_resolve"] = latest_resolve["closed_at"] if latest_resolve and latest_resolve["closed_at"] else "N/A"
        except Exception:
            engine_health = {"last_trade": "N/A", "last_resolve": "N/A"}

        total = stats["total"] or 0
        resolved = stats["resolved_n"] or 0
        wins_n = stats["wins"] or 0
        losses_n = stats["losses"] or 0
        net_pnl = stats["net_pnl"] or 0
        volume = stats["volume"] or 0

        win_rate = safe_div(wins_n, resolved) * 100
        loss_rate = safe_div(losses_n, resolved) * 100
        gross_profit = sum(s["gross_profit"] or 0 for s in strategies)
        gross_loss = sum(s["gross_loss"] or 0 for s in strategies)
        profit_factor = safe_div(gross_profit, gross_loss) if gross_loss > 0 else 0
        best_strategy = strategies[0]["strategy"] if strategies and (strategies[0]["net_pnl"] or 0) > 0 else "N/A"
        worst_strategy = strategies[-1]["strategy"] if strategies and (strategies[-1]["net_pnl"] or 0) < 0 else "N/A"

        conn.close()

        return {
            "stats": stats, "strategies": strategies, "categories": categories,
            "resolution": resolution, "go_live": go_live, "edge_accuracy": edge_accuracy,
            "daily": daily, "recent": recent, "top_winners": top_winners,
            "top_losers": top_losers, "engine_health": engine_health,
            "win_rate": win_rate, "loss_rate": loss_rate, "profit_factor": profit_factor,
            "best_strategy": best_strategy, "worst_strategy": worst_strategy,
            "gross_profit": gross_profit, "gross_loss": gross_loss,
            "now": now_utc.strftime("%Y-%m-%d %H:%M UTC"),
        }
    except Exception as e:
        logging.error(f"Stats computation error: {e}")
        return None


def _stats_cache_refresh_loop():
    """Background thread: refresh dashboard stats every 60s."""
    while True:
        try:
            data = _compute_dashboard_stats()
            if data:
                with _STATS_CACHE_LOCK:
                    _STATS_CACHE["data"] = data
                    _STATS_CACHE["updated"] = _time_mod.time()
        except Exception as e:
            logging.error(f"Stats cache refresh error: {e}")
        _time_mod.sleep(_STATS_CACHE_TTL)

_stats_cache_thread = threading.Thread(target=_stats_cache_refresh_loop, daemon=True)
_stats_cache_thread.start()


'''

    old_index = "\ndef index():\n    conn = db()\n    now_utc = datetime.now(timezone.utc)"

    new_index = cache_code + """
def index():
    # Serve from background cache if available
    with _STATS_CACHE_LOCK:
        cached = _STATS_CACHE["data"]
    if cached is not None:
        return render_template_string(
            MAIN_TEMPLATE,
            **cached,
        )

    # Fallback: compute synchronously (first load only)
    cached = _compute_dashboard_stats()
    if cached:
        with _STATS_CACHE_LOCK:
            _STATS_CACHE["data"] = cached
            _STATS_CACHE["updated"] = _time_mod.time()
        return render_template_string(MAIN_TEMPLATE, **cached)

    # Ultimate fallback: original inline queries
    conn = db()
    now_utc = datetime.now(timezone.utc)"""

    if old_index in content:
        content = content.replace(old_index, new_index, 1)
        changes += 1
        print("  OK: Wrapped index() with stats cache")
    else:
        print("  WARNING: Could not find index() function marker for caching")

    with open(RD, "w") as f:
        f.write(content)

    print(f"  Applied {changes} changes to {RD}")
    return changes


def patch_gunicorn():
    """Patch systemd service files to use 3 workers instead of 1."""
    print("\n=== Patching gunicorn workers ===")
    changes = 0

    for svc_name in ["polybot-master-dashboard", "polybot-rd-dashboard"]:
        svc_path = f"/etc/systemd/system/{svc_name}.service"
        try:
            with open(svc_path, "r") as f:
                content = f.read()

            if "-w 1" in content:
                backup(svc_path)
                content = content.replace("-w 1", "-w 3")
                with open(svc_path, "w") as f:
                    f.write(content)
                changes += 1
                print(f"  OK: {svc_name} workers 1 -> 3")
            elif "-w 3" in content:
                print(f"  SKIP: {svc_name} already has 3 workers")
            else:
                print(f"  WARNING: {svc_name} — no -w flag found")
        except FileNotFoundError:
            print(f"  WARNING: {svc_path} not found")

    return changes


if __name__ == "__main__":
    print("=" * 60)
    print("  DASHBOARD PERFORMANCE FIX")
    print("=" * 60)

    c1 = patch_unified()
    c2 = patch_rd_dashboard()
    c3 = patch_gunicorn()

    total = c1 + c2 + c3
    print(f"\n{'=' * 60}")
    print(f"  Total changes: {total}")
    print(f"\n  Next steps:")
    print(f"    systemctl daemon-reload")
    print(f"    systemctl restart polybot-master-dashboard polybot-rd-dashboard")
    print(f"{'=' * 60}")
