# Fleet Activation Runbook

**Status: infrastructure ready, DORMANT until Wallet #1 (polybot / Prod) hits $1,000.**

Per Dale 2026-04-23: no external capital for secondary wallets. Wallet #1 funds wallet #2 from its own profits once it reaches $1K. $100 initial seed per new wallet.

## Architecture summary

- **16 entities** defined in `config/entities.yaml` (polybot + 15 secondary)
- **Staggered scan-scheduler** (`src/core/scan-scheduler.ts`) — per-entity offset = baseInterval/N, so 120s/N dynamically. At 16 wallets: 7.5s. At 4 wallets during rollout: 30s.
- **Pool-manager treasury** (`src/treasury/pool-manager.ts`) — daily 00:00 UTC sweep. Working-capital floor $2,000 per entity. Surplus split 50% debt / 30% growth / 20% under-floor refunds. A Brown entity isolated.
- **Cross-wallet dedup** (`src/strategy/strategy-context.ts#getOpenPositionsAcrossFleet`) — when FLEET_ACTIVE=true, strategies check ALL entities' open positions before opening new. Prevents sister wallets from piling into the same condition_id.
- **Feature flag**: `FLEET_ACTIVE=true` in each engine's .env. Dormant means everything behaves as single-entity mode.

## Wallet #1 → $1K bootstrap (gate for fleet activation)

Wallet #1 is `polybot` entity on Prod. Currently $373.62. To fund wallet #2 at $100 seed (leaving $1,000+ operational capital in wallet #1), we need +$726.38 realized profit.

At Prod's realistic run-rate of $5-20/day ($374 bankroll × 1.5-5% daily return), that's ~30-45 days. Two levers to accelerate:
1. Raise `max_portfolio_exposure_pct` 0.15 → 0.30 (Gate-5 caps relax after proven 7-day green streak)
2. Raise `max_position_usd` $25 → $40 (same gate)

## Activation sequence (phased, NOT all 16 at once)

### Phase 0: Wallet generation (one-time, before any activation)

Runs locally on Dale's workstation OR the VPS. Requires age CLI installed (`age --version`).

```bash
# Generate 15 new Polygon wallets (one per non-polybot entity)
for slug in armorstack lilac caspian-intl armorstack-tax armorstack-marketing armorstack-te boehm-family nolan-fund landon-fund artisan179 sage-holdings midwest-ai weather-alpha delta-neutral a-brown; do
  node scripts/gen-wallet.ts --slug "$slug" > "secrets/wallet-${slug}.json"
  age -r $(cat ~/.config/age/polybot.pub) -o "secrets/wallet-${slug}.json.age" "secrets/wallet-${slug}.json"
  shred -u "secrets/wallet-${slug}.json"  # delete plaintext
done
```

Then extend `scripts/boot-decrypt-secrets.sh` to decrypt each on boot to `/dev/shm/polybot-secrets/wallet-<slug>.json` and `chmod 600`.

**DO NOT RUN until Dale greenlights** — once wallets exist in secrets/, they're tracked in git-ignore but the .age files are committed for disaster recovery.

### Phase 1: Fund wallet #2 ("armorstack")

Only executes when wallet #1 ≥ $1,000. Do NOT skip.

1. From wallet #1 (Prod polybot), withdraw $100 USDC to wallet #2 (armorstack) address
2. Mark `config/entities.yaml` `armorstack.mode: live` and `status: active`
3. Commit + push
4. On VPS: set `FLEET_ACTIVE=true` in `/opt/polybot-v3/.env`
5. `systemctl restart polybot-v3`
6. Kill-switch is still halted (operator_sigusr1) — SIGUSR2 to release on both engines once scheduler confirmed firing

Expected behavior: scan-scheduler now runs 2 entities at 60s offset. Dedup prevents wallet #2 from duplicating wallet #1's positions. Pool-manager sweeps at next 00:00 UTC.

### Phase 2: Monitor for 48h

- Does wallet #2 open positions that wallet #1 didn't? (expected yes — different markets via dedup)
- Is wallet #2's PnL positive after 48h? (expected if wallet #1 pattern is transferable)
- Any orderbook impact from 2 wallets trading same strategies? (monitor exchange-divergence-scout output)

### Phase 3: Add wallets 3-4 ("lilac", "caspian-intl")

Only if Phase 2 is green. Same procedure:
1. Fund each $100 from wallet #1
2. Flip mode: live + status: active in yaml
3. Restart engines
4. Scheduler auto-adjusts stagger: 120/4 = 30s

### Phase 4+: Scale to full 16

One new wallet every 3-5 days if prior batch is stable. 30 days to full fleet.

## Rollback

If fleet behavior degrades (concentration, orderbook impact, cross-wallet correlation):

```bash
# Immediate rollback to single-wallet mode
sed -i 's/FLEET_ACTIVE=true/FLEET_ACTIVE=false/' /opt/polybot-v3/.env
systemctl restart polybot-v3
```

Active wallets stay alive but each operates independently. Dedup disengages. Scheduler reverts to one-entity mode (polybot only).

## Monitoring per-wallet PnL

```sql
-- Per-wallet 24h PnL
SELECT entity_slug,
       ROUND(SUM(unrealized_pnl),2) AS pnl_24h,
       COUNT(*) AS resolved_24h
FROM positions
WHERE status='resolved' AND closed_at >= datetime('now','-24 hours')
GROUP BY entity_slug
ORDER BY pnl_24h DESC;
```

## Critical Do-NOTs

- Do NOT activate `FLEET_ACTIVE=true` before wallet #1 is ≥ $1K
- Do NOT activate more than 2 wallets at once (phased rollout gates data integrity)
- Do NOT withdraw from wallet #1 below $1K operational floor to seed others
- Do NOT fund multiple secondary wallets in one transaction (batch failures = capital in limbo)
- Do NOT skip the 48h monitoring gate between phases
