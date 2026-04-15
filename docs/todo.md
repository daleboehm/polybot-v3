# Polybot V3 — TODO

**Updated: 2026-04-14** (PROD HALTED 2026-04-13, R&D live, R1-R3c rebuild complete)

## Start-of-session checklist for any Claude

1. Read `docs/status.md` for current state
2. Read `docs/context.md` for architecture
3. Check memory: `polybot_v3_state.md` + `polybot_v3_prod_halted.md` + `polybot_v3_rebuild_complete.md`
4. **DO NOT** start "rebuild" work on R1/R2/R3 items without verifying status first — those are done
5. **DO NOT** `systemctl restart polybot-v3` as a "fresh start" — kill switch is not persisted, restart auto-resumes live trading into the broken longshot strategy. Use SIGUSR2 for deliberate release, and only after the recap-day gate list below is cleared.
6. Check both engines are healthy: `ssh ... "curl -s http://localhost:9100/api/health"` and `http://localhost:9200/rd/api/health`

## Recap-day gate list (BLOCKING any live redeploy)

Prod is kill-switch halted since 2026-04-13 13:36 UTC on 43.8% daily drawdown. When fresh USDC arrives, the following must be cleared IN ORDER before SIGUSR2 release. Nothing in "Next actionable work" below runs live until this list is green.

### G1. Fix weather_forecast kill-switch bypass
Evidence: trades 1347 + 1348 placed AFTER the 4/13 halt via `weather_forecast` strategy path. Combined exposure only $0.49 but the defect is real — `src/execution/clob-router.ts` order path for weather_forecast isn't checking `killSwitch.isHalted()` before submission. Audit ALL strategy → order-router paths for kill-switch checks; the halt primitive is only as good as its weakest caller.

### G2. Add portfolio-wide exposure cap (NEW 2026-04-14)
**Gap:** Current risk stack caps per-position (`max_position_pct: 0.10`, `max_position_usd: 20`) but has NO aggregate exposure cap. On 4/13, the longshot cluster opened ~8 correlated positions that each passed the per-position gate but collectively reached ~60% of equity. A portfolio-level cap would have blocked the 4th+ orders and contained the blow-up before the 20% drawdown kill switch tripped.

**Proposed:** `max_portfolio_exposure_pct: 0.15` in `src/config/schema.ts`, enforced in `src/risk/risk-engine.ts` as a new pre-trade check that sums `open_positions.cost_basis` for the entity and rejects if adding the new order would exceed the cap. Reference: stacyonchain postmortem (2026-04-14 research) — same cap value he uses on a 3-strategy portfolio.

**Interaction with kill switch:** Additive, not replacement. Kill switch catches *drawdown* after the fact; portfolio cap catches *concentration* before the fact. Both needed.

### G3. Disable longshot on live until R&D proves it post-divergence
Paper-to-live divergence is the root cause of the 4/13 blow-up (R&D on identical code is flat, prod dropped 80%). Do NOT re-enable longshot on prod until R&D shows Wilson LB ≥ 0.50 on n ≥ 50 **live-matched** trades (not paper). Quarantine like value/skew/complement were, or flag-gate it with `LONGSHOT_LIVE_ENABLED=false`.

### G4. Verify auto-claim flow end-to-end
stacyonchain research flagged auto-claim as "not optional" — unclaimed resolved positions are dead capital. `src/execution/neg-risk-redeemer.ts` exists but behavior under UMA `proposed` state needs verification. Position 1629 (White House posts 180-199, NO 0.991, currently `proposed`) is the natural test case — watch it through resolution and confirm the redeemer fires.

### G5. Right-size caps for new capital level
$20 abs cap is correct for $257 seed but too tight for $1K+:
- At $1K seed → `max_position_usd: 100`, `max_position_pct: 0.08` (tighter than 0.10 per stacyonchain)
- At $2K seed → `max_position_usd: 200`, `max_position_pct: 0.08`
- At $5K+ → revisit; Kelly math changes at that scale

