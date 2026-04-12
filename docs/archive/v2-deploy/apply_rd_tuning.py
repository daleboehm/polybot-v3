#!/usr/bin/env python3
"""
R&D Engine Tuning Patch — apply_rd_tuning.py
Applies all 6 recommendations to rd_trader_v3.py:
  1. Tiered stop-loss by entry price
  2. momentum_cheap volume threshold 500 → 5000
  3. Minimum 6h hold period before stop-loss activates
  4. Scan window 168h → 48h, market cap 8000 → 3000, dedup 30min → 120min, pages 200 → 100
  5. Favorites edge floor: min_price 0.88 → 0.50, add max_price 0.92
  6. Random control rate 10 → 20

Usage: python3 apply_rd_tuning.py /opt/polybot/rd/rd_trader_v3.py
"""
import sys
import shutil
from datetime import datetime

def apply_patch(filepath):
    # Backup first
    backup = f"{filepath}.bak.{datetime.now().strftime('%Y%m%d_%H%M%S')}"
    shutil.copy2(filepath, backup)
    print(f"Backup: {backup}")

    with open(filepath, 'r') as f:
        content = f.read()

    original = content  # for diff count

    # ═══════════════════════════════════════════════════════════
    # CHANGE 1: Scan parameters (constants)
    # ═══════════════════════════════════════════════════════════

    content = content.replace(
        'DEDUP_MINUTES = 30         # allow re-entry after 30 min (was 60)',
        'DEDUP_MINUTES = 120        # allow re-entry after 2h (was 30 — reduce volume for focused R&D)'
    )
    content = content.replace(
        'MAX_HORIZON_HOURS = 168    # 7-day window (was 72h)',
        'MAX_HORIZON_HOURS = 48     # 48h window for focused R&D test (was 168h)'
    )
    content = content.replace(
        'MAX_MARKETS_PER_CYCLE = 8000  # Cap per scan cycle (was 3000)',
        'MAX_MARKETS_PER_CYCLE = 3000  # Reduced for focused R&D (was 8000)'
    )
    content = content.replace(
        'MAX_SCAN_PAGES = 200       # Pages per fetch pass (was 100)',
        'MAX_SCAN_PAGES = 100       # Reduced for focused R&D (was 200)'
    )

    # ═══════════════════════════════════════════════════════════
    # CHANGE 2: momentum_cheap volume threshold
    # ═══════════════════════════════════════════════════════════

    content = content.replace(
        '"momentum_cheap": {"min_volume": 500, "min_price": 0.03, "max_price": 0.22}',
        '"momentum_cheap": {"min_volume": 5000, "min_price": 0.03, "max_price": 0.22}'
    )

    # ═══════════════════════════════════════════════════════════
    # CHANGE 3: Favorites edge floor
    # ═══════════════════════════════════════════════════════════

    content = content.replace(
        '"favorites": {"min_price": 0.88}',
        '"favorites": {"min_price": 0.50, "max_price": 0.92}'
    )

    # Update _eval_favorites to check max_price
    content = content.replace(
        '    if price is None or price < cfg["min_price"]:\n        return 0',
        '    if price is None or price < cfg["min_price"] or price > cfg.get("max_price", 1.0):\n        return 0'
    )

    # ═══════════════════════════════════════════════════════════
    # CHANGE 4: Random control rate
    # ═══════════════════════════════════════════════════════════

    content = content.replace(
        'RANDOM_CONTROL_RATE = 10   # 1-in-N markets get a random trade (was 8, slightly less random)',
        'RANDOM_CONTROL_RATE = 20   # 1-in-N markets get a random trade (was 10 — halved for R&D focus)'
    )

    # ═══════════════════════════════════════════════════════════
    # CHANGE 5: Stale cutoff 48h → 24h in is_within_window
    # ═══════════════════════════════════════════════════════════

    content = content.replace(
        '    # Skip markets with endDate more than 48h in the past (was 24h)\n    stale_cutoff = now - timedelta(hours=48)',
        '    # Skip markets with endDate more than 24h in the past (tightened for R&D focus)\n    stale_cutoff = now - timedelta(hours=24)'
    )

    # ═══════════════════════════════════════════════════════════
    # CHANGE 6: Tiered stop-loss + minimum hold period
    # Replace the entire check_stop_losses function
    # ═══════════════════════════════════════════════════════════

    old_stop_loss = '''def check_stop_losses():
    """Check open positions for stop-loss exits (30% adverse movement)."""
    STOP_LOSS_PCT = 0.30  # 30% adverse price movement triggers exit

    conn = db()
    try:
        open_trades = conn.execute(
            "SELECT id, condition_id, side, entry_price, shares, strategy, question "
            "FROM trades WHERE status = 'OPEN'"
        ).fetchall()

        if not open_trades:
            return

        # Load market prices from cache using shared helper
        price_map, cache_age = _load_price_map()

        stopped = 0
        for t in open_trades:
            current_price = price_map.get((t["condition_id"], t["side"]))
            if current_price is None:
                continue  # No price data available

            entry = t["entry_price"]
            if entry <= 0:
                continue

            # Calculate adverse movement
            # For a BUY position, adverse = price dropped
            price_change_pct = (current_price - entry) / entry

            if price_change_pct <= -STOP_LOSS_PCT:
                pnl = (current_price - entry) * t["shares"]
                pnl_pct = price_change_pct * 100
                now_ts = datetime.now(timezone.utc).isoformat()

                conn.execute("""
                    UPDATE trades SET exit_price=?, pnl=?, pnl_pct=?,
                                     status='STOPPED', resolved_outcome='STOP_LOSS',
                                     closed_at=?, notes=?
                    WHERE id=?
                """, (current_price, pnl, pnl_pct, now_ts,
                      f"Stop-loss at {current_price:.4f} ({price_change_pct:.1%} from {entry:.4f})",
                      t["id"]))
                stopped += 1

        conn.commit()
    finally:
        conn.close()

    if stopped > 0:
        log(f"STOP-LOSS: Exited {stopped} positions (>{STOP_LOSS_PCT:.0%} adverse movement)")'''

    new_stop_loss = '''def _get_stop_loss_pct(entry_price):
    """Tiered stop-loss: wider threshold for cheaper assets.
    - >= $0.50 entry: 30% stop (standard)
    - $0.20-$0.50 entry: 50% stop (moderate)
    - $0.10-$0.20 entry: 60% stop (loose)
    - < $0.10 entry: no stop-loss (binary bet — runs to resolution)
    """
    if entry_price >= 0.50:
        return 0.30
    elif entry_price >= 0.20:
        return 0.50
    elif entry_price >= 0.10:
        return 0.60
    else:
        return None  # No stop-loss for extreme longshots


MIN_HOLD_HOURS = 6  # Don't trigger stop-loss within first 6 hours


def check_stop_losses():
    """Check open positions for tiered stop-loss exits with minimum hold period."""
    conn = db()
    now = datetime.now(timezone.utc)
    try:
        open_trades = conn.execute(
            "SELECT id, condition_id, side, entry_price, shares, strategy, question, opened_at "
            "FROM trades WHERE status = 'OPEN'"
        ).fetchall()

        if not open_trades:
            return

        # Load market prices from cache using shared helper
        price_map, cache_age = _load_price_map()

        stopped = 0
        skipped_hold = 0
        skipped_no_stop = 0
        for t in open_trades:
            entry = t["entry_price"]
            if entry <= 0:
                continue

            # Minimum hold period: skip trades opened less than 6h ago
            opened_at_str = t["opened_at"]
            if opened_at_str:
                try:
                    opened_dt = datetime.fromisoformat(opened_at_str)
                    if (now - opened_dt).total_seconds() < MIN_HOLD_HOURS * 3600:
                        skipped_hold += 1
                        continue  # Let the trade breathe
                except (ValueError, TypeError):
                    pass  # If we can't parse, proceed with stop-loss check

            # Tiered stop-loss threshold based on entry price
            stop_pct = _get_stop_loss_pct(entry)
            if stop_pct is None:
                skipped_no_stop += 1
                continue  # No stop-loss for very cheap assets — binary bets

            current_price = price_map.get((t["condition_id"], t["side"]))
            if current_price is None:
                continue  # No price data available

            # Calculate adverse movement
            price_change_pct = (current_price - entry) / entry

            if price_change_pct <= -stop_pct:
                pnl = (current_price - entry) * t["shares"]
                pnl_pct = price_change_pct * 100
                now_ts = now.isoformat()

                conn.execute("""
                    UPDATE trades SET exit_price=?, pnl=?, pnl_pct=?,
                                     status='STOPPED', resolved_outcome='STOP_LOSS',
                                     closed_at=?, notes=?
                    WHERE id=?
                """, (current_price, pnl, pnl_pct, now_ts,
                      f"Stop-loss at {current_price:.4f} ({price_change_pct:.1%} from {entry:.4f}, threshold={stop_pct:.0%})",
                      t["id"]))
                stopped += 1

        conn.commit()
    finally:
        conn.close()

    parts = []
    if stopped > 0:
        parts.append(f"exited {stopped}")
    if skipped_hold > 0:
        parts.append(f"hold-period skip {skipped_hold}")
    if skipped_no_stop > 0:
        parts.append(f"no-stop (cheap) {skipped_no_stop}")
    if parts:
        log(f"STOP-LOSS: {', '.join(parts)}")'''

    if old_stop_loss in content:
        content = content.replace(old_stop_loss, new_stop_loss)
        print("OK: Stop-loss function replaced with tiered + hold period version")
    else:
        print("WARNING: Could not find exact stop-loss function to replace!")
        print("  Will need manual patching.")

    # ═══════════════════════════════════════════════════════════
    # Verify changes
    # ═══════════════════════════════════════════════════════════

    changes = 0
    checks = [
        ('DEDUP_MINUTES = 120', 'Dedup window → 120 min'),
        ('MAX_HORIZON_HOURS = 48', 'Horizon → 48h'),
        ('MAX_MARKETS_PER_CYCLE = 3000', 'Market cap → 3000'),
        ('MAX_SCAN_PAGES = 100', 'Scan pages → 100'),
        ('"min_volume": 5000', 'momentum_cheap volume → 5000'),
        ('"max_price": 0.92', 'Favorites max_price → 0.92'),
        ('RANDOM_CONTROL_RATE = 20', 'Random control → 1-in-20'),
        ('stale_cutoff = now - timedelta(hours=24)', 'Stale cutoff → 24h'),
        ('_get_stop_loss_pct', 'Tiered stop-loss function'),
        ('MIN_HOLD_HOURS = 6', 'Minimum hold period'),
    ]

    for needle, label in checks:
        if needle in content:
            print(f"  OK: {label}")
            changes += 1
        else:
            print(f"  MISSING: {label}")

    # Write patched file
    with open(filepath, 'w') as f:
        f.write(content)

    print(f"\nApplied {changes}/10 changes to {filepath}")
    return changes


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python3 apply_rd_tuning.py /opt/polybot/rd/rd_trader_v3.py")
        sys.exit(1)
    result = apply_patch(sys.argv[1])
    if result < 10:
        print("\nWARNING: Not all changes applied. Review output above.")
        sys.exit(1)
    else:
        print("\nAll changes applied successfully.")
