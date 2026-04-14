#!/usr/bin/env python3
"""Scan wallet positions for win rate. Writes to temp DB to avoid WAL lock."""
import json
import urllib.request
import sqlite3
import time

DB = '/opt/polybot-v3/data/polybot.db'
TMP = '/tmp/scan_results.db'
H = {'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json'}

def fetch(url):
    req = urllib.request.Request(url, headers=H)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())

# Read-only from main DB
db = sqlite3.connect(f'file:{DB}?mode=ro', uri=True)
rows = db.execute(
    'SELECT proxy_wallet, all_time_pnl_usd, pseudonym '
    'FROM smart_money_candidates WHERE all_time_pnl_usd > 100 '
    'ORDER BY all_time_pnl_usd DESC'
).fetchall()
db.close()
print(f'Loaded {len(rows)} wallets', flush=True)

# Temp DB for results
tmp = sqlite3.connect(TMP)
tmp.execute('CREATE TABLE IF NOT EXISTS results (wallet TEXT PRIMARY KEY, name TEXT, pnl REAL, n INT, wins INT, wr REAL, cats INT)')
tmp.execute('DELETE FROM results')
tmp.commit()

winners = []
errs = 0
for i, (w, pnl, name) in enumerate(rows):
    if i % 100 == 0:
        print(f'  {i}/{len(rows)} scanned, {len(winners)} winners, {errs} err', flush=True)
        tmp.commit()
    try:
        pos = fetch(f'https://data-api.polymarket.com/positions?user={w}&sizeThreshold=0.01&limit=500')
        if not isinstance(pos, list):
            continue
        settled = [p for p in pos if abs(float(p.get('cashPnl', 0) or 0)) > 0.001]
        wc = sum(1 for p in settled if float(p.get('cashPnl', 0) or 0) > 0)
        n = len(settled)
        wr = wc / n if n > 0 else 0
        cats = len(set((p.get('slug') or '').split('-')[0] for p in pos if p.get('slug')))
        tmp.execute('INSERT OR REPLACE INTO results VALUES (?,?,?,?,?,?,?)',
                   (w, name, pnl, n, wc, wr, cats))
        if wr >= 0.70 and n >= 20:
            winners.append((w, name, pnl, n, wc, wr, cats))
        time.sleep(0.15)
    except Exception as e:
        errs += 1
        if errs <= 3:
            print(f'  err: {w[:14]}: {e}', flush=True)

tmp.commit()
tmp.close()

winners.sort(key=lambda x: -x[2])
print(f'\nDone: {len(rows)} scanned, {errs} errors, {len(winners)} with WR>=70% n>=20')

print(f'\nTOP 20:')
for i, (w, name, p, n, wc, wr, cats) in enumerate(winners[:20], 1):
    nm = (name or '-')[:20]
    print(f'{i:2d}. {w}  {nm:20}  PnL=${p:>10,.0f}  WR={wr*100:.1f}%  n={n}  cats={cats}')

print(f'\nALL {len(winners)} WINNERS (WR>=70% n>=20):')
for i, (w, name, p, n, wc, wr, cats) in enumerate(winners, 1):
    nm = (name or '-')[:20]
    print(f'{i:3d}. {w}  {nm:20}  PnL=${p:>10,.0f}  WR={wr*100:.1f}%  n={n}  cats={cats}')
