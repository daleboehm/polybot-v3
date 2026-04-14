#!/usr/bin/env python3
"""
Whale Consensus Scanner — fetches current open positions for all
whitelisted whales and finds markets where multiple whales hold
the same side. Outputs a probability-weighted consensus view.

Usage:
  python3 whale-consensus.py              # scan all active whales
  python3 whale-consensus.py --min-whales 3  # only show markets with 3+ whales

Runs against the live Polymarket Data API (read-only).
"""

import json
import urllib.request
import sqlite3
import time
import sys
from collections import defaultdict
from dataclasses import dataclass, field

DB = '/opt/polybot-v3/data/polybot.db'
POS_URL = 'https://data-api.polymarket.com/positions'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; polybot-v3/1.0)',
    'Accept': 'application/json',
}

MIN_WHALES = 2  # default: show markets with 2+ whales

@dataclass
class WhalePosition:
    wallet: str
    pseudonym: str
    side: str       # 'YES' or 'NO'
    size: float     # shares
    avg_price: float
    cur_price: float
    pnl: float
    copy_multiplier: float
    win_rate: float

@dataclass
class MarketConsensus:
    condition_id: str
    question: str
    slug: str
    positions: list = field(default_factory=list)
    yes_count: int = 0
    no_count: int = 0
    total_size_usd: float = 0
    weighted_conviction: float = 0  # WR-weighted directional conviction

