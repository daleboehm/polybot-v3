# Polybot V3 — TODO

**Updated: 2026-04-15** (PROD HALTED 2026-04-13, R&D live, G1+G2+G3+G4b code landed & R&D-verified — prod still on old binary pending G4a backlog sweep + SIGUSR2 release. Prod-exit-hatch `sell-position --all-open` landed 2026-04-15 commit `3bc2de3`, verified against the 7 open prod positions via `--dry-run`.)

## Start-of-session checklist for any Claude

1. Read `docs/status.md` for current state
2. Read `docs/context.md` for architecture
3. Check memory: `polybot_v3_state.md` + `polybot_v3_prod_halted.md` + `polybot_v3_rebuild_complete.md`
4. **DO NOT** start "rebuild" work on R1/R2/R3 items without verifying status first — those are done
5. **DO NOT** `systemctl restart polybot-v3` as a "fresh start" — kill switch is not persisted, restart auto-resumes live trading into the broken longshot strategy. Use SIGUSR2 for deliberate release, and only after the recap-day gate list below is cleared.
6. Check both engines are healthy: `ssh ... "curl -s http://localhost:9100/api/health"` and `http://localhost:9200/rd/api/health`

## Recap-day gate list (BLOCKING any live redeploy)

Prod is kill-switch halted since 2026-04-13 13:36 UTC on 43.8% daily drawdown. When fresh USDC arrives, the following must be cleared IN ORDER before SIGUSR2 release. Nothing in "Next actionable work" below runs live until this list is green.

### G1. Persist kill-switch state to SQLite — DONE 2026-04-15

**Original hypothesis (WRONG):** weather_forecast strategy path bypasses `killSwitch.isHalted()`.

**Audit finding (see `docs/symmetry-audit-2026-04-15.md`):** `clob-router.routeOrder()` at line 30 calls `killSwitch.check()` unconditionally on every submission, and `kill-switch.ts:85-89` throws for every halt reason with no bypass. weather_forecast.ts returns `Signal[]` through the normal risk-engine → order-router pipeline — no out-of-band submission path exists. If the kill switch had been halted when trades 1347/1348 were attempted, `routeOrder` would have thrown. Since the trades filled, the kill switch was NOT halted at that moment.

**Real root cause:** the kill switch was NOT persisted across process restarts (explicit design choice in old `kill-switch.ts` lines 14-17). Between the 4/13 13:36 UTC halt and trades 1347/1348, the prod process must have restarted (OOM, systemctl, or uncaughtException graceful shutdown), clearing the in-memory halt state and auto-resuming live trading. This matches the existing start-of-session checklist warning item 5 exactly.

**Implemented in commit `edc649c`:**
- New `kill_switch_state` table in `src/storage/schema.ts` DDL (single row, `CHECK (id = 1)`).
- New `src/storage/repositories/kill-switch-repo.ts` with `getKillSwitchState`, `setKillSwitchState`, `clearKillSwitchState`.
- `KillSwitch.halt()` writes the halted row (wrapped in try/catch — the halt path must never throw on DB failure).
- `KillSwitch.resume()` clears the row on deliberate operator release.
- New `KillSwitch.loadPersistedState()` method re-halts the in-memory singleton from the DB row on startup, emitting a fresh `killswitch:activated` event so alerters see the boot-halted state.
- `engine.start()` calls `killSwitch.loadPersistedState()` immediately after `applySchema(db)`, BEFORE entity init / strategy registration / clob-router wiring.

**R&D verification (2026-04-15 16:50 UTC):**
1. Cold start → `Kill switch persistence: no active halt to restore`, health `kill_switch_halted:false` ✅
2. `kill -USR1 $PID` → row `1|1|operator_sigusr1|SIGUSR1 received|2026-04-15T16:50:41.016Z` written, health flips to unhealthy ✅
3. `systemctl restart polybot-v3-rd` → new PID 323962 logs `KILL SWITCH RE-HALTED FROM PERSISTED STATE — operator must SIGUSR2 to release`, `halted_at` preserved ✅
4. `kill -USR2 $PID` → row `halted=0` (reason history preserved for forensics), health returns to `kill_switch_halted:false` ✅

**Status: DONE and R&D-verified.** Prod still runs the old binary (no restart since 2026-04-13); it will pick up G1+G2+G3 only when Dale does the deliberate SIGUSR2 release at gate G6. Once prod restarts on the new binary, the persisted row will re-halt the engine on every subsequent restart until the operator explicitly resumes.

### G2. Add portfolio-wide exposure cap — DONE 2026-04-15

**Implemented in commit `6e7b636`:**
- `max_portfolio_exposure_pct: 0.15` added to `riskLimitsSchema` in `src/config/schema.ts`
- New pre-trade check in `src/risk/risk-engine.ts` after the cluster cap: sums `cost_basis` across ALL open positions for the entity and rejects if `currentDeployed + proposedIncrement > equity * portfolioExposurePct`.
- Additive to `max_strategy_envelope_pct`, `max_cluster_pct`, `min_edge`. Exits bypass.
- Reuses `openPositionsCache` and `computeEquity()` from the envelope-check block above (single positions scan).

**Status:** needs R&D deploy + 72h paper verification before it counts as cleared. Build on VPS will type-check the changes.

### G3. Disable longshot on live until R&D proves it post-divergence — DONE 2026-04-15

