# Recap-Day Runbook — Polybot V3 Prod

**Purpose:** sequenced steps from kill-switch-halted prod (state as of 2026-04-16) to a deliberately released, capital-refilled live engine. This is the ONLY approved path. No `systemctl restart` shortcut.

**Status prior to recap:** prod halted 2026-04-13 13:36 UTC on 43.8% daily drawdown (longshot cluster blew up). Equity ~$49 cash + positions against $257 seed (-80.8%).

---

## Gate status going in

| Gate | State |
|------|-------|
| G1 — Kill-switch persistence | ✅ Implemented (`killSwitch.loadPersistedState()` fires on engine start) |
| G2 — Every router call gated | ✅ Audited `clob-router.routeOrder` — first statement is `killSwitch.check()` |
| G3 — Longshot disabled on prod | ✅ Removed from `config/entities.yaml` polybot strategies block (2026-04-16) |
| G4 — Position caps right-sized | ✅ `config/default.yaml` updated 2026-04-16: pos cap $100 / 10%, envelope+cluster re-armed, portfolio 0.15 held |
| G5 — Whale-consensus entry preferred | ✅ Policy documented below |
| G6 — All router call sites audited | ✅ Every strategy → order path funnels through `routeOrder` |
| P0-1 — CTF Exchange V2 migration | ⏳ Research done, code change queued behind `exchange_version: v1` flag |
| P0-2 — NULL strategy attribution | ✅ Reconciler orphans now tagged `reconciler_orphan` (2026-04-16) |

---

## G5 — Entry Policy: Whale-Consensus First, Scan-Strategy Second

**Rule:** the first new capital deployed after recap goes through `polybot whale-consensus`, not through the scan-strategy pipeline.

**Why:** the same scan-strategy code that ran flat on R&D dropped prod 80% in 8 days. The paper-to-live divergence on `longshot` is not fully understood yet. Whale-consensus entries have three independent guardrails that scan entries do not:

1. **Consensus requirement** — at least N whitelisted whales (default 4) are buying the same side. Idiosyncratic scan signals get zero coverage from this filter; whale entries are structurally less correlated with the failure mode that killed the April 13 book.
2. **Whale WR threshold** — default 75%. Whales on the whitelist have demonstrated persistence; a single mispriced market can't fake four whales at 75%+ WR.
3. **Per-trade, per-market, manual-confirmed** — the CLI surfaces the proposed trades, Dale confirms with `--execute`. No autonomous buildup like the correlated longshot cluster that tripped the kill switch.

**Command pattern:**

```bash
# Dry run — read-only, prints candidate trades, does not fire
polybot whale-consensus --entity polybot --min-whales 4 --min-wr 0.75

# Live — requires --execute flag and the kill switch to be released
polybot whale-consensus --entity polybot --min-whales 4 --min-wr 0.75 --execute
```

**When to relax to scan entries:** only after two consecutive weeks of positive whale-consensus P&L with no fresh prod drawdown event, AND after Fix 1 (Kelly boundary), Fix 4 (weather 2x), and the R&D-to-prod Wilson gate confirm a scan-strategy is ready to re-enable.

**Hard rule:** `longshot` is not re-enabled on prod via the scan pipeline until R&D Wilson LB ≥ 0.50 on ≥50 resolved longshot trades AND Fix 1 has shipped and produced 30 days of stable sizing on R&D.

---

## The release sequence

0. **Preflight checks** (must all be true):
   - [ ] Workstation `git status` clean, on `main`
   - [ ] Latest commits pushed: `git log origin/main..main` empty
   - [ ] VPS `git fetch && git status` — in sync with origin
   - [ ] `v_strategy_performance` on rd.db reviewed — no new surprises
   - [ ] Current open prod positions listed and checked — anything still held from 4/13 cluster accounted for

