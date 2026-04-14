#!/usr/bin/env python3
"""Scan the full Polymarket leaderboard for high-WR wallets."""

import json
import urllib.request
import time
import sqlite3
import sys

DB_PATH = '/opt/polybot-v3/data/polybot.db'
BASE = 'https://data-api.polymarket.com/v1/leaderboard'
POS_URL = 'https://data-api.polymarket.com/positions'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (compatible; polybot-v3/1.0)',
    'Accept': 'application/json',
}

MIN_PNL = 100       # only scan wallets with PnL > $100
MIN_SETTLED = 20     # need at least 20 settled to be meaningful
WIN_RATE_THRESH = 0.70

def fetch_json(url):
    req = urllib.request.Request(url, headers=HEADERS)
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def main():
    # Step 1: Pull full leaderboard
    all_wallets = {}
    offset = 0
    batch_size = 500
    while True:
        url = f'{BASE}?limit={batch_size}&offset={offset}'
        try:
            data = fetch_json(url)
            if not isinstance(data, list) or len(data) == 0:
                break
            for entry in data:
                wallet = (entry.get('proxyWallet') or '').lower()
                if wallet and wallet.startswith('0x'):
                    all_wallets[wallet] = {
                        'pseudonym': entry.get('userName'),
                        'rank': int(entry.get('rank', 0)),
                        'pnl': float(entry.get('pnl', 0) or 0),
                        'volume': float(entry.get('vol', 0) or 0),
                    }
            print(f'  offset={offset}: got {len(data)}, total unique: {len(all_wallets)}', flush=True)
            offset += batch_size
            if len(data) < batch_size:
                break
            time.sleep(0.5)
        except Exception as e:
            print(f'  FAILED at offset={offset}: {e}', flush=True)
            break

    print(f'\nTotal wallets from leaderboard: {len(all_wallets)}', flush=True)

    # Step 2: Upsert all candidates into DB
    db = sqlite3.connect(DB_PATH)
    now = int(time.time() * 1000)
    for wallet, info in all_wallets.items():
        db.execute(
            '''INSERT INTO smart_money_candidates
               (proxy_wallet, pseudonym, weekly_profit_usd, all_time_pnl_usd,
                total_volume_usd, first_seen_at, last_seen_at, status)
             VALUES (?, ?, 0, ?, ?, ?, ?, 'candidate')
             ON CONFLICT(proxy_wallet) DO UPDATE SET
               pseudonym = COALESCE(excluded.pseudonym, smart_money_candidates.pseudonym),
               all_time_pnl_usd = excluded.all_time_pnl_usd,
               total_volume_usd = excluded.total_volume_usd,
               last_seen_at = excluded.last_seen_at''',
            (wallet, info['pseudonym'], info['pnl'], info['volume'], now, now)
        )
    db.commit()
    print(f'Upserted {len(all_wallets)} candidates', flush=True)

    # Step 3: Scan positions for win rate on high-PnL wallets
    high_pnl = [(w, i) for w, i in all_wallets.items() if i['pnl'] > MIN_PNL]
    print(f'Wallets with PnL > ${MIN_PNL}: {len(high_pnl)}', flush=True)

    winners = []
    scanned = 0
    errors = 0

    for wallet, info in high_pnl:
        scanned += 1
        if scanned % 50 == 0:
            print(f'  scanned {scanned}/{len(high_pnl)}...', flush=True)

        try:
            url = f'{POS_URL}?user={wallet}&sizeThreshold=0.01&limit=500'
            positions = fetch_json(url)
            if not isinstance(positions, list):
                continue

            settled = [p for p in positions if abs(float(p.get('cashPnl', 0) or 0)) > 0.001]
            wins = sum(1 for p in settled if float(p.get('cashPnl', 0) or 0) > 0)
            n = len(settled)
            wr = wins / n if n > 0 else 0

            cats = set()
            for p in positions:
                slug = (p.get('slug') or '').split('-')[0]
                if slug:
                    cats.add(slug)

            # Check sizing uniformity
            uniform = False
            values = [float(p.get('initialValue', 0) or 0) for p in settled if float(p.get('initialValue', 0) or 0) > 0]
            if len(values) >= 10:
                mean = sum(values) / len(values)
                variance = sum((v - mean) ** 2 for v in values) / len(values)
                std = variance ** 0.5
                cv = std / mean if mean > 0 else 0
                uniform = cv < 0.1

            db.execute(
                '''UPDATE smart_money_candidates
                   SET settled_markets = ?, win_rate = ?, category_count = ?,
                       uniform_sizing = ?, last_filter_run_at = ?
                   WHERE proxy_wallet = ?''',
                (n, wr, len(cats), 1 if uniform else 0, now, wallet)
            )

            if wr >= WIN_RATE_THRESH and n >= MIN_SETTLED:
                winners.append({
                    'wallet': wallet,
                    'name': info['pseudonym'],
                    'rank': info['rank'],
                    'pnl': info['pnl'],
                    'volume': info['volume'],
                    'settled': n,
                    'wins': wins,
                    'wr': wr,
                    'cats': len(cats),
                    'uniform': uniform,
                })

            time.sleep(0.3)
        except Exception as e:
            errors += 1
            if errors < 10:
                print(f'  error on {wallet[:14]}: {e}', flush=True)

    db.commit()
    db.close()

    print(f'\nScan complete: {scanned} wallets, {errors} errors', flush=True)
    print(f'Wallets with WR >= {WIN_RATE_THRESH*100:.0f}% and n >= {MIN_SETTLED}: {len(winners)}', flush=True)

    winners.sort(key=lambda x: -x['pnl'])

    print(f'\n{"="*110}')
    print(f'TOP WALLETS (WR >= 70%, n >= 20, sorted by PnL)')
    print(f'{"="*110}')
    print(f'{"#":>3} {"Rank":>5} {"Name":20} {"PnL":>12} {"Vol":>12} {"N":>6} {"Wins":>6} {"WR":>6} {"Cats":>5} {"Unif":>5} Wallet')
    print(f'{"-"*110}')
    for i, w in enumerate(winners[:50], 1):
        name = (w['name'] or '-')[:20]
        pnl_str = f"${w['pnl']:,.0f}"
        vol_str = f"${w['volume']:,.0f}"
        wr_str = f"{w['wr']*100:.1f}%"
        unif_str = 'YES' if w['uniform'] else 'no'
        print(f'{i:3d} {w["rank"]:5d} {name:20} {pnl_str:>12} {vol_str:>12} {w["settled"]:6d} {w["wins"]:6d} {wr_str:>6} {w["cats"]:5d} {unif_str:>5} {w["wallet"]}')

    print(f'\n{"="*110}')
    print(f'TOP 20 FOR WHALE WHITELIST')
    print(f'{"="*110}')
    for i, w in enumerate(winners[:20], 1):
        name = (w['name'] or '-')[:20]
        print(f'{i:2d}. {w["wallet"]}  {name:20}  PnL=${w["pnl"]:>10,.0f}  WR={w["wr"]*100:.1f}%  n={w["settled"]}  cats={w["cats"]}  uniform={w["uniform"]}')


if __name__ == '__main__':
    main()