### G6. SIGUSR2 release (NOT systemctl restart)
Only after G1-G5 are green. `kill -USR2 $(systemctl show polybot-v3 -p MainPID --value)`. Restart would auto-resume live trading immediately because the kill switch is not persisted.

## Next actionable work (prioritized — ALL GATED on recap-day list above)

### 1. Consensus-driven entries (READY once recap-day gates clear)

The `polybot whale-consensus` CLI is deployed and dry-run tested. 10 markets with 4-9 high-WR whales agreeing. Command to execute:

```bash
ssh -i ~/.armorstack-vault/polymarket/armorstack_vps_key -p 2222 root@178.62.225.235 \
  'cd /opt/polybot-v3 && node dist/cli/index.js whale-consensus --entity polybot --min-whales 4 --min-wr 0.75 --max-entries 10 --execute'
```

Per-position size defaults to $5. Skips markets already held. Sorts by whale count desc.

### 2. Merge wallet scan results into full smart_money_candidates

The scan found 139 wallets with WR ≥ 70% and n ≥ 20 from `/tmp/scan_results.db` on VPS. Only top 20 were seeded. If Dale wants to expand, merge the remaining 119 wallets into `smart_money_candidates` (not necessarily promoting them to `whitelisted_whales` — that requires manual review or Bravado filter pass).

### 3. R4 scale items (if Dale wants to push)

- **AWS KMS signing** for prod wallet — eliminate private key on VPS disk
- **Blue/green deploy** — second VPS for zero-downtime rolling updates
- **Kalshi atomic arbitrage** — wire kalshi-client into cross-market-divergence strategy for real-time arb execution
- **Market-making module** — Avellaneda-Stoikov adaptation for prediction markets (needs 100-500ms infra — see tier-1 research)
- **Layer 2 redundancy** — hot standby VPS in UK
- **Non-root systemd user** — migrate from `User=root` to `polybot` user (requires chown of `/opt/polybot-v3/data/` + `state/`)

### 4. R1 PR #2 — Exit signal wiring (from original rebuild plan)

Check if stop-loss monitor's exit signals properly flow through the engine pipeline (bypass edge check, daily loss check, max position check — but respect kill switch and cash available). Currently works for paper; verify for live.

### 5. Strategy refinements based on R&D data

R&D (the exploration engine with $10K paper) shows these clear winners (n ≥ 50):
- `favorites.compounding`: 53.2% WR, n=562, +$144.78 ✅
- `longshot.bucketed_fade`: 80.9% WR, n=157, +$23.52 ✅
- `convergence.long_term_grind`: 66.7% WR, n=126, +$7.37 ✅

And clear losers (should stay disabled):
- `favorites.stratified_bias`: 35.3% WR → already disabled by advisor
- `favorites.fan_fade`: 4.8% WR → already disabled
- `longshot.news_overreaction_fade`: 71.7% WR but -$37.30 (edge masked by negative P&L)

Consider: why is news_overreaction_fade beating Wilson but losing money? Possibly execution slippage or exit timing — worth investigating.

## Daily automated research

- Task `polybot-strategy-research` scheduled daily at 8 PM local
- One-shot `polybot-research-tonight` fires at 2026-04-14 00:12 local
- Output: .docx to `/mnt/CLAUDE/Polymarket/` + emailed summary to dale.boehm@armorstack.ai

## Things explicitly NOT to do

- **Don't hot-patch `/opt/polybot-v3/dist/`** — always go workstation src → git → VPS pull → rebuild
- **Don't put source code on OneDrive** — docs only. OneDrive sync caused 6+ hours of debugging on 2026-04-11/12/13
- **Don't change prod risk limits** without Dale's explicit approval — it's live money
- **Don't restart v1/v2 services** — `/opt/polybot/`, `/opt/polybot-v2/`, `/opt/polybot-v2-rd/` are legacy, quiesced
- **Don't trust the rebuild plan as a todo list** — R1-R3c are done, verify with Explore before starting "rebuild" work
