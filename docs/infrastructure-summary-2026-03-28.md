# Gemini Capital — Infrastructure Summary

**Date:** 2026-03-28
**VPS:** 178.62.225.235 (DigitalOcean AMS3, armorstack-vps-ams3)
**Domain:** geminicap.net (SSL via Let's Encrypt)
**SSH:** Port 2222, key-based auth only

---

## System Overview

The Gemini Capital trading platform runs an 11-entity multi-account Polymarket trading operation on a single DigitalOcean VPS. Each entity operates independently with its own wallet, dashboard, and state directory. A master aggregator dashboard provides cross-entity visibility. All data is now backed by a SQLite database that serves as the single source of truth for trades, portfolio snapshots, and tax reporting.

## Architecture Layers

**Access Layer** — Nginx reverse proxy with SSL termination on port 443. SSO authentication via `auth_request` directive. Each entity has a dedicated URL path (`/entity/{slug}/`) with `sub_filter` URL rewriting. Reports served at `/reports/`.

**Dashboard Layer** — 11 Flask-based dashboards (ports 8080-8090) plus a master aggregator (port 9090). All dashboard ports are firewalled to localhost-only via UFW. Nginx proxies authenticated requests to the correct port.

**Data Layer** — SQLite database at `/opt/polybot/db/portfolio.db`. Five tables: `entities` (11 registered), `trades` (277 on-chain trades from Polymarket Data API), `resolutions` (15 resolved positions with P&L), `snapshots` (periodic equity/cash/positions capture), `transfers` (cross-entity USDC movements). Three views: `v_entity_pnl`, `v_weekly_tax`, `v_daily_volume`.

**Trading Layer** — Cron-driven bot engine with 18 scheduled jobs. Grinder (92-98.5% probability trades every 10 min), Sprint Trader and Auto Trader (every 15 min), Arb Executor (every 5 min), Position Monitor (exit signals), Auto Redeem (claim resolved positions), Auto Fund (cross-entity $100 USDC transfers at $2,500 trigger).

**Reporting Layer** — Portfolio status report generated every 6 hours (00:00, 06:00, 12:00, 18:00 UTC). Weekly taxable income report per entity generated Mondays at 08:00 UTC. All reports saved as HTML to `/opt/polybot/db/reports/` and served via Nginx at `geminicap.net/reports/`. Email delivery via msmtp configured but requires Gmail App Password for authenticated relay.

## Entity Status

| Entity | Slug | Port | Wallet | Status | Capital |
|--------|------|------|--------|--------|---------|
| GC Caspian | caspian | 8080 | 0xF8d1...1fd7 | Active | $257.09 |
| GC Armorstack | armorstack | 8081 | 0x5F7d...3c57 | Pending | $0 |
| GC Lilac Ventures | lilac | 8082 | 0x7529...fE5D | Pending | $0 |
| GC Caspian International | caspian-intl | 8083 | 0x9343...eDC3 | Pending | $0 |
| GC JW Debt | jw-debt | 8084 | 0xFb4C...4B0f | Pending | $0 |
| GC NJB Education Fund | njb-education | 8085 | 0x1450...C2C8C | Pending | $0 |
| GC LDB Education Fund | ldb-education | 8086 | 0x4DDd...e400E | Pending | $0 |
| GC Parkside Infrastructure | parkside | 8087 | 0x4d3A...444Be | Pending | $0 |
| GC Armorstack Tax | armorstack-tax | 8088 | shared* | Pending | $0 |
| GC Armorstack Marketing | armorstack-marketing | 8089 | shared* | Pending | $0 |
| GC Armorstack T&E | armorstack-te | 8090 | shared* | Pending | $0 |

\* Tax, Marketing, and T&E entities currently share the Caspian wallet address. They need dedicated wallets generated before receiving funding.

## Current Portfolio (Caspian Only)

- **Total Equity:** $259.04
- **Cash:** $205.01
- **Positions Value:** $54.01
- **Reserve Balance:** $154.25
- **Deposit Basis:** $257.09
- **Net P&L:** +$1.95 (+0.8%)
- **On-Chain Trades:** 277 (all real, Data API sourced)
- **Resolved Positions:** 15 (net realized P&L: -$71.68)
- **24h Volume:** $52.08 across 22 trades

## Database Files

| File | Path | Purpose |
|------|------|---------|
| db_init.py | /opt/polybot/db_init.py | Schema initialization |
| db_writer.py | /opt/polybot/db_writer.py | Data ingestion from Polymarket API |
| db_reports.py | /opt/polybot/db_reports.py | Report generation engine |
| email_report.py | /opt/polybot/email_report.py | Report delivery (file + email) |
| portfolio.db | /opt/polybot/db/portfolio.db | SQLite database |

## Firewall (UFW)

- **Allow:** 80 (HTTP), 443 (HTTPS), 2222 (SSH)
- **Deny:** All dashboard ports (8080-8090, 9090) from external
- **Internal:** Dashboard ports accessible via localhost only

## Next Steps

1. **Email delivery:** Configure Gmail App Password in `/etc/msmtprc` for authenticated email relay
2. **Entity funding:** Generate dedicated wallets for Tax/Marketing/T&E entities, fund Round 1 entities when Caspian reaches $500 equity
3. **Transaction history report:** Full on-chain trade analysis showing the $4,600 gain/loss cycle
4. **Reconcile.py patch:** Fix starting_capital persistence so it doesn't revert to $100
