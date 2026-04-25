#!/usr/bin/env python3
"""
tax-export.py — IRS Form 8949-style realized gain/loss export for Polybot V3.

Walks the trades + resolutions tables, performs FIFO lot-matching per
(entity_slug, condition_id, token_id), and emits Form 8949-shaped CSV rows
with per-lot proceeds, cost basis, gain/loss, and holding period.

Classification caveat: this script does NOT decide whether prediction-market
P&L should be reported as capital gains (Form 8949), gambling income
(Schedule 1), or hobby income. That is a CPA decision. See the README.

Usage:
    python3 tax-export.py [--db PATH] [--entity SLUG] [--year YYYY]
                          [--quarter Q1|Q2|Q3|Q4] [--include-paper]
                          [--out FILE.csv] [--summary]
"""
from __future__ import annotations

import argparse
import csv
import sqlite3
import sys
from collections import defaultdict, deque
from datetime import datetime, timezone
from typing import Iterable

DEFAULT_DB = "/opt/polybot-v3/data/polybot.db"


def parse_iso(ts: str) -> datetime:
    """Parse the various ISO-ish timestamp formats used in the DB."""
    if ts is None:
        raise ValueError("timestamp is None")
    s = ts.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError:
        dt = datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


def quarter_bounds(year: int, quarter):
    if quarter is None:
        start = datetime(year, 1, 1, tzinfo=timezone.utc)
        end = datetime(year + 1, 1, 1, tzinfo=timezone.utc)
        return start, end
    q = quarter.upper()
    starts = {"Q1": (1, 1), "Q2": (4, 1), "Q3": (7, 1), "Q4": (10, 1)}
    ends = {"Q1": (4, 1), "Q2": (7, 1), "Q3": (10, 1), "Q4": (None, None)}
    if q not in starts:
        raise ValueError("invalid quarter: " + str(quarter))
    sm, sd = starts[q]
    em, ed = ends[q]
    start = datetime(year, sm, sd, tzinfo=timezone.utc)
    end = (
        datetime(year + 1, 1, 1, tzinfo=timezone.utc)
        if em is None
        else datetime(year, em, ed, tzinfo=timezone.utc)
    )
    return start, end


def holding_period(opened: datetime, closed: datetime) -> str:
    return "long" if (closed - opened).days > 365 else "short"


def fetch_trades(conn, entity, include_paper):
    sql = (
        "SELECT entity_slug, condition_id, token_id, side, size, price, "
        "usdc_size, fee_usdc, net_usdc, outcome, market_question, "
        "market_slug, timestamp_utc, is_paper "
        "FROM trades WHERE 1=1"
    )
    params = []
    if entity:
        sql += " AND entity_slug = ?"
        params.append(entity)
    if not include_paper:
        sql += " AND is_paper = 0"
    sql += " ORDER BY timestamp ASC, id ASC"
    return conn.execute(sql, params).fetchall()


def fetch_resolutions(conn, entity, include_paper):
    sql = (
        "SELECT entity_slug, condition_id, token_id, position_side, size, "
        "payout_usdc, cost_basis_usdc, sell_proceeds_usdc, realized_pnl, "
        "market_question, market_slug, resolved_at, is_paper "
        "FROM resolutions WHERE 1=1"
    )
    params = []
    if entity:
        sql += " AND entity_slug = ?"
        params.append(entity)
    if not include_paper:
        sql += " AND is_paper = 0"
    sql += " ORDER BY resolved_at ASC, id ASC"
    return conn.execute(sql, params).fetchall()


class Lot:
    __slots__ = ("size_remaining", "price", "fee_per_share", "opened_at",
                 "outcome", "market_question", "market_slug")

    def __init__(self, size, price, fee_total, opened_at, outcome, mq, ms):
        self.size_remaining = size
        self.price = price
        self.fee_per_share = (fee_total / size) if size else 0.0
        self.opened_at = opened_at
        self.outcome = outcome
        self.market_question = mq
        self.market_slug = ms