def fetch_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main():
    min_whales = MIN_WHALES
    if '--min-whales' in sys.argv:
        idx = sys.argv.index('--min-whales')
        min_whales = int(sys.argv[idx + 1])

    # Load active whales from DB
    db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
    whales = db.execute(
        '''SELECT w.proxy_wallet, w.pseudonym, w.copy_multiplier,
                  COALESCE(c.win_rate, 0) as win_rate,
                  COALESCE(c.all_time_pnl_usd, 0) as pnl
           FROM whitelisted_whales w
           LEFT JOIN smart_money_candidates c ON c.proxy_wallet = w.proxy_wallet
           WHERE w.active = 1
           ORDER BY c.all_time_pnl_usd DESC'''
    ).fetchall()
    db.close()

    print(f'Scanning {len(whales)} whitelisted whales for position consensus...\n')

    # Market -> list of whale positions
    markets = defaultdict(lambda: MarketConsensus('', '', ''))
    errors = 0

    for i, (wallet, name, mult, wr, pnl) in enumerate(whales):
        label = (name or wallet[:14])[:20]
        try:
            url = f'{POS_URL}?user={wallet}&sizeThreshold=0.01&limit=500'
            positions = fetch_json(url)
            if not isinstance(positions, list):
                continue

            # Filter to active (non-zero size) positions
            active = [p for p in positions if abs(float(p.get('size', 0) or 0)) > 0.1]
            print(f'  [{i+1}/{len(whales)}] {label:20} — {len(active)} active positions', flush=True)

            for p in active:
                cond = p.get('conditionId') or p.get('condition_id') or ''
                if not cond:
                    continue

                size = float(p.get('size', 0) or 0)
                avg = float(p.get('avgPrice', 0) or 0)
                cur = float(p.get('curPrice', 0) or 0)
                cash_pnl = float(p.get('cashPnl', 0) or 0)
                outcome = p.get('outcome', 'Yes')
                question = p.get('title') or p.get('question') or ''
                slug = p.get('slug') or ''

                side = 'YES' if outcome.upper() in ('YES', 'Y') else 'NO'

                if cond not in markets or not markets[cond].condition_id:
                    markets[cond] = MarketConsensus(
                        condition_id=cond,
                        question=question[:100],
                        slug=slug[:60],
                    )

                mc = markets[cond]
                # Update question if we got a better one
                if question and not mc.question:
                    mc.question = question[:100]

                mc.positions.append(WhalePosition(
                    wallet=wallet,
                    pseudonym=name or wallet[:14],
                    side=side,
                    size=size,
                    avg_price=avg,
                    cur_price=cur,
                    pnl=cash_pnl,
                    copy_multiplier=mult,
                    win_rate=wr,
                ))

            time.sleep(0.3)
        except Exception as e:
            errors += 1
            if errors < 5:
                print(f'  ERROR: {label}: {e}', flush=True)

    # Compute consensus metrics
    consensus_markets = []
    for cond_id, mc in markets.items():
        yes_whales = [p for p in mc.positions if p.side == 'YES']
        no_whales = [p for p in mc.positions if p.side == 'NO']
        mc.yes_count = len(yes_whales)
        mc.no_count = len(no_whales)

        total_whales = mc.yes_count + mc.no_count
        if total_whales < min_whales:
            continue

        # Total USD exposure
        mc.total_size_usd = sum(p.size * p.avg_price for p in mc.positions)

        # WR-weighted conviction: positive = YES consensus, negative = NO consensus
        # Each whale's vote is weighted by their win rate
        yes_weight = sum(p.win_rate * p.copy_multiplier for p in yes_whales)
        no_weight = sum(p.win_rate * p.copy_multiplier for p in no_whales)
        total_weight = yes_weight + no_weight
        if total_weight > 0:
            mc.weighted_conviction = (yes_weight - no_weight) / total_weight
        else:
            mc.weighted_conviction = 0

        consensus_markets.append(mc)

    # Sort by total whale count, then by absolute conviction
    consensus_markets.sort(key=lambda m: (-len(m.positions), -abs(m.weighted_conviction)))

    # Output
    print(f'\n{"="*120}')
    print(f'WHALE CONSENSUS REPORT — {len(consensus_markets)} markets with {min_whales}+ whales')
    print(f'{"="*120}')

    # Summary: unanimous markets first
    unanimous = [m for m in consensus_markets if m.yes_count == 0 or m.no_count == 0]
    split = [m for m in consensus_markets if m.yes_count > 0 and m.no_count > 0]

    if unanimous:
        print(f'\n--- UNANIMOUS CONSENSUS ({len(unanimous)} markets) ---')
        print(f'{"#":>3} {"Whales":>6} {"Side":>4} {"Conv":>6} {"USD":>10} {"Question":<70}')
        print(f'{"-"*110}')
        for i, m in enumerate(unanimous, 1):
            side = 'YES' if m.yes_count > 0 else 'NO'
            total = m.yes_count + m.no_count
            conv = f'{m.weighted_conviction*100:+.0f}%'
            usd = f'${m.total_size_usd:,.0f}'
            q = (m.question or m.slug or m.condition_id[:20])[:70]
            print(f'{i:3d} {total:6d} {side:>4} {conv:>6} {usd:>10} {q}')

            # Show individual whales
            for p in sorted(m.positions, key=lambda x: -x.size * x.avg_price):
                nm = p.pseudonym[:16]
                sz = f'{p.size:.1f}'
                pr = f'@{p.avg_price:.2f}'
                wr = f'WR={p.win_rate*100:.0f}%'
                pnl_str = f'PnL={p.pnl:+.2f}'
                print(f'       {nm:16} {p.side:>3} {sz:>8}sh {pr:>6} {wr:>7} {pnl_str:>12}')

    if split:
        print(f'\n--- SPLIT CONSENSUS ({len(split)} markets — whales disagree) ---')
        print(f'{"#":>3} {"Y":>3}/{"N":<3} {"Conv":>6} {"USD":>10} {"Question":<70}')
        print(f'{"-"*110}')
        for i, m in enumerate(split, 1):
            conv = f'{m.weighted_conviction*100:+.0f}%'
            usd = f'${m.total_size_usd:,.0f}'
            q = (m.question or m.slug or m.condition_id[:20])[:70]
            print(f'{i:3d} {m.yes_count:3d}/{m.no_count:<3d} {conv:>6} {usd:>10} {q}')

            for p in sorted(m.positions, key=lambda x: (-1 if x.side == 'YES' else 1, -x.size * x.avg_price)):
                nm = p.pseudonym[:16]
                sz = f'{p.size:.1f}'
                pr = f'@{p.avg_price:.2f}'
                wr = f'WR={p.win_rate*100:.0f}%'
                pnl_str = f'PnL={p.pnl:+.2f}'
                print(f'       {nm:16} {p.side:>3} {sz:>8}sh {pr:>6} {wr:>7} {pnl_str:>12}')

    # Top-line summary
    print(f'\n{"="*120}')
    print(f'SUMMARY:')
    print(f'  Whales scanned: {len(whales)}')
    print(f'  Unique markets with positions: {len(markets)}')
    print(f'  Markets with {min_whales}+ whales: {len(consensus_markets)}')
    print(f'  Unanimous consensus: {len(unanimous)}')
    print(f'  Split (whales disagree): {len(split)}')
    print(f'  Errors: {errors}')

    # Probability balance: which side has more high-WR whales?
    if consensus_markets:
        all_yes_wr = [p.win_rate for m in consensus_markets for p in m.positions if p.side == 'YES']
        all_no_wr = [p.win_rate for m in consensus_markets for p in m.positions if p.side == 'NO']
        avg_yes_wr = sum(all_yes_wr) / len(all_yes_wr) if all_yes_wr else 0
        avg_no_wr = sum(all_no_wr) / len(all_no_wr) if all_no_wr else 0
        print(f'  Avg WR of YES-side whales: {avg_yes_wr*100:.1f}%')
        print(f'  Avg WR of NO-side whales: {avg_no_wr*100:.1f}%')
    print(f'{"="*120}')


if __name__ == '__main__':
    main()
