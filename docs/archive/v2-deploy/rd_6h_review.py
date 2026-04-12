#!/usr/bin/env python3
"""
R&D 6-Hour Review Script
Runs on VPS, produces a structured report for decision-making.
Outputs JSON for programmatic consumption + human-readable summary.
"""
import sqlite3
import json
import sys
from datetime import datetime, timezone, timedelta

DB_PATH = "rd_ledger.db"

def run_review():
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    now = datetime.now(timezone.utc)
    six_hours_ago = (now - timedelta(hours=6)).isoformat()
    twelve_hours_ago = (now - timedelta(hours=12)).isoformat()

    report = {"timestamp": now.isoformat(), "window": "6h"}

    # ── 1. RESOLUTION FLOW ──
    total_resolved = db.execute("SELECT COUNT(*) FROM trades WHERE status IN ('WON','LOST')").fetchone()[0]
    recent_resolved = db.execute(
        "SELECT COUNT(*) FROM trades WHERE status IN ('WON','LOST') AND closed_at > ?",
        (six_hours_ago,)
    ).fetchone()[0]
    total_open = db.execute("SELECT COUNT(*) FROM trades WHERE status='OPEN'").fetchone()[0]
    total_stopped = db.execute("SELECT COUNT(*) FROM trades WHERE status='STOPPED'").fetchone()[0]

    report["resolutions"] = {
        "total_resolved": total_resolved,
        "resolved_last_6h": recent_resolved,
        "total_open": total_open,
        "total_stopped": total_stopped,
    }

    # ── 2. STRATEGY PERFORMANCE (Resolved Only) ──
    strat_perf = []
    rows = db.execute("""
        SELECT strategy,
               COUNT(*) as resolved,
               SUM(CASE WHEN status='WON' THEN 1 ELSE 0 END) as won,
               SUM(CASE WHEN status='LOST' THEN 1 ELSE 0 END) as lost,
               ROUND(SUM(pnl), 2) as net_pnl,
               ROUND(AVG(pnl), 4) as avg_pnl,
               ROUND(100.0 * SUM(CASE WHEN status='WON' THEN 1 ELSE 0 END) / COUNT(*), 1) as win_pct
        FROM trades WHERE status IN ('WON','LOST')
        GROUP BY strategy ORDER BY net_pnl DESC
    """).fetchall()
    for r in rows:
        strat_perf.append(dict(r))
    report["strategy_resolved"] = strat_perf

    # Random control baseline
    rc = next((s for s in strat_perf if s["strategy"] == "random_control"), None)
    rc_win_pct = rc["win_pct"] if rc else 0
    rc_avg_pnl = rc["avg_pnl"] if rc else 0
    report["random_control_baseline"] = {"win_pct": rc_win_pct, "avg_pnl": rc_avg_pnl}

    # ── 3. STRATEGY EDGE ASSESSMENT ──
    edge_assessment = []
    for s in strat_perf:
        if s["strategy"] == "random_control":
            continue
        edge = {
            "strategy": s["strategy"],
            "resolved": s["resolved"],
            "win_pct": s["win_pct"],
            "win_pct_vs_random": round(s["win_pct"] - rc_win_pct, 1),
            "avg_pnl": s["avg_pnl"],
            "avg_pnl_vs_random": round(s["avg_pnl"] - rc_avg_pnl, 4),
            "net_pnl": s["net_pnl"],
            "verdict": "INSUFFICIENT_DATA"
        }
        if s["resolved"] >= 50:
            if s["win_pct"] > rc_win_pct + 10 and s["net_pnl"] > 0:
                edge["verdict"] = "VALIDATED_EDGE"
            elif s["net_pnl"] > 0:
                edge["verdict"] = "POSITIVE_BUT_WEAK"
            elif s["win_pct"] < rc_win_pct and s["net_pnl"] < rc["net_pnl"]:
                edge["verdict"] = "UNDERPERFORMING_DISABLE"
            else:
                edge["verdict"] = "NEUTRAL"
        elif s["resolved"] >= 10:
            edge["verdict"] = "EARLY_SIGNAL"
        edge_assessment.append(edge)
    report["edge_assessment"] = edge_assessment

    # ── 4. STOP-LOSS HEALTH ──
    recent_stopped = db.execute(
        "SELECT COUNT(*) FROM trades WHERE status='STOPPED' AND closed_at > ?",
        (six_hours_ago,)
    ).fetchone()[0]

    stop_by_strategy = []
    rows = db.execute("""
        SELECT strategy,
               COUNT(*) as total,
               SUM(CASE WHEN status='STOPPED' THEN 1 ELSE 0 END) as stopped,
               ROUND(100.0 * SUM(CASE WHEN status='STOPPED' THEN 1 ELSE 0 END) / COUNT(*), 1) as stop_pct
        FROM trades
        GROUP BY strategy ORDER BY stop_pct DESC
    """).fetchall()
    for r in rows:
        stop_by_strategy.append(dict(r))

    # Recovery rate on stopped trades
    recovery = db.execute("""
        SELECT COUNT(*) as total,
               SUM(CASE WHEN last_mtm_price > entry_price THEN 1 ELSE 0 END) as recovered
        FROM trades WHERE status='STOPPED' AND last_mtm_price IS NOT NULL
    """).fetchone()
    recovery_pct = round(100.0 * recovery["recovered"] / recovery["total"], 1) if recovery["total"] > 0 else 0

    report["stop_loss"] = {
        "stopped_last_6h": recent_stopped,
        "total_stopped": total_stopped,
        "recovery_pct": recovery_pct,
        "by_strategy": stop_by_strategy,
    }

    # ── 5. TRADE VOLUME ──
    recent_trades = db.execute(
        "SELECT COUNT(*) FROM trades WHERE opened_at > ?", (six_hours_ago,)
    ).fetchone()[0]
    trades_12h = db.execute(
        "SELECT COUNT(*) FROM trades WHERE opened_at > ?", (twelve_hours_ago,)
    ).fetchone()[0]
    projected_daily = recent_trades * 4

    report["volume"] = {
        "trades_last_6h": recent_trades,
        "trades_last_12h": trades_12h,
        "projected_daily": projected_daily,
        "target_daily": "50000-100000",
    }

    # ── 6. UNREALIZED P&L TREND ──
    unrealized = db.execute("""
        SELECT strategy,
               COUNT(*) as open_trades,
               ROUND(SUM(CASE WHEN last_mtm_price IS NOT NULL
                         THEN (last_mtm_price - entry_price) * shares ELSE 0 END), 2) as unrealized_pnl
        FROM trades WHERE status='OPEN'
        GROUP BY strategy ORDER BY unrealized_pnl DESC
    """).fetchall()
    report["unrealized"] = [dict(r) for r in unrealized]
    report["total_unrealized"] = round(sum(r["unrealized_pnl"] for r in report["unrealized"]), 2)

    # ── 7. AUTO-ADJUSTMENT RECOMMENDATIONS ──
    recommendations = []

    # Check if resolutions are too low
    if total_resolved < 50 and recent_resolved < 10:
        recommendations.append({
            "action": "TIGHTEN_WINDOW",
            "detail": "Less than 50 total resolutions. Consider dropping MAX_HORIZON_HOURS from 48 to 24.",
            "severity": "HIGH",
            "auto": True,
            "param": "MAX_HORIZON_HOURS",
            "current": 48,
            "proposed": 24
        })

    # Check strategies underperforming random
    for e in edge_assessment:
        if e["verdict"] == "UNDERPERFORMING_DISABLE":
            recommendations.append({
                "action": "DISABLE_STRATEGY",
                "detail": f"{e['strategy']}: {e['resolved']} resolved, win%={e['win_pct']} vs random {rc_win_pct}%, net=${e['net_pnl']}",
                "severity": "MEDIUM",
                "auto": True,
                "strategy": e["strategy"]
            })

    # Check stop rate
    for s in stop_by_strategy:
        if s["stop_pct"] > 25 and s["stopped"] > 1000:
            recommendations.append({
                "action": "REVIEW_STOP_LOSS",
                "detail": f"{s['strategy']}: {s['stop_pct']}% stop rate ({s['stopped']} stopped)",
                "severity": "MEDIUM",
                "auto": False,
            })

    # Check recovery rate
    if recovery_pct > 30:
        recommendations.append({
            "action": "WIDEN_STOP_LOSS",
            "detail": f"{recovery_pct}% of stopped trades recovered past entry. Stop-loss may still be too aggressive.",
            "severity": "MEDIUM",
            "auto": False,
        })

    # Check volume
    if projected_daily > 100000:
        recommendations.append({
            "action": "REDUCE_VOLUME",
            "detail": f"Projected {projected_daily} trades/day exceeds 100K target. Increase DEDUP_MINUTES.",
            "severity": "LOW",
            "auto": True,
            "param": "DEDUP_MINUTES",
            "current": 120,
            "proposed": 180
        })

    # ── 8. CROSS-PLATFORM REFERENCE VALUE ──
    xref = _cross_platform_value(db, six_hours_ago)
    report["cross_platform_ref"] = xref

    # Add ref-based recommendations
    if xref["total_refs"] > 0 and xref["trade_overlap"]["ref_matched_conditions"] == 0:
        recommendations.append({
            "action": "INCREASE_REF_COVERAGE",
            "detail": f"0 trade conditions matched to cross-platform refs ({xref['total_refs']} refs across {xref['source_count']} sources). Run kalshi_reference.py --scan to refresh.",
            "severity": "LOW",
            "auto": False,
        })
    elif xref["trade_overlap"].get("ref_matched_resolved", 0) >= 20:
        matched_win = xref["trade_overlap"].get("ref_matched_win_pct", 0)
        unmatched_win = xref["trade_overlap"].get("unmatched_win_pct", 0)
        if matched_win > unmatched_win + 5:
            recommendations.append({
                "action": "PRIORITIZE_REF_MATCHED",
                "detail": f"Ref-matched trades win at {matched_win:.1f}% vs {unmatched_win:.1f}% unmatched. Consider weighting ref-confirmed markets higher.",
                "severity": "MEDIUM",
                "auto": False,
            })
        elif matched_win < unmatched_win - 5:
            recommendations.append({
                "action": "REVIEW_REF_QUALITY",
                "detail": f"Ref-matched trades underperform ({matched_win:.1f}% vs {unmatched_win:.1f}%). Cross-platform signals may be noise.",
                "severity": "MEDIUM",
                "auto": False,
            })

    report["recommendations"] = recommendations

    db.close()

    # ── OUTPUT ──
    # JSON for programmatic use
    with open("rd_6h_review.json", "w") as f:
        json.dump(report, f, indent=2, default=str)

    # Human-readable summary
    print("=" * 70)
    print(f"  R&D 6-HOUR REVIEW — {now.strftime('%Y-%m-%d %H:%M UTC')}")
    print("=" * 70)

    print(f"\n  RESOLUTIONS: {total_resolved} total ({recent_resolved} last 6h)")
    print(f"  OPEN: {total_open} | STOPPED: {total_stopped}")

    print(f"\n  STRATEGY PERFORMANCE (Resolved Trades):")
    print(f"  {'Strategy':20s} | {'Rslvd':>6s} | {'Win%':>6s} | {'Net P&L':>10s} | {'vs Random':>10s} | Verdict")
    print(f"  {'-'*20}-+-{'-'*6}-+-{'-'*6}-+-{'-'*10}-+-{'-'*10}-+-{'-'*20}")
    for e in edge_assessment:
        print(f"  {e['strategy']:20s} | {e['resolved']:6d} | {e['win_pct']:5.1f}% | ${e['net_pnl']:>9} | {e['win_pct_vs_random']:>+9.1f}% | {e['verdict']}")
    if rc:
        print(f"  {'random_control':20s} | {rc['resolved']:6d} | {rc['win_pct']:5.1f}% | ${rc['net_pnl']:>9} | {'BASELINE':>10s} |")

    print(f"\n  STOP-LOSS: {recent_stopped} stopped last 6h | Recovery rate: {recovery_pct}%")

    print(f"\n  VOLUME: {recent_trades} trades last 6h (projected {projected_daily}/day)")

    print(f"\n  UNREALIZED P&L: ${report['total_unrealized']:,.2f}")

    # Cross-platform reference section
    _print_xref_section(xref)

    if recommendations:
        print(f"\n  RECOMMENDATIONS ({len(recommendations)}):")
        for r in recommendations:
            auto = "[AUTO]" if r.get("auto") else "[MANUAL]"
            print(f"    {auto} {r['severity']}: {r['action']} — {r['detail']}")
    else:
        print(f"\n  RECOMMENDATIONS: None — all metrics within acceptable range")

    print("\n" + "=" * 70)

    return report