def consume_lots(lot_q, sell_size, sell_proceeds, sell_fee_total,
                 closed_at, key, market_question, market_slug,
                 outcome_hint, warnings):
    """FIFO-consume lots to match sell_size; yield Form 8949 row dicts."""
    if sell_size <= 0:
        return
    price_per_share = sell_proceeds / sell_size if sell_size else 0.0
    fee_per_share_sell = sell_fee_total / sell_size if sell_size else 0.0
    remaining = sell_size

    while remaining > 1e-9:
        if not lot_q:
            warnings.append(
                "orphan SELL: " + repr(key) + " sold " +
                "{:.4f}".format(remaining) + " shares with no matching BUY at " +
                closed_at.isoformat()
            )
            return
        lot = lot_q[0]
        take = min(lot.size_remaining, remaining)
        proceeds = take * price_per_share
        cost_basis = take * lot.price
        fees_buy = take * lot.fee_per_share
        fees_sell = take * fee_per_share_sell
        fees_total = fees_buy + fees_sell
        gain = proceeds - cost_basis - fees_total
        outcome = lot.outcome or outcome_hint or ""
        mq = lot.market_question or market_question or ""
        ms = lot.market_slug or market_slug or ""
        desc = "{:.4f} {} shares".format(take, outcome).strip()
        if mq:
            desc = desc + " - " + mq
        yield {
            "description": desc,
            "date_acquired": lot.opened_at.date().isoformat(),
            "date_sold": closed_at.date().isoformat(),
            "proceeds": round(proceeds, 6),
            "cost_basis": round(cost_basis, 6),
            "gain_loss": round(gain, 6),
            "holding_period": holding_period(lot.opened_at, closed_at),
            "entity_slug": key[0],
            "market_slug": ms,
            "condition_id": key[1],
            "token_id": key[2],
            "fees_total": round(fees_total, 6),
        }
        lot.size_remaining -= take
        remaining -= take
        if lot.size_remaining <= 1e-9:
            lot_q.popleft()


def build_rows(conn, entity, include_paper, period_start, period_end):
    """Returns (rows, warnings). FIFO walks trades + synthesized resolution sells."""
    trades = fetch_trades(conn, entity, include_paper)
    resolutions = fetch_resolutions(conn, entity, include_paper)

    events = defaultdict(list)

    for r in trades:
        (e, cid, tid, side, size, price, usdc_size, fee, net, outcome,
         mq, ms, ts, is_paper) = r
        events[(e, cid, tid)].append(
            ("TRADE", parse_iso(ts), side, float(size), float(price),
             float(usdc_size), float(fee or 0.0), outcome, mq, ms)
        )

    for r in resolutions:
        (e, cid, tid, side, size, payout, cb, sell_proc, rpnl,
         mq, ms, resolved_at, is_paper) = r
        if not size or size <= 0:
            continue
        events[(e, cid, tid)].append(
            ("RESOLUTION", parse_iso(resolved_at), side, float(size),
             float(payout or 0.0), float(cb or 0.0),
             float(sell_proc or 0.0), float(rpnl or 0.0), mq, ms)
        )

    rows = []
    warnings = []

    for key, ev_list in events.items():
        ev_list.sort(key=lambda x: x[1])
        lot_q = deque()
        for ev in ev_list:
            kind = ev[0]
            ts = ev[1]
            if kind == "TRADE":
                _, ts, side, size, price, usdc_size, fee, outcome, mq, ms = ev
                if side == "BUY":
                    lot_q.append(Lot(size, price, fee, ts, outcome, mq, ms))
                else:
                    in_window = (period_start <= ts < period_end)
                    gen = consume_lots(
                        lot_q, size, usdc_size, fee, ts, key,
                        mq, ms, outcome or "", warnings,
                    )
                    if in_window:
                        rows.extend(gen)
                    else:
                        # consume to keep FIFO state correct, drop output
                        for _row in gen:
                            pass
            else:  # RESOLUTION
                _, ts, pos_side, size, payout, cb, sell_proc, rpnl, mq, ms = ev
                held = sum(l.size_remaining for l in lot_q)
                if held <= 1e-9:
                    continue
                consume_size = min(held, size)
                if size > 0:
                    proceeds_for_consumed = payout * (consume_size / size)
                else:
                    proceeds_for_consumed = 0.0
                in_window = (period_start <= ts < period_end)
                gen = consume_lots(
                    lot_q, consume_size, proceeds_for_consumed, 0.0,
                    ts, key, mq, ms, pos_side or "", warnings,
                )
                if in_window:
                    rows.extend(gen)
                else:
                    for _row in gen:
                        pass
                if size - consume_size > 1e-6:
                    warnings.append(
                        "resolution > tracked lots for " + repr(key) +
                        ": resolution.size=" + "{:.4f}".format(size) +
                        ", tracked=" + "{:.4f}".format(consume_size)
                    )

    return rows, warnings


