#!/usr/bin/env python3
"""Open book / unrealized position report."""
import sqlite3

db = sqlite3.connect("rd_ledger.db")
db.row_factory = sqlite3.Row

r = db.execute("""
    SELECT COUNT(*) as trades,
           ROUND(SUM(size_usd), 2) as total_volume,
           ROUND(SUM(CASE WHEN last_mtm_price IS NOT NULL THEN (last_mtm_price - entry_price) * shares ELSE 0 END), 2) as unrealized_pnl,
           COUNT(DISTINCT condition_id) as unique_markets
    FROM trades WHERE status='OPEN'
""").fetchone()
print("=" * 70)
print("  OPEN BOOK SUMMARY")
print("=" * 70)
print(f"  Open trades:       {r['trades']:>12,}")
print(f"  Unique markets:    {r['unique_markets']:>12,}")
print(f"  Notional volume:   ${r['total_volume']:>14,.2f}")
print(f"  Unrealized P&L:    ${r['unrealized_pnl']:>14,.2f}")

hdr = f"  {'Strategy':20s} | {'Trades':>8s} | {'Volume ($)':>14s} | {'Unrealized ($)':>14s} | {'Avg Entry':>9s} | {'Avg MTM':>9s}"
sep = "  " + "-" * (len(hdr) - 2)
print(f"\n{hdr}\n{sep}")
for r in db.execute("""
    SELECT strategy, COUNT(*) as trades,
           ROUND(SUM(size_usd), 2) as volume,
           ROUND(SUM(CASE WHEN last_mtm_price IS NOT NULL THEN (last_mtm_price - entry_price) * shares ELSE 0 END), 2) as unrealized,
           ROUND(AVG(entry_price), 4) as avg_entry,
           ROUND(AVG(last_mtm_price), 4) as avg_mtm
    FROM trades WHERE status='OPEN'
    GROUP BY strategy ORDER BY volume DESC
""").fetchall():
    mtm = r['avg_mtm'] if r['avg_mtm'] else 0
    print(f"  {r['strategy']:20s} | {r['trades']:>8,} | ${r['volume']:>12,.2f} | ${r['unrealized']:>12,.2f} | {r['avg_entry']:>9.4f} | {mtm:>9.4f}")

hdr2 = f"\n  {'Category':20s} | {'Trades':>8s} | {'Volume ($)':>14s} | {'Unrealized ($)':>14s}"
sep2 = "  " + "-" * (len(hdr2.strip()) - 2)
print(f"{hdr2}\n{sep2}")
for r in db.execute("""
    SELECT category, COUNT(*) as trades,
           ROUND(SUM(size_usd), 2) as volume,
           ROUND(SUM(CASE WHEN last_mtm_price IS NOT NULL THEN (last_mtm_price - entry_price) * shares ELSE 0 END), 2) as unrealized
    FROM trades WHERE status='OPEN'
    GROUP BY category ORDER BY volume DESC
""").fetchall():
    print(f"  {r['category']:20s} | {r['trades']:>8,} | ${r['volume']:>12,.2f} | ${r['unrealized']:>12,.2f}")

print(f"\n  ENTRY PRICE DISTRIBUTION (Open Trades)")
print(f"  {'Bucket':15s} | {'Trades':>8s} | {'Volume ($)':>14s} | {'Unrealized ($)':>14s}")
print("  " + "-" * 60)
for r in db.execute("""
    SELECT
        CASE
            WHEN entry_price < 0.05 THEN 'A: <$0.05'
            WHEN entry_price < 0.10 THEN 'B: $0.05-0.10'
            WHEN entry_price < 0.20 THEN 'C: $0.10-0.20'
            WHEN entry_price < 0.50 THEN 'D: $0.20-0.50'
            WHEN entry_price < 0.80 THEN 'E: $0.50-0.80'
            WHEN entry_price < 0.95 THEN 'F: $0.80-0.95'
            ELSE 'G: $0.95+'
        END as bucket,
        COUNT(*) as trades,
        ROUND(SUM(size_usd), 2) as volume,
        ROUND(SUM(CASE WHEN last_mtm_price IS NOT NULL THEN (last_mtm_price - entry_price) * shares ELSE 0 END), 2) as unrealized
    FROM trades WHERE status='OPEN'
    GROUP BY bucket ORDER BY bucket
""").fetchall():
    print(f"  {r['bucket']:15s} | {r['trades']:>8,} | ${r['volume']:>12,.2f} | ${r['unrealized']:>12,.2f}")

print("\n" + "=" * 70)
db.close()