def _cross_platform_value(db, six_hours_ago):
    """Analyze how cross-platform reference data adds value to trading decisions."""

    # Check if table exists
    table_exists = db.execute(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='cross_platform_ref'"
    ).fetchone()[0]

    if not table_exists:
        return {
            "status": "NO_TABLE",
            "total_refs": 0,
            "source_count": 0,
            "sources": [],
            "trade_overlap": {"ref_matched_conditions": 0, "total_trade_conditions": 0, "coverage_pct": 0},
            "arb_signals": {"total": 0, "top_spreads": []},
            "value_assessment": "Cross-platform reference table not yet created. Run kalshi_reference.py --scan."
        }

    # Source-level stats
    source_rows = db.execute("""
        SELECT source,
               COUNT(*) as matches,
               ROUND(AVG(match_score), 3) as avg_match_quality,
               ROUND(MIN(match_score), 3) as min_match,
               ROUND(MAX(match_score), 3) as max_match,
               SUM(CASE WHEN arb_direction IS NOT NULL AND arb_direction != '' THEN 1 ELSE 0 END) as arb_signals,
               ROUND(AVG(CASE WHEN spread IS NOT NULL THEN ABS(spread) END), 4) as avg_spread
        FROM cross_platform_ref
        GROUP BY source ORDER BY matches DESC
    """).fetchall()

    sources = [dict(r) for r in source_rows]
    total_refs = sum(s["matches"] for s in sources)
    total_arbs = sum(s["arb_signals"] for s in sources)

    # Recent scan activity
    recent_refs = db.execute(
        "SELECT COUNT(*) FROM cross_platform_ref WHERE scanned_at > ?",
        (six_hours_ago,)
    ).fetchone()[0]

    last_scan = db.execute(
        "SELECT MAX(scanned_at) FROM cross_platform_ref"
    ).fetchone()[0]

    # Unique poly conditions with refs
    ref_conditions = db.execute(
        "SELECT COUNT(DISTINCT poly_condition_id) FROM cross_platform_ref"
    ).fetchone()[0]

    # Trade overlap: how many of our active trades have cross-platform coverage
    overlap = db.execute("""
        SELECT
            COUNT(DISTINCT t.condition_id) as total_trade_conditions,
            COUNT(DISTINCT CASE WHEN cr.poly_condition_id IS NOT NULL THEN t.condition_id END) as ref_matched
        FROM trades t
        LEFT JOIN (SELECT DISTINCT poly_condition_id FROM cross_platform_ref) cr
            ON t.condition_id = cr.poly_condition_id
        WHERE t.status = 'OPEN'
    """).fetchone()

    trade_conditions = overlap["total_trade_conditions"]
    ref_matched_conditions = overlap["ref_matched"]
    coverage_pct = round(100.0 * ref_matched_conditions / trade_conditions, 2) if trade_conditions > 0 else 0

    # Resolved trade comparison: ref-matched vs unmatched
    resolved_comparison = db.execute("""
        SELECT
            CASE WHEN cr.poly_condition_id IS NOT NULL THEN 'ref_matched' ELSE 'unmatched' END as grp,
            COUNT(*) as resolved,
            SUM(CASE WHEN t.status='WON' THEN 1 ELSE 0 END) as won,
            SUM(CASE WHEN t.status='LOST' THEN 1 ELSE 0 END) as lost,
            ROUND(SUM(t.pnl), 2) as net_pnl,
            ROUND(AVG(t.pnl), 4) as avg_pnl
        FROM trades t
        LEFT JOIN (SELECT DISTINCT poly_condition_id FROM cross_platform_ref) cr
            ON t.condition_id = cr.poly_condition_id
        WHERE t.status IN ('WON', 'LOST')
        GROUP BY grp
    """).fetchall()

    trade_overlap = {
        "total_trade_conditions": trade_conditions,
        "ref_matched_conditions": ref_matched_conditions,
        "coverage_pct": coverage_pct,
    }

    for row in resolved_comparison:
        r = dict(row)
        prefix = r["grp"]
        win_pct = round(100.0 * r["won"] / r["resolved"], 1) if r["resolved"] > 0 else 0
        trade_overlap[f"{prefix}_resolved"] = r["resolved"]
        trade_overlap[f"{prefix}_won"] = r["won"]
        trade_overlap[f"{prefix}_lost"] = r["lost"]
        trade_overlap[f"{prefix}_win_pct"] = win_pct
        trade_overlap[f"{prefix}_net_pnl"] = r["net_pnl"]
        trade_overlap[f"{prefix}_avg_pnl"] = r["avg_pnl"]

    # Unrealized P&L on ref-matched vs unmatched open trades
    unrealized_comparison = db.execute("""
        SELECT
            CASE WHEN cr.poly_condition_id IS NOT NULL THEN 'ref_matched' ELSE 'unmatched' END as grp,
            COUNT(*) as open_trades,
            ROUND(SUM(CASE WHEN t.last_mtm_price IS NOT NULL
                       THEN (t.last_mtm_price - t.entry_price) * t.shares ELSE 0 END), 2) as unrealized_pnl
        FROM trades t
        LEFT JOIN (SELECT DISTINCT poly_condition_id FROM cross_platform_ref) cr
            ON t.condition_id = cr.poly_condition_id
        WHERE t.status = 'OPEN'
        GROUP BY grp
    """).fetchall()

    for row in unrealized_comparison:
        r = dict(row)
        prefix = r["grp"]
        avg_unrealized = round(r["unrealized_pnl"] / r["open_trades"], 4) if r["open_trades"] > 0 else 0
        trade_overlap[f"{prefix}_open"] = r["open_trades"]
        trade_overlap[f"{prefix}_unrealized"] = r["unrealized_pnl"]
        trade_overlap[f"{prefix}_avg_unrealized"] = avg_unrealized

    # Arb signal quality: largest spreads by source
    top_arbs = db.execute("""
        SELECT source, poly_question, spread, arb_direction,
               source_yes_price, poly_yes_price, match_score
        FROM cross_platform_ref
        WHERE arb_direction IS NOT NULL AND arb_direction != ''
        ORDER BY ABS(spread) DESC
        LIMIT 5
    """).fetchall()

    arb_signals = {
        "total": total_arbs,
        "top_spreads": [dict(r) for r in top_arbs],
    }

    # Determine value assessment
    if total_refs == 0:
        value = "NO_DATA — Run kalshi_reference.py --scan to populate."
    elif ref_matched_conditions == 0:
        value = f"LOW_OVERLAP — {total_refs} refs across {len(sources)} sources but 0 match active trades. Need more scan cycles for coverage to build."
    elif ref_matched_conditions < 10:
        value = f"EARLY — {ref_matched_conditions} trade conditions have cross-platform coverage ({coverage_pct}%). Need more scan cycles for meaningful comparison."
    else:
        matched_resolved = trade_overlap.get("ref_matched_resolved", 0)
        if matched_resolved < 20:
            value = f"BUILDING — {ref_matched_conditions} covered conditions, {matched_resolved} resolved. Need 20+ resolved ref-matched trades for edge comparison."
        else:
            matched_win = trade_overlap.get("ref_matched_win_pct", 0)
            unmatched_win = trade_overlap.get("unmatched_win_pct", 0)
            delta = matched_win - unmatched_win
            if delta > 5:
                value = f"POSITIVE_EDGE — Ref-matched win at {matched_win:.1f}% vs {unmatched_win:.1f}% unmatched (+{delta:.1f}pp). Cross-platform consensus adds value."
            elif delta < -5:
                value = f"NEGATIVE — Ref-matched underperform ({matched_win:.1f}% vs {unmatched_win:.1f}%). Investigate whether arb signals are noise."
            else:
                value = f"NEUTRAL — {matched_win:.1f}% vs {unmatched_win:.1f}% (delta {delta:+.1f}pp). No clear edge from cross-platform data yet."

    return {
        "status": "ACTIVE",
        "total_refs": total_refs,
        "source_count": len(sources),
        "sources": sources,
        "recent_refs_6h": recent_refs,
        "last_scan": last_scan,
        "unique_poly_conditions": ref_conditions,
        "trade_overlap": trade_overlap,
        "arb_signals": arb_signals,
        "value_assessment": value,
    }


