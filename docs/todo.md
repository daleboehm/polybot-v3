# Polybot V3 — TODO

**Updated: 2026-04-14** (R1-R3c rebuild verified complete, whale tracking live)

## Start-of-session checklist for any Claude

1. Read `docs/status.md` for current state
2. Read `docs/context.md` for architecture
3. Check memory: `polybot_v3_state.md` + `polybot_v3_rebuild_complete.md`
4. **DO NOT** start "rebuild" work on R1/R2/R3 items without verifying status first — those are done
5. Check both engines are healthy: `ssh ... "curl -s http://localhost:9100/api/health"` and `http://localhost:9200/rd/api/health`

## Next actionable work (prioritized)

### 1. Consensus-driven entries (READY TO EXECUTE — awaiting Dale's go)

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
