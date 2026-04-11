# Polymarket V3 — TODO

Updated: 2026-04-11 (attention router + scout fleet shipped)

## NEXT SESSION — START HERE

### Today's verification tasks (first 15 min of next session)

**0a. Phase A 24h gate — CRITICAL BEFORE Phase B activation.** After 24h of
runtime with Phase A live (commits a2192ff + b95952f), check:
- `v_strategy_performance` approval rates BEFORE vs AFTER a2192ff — no
  strategy should have dropped by more than its normal variation.
  Expected: longshot and favorites.near_snipe see lower approval rates
  (they're eating the A1 taker routing and the A3 churn haircut).
- `sqlite3 rd.db "SELECT strategy_id, sub_strategy_id, COUNT(*), SUM(CASE WHEN approved=1 THEN 1 ELSE 0 END) FROM signals WHERE created_at >= datetime('now','-24 hours') GROUP BY strategy_id, sub_strategy_id;"`
- `journalctl -u polybot-v3-rd --since '24 hours ago' | grep -c 'A4 gate'` —
  count of A4 refusals. Zero is fine (few signals below 25¢); high count
  means the A1 taker routing is too aggressive.
- `sqlite3 rd.db "SELECT AVG(CASE WHEN json_extract(metadata,'$.in_dead_band')=1 THEN 1.0 ELSE 0.0 END) FROM signals WHERE created_at >= datetime('now','-24 hours');"` —
  fraction of signals in dead-band zone. Should be 2-5%.
- No new errors in journalctl since a2192ff deploy time.

**If 0a passes:** proceed with Phase B activation — wire dsr-psr.ts + brier
decomposition into the StrategyAdvisor behind an `ADVISOR_V2_ENABLED`
feature flag. Run 7-day A/B against the existing Wilson LB gating.

**If 0a fails:** identify the regressing strategy, narrow the A1/A3/A4
rule that caused it, and ship a fix before Phase B.

0. **Scout fleet signal review** — the big new thing from the prior session. After 24h+ of runtime check:
   - `journalctl -u polybot-v3-rd --since '1 hour ago' | grep -iE 'spike|jump|flagged|Scout tick'` — confirm scouts are firing real findings
   - `sqlite3 /opt/polybot-v3-rd/data/rd.db 'SELECT created_by, COUNT(*), MAX(priority), MIN(created_at), MAX(created_at) FROM market_priorities GROUP BY created_by;'` — priority rows per scout
   - `sqlite3 /opt/polybot-v3-rd/data/rd.db 'SELECT created_by, COUNT(*) FROM scout_intel GROUP BY created_by;'` — qualitative intel rows
   - `sqlite3 /opt/polybot-v3-rd/data/rd.db 'SELECT COUNT(*) FROM signals WHERE metadata LIKE "%scout_overlay%" AND json_extract(metadata, "$.scout_overlay_multiplier") != 1.0;'` — signals where overlay actually shifted size
   - `journalctl -u polybot-v3-rd --since '1 hour ago' | grep -iE 'Priority scan complete'` — how often the priority scanner fired
   - **If zero scout activity after 24h**: probably a market-data / marketCache issue. Check `sampling-poller` logs for volume_24h refresh errors.

0b. **Verify advisor fired on prod** — the yaml fix re-enabled the advisor. Check:
   - `journalctl -u polybot-v3 --since '1 hour ago' | grep -iE 'strategy advisor'` — should see periodic 5-min checks
   - Verify `convergence.long_term_grind` got disabled (it was producing −97pp avg edge per prior session notes)

0c. **Activate LlmNewsScout** — requires `ANTHROPIC_API_KEY` on the VPS and un-stubbing `callClaude()` in `src/scouts/llm-news-scout.ts`. Takes ~1-2 hours once key is available. Add `@anthropic-ai/sdk` to package.json.

1. **Check maker/taker fill rates** — query `v_strategy_performance` or logs for:
   - Count of orders where `execution_mode='maker'` that actually filled vs timed out
   - Compare entry fill price vs market price at scan time (should average +0.01 better than before db687ca)
   - If fill rate <50% over 24h, consider shrinking the 1-tick delta or switching specific strategies back to taker
2. **Verify Markov longshot signals** — query recent longshot signals where `metadata.bias_multiplier != 1.0`. Confirm YES-side <20¢ signals are being sized down and NO-side signals sized up.
3. **Check `markov-calibration.ts` didn't break anything** — look for any edge-report logs showing NaN or unexpected probabilities.
4. **Check advisor disabled `convergence.long_term_grind` on prod** — the patch exposed that prod's 81 own-data resolutions for this sub are producing avg edge −97pp on new signals. Advisor runs every 10 min with Wilson LB gating. Verify it has disabled the sub by the time the next session starts. If NOT disabled, check advisor config thresholds — something is likely blocking the disable path.
5. **Check prod signal volume per sub** — after the Markov patch (`0249404`), prod's signal-generation profile should tighten dramatically toward strategies with actual edge (near_snipe, filtered_high_prob, longshot.*, weather, crypto, sportsbook_fade, cross_market, macro_forecast). Strategies with tautological pre-patch fallbacks (compounding, stratified_bias, fan_fade at mid-price, long_term_grind) should see very few approvals at the 1.5% min_edge gate. If any of those subs are still approving >5% of signals, debug the Markov wiring.

### Top priority for next session (from 2026-04-10, still relevant)

1. **Private GitHub repo for polybot-v3** — single source of truth across workstation / VPS src / VPS dist. Ends hot-patch drift forever. ~30-45 min setup:
   - `git init` in `Polymarket/polybot-v3/`
   - Write `.gitignore` (node_modules/, dist/, data/, archive/, .env*, api_keys.json, wallet.json, *.log)
   - Initial commit + push to private repo (`dale-boehm/polybot-v3` or similar)
   - VPS: `git init && git remote add origin ... && git fetch && git reset --hard origin/main`
   - New deploy flow: `git push` (workstation) → `git pull && npm run build && systemctl restart` (VPS)
   - Update `Polymarket/docs/deploy.md` to document the git-based flow
   - Future: GitHub Actions for `npm run typecheck` on push

2. **Decide whether prod should adopt R&D's risk tuning**:
   - R&D is now: `max_positions: 100000`, `max_position_usd: $10`, `min/max_hours_to_resolve: 1/48`
   - Prod is still: `max_positions: 40` (schema default), `max_position_pct: 5%`
   - Prod is live money with $24.89 cash. Changing live limits is Dale's call.
   - Code-level fixes are already on prod (same dist binary). This is purely config.

3. **Check R&D paper-resolver progress**: by next session, 1-48h paper positions should be resolving. Verify `resolutions` table has entries > 0 and the advisor's check log fires cleanly.

4. **Verify new sub-strategies are firing**: the 5 new subs (weather same_day_snipe / next_day_horizon / ensemble_spread_fade, crypto target_proximity / volatility_premium_fade) had strict gates and hadn't fired yet at session end. After ~12-24h of R&D runtime, check signal counts per sub. If any sub has 0 signals, the gates are probably too tight — loosen and redeploy.

5. **Odds API quota check**: `MONTHLY_QUOTA = 20000` is hardcoded. Confirm Dale's actual plan tier. With the 60-min cache shipped tonight, current burn rate is ~5K/month. Safe for any tier ≥ Plus.

## Deploy discipline (LOCKED-IN, do not deviate)

- **STANDING RULE (Dale 2026-04-11):** No patches. Only code updates. No rsync drift-plastering. No ad-hoc SQL updates. Every fix flows: workstation src edit → git commit → GitHub push → VPS git pull → `npm run build` → `systemctl restart`.
- Workstation `Polymarket/polybot-v3/src/` is THE source of truth
- NEVER hot-patch `/opt/polybot-v3/dist/` directly. If you must (emergency), update workstation src and git commit + push in the SAME session.
- **R&D does NOT have its own dist.** `polybot-v3-rd.service` uses `ExecStart=/usr/bin/node /opt/polybot-v3/dist/index.js` with `WorkingDirectory=/opt/polybot-v3-rd`. One rebuild = both engines updated. No rsync step needed. Verified 2026-04-11.
- Flow: edit workstation → git commit + push → VPS `git pull` → `npm run build` → `systemctl restart polybot-v3 polybot-v3-rd` → verify
- Doc: `polybot-v3/docs/deploy.md`

## Both engines currently LIVE (as of 2026-04-10 21:05)

- **Prod** (`polybot-v3.service`): live, cash $24.89, 40 open positions, kill switch down, dashboard https://sageadvisors.ai
- **R&D** (`polybot-v3-rd.service`): paper, $10K starting, cash $1.87, 1015 open positions across 9 sub-strategies, kill switch down, dashboard https://rd.sageadvisors.ai/rd
- 9 of 14 sub-strategies actively firing; 5 new subs waiting for matching market conditions (gated by design)
- Both engines share the same `/opt/polybot-v3/dist/` binary (rsync'd to R&D each deploy)

---

## ARCHIVE — previous session state (pre-deploy)



## Rebuild plan approved 2026-04-10

Companion docs:
- Plan: `C:\Users\dboehm\.claude\plans\spicy-puzzling-robin.md`
- Design decisions: `Polymarket/docs/rebuild-design-decisions-2026-04-10.md`
- Regulatory holding: `Polymarket/docs/regulatory-posture-holding.md`
- Lessons (4 new): `Polymarket/docs/lessons.md`

Architecture: **Full R1→R4 rebuild** into a staggered-scan fleet with pooled treasury. Dale decisions locked across 7 walk items (capital $500→iterative, signal feeds Odds API + Kalshi + FRED in R3a, AWS KMS in R4, Telegram alerts, single-entity through R3 with fleet subsystems dormant).

## STATUS: FULL v3 rebuild code-complete, both engines configured for LIVE MODE

R1 + R2 + R3 (full: PR#1, PR#2, R3a signal feeds, R3b observability, R3c dormant fleet) + R4 scaffolds all committed to `Polymarket/polybot-v3/`. Full commit list in `status.md`. Both engines set to live mode per Dale 2026-04-10.

**Deployment gate**: install Node locally, run `npm install && npm run typecheck`, fix any errors, then rsync to VPS, create `.env` + `api_keys.json`, install systemd units, fund wallets, start both services. Detailed steps in `status.md` "Next session starts here".

## NEXT SESSION — Deploy + Verify

Start here:

- [ ] Install Node.js on workstation (one-off)
- [ ] `cd Polymarket/polybot-v3&& npm install && npm run typecheck && npm test`
- [ ] Fix any typecheck errors surfaced (R1+R2 code was written without local compilation)
- [ ] Deploy v3 to VPS: `rsync Polymarket/polybot-v3/ root@178.62.225.235:/opt/polybot-v3/`
- [ ] Create `/opt/polybot-v3/.env` with credentials (never commit)
- [ ] Install systemd units: `cp systemd/polybot-v3.service /etc/systemd/system/; systemctl daemon-reload`
- [ ] Start R&D only: `systemctl start polybot-v3-rd`
- [ ] Curl `/health` — expect 200 + JSON status
- [ ] 72-hour unattended burn-in on R&D paper
- [ ] Dale funds GC Caspian wallet with $500 USDC
- [ ] Start prod: `systemctl start polybot-v3`
- [ ] Verify stuck-position reconciliation clears the 40 backlog automatically on first scan cycle

## Phase 1 — Critical Risk Fixes (roadmap §11 Phase 1)

**Goal**: make the system safe enough to resume R&D paper trading. No live trading.

- [ ] **#1** Replace `resolution-checker.ts` with Polymarket Data API `/positions?user=...` reconciliation (Rec 1 in audit §12) — **unblocks prod**
- [ ] **#2** Remove phantom 2% fee in `clob-router.ts:124` and `paper-simulator.ts:44` — read `taker_base_fee` from marketCache
- [ ] **#3** Wire stop-loss exits through `routeOrder` with `is_exit` short-circuit in risk engine
- [ ] **#4** Call `updatePositionPrice` every scan cycle for all open positions
- [ ] **#5** Reorder position sizer: clamp AFTER strategy weight multiply
- [ ] **#6** Add `> 0` guard to `daily-loss-guard.ts:30`
- [ ] **#7** Fix `engine.ts:206, 282` daily-P&L double-counting
- [ ] **#8** Fix `sampling-poller.ts:100` `tokens[0]=YES` hardcoding — validate outcome field
- [ ] **#9** Assign `order_id` at build time for both paper and live; add `clob_order_id` column
- [ ] **#10** Quarantine all 54 `polybot-v3/scripts/*.py` patch scripts into `archive/` (do not delete — evidence)
- [ ] **#11** Add kill switch singleton + dashboard endpoint + `SIGUSR1` handler
- [ ] **#12** Move `deploy/armorstack_vps_key` to `C:\Users\dboehm\.armorstack-vault\polymarket\vps-ssh\` (awaiting Dale's signoff)
- [ ] **#13** Create non-root `polybot` service user on VPS; chown data dirs; update both systemd units
- [ ] **#14** Session management rewrite: separate `SESSION_SECRET`, server-side session store, bcrypt password, server-side expiry cap (audit Rec 8)
- [ ] **#15** Add `/health` endpoint returning DB reachable, last-scan age, positions count, mode
- [ ] **#16** Add backup cron for V2 SQLite DBs to off-VPS storage (S3 or DO Spaces)
- [ ] **#17** Fix VPS IP drift in deploy scripts (choose one, update all references)
- [ ] **#18** Wire existing `retry.ts` and `rate-limiter.ts` (currently dead code) into Gamma, CLOB, Polygon RPC callers

**Gate before Phase 2**: 72-hour unattended paper run with clean resolution cycle, no manual intervention.

## Phase R2 — Core Rebuild (strategies + validation framework)

Renamed from "Phase 2". 7-day paper burn-in + walk-forward gate before R3.

- [ ] **Parallel**: dispatch v1→v2 gap analysis subagent — catalog `Polymarket/scripts/simulator/` and flag modules worth porting before rebuilding from scratch (base_rate_db, calibration_engine, correlation_tracker, ensemble_forecaster, lmsr_engine, etc.)
- [ ] Quarantine `value.ts`, `skew.ts`, `complement.ts` → `polybot-v3/src/strategy/archive/` + README (delete Day 31)
- [ ] Rewrite `convergence.ts` with historical base-rate calibration per 5% price bucket
- [ ] Rewrite `favorites.ts` (4 subs) with empirical base rates + disjoint price ranges (no 0.85-0.92 collision)
- [ ] Rewrite `longshot.ts` (3 subs) with per-market precedence (only 1 sub fires per market per scan)
- [ ] Keep `weather_forecast` + `crypto_price` as-is (real data feeds verified)
- [ ] Rename R&D weighter tiers to Avoid/Monitor/Buy vocabulary; change default new-sub weight 0.25 → 1.0; floor 0.15, ceiling 2.0; add `entity_slug` to cache key; drop "sibling average" fallback
- [ ] Advisor ENABLE gate: n≥50 AND Wilson LB ≥ 0.50 AND P&L > $5
- [ ] Advisor DISABLE gate: n≥50 AND Wilson UPPER bound < 0.50 AND P&L < -$5
- [ ] NEW: `src/risk/wilson.ts` — Wilson LB utility
- [ ] NEW: `src/validation/walk-forward.ts` — rolling 60/14/3 window
- [ ] NEW: `src/validation/base-rate-calibrator.ts` — historical bucket stats
- [ ] NEW: `src/validation/brier.ts` — calibration tracking
- [ ] Extend `v_strategy_performance` view: Sharpe, Sortino, Calmar, Brier, reliability buckets, Wilson LB
- [ ] Deflated Sharpe Ratio gate (num_trials=13, threshold 0.95) in advisor
- [ ] R2 gate: 7-day paper run + walk-forward Sharpe gap <30% + ≥1 sub crosses Wilson gate

## Phase R3a — Signal feeds (external probability estimators)

NEW in 2026-04-10 revision. Addresses the tautological `model_prob` problem directly.

- [ ] NEW: `src/market/odds-api-client.ts` — The Odds API paid tier $30/mo, 20K req/mo
- [ ] NEW: `src/market/kalshi-client.ts` — read-only, free, public API, Polymarket↔Kalshi matching via Jaccard similarity
- [ ] NEW: `src/market/fred-client.ts` — Federal Reserve data, free API key
- [ ] NEW: `src/strategy/custom/cross-market-divergence.ts` — fires when |Polymarket_prob - ensemble_blend| > 4%
- [ ] NEW: `src/strategy/custom/sportsbook-fade.ts` — Odds API as sports probability ground truth, fade Polymarket when it disagrees by >3%
- [ ] NEW: `src/strategy/custom/macro-forecast.ts` — FRED + simple Fed reaction function, targets macro markets
- [ ] Polymarket↔Kalshi market matching cache (24h TTL)
- [ ] API rate limiter (existing `rate-limiter.ts` wired, shared across all feeds)
- [ ] Budget alerting: warn if Odds API usage >80% of monthly quota
- [ ] DROP from consideration: Manifold, Metaculus, PredictIt, RCP (v1 references deleted)

## Phase R3b — Observability + portfolio risk

Renamed from "Phase 3". Builds the ops surface for single-entity prod.

- [ ] NEW: `src/metrics/prom-client.ts` — Prometheus metrics (scan_duration, positions_open, cash_balance, api_errors, reconciliation_drift, strategy_signals, fills, kill_switch_activations)
- [ ] Grafana dashboards (deploy on VPS or DO managed)
- [ ] Telegram bot + chat_id capture runbook (operator messages bot once, bot records numeric ID into vault)
- [ ] Uptime Kuma monitoring `/health`, alerts → Telegram bot
- [ ] NEW: `src/risk/portfolio-risk.ts` — correlation matrix, category exposure caps, drawdown halt
- [ ] NEW: `src/market/regime-detector.ts` — volatility regime classification
- [ ] NEW: `src/market/orderbook-depth.ts` — depth-of-book reader for liquidity caps
- [ ] Rewrite `position-sizer.ts` with liquidity-aware cap (10% of top-3 book depth)
- [ ] Split `sse-server.ts` 540-line monolith
- [ ] Dashboard "gain" column fix (shares-vs-dollars bug)
- [ ] Position resolution age on dashboard
- [ ] logrotate + systemd hardening primitives
- [ ] Enable `noUncheckedIndexedAccess` in tsconfig
- [ ] Runbooks: safe start/stop, resolution stuck, kill-switch, Telegram bot setup
- [ ] R3b gate: portfolio halt fire-drill + Grafana/Telegram alerting drill

## Phase R3c — Dormant fleet subsystems (built but feature-flagged off)

NEW in 2026-04-10 revision. Multi-entity capability lands but stays inactive until Dale funds Entity 2.

- [ ] NEW: `src/core/scan-scheduler.ts` — staggered scan offsets per entity (5min / N_active_entities)
- [ ] NEW: `src/core/position-claim.ts` — anti-self-bidding across entities (once entity 1 buys market X, others skip it this cycle)
- [ ] NEW: `src/treasury/pool-manager.ts` — central treasury, daily UTC sweep, working-capital floor per entity, A Brown isolation flag
- [ ] NEW: `src/accounting/entity-tax.ts` — per-entity FIFO cost basis, realized P&L, year-end export, wash-sale detection per `agi-wash-sale-detection`
- [ ] `entities.yaml` schema extension: `isolated`, `compliance_strict`, `lifecycle_state`, `working_capital_floor`
- [ ] Fleet-level risk: cross-entity exposure tracking, category correlation halt
- [ ] Feature flag: `FLEET_ACTIVE` — when false, only `polybot` entity runs with no pool sweeps
- [ ] R3c gate: all subsystems pass unit tests + integration tests on 2-entity synthetic fleet

## Phase R4 — Scale & multi-exchange (deferred, unchanged except Kalshi move to R3a)

- [ ] AWS KMS asymmetric signing (`ECC_SECG_P256K1` key spec) — Polygon Amoy testnet burn-in → mainnet cutover
- [ ] Blue/green deploy (second VPS cold standby)
- [ ] Polymarket ↔ Kalshi ATOMIC cross-exchange arb (low priority — read-only divergence signal already delivered in R3a)
- [ ] Real market-making (two-sided quoting) on high-liquidity books
- [ ] News-driven strategy with NLP input
- [ ] UMA dispute handling
- [ ] Manifold emerging-market scout (deferred from R3a)

## Quick Wins (can land in a single cleanup PR)

See audit §13. 15 items, ~4-6h total. Includes the phantom fee, daily-loss-guard guard, tokens[0] fix, position sizer reorder, entity_slug in weighter, favorites boundary fix, skew hours_to_resolve filter, `Math.abs(signal.edge)` fix, empty-loop cleanup, dead retry/rate-limiter wiring.

## Dale-only items (require Dale's explicit signoff)

**Closed in 2026-04-10 walk**:
- [x] Decide rebuild scope → Full R1→R4
- [x] Decide: delete or rewrite fabricated-edge strategies → Quarantine → delete Day 31
- [x] Confirm v1 `auto_redeem.py` status → Stopped, v2 owns redemption
- [x] Authorize SSH key move → Approved, bundled into R1 #12 + deploy script updates
- [x] R1 redemption test scope → Polygon mainnet $1 position, kill switch armed
- [x] Entity scaling decision → Single entity through R3, fleet subsystems dormant
- [x] Initial capital target → $500 at R1, iterative thereafter
- [x] Kalshi integration → Port as read-only signal feed in R3a (not trading venue)
- [x] Hardware signing vendor → AWS KMS `ECC_SECG_P256K1` in R4
- [x] Alerting channel → Telegram (chat_id binding at R3b setup)
- [x] Working capital floor per entity → deferred until entity 2 funding imminent
- [x] Pool sweep cadence → Daily UTC (locked for when treasury activates)

**Still open** (non-blocking for R1 start):
- [ ] Confirm both engines stopped on VPS (operator verify after R1 starts)
- [ ] Decide: fix Dockerfile or delete it? (R3b cleanup scope)
- [ ] Quarterly review of `regulatory-posture-holding.md` triggering events
- [ ] Capital additions beyond $500 — Dale-initiated, never auto-triggered

## COMPLETED (2026-04-09/10 audit session)

- [x] 5-track parallel audit (A-E) — raw findings in `audit/2026-04-09/`
- [x] Skills internalization summary — `audit/2026-04-09/skills-internalization-summary.md`
- [x] Synthesis into unified 19-section report — `docs/audit-2026-04-09.md`
- [x] 2026-04-10 redaction pass (10 files)
- [x] Vault pattern documented — `docs/secrets-vault-README-2026-04-10.md`
- [x] Continuity docs updated (status.md, todo.md, lessons.md, context.md)

## Deferred indefinitely

These were in the pre-audit HIGH/MEDIUM lists but are either obsolete, already subsumed by the audit findings, or gated on the audit fix plan:

- ~~Monitor longshot fade experiment~~ — the 830+ fade trades are part of the 1,280 stuck positions; no data until resolution pipeline is fixed
- ~~Watch favorites.near_snipe~~ — same
- ~~Watch convergence.filtered_high_prob~~ — covered by audit C-P1-5 (volume never inserted)
- ~~Fund prod wallet with additional USDC~~ — do not fund until audit fixes land
- ~~Implement SELL/exit logic~~ — covered by Phase 1 #3
- ~~Clean up v1 auto_redeem cron~~ — depends on Phase 1 #1 decision
- ~~Weather forecast multi-model~~ — Phase 2/3 work, not before Phase 1 clears
- ~~Provision 8 additional entity wallets~~ — scale decision, Phase 2+
- ~~LLM ensemble for value strategy~~ — value strategy is slated for deletion per audit