def _print_xref_section(xref):
    """Print cross-platform reference value section."""
    print(f"\n  CROSS-PLATFORM REFERENCE VALUE:")

    if xref["status"] == "NO_TABLE":
        print(f"    Not active — table not created yet. Run kalshi_reference.py --scan.")
        return

    if xref["total_refs"] == 0:
        print(f"    No data — run kalshi_reference.py --scan to populate.")
        return

    print(f"    Sources: {xref['source_count']} | Total refs: {xref['total_refs']} | Last scan: {xref['last_scan'] or 'never'}")
    print(f"    {'Source':15s} | {'Matches':>7s} | {'Avg Quality':>11s} | {'Arb Signals':>11s} | {'Avg Spread':>10s}")
    print(f"    {'-'*15}-+-{'-'*7}-+-{'-'*11}-+-{'-'*11}-+-{'-'*10}")
    for s in xref["sources"]:
        spread_str = f"{s['avg_spread']:.2%}" if s["avg_spread"] is not None else "n/a"
        print(f"    {s['source']:15s} | {s['matches']:7d} | {s['avg_match_quality']:10.3f}x | {s['arb_signals']:11d} | {spread_str:>10s}")

    ov = xref["trade_overlap"]
    print(f"\n    Trade Coverage: {ov['ref_matched_conditions']}/{ov['total_trade_conditions']} conditions ({ov['coverage_pct']}%)")

    # Show resolved comparison if data exists
    if ov.get("ref_matched_resolved", 0) > 0 or ov.get("unmatched_resolved", 0) > 0:
        print(f"    Resolved Performance:")
        if ov.get("ref_matched_resolved", 0) > 0:
            print(f"      Ref-matched: {ov['ref_matched_resolved']} resolved, "
                  f"{ov.get('ref_matched_win_pct', 0):.1f}% win, "
                  f"${ov.get('ref_matched_net_pnl', 0)} net P&L")
        if ov.get("unmatched_resolved", 0) > 0:
            print(f"      Unmatched:   {ov['unmatched_resolved']} resolved, "
                  f"{ov.get('unmatched_win_pct', 0):.1f}% win, "
                  f"${ov.get('unmatched_net_pnl', 0)} net P&L")

    # Show unrealized comparison
    if ov.get("ref_matched_open", 0) > 0:
        print(f"    Unrealized (Open Trades):")
        print(f"      Ref-matched: {ov['ref_matched_open']} trades, "
              f"${ov.get('ref_matched_unrealized', 0):,.2f} "
              f"(${ov.get('ref_matched_avg_unrealized', 0):.4f}/trade)")
        if ov.get("unmatched_open", 0) > 0:
            print(f"      Unmatched:   {ov['unmatched_open']} trades, "
                  f"${ov.get('unmatched_unrealized', 0):,.2f} "
                  f"(${ov.get('unmatched_avg_unrealized', 0):.4f}/trade)")

    # Top arb signals
    arbs = xref["arb_signals"]
    if arbs["total"] > 0 and arbs["top_spreads"]:
        print(f"\n    Top Arb Signals ({arbs['total']} total):")
        for a in arbs["top_spreads"][:3]:
            q = a["poly_question"][:50] + "..." if len(a["poly_question"]) > 50 else a["poly_question"]
            print(f"      {a['source']:12s} | spread={a['spread']:+.2%} | {a['arb_direction']} | {q}")

    print(f"\n    VALUE ASSESSMENT: {xref['value_assessment']}")


if __name__ == "__main__":
    run_review()