def main():
    p = argparse.ArgumentParser(description="Polybot V3 Form 8949-style tax export")
    p.add_argument("--db", default=DEFAULT_DB)
    p.add_argument("--entity", default=None, help="entity_slug filter (default: all)")
    p.add_argument("--year", type=int, default=datetime.now(timezone.utc).year)
    p.add_argument("--quarter", choices=["Q1", "Q2", "Q3", "Q4"], default=None)
    p.add_argument("--include-paper", action="store_true",
                   help="include is_paper=1 rows (default: exclude)")
    p.add_argument("--out", default="-", help="output CSV path (default: stdout)")
    p.add_argument("--summary", action="store_true",
                   help="print aggregate summary to stderr")
    args = p.parse_args()

    period_start, period_end = quarter_bounds(args.year, args.quarter)

    conn = sqlite3.connect(args.db)
    try:
        rows, warnings = build_rows(
            conn, args.entity, args.include_paper, period_start, period_end
        )
    finally:
        conn.close()

    for w in warnings:
        print("WARN: " + w, file=sys.stderr)

    fieldnames = [
        "description", "date_acquired", "date_sold", "proceeds",
        "cost_basis", "gain_loss", "holding_period", "entity_slug",
        "market_slug", "condition_id", "token_id", "fees_total",
    ]
    if args.out == "-":
        out_fh = sys.stdout
        close_fh = False
    else:
        out_fh = open(args.out, "w", newline="", encoding="utf-8")
        close_fh = True
    try:
        wr = csv.DictWriter(out_fh, fieldnames=fieldnames)
        wr.writeheader()
        for r in rows:
            wr.writerow(r)
    finally:
        if close_fh:
            out_fh.close()

    if args.summary:
        total_proc = sum(r["proceeds"] for r in rows)
        total_cb = sum(r["cost_basis"] for r in rows)
        total_gl = sum(r["gain_loss"] for r in rows)
        total_fees = sum(r["fees_total"] for r in rows)
        n_short = sum(1 for r in rows if r["holding_period"] == "short")
        n_long = sum(1 for r in rows if r["holding_period"] == "long")
        n_orphan = sum(1 for w_ in warnings if "orphan" in w_)
        print("", file=sys.stderr)
        print("=== SUMMARY ===", file=sys.stderr)
        print("  period           : {} to {}".format(period_start.date(), period_end.date()), file=sys.stderr)
        print("  entity           : {}".format(args.entity or "ALL"), file=sys.stderr)
        print("  include_paper    : {}".format(args.include_paper), file=sys.stderr)
        print("  rows             : {}".format(len(rows)), file=sys.stderr)
        print("  short-term lots  : {}".format(n_short), file=sys.stderr)
        print("  long-term lots   : {}".format(n_long), file=sys.stderr)
        print("  total proceeds   : ${:,.4f}".format(total_proc), file=sys.stderr)
        print("  total cost basis : ${:,.4f}".format(total_cb), file=sys.stderr)
        print("  total fees       : ${:,.4f}".format(total_fees), file=sys.stderr)
        print("  realized gain/loss: ${:,.4f}".format(total_gl), file=sys.stderr)
        print("  warnings         : {} (orphan SELLs: {})".format(len(warnings), n_orphan), file=sys.stderr)


if __name__ == "__main__":
    main()