1. **Deploy code to VPS** (workstation):
   ```
   cd C:\Users\dboehm\dev\polybot-v3
   git push
   ```
   VPS:
   ```
   ssh -i ~/.armorstack-vault/polymarket/armorstack_vps_key -p 2222 root@178.62.225.235
   cd /opt/polybot-v3
   git fetch origin
   git reset --hard origin/main
   npm install           # only if package.json changed
   npm run build
   ```
   Do NOT `systemctl restart` yet — kill switch is still live and this is the moment we verify the new binary didn't break anything.

2. **Dry-run verification** (VPS):
   ```
   sqlite3 /opt/polybot-v3/data/polybot.db \
     "SELECT slug, strategy_id, enabled FROM entity_strategies WHERE slug='polybot' ORDER BY strategy_id;"
   ```
   Confirm: `longshot` NOT in enabled rows. `convergence` NOT in enabled rows. `weather_forecast`, `crypto_price`, `favorites.compounding`, `favorites.near_snipe`, `favorites.fan_fade`, `cross_market`, `macro_forecast`, `whale_copy` all present.

3. **Fund the wallet** — deposit the recap amount ($1K default, $2K tier, or $5K tier) to the prod wallet. Verify on-chain:
   ```
   polybot wallet-balance --entity polybot
   ```
   Confirm `usdc_balance` matches the deposit and `pusd_balance` is zero (pre-CTF-V2 cutover) OR `pusd_balance` matches deposit (post-cutover, after wrapping).

4. **Confirm risk caps match the recap tier.** Read `config/default.yaml` lines 9–50. For $1K: `max_position_usd=100`, `max_position_pct=0.10`. For $2K: edit `max_position_usd=200`, keep pct, commit + redeploy, then return to this step.

5. **Release the kill switch DELIBERATELY:**
   ```
   kill -USR2 $(systemctl show polybot-v3 -p MainPID --value)
   ```
   This is the only approved release path. Do NOT use `systemctl restart` — the kill switch state persists across SIGUSR2 releases but an unclean restart re-arms it inconsistently.

6. **First trades — via whale-consensus, not the scan loop:**
   ```
   polybot whale-consensus --entity polybot --min-whales 4 --min-wr 0.75
   # Review candidates. If happy:
   polybot whale-consensus --entity polybot --min-whales 4 --min-wr 0.75 --execute
   ```

7. **Watch the first 60 minutes.** Tail logs on VPS:
   ```
   journalctl -u polybot-v3 -f | grep -E 'signal|order|kill|risk_rejection'
   ```
   If anything looks like the 4/13 pattern (rapid correlated entries, sizing hitting the cap repeatedly, convergence or longshot firing somehow), hit the kill switch from the CLI or with another `kill -USR2` to toggle it. Investigate before re-release.

8. **24-hour review.**
   ```
   sqlite3 /opt/polybot-v3/data/polybot.db \
     "SELECT strategy_id, sub_strategy_id, total_resolutions n, ROUND(win_rate,1) wr, ROUND(total_pnl,2) pnl, open_positions FROM v_strategy_performance ORDER BY total_resolutions DESC;"
   ```
   If any strategy shows clear early divergence from R&D's profile, flag it. Adjust config, redeploy, re-release.

---

## What NOT to do

- **NEVER** `systemctl restart polybot-v3` as the first move after recap — kill switch re-arm semantics after a full process restart are not the same as the deliberate SIGUSR2 release path.
- **NEVER** enable `longshot` or `convergence` in `config/entities.yaml` as part of the recap day — those decisions have their own separate gates (Fix 1, Fix 2, R&D Wilson) and are not coupled to the recap release.
- **NEVER** raise `max_portfolio_exposure_pct` above 0.15 without an incident review. That cap saved prod from a worse blowup on 4/13.
- **NEVER** edit `/opt/polybot-v3/dist/` directly on the VPS. Workstation → git → VPS git pull → `npm run build` is the only path.

---

*Document version: 2026-04-16. Owner: Dale Boehm. Review: after first full recap cycle.*