**Implemented in commit `e170d95`:**
- `LongshotStrategy.shouldRun(ctx)` override in `src/strategy/custom/longshot.ts`.
- Paper entities always run longshot (R&D needs the data to isolate the paper-to-live divergence).
- Live entities only run longshot when `process.env.LONGSHOT_LIVE_ENABLED === 'true'`.
- Belt-and-suspenders: even if yaml lists 'longshot' for a live entity, `shouldRun` blocks `evaluate()` from ever firing.

**Status:** quarantine is in code. R&D deploy still needed to activate on the VPS binary. Gate remains blocking until R&D shows Wilson LB ≥ 0.50 on n ≥ 50 live-matched trades.

### G4. Auto-claim flow end-to-end

**Audit finding (2026-04-15):** `src/market/on-chain-reconciler.ts` line 247 used to be `void redeemer;` with a stale comment claiming per-cycle redemption was "deferred until the Data API provides a reliable redeemable flag." That flag has been reliable since the Phase -1 fix on 2026-04-11, so the deferral was invalid. The reconciler was DB-closing winning positions via Data API `cashPnl` without ever claiming the USDC on-chain. Result: ~$286 of dead capital on the prod wallet across 25 positions, headlined by a $229 Beijing weather redemption. stacyonchain's "auto-claim is not optional" was literally correct.

Split into G4a (operator action on backlog) and G4b (code fix for the reconciler):

#### G4a. Clear the current backlog — OPERATOR ACTION (~$286 pending)

Dale runs the already-tested CLI once fresh USDC is back on the wallet, BEFORE restarting prod for G6:

```bash
ssh -i ~/.armorstack-vault/polymarket/armorstack_vps_key -p 2222 root@178.62.225.235 \
  'cd /opt/polybot-v3 && node dist/cli/index.js redeem-all --entity polybot --execute'
```

Dry-run first (omit `--execute`). The CLI already handles approval checks, neg-risk vs CTF dispatch, and per-position tx confirmation. This is live money, so it is NOT automated — Dale's call.

#### G4b. Wire auto-redeem into the reconciler — DONE 2026-04-15

**Implemented in commit `bd73f74`:**
- `on-chain-reconciler.ts` dead-bucket branch now attempts redemption BEFORE closing the DB row.
- Rules: paper entities (redeemer === null) skip redemption; zero-value positions (losses, `currentValue === 0`) skip redemption (gas waste); winning positions with a live redeemer go through `redeemDeadPosition()` which picks `NegRiskAdapter.redeemPositions` (neg-risk, `[yesMicro, noMicro]`) vs `CTF.redeemPositions` (standard binary) based on `dead.negativeRisk`.
- Failure mode is redeem-first-close-on-success: if redemption fails, the DB row is left open and `result.errors` records it, so the next reconcile cycle retries. This prevents the "DB says closed, cash is stuck" hole.
- `closeDbPosition()` gained an `onChainTxHash` param plumbed into the resolution row's `tx_hash` field (was hardcoded null). `tx_hash IS NOT NULL` is the auto-claim audit trail going forward.
- On success, the real on-chain USDC delta overrides the Data API `payout`/`cashPnl` estimates for the resolution row.

**R&D verification (2026-04-15 17:05 UTC):** cold restart on PID 324906, `Kill switch persistence: no active halt to restore`, `Skipping startup reconciliation — no wallet address (paper or unprovisioned entity)`, no errors in the new path (paper entity has `redeemer === null` so the branch short-circuits unchanged). Full engine up: 9 strategies, 5000 markets, paper-only.

**Status:** code DONE and R&D-verified. Effective on prod only after Dale's SIGUSR2 release at G6. Position 1629 (White House posts 180-199, `proposed` at halt time) is still the natural live test case once the backlog is cleared and the new binary is running — when UMA finalizes and the position hits the dead bucket, the reconciler will auto-claim and the resolution row will carry a real `tx_hash`.

### G5. Right-size caps for new capital level
$20 abs cap is correct for $257 seed but too tight for $1K+:
- At $1K seed → `max_position_usd: 100`, `max_position_pct: 0.08` (tighter than 0.10 per stacyonchain)
- At $2K seed → `max_position_usd: 200`, `max_position_pct: 0.08`
- At $5K+ → revisit; Kelly math changes at that scale

### G6. SIGUSR2 release (NOT systemctl restart)
Only after G1-G5 are green. `kill -USR2 $(systemctl show polybot-v3 -p MainPID --value)`. Restart would auto-resume live trading immediately because the kill switch is not persisted.

### Prod exit hatch (decoupled from G1-G6)

The `sell-position --all-open` CLI landed in commit `3bc2de3` bypasses `clob-router.routeOrder()` and therefore the kill switch — this is the intentional operator exit path when prod is halted. Dale can liquidate the 7 open prod positions ($22.99 total cost basis) at any time WITHOUT waiting for the G6 release:

```bash
# Verify first:
ssh -i ~/.armorstack-vault/polymarket/armorstack_vps_key -p 2222 root@178.62.225.235 \
  'cd /opt/polybot-v3 && node dist/cli/index.js sell-position --entity polybot --all-open --dry-run'
# Execute (live money):
ssh -i ~/.armorstack-vault/polymarket/armorstack_vps_key -p 2222 root@178.62.225.235 \
  'cd /opt/polybot-v3 && node dist/cli/index.js sell-position --entity polybot --all-open'
```

Dry-run 2026-04-15 18:00 UTC confirmed 7 rows, all strategy-tagged (so `--all-untagged` would miss them), total $22.99 cost basis. Sells are priced at `0.01` which effectively crosses any bid — net expectation at current prices is ~$21-22 recovered on high-prob favorites.

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
