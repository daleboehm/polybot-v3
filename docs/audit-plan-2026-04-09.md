# Plan: Polymarket Trading Engine — Comprehensive Read-Only Audit (2026-04-09)

## Context

The Polymarket V2 dual-engine trading system (Prod + R&D) has reached a stability inflection point and is in REBUILD MODE for several components. A 472-skill expansion just landed in `~/.claude/skills/`, including the `agi-*` quantitative trading cluster, the `polymarket-*` Polymarket-specific cluster, the `obra-*` operational discipline cluster, and the `mcs-*` cybersecurity cluster. Before continuing the rebuild, we need a **comprehensive read-only audit** to:

1. Identify any P0 issues that imply immediate financial risk (exposed keys, broken risk gates, sizing bugs, state corruption)
2. Compare our current implementation against authoritative references (`polymarket-official-agent`, `polymarket-trading-expert`, `mj-polymarket-paper-trader` as the gold-standard paper-vs-live separation pattern)
3. Validate trading logic correctness against quant best practices (`agi-strategy-framework`, `agi-risk-management`, `agi-walk-forward-validation`, `agi-kelly-criterion`, `agi-slippage-modeling`)
4. Audit security posture against trading-system standards (secrets handling, supply chain, VPS hardening, log hygiene)
5. Build a prioritized improvement roadmap that exploits the new skills to create sustainable edges, while strictly preserving capital
6. Surface findings before more code lands so the rebuild can be sequenced intelligently

This is **audit only — not fix.** Hard boundaries from the original prompt apply throughout (no code changes, no config changes, no orders, no live mode toggles, no VPS commands without explicit approval, no secret exfiltration). Stop points are non-negotiable.

The plan also harmonizes the original audit prompt with the follow-on "Elite Polymarket Trading Expert" prompt that expanded the deliverable structure into Steps 1-4 (Skills Internalization → Audit → Discovery → Improvement Plan). The audit plan below adopts that structured deliverable format while preserving every safety control from the original prompt.

## Phase 0 Status (already complete before this plan)

- [x] Read `Polymarket/docs/context.md` — current architecture (dual-engine, sub-strategy hierarchy v3.0, schema v2)
- [x] Read `Polymarket/docs/status.md` — Prod has $2.49 cash / 40 open / 47 v2 trades; R&D has $18.93 / 1,280 open / 11,245 trades / 831 resolutions; longshot fade experiment in flight
- [x] Read `Polymarket/docs/todo.md` — HIGH priorities, completed sub-strategy refactor list
- [x] Read `Polymarket/docs/system_audit_2026-04-03.md` — prior Python-era audit (51 findings: 2 critical, 11 high, 20 medium, 18 low). Most findings are now obsolete (Python codebase replaced with TypeScript), but the **patterns** are essential context: hardcoded secrets, missing CSRF, no WAL on dashboard, no API retry, no circuit breakers, no log rotation, secrets stored in `/dev/shm` tmpfs, screen sessions instead of systemd. The pattern of fix-by-patching is still visible in `polybot-v2/scripts/` (40+ `fix_*.py` / `patch_*.py` / `nuke_*.py` files).
- [x] Read `Polymarket/docs/strategy-overhaul-2026-04-02.md` — historical context: 400 resolved trades / 2 wins / 0.5% WR / -$910 P&L caused the strategy overhaul that begat the current system
- [x] Invoked `cowork-ops` skill (loaded into context)
- [x] Read `_Skills/skill-catalog-expansion-2026-04-09.md` — full awareness of all 472 new + 64 core = 536 skills, NO SKILL.md bodies pre-read
- [x] Repo structure exploration:
  - `Polymarket/polybot-v2/src/` — 60 TypeScript files in core/, risk/, strategy/, execution/, market/, storage/, dashboard/, entity/, config/, types/, cli/, utils/
  - `Polymarket/polybot-v2/scripts/` — 40+ historical fix/patch scripts (technical debt indicator)
  - `Polymarket/polybot-v2/config/` — `default.yaml`, `entities.yaml`, `rd-default.yaml`, `rd-entities.yaml`, `strategies.yaml`
  - `Polymarket/polybot-v2/systemd/` — 2 service units (polybot-v2.service, polybot-v2-rd.service)
  - `Polymarket/polybot-v2/docker/Dockerfile` (containerization status uncertain)
  - `Polymarket/polybot-v2/.env.example` exists; **production .env lives on the VPS only — NOT in this workstation tree**
  - `Polymarket/polybot-v2/tests/` — directory exists, contents unknown (suspected empty, will verify during audit)
  - **CRITICAL FINDING (preliminary, must be verified):** `Polymarket/deploy/armorstack_vps_key` is the SSH private key to the live VPS, sitting in a OneDrive-synced workstation folder. CLAUDE.md confirms `Is a git repository: false`, so there's no `.gitignore` protection layer at the workspace root. **Audit must verify** the key's permissions, exposure surface, and whether it's the only copy.

## Why no Explore agents yet

The plan-mode workflow requires Explore agents in Phase 1, but I've already done targeted reads of the critical context files (context.md, status.md, todo.md, system_audit_2026-04-03.md, strategy-overhaul, expansion catalog) and a directory survey. The audit itself will spawn parallel subagents during execution per the original prompt's direction. The plan below specifies the subagent structure.

## Architecture decision: subagent strategy

Rather than one monolithic audit, the audit will run as **5 parallel investigation tracks** via subagents, each focused on a non-overlapping concern. This keeps main context clean and produces parallelizable findings. Each track produces a markdown file in `Polymarket/audit/2026-04-09/`. The main session synthesizes them into the unified `Polymarket/docs/audit-2026-04-09.md` deliverable.

| Track | Focus | Skills loaded on demand | Output file |
|---|---|---|---|
| **A. Trading correctness** (P0 — money) | Strategy logic, sizing, execution safety, state management, sub-strategy bug check, longshot inversion verification, R&D weighter math, prod advisor logic | `agi-strategy-framework`, `agi-risk-management`, `agi-position-sizing`, `agi-kelly-criterion`, `agi-exit-strategies`, `agi-slippage-modeling`, `agi-walk-forward-validation`, `agi-portfolio-analytics`, `polymarket-official-agent`, `polymarket-trading-expert`, `mj-polymarket-paper-trader`, `obra-defense-in-depth`, `obra-systematic-debugging`, `obra-root-cause-tracing` | `Polymarket/audit/2026-04-09/A-trading-correctness.md` |
| **B. Security & secrets** (P0 — keys) | Wallet key handling, API credentials, log scrubbing, supply chain (npm), VPS SSH key exposure, dashboard auth, HMAC token model, env var loading, .env files in tree, CLOB/Polygon RPC credentials | `ar-env-secrets-manager`, `ar-secrets-vault-manager`, `ar-skill-security-auditor`, `ar-security-pen-testing`, `ar-cloud-security`, `sk-vibe-code-auditor`, `mcs-analyzing-sbom-for-supply-chain-vulnerabilities`, `mcs-detecting-supply-chain-attacks-in-ci-cd`, `mcs-hunting-for-supply-chain-compromise`, `mcs-implementing-honeytokens-for-breach-detection`, `ar-dependency-auditor` | `Polymarket/audit/2026-04-09/B-security-secrets.md` |
| **C. Code quality & structure** (P1) | TypeScript correctness, async hygiene, error handling, schema integrity, repository pattern consistency, dead code, magic numbers, the 40+ fix_*.py scripts (technical debt evidence), naming, sub-strategy refactor completeness | `sk-vibe-code-auditor`, `sk-code-review-excellence`, `sk-clean-code`, `sk-fix-review`, `sk-typescript-pro`, `sk-typescript-advanced-types`, `sk-bug-hunter`, `sk-error-detective`, `ar-adversarial-reviewer`, `ar-code-reviewer`, `ar-tech-debt-tracker`, `ar-pr-review-expert` | `Polymarket/audit/2026-04-09/C-code-quality.md` |
| **D. Infra, ops, observability** (P1) | systemd units, deploy scripts, Dockerfile (if used), log structure, monitoring, alerting, backup posture, DR, dependency health, restart resilience, schema migrations on VPS, VPS hardening posture | `ar-observability-designer`, `ar-runbook-generator`, `ar-ci-cd-pipeline-builder`, `ar-docker-development`, `ar-performance-profiler`, `backup-data-protection`, `bcdr-planning`, `ar-incident-response`, `ar-incident-commander`, `ar-cloud-security`, `runbooks` | `Polymarket/audit/2026-04-09/D-infra-ops.md` |
| **E. Backtest validity & R&D analytics** (P1) | Whether v_strategy_performance is statistically valid, sample size for sub-strategy decisions, look-ahead bias check on resolution checker, walk-forward absent (acknowledged), advisor promotion thresholds (5 resolutions / 50% WR / positive P&L) — are they statistically defensible? Strategy weighter tier math correctness | `agi-walk-forward-validation`, `agi-strategy-framework`, `agi-portfolio-analytics`, `agi-position-sizing`, `agi-kelly-criterion`, `agi-feature-engineering`, `polymarket-statguy-research`, `mj-polymarket-strategy-advisor`, `obra-verification-before-completion`, `ar-statistical-analyst` | `Polymarket/audit/2026-04-09/E-backtest-rnd-validity.md` |

**Total parallel subagents: 5.** Each runs in isolation against read-only file inspection. None executes anything on the VPS without my explicit per-command approval.

## What's in REBUILD scope vs stable scope

Per `status.md` and `todo.md`, the following are intentionally in flux and should be **audited against the rebuild plan, not the current code state**:

- Strategy implementations (longshot just inverted, 4 sub-strategies brand new — code is fresh and may still have bugs)
- Sub-strategy refactor (deployed today, sub-strategy data has 0 resolutions so far — too early to judge effectiveness, but code paths must be verified)
- Strategy Advisor sub-strategy promotion logic (just rewritten)
- Strategy Weighter sub-strategy keying (just rewritten)
- v_strategy_performance view (just rewritten)
- Resolution Checker (rewritten in prior session using Gamma API bulk lookup)
- Cash tracking on BUY trades (recently fixed)

The following are **stable scope** and should be audited as-is:

- Engine scan loop core orchestration
- Risk Engine pre-trade gates (edge, position cap, daily loss)
- Position Sizer Kelly math
- Database schema, repositories, views
- Dashboard auth (HMAC tokens)
- Sampling poller and market cache
- CLOB router and paper simulator
- Entity manager
- Order builder
- Config loader and Zod schema
- v1 auto_redeem cron (still running on the VPS)
- VPS infrastructure, systemd units, nginx config, SSL certs
- All secrets handling (env files, SSH keys, wallet credentials)

## Audit scope checklist (mapped to original prompt's 32 items + new prompt's exhaustive coverage)

### Trading correctness (P0)
- [ ] 1. Strategy logic — signals compute what they claim; no look-ahead bias; no data leakage; edge cases handled
- [ ] 2. Sizing and risk — actual sizing matches declared policy; per-market/per-day/per-strategy hard caps; max drawdown actually monitored
- [ ] 3. Execution safety — paper vs live separation; dual-flag check; kill switch presence and functionality; in-flight order handling
- [ ] 4. State management and reconciliation — position tracking, PnL calc, restart recovery, exchange reconciliation cadence
- [ ] 5. Order management — idempotency, network failure handling, retry logic, duplicate prevention
- [ ] 6. Data integrity — market data correctness, time sync, gap detection, stale quote detection, NTP, exchange clock drift
- [ ] **NEW: Sub-strategy promotion threshold defensibility** — is `≥5 resolutions, ≥50% WR, positive P&L` statistically meaningful, or is it a sample-size trap?
- [ ] **NEW: Longshot inversion verification** — is the FADE logic correct (buying high-prob side, not low-prob side)? Walk every sub-strategy's signal generation against research claims.
- [ ] **NEW: Strategy Weighter fallback chain correctness** — exact match → parent → average → 0.25 default. Does the average-of-subs path produce sane numbers when one sub has 0 resolutions and another has 100?
- [ ] **NEW: Cash deduction race conditions** — is BUY cash deduction atomic with order placement? What if the engine restarts between deduction and DB persist?

### Backtesting and R&D engine validity
- [ ] 7. Backtest realism — slippage, fees, market impact, partial fills, rejections; same code path as live
- [ ] 8. Overfitting and walk-forward — is there walk-forward at all? Out-of-sample? Train/validate/test? Look-ahead window?
- [ ] 9. R&D engine isolation — can it ever touch real money? Hard-sandboxed? What guarantees this?
- [ ] **NEW: v_strategy_performance statistical validity** — is per-(strategy, sub_strategy) sample size sufficient for the advisor to make decisions? At 5 resolutions, what's the binomial confidence interval?

### Security (P0)
- [ ] 10. Secrets handling — wallet keys, API keys, RPC URLs, DB creds. Where stored? How loaded? In logs? Errors? Stack traces?
- [ ] 11. Key isolation — signing key in process memory? HSM/vault? Rotation? Compromise recovery plan?
- [ ] 12. VPS hardening — SSH config, firewall, fail2ban, auto-updates, audit logging, kernel
- [ ] 13. Supply chain — npm packages, CVEs, typosquats, packages that shouldn't be there
- [ ] 14. Code-level security — input validation, SQLi, command injection, SSRF, path traversal, XXE, deserialization
- [ ] 15. Log hygiene — sanitized? Leak API keys, wallet addresses, PnL?
- [ ] **NEW: SSH private key exposure check** — `Polymarket/deploy/armorstack_vps_key` is on a OneDrive-synced workstation. Audit must verify: file permissions, presence of any backup/version-history copies, whether OneDrive has uploaded it to Microsoft cloud, whether it's the same key on the VPS, whether passphrase-protected, whether documented as the only copy.
- [ ] **NEW: Workspace tree as a secret-exposure surface** — no `.gitignore`, no git, but the user works on this from a OneDrive-synced workstation. Any secret in the tree is at risk of cloud sync.

### Infrastructure
- [ ] 16. Deployment safety — graceful shutdown, blue/green, canary, rollback, mid-trade safety
- [ ] 17. Monitoring and alerting — what's monitored? What triggers? On-call path?
- [ ] 18. Logging and observability — structured logs, trace IDs, correlation, retention, search
- [ ] 19. Backup and DR — what, how often, tested, RTO, RPO
- [ ] 20. Dependency health — service availability, failure modes when CLOB/RPC/DB is down

### Code quality
- [ ] 21. Clean-code violations — magic numbers, duplicated logic, long functions, god objects
- [ ] 22. Error handling — swallowed exceptions, generic catch, silent error+continue, retry storms
- [ ] 23. Async correctness — Promise handling, unhandled rejections, cancellation
- [ ] 24. Resource management — file handles, DB connections, sockets, memory
- [ ] 25. Technical debt — TODOs, deprecated APIs, commented code, the 40+ fix_*.py scripts

### Testing
- [ ] 26. Test coverage — what's tested
- [ ] 27. Test quality — behavior or mocks?
- [ ] 28. Integration tests — end-to-end paper, reconciliation, restart
- [ ] 29. Chaos / fault injection — network drops, 500s, rate limits

### Compliance and records
- [ ] 30. Trade journal — complete, immutable, auditable
- [ ] 31. Tax records — cost basis, wash sale, year-end
- [ ] 32. Regulatory posture — KYC/AML, sanctions

### Quant-specific (added per new prompt's scope)
- [ ] **A. Probability calibration** — does any strategy track its calibration over time? Brier score? Reliability diagram?
- [ ] **B. Sharpe / Sortino / drawdown computation** — does the system compute risk-adjusted return metrics, or only raw P&L?
- [ ] **C. Correlation across markets** — when one strategy buys 200 favorites, are those positions correlated? Is correlation modeled in risk?
- [ ] **D. Liquidity assessment** — are positions sized vs market depth, or just vs bankroll?
- [ ] **E. Resolution dispute handling** — UMA disputes can take 48+ hours; does the engine handle the limbo state?
- [ ] **F. Cross-platform arbitrage potential** — Kalshi connectivity exists in skills (`agi-` cluster), is this in the rebuild plan?
- [ ] **G. AI-assisted information arbitrage** — `polymarket-statguy-research`, `mj-polymarket-analyzer`, `mj-polymarket-strategy-advisor` all describe orchestration patterns we don't currently use
- [ ] **H. Market making (skew strategy)** — is this real two-sided quoting or just signal-based BUYing?

### **PROD-BLOCKING — Position Resolution Failure (added per Dale's explicit direction)**

**The core operational symptom:** Prod has 40 open positions and only $2.49 cash. Positions are not closing, which means cash is not being credited back, which means the engine cannot place new trades, which means the system is **functionally dead even though both services show "active"**. The 47 v2 trades / 12 resolved / -$4.62 P&L on prod is far below the trade volume R&D is generating, and the 1,280 open positions on R&D with 831 resolutions (out of 11,245 trades) suggests the same root issue is happening at scale on the R&D side too — only 7% of R&D's trades have been resolved.

**This is a P0 trading-correctness finding that the audit MUST root-cause.** Tracks A and E both need to investigate. Specific questions for the subagents:

- [ ] **R-1. Resolution Checker actually runs?** — verify the `resolution-checker.ts` is invoked in the engine scan loop, that it queries the Gamma API successfully, that results are processed, and that `markMarketClosed()` + `closePosition()` + `insertResolution()` actually fire on resolved markets. Trace one specific resolved market end-to-end if possible.
- [ ] **R-2. Gamma API bulk query coverage** — is the resolution checker querying ALL of prod's open positions on every cycle, or only a subset? Pagination? Rate limiting? Silent partial responses?
- [ ] **R-3. Polymarket "closed" semantics** — Polymarket markets transition through several states: active → trading_closed → resolution_pending → resolved. The resolution checker may be filtering on the wrong state, or treating "trading_closed" as "not yet resolvable" when it should be checking if the UMA oracle has settled.
- [ ] **R-4. Multi-outcome market handling** — the prior session removed the CHECK constraint on resolutions to allow multi-outcome markets. Is the resolution checker actually parsing the winner correctly for non-binary markets? Or is it silently skipping them?
- [ ] **R-5. Cash credit on resolution** — when a position resolves WIN, is the payout actually credited to entity cash? Verify the entity-manager.ts updateBalances() path fires, that the SQL UPDATE commits, and that the next scan cycle sees the new balance.
- [ ] **R-6. Position not closing despite being resolved on-chain** — is there a wallet-state-vs-DB-state divergence? The v1 `auto_redeem.py` cron is still running on the VPS — does it interfere with v2's resolution handling? Could the v1 cron be redeeming positions on-chain while v2 thinks they're still open?
- [ ] **R-7. v_strategy_performance vs reality** — does the view's `total_resolutions` match the count of `resolutions` rows for prod's polybot entity? If not, the view is broken. If they match but real on-chain resolved positions aren't reflected, the resolution checker is broken.
- [ ] **R-8. The `lossless` cycle issue** — even if the resolution checker works, if it's running every 5 min on prod scan but the strategy advisor checks R&D every 10 min and the strategy weighter refreshes every 5 min on R&D, are we hitting a SQLite WAL contention issue where the read-only advisor lock blocks the resolution-checker write? `obra-defense-in-depth` and `obra-systematic-debugging` should be applied here.
- [ ] **R-9. Stale advisor data driving stale prod strategy assignment** — if the advisor is reading R&D's view and R&D's resolutions table is also lagging (only 831/11,245 resolved), the advisor is making promotion decisions on bad data. This compounds the resolution failure into a strategy failure.
- [ ] **R-10. Better solution proposals (in the improvement roadmap section)** — the audit must propose a *better* resolution mechanism, not just identify the bug. Candidates to evaluate:
  - **(a)** Direct on-chain reconciliation: query the wallet's `balanceOf` for each position's CTF (conditional token framework) ERC-1155 token ID via a Polygon RPC call, and treat zero balance as "redeemed." This is the source-of-truth approach.
  - **(b)** Polymarket Data API user positions endpoint: `data-api.polymarket.com/positions?user={proxy_wallet}` returns the wallet's actual open positions. If a position is in DB but not in this list, it's been redeemed. Reconcile periodically.
  - **(c)** UMA event subscription: listen to UMA OracleAncillaryProposed and Settled events on Polygon to know exactly when a market resolves, then trigger reconciliation immediately.
  - **(d)** Reuse v1 `auto_redeem.py`'s mechanism inside v2 (or replace v1 entirely): the v1 cron is presumably working since it's been running for months. Steal its logic.
  - **(e)** Accept that the Gamma API "closed" field is unreliable and add a fallback that uses position-age + market end_date to flag stale-open positions for manual review.

**This must be Section 4.1 (Trading Correctness — Position Resolution Pipeline) in the final report and called out in the executive summary.**

## Deliverable structure (harmonized: original prompt § "Phase 4" + new prompt § "Required Output Format")

Single canonical report at `Polymarket/docs/audit-2026-04-09.md` with these sections (in order):

1. **Skills Internalization Summary** (new prompt Step 1) — concise bulleted list of the most impactful new skills, grouped by category (Quant Trading, Polymarket-Specific, Code Quality, Security, Infra/Ops, Operational Discipline), with a one-line application note for each. Will be drafted at the start of the audit so the rest of the report can reference specific skills.
2. **Executive Summary** (1 page) — top 5 P0/P1 findings, recommended priority order, estimated remediation effort, risk if not addressed. **MUST lead with the Position Resolution Pipeline failure (R-1 through R-10) — this is the prod-blocking issue that explains why the system feels dead.**
3. **Current Trading Setup Overview** (new prompt Step 2 high-level) — what the system does today, capital posture, main strategies, performance baseline (Prod: 47 v2 trades / -$4.62 P&L; R&D: 11,245 trades / 831 resolutions / mostly losing). Map of components, two-engine model, intelligence loop.
4. **Trading Correctness Section** (P0 deep dive) — strategy-by-strategy, sizing math, execution safety, state management, longshot inversion verification, sub-strategy refactor verification, cash tracking race check
5. **Security Section** (P0 deep dive) — secrets, keys, VPS, supply chain, log hygiene, SSH key exposure verdict
6. **Backtesting & R&D Validity Section** — view correctness, advisor threshold defensibility, weighter math, sample-size critique
7. **Infrastructure Section** — systemd, deploy, monitoring, backup, DR, dependencies
8. **Code Quality Findings** — by category (clean code, error handling, async, testing, debt, the fix_*.py legacy)
9. **For each finding (across all sections):** severity (P0/P1/P2/P3), `file:line` evidence, root cause, recommended fix, estimated effort (S/M/L), dependencies on other findings, REBUILD-scope flag
10. **Detailed Audit Findings table** (new prompt Step 3) — comprehensive table view of every finding for cross-reference
11. **Prioritized Improvement Roadmap** (new prompt Step 4) — table with `Priority | Category | Description | Affected Areas | Effort | Dependencies | Expected Benefit`, grouped into Phase 1 (Critical Risk Fixes), Phase 2 (Edge Enhancement & Automation), Phase 3 (UX/Workflow), Phase 4 (Advanced Strategies & Scaling)
12. **Specific Recommendations & Implementation Guidance** (new prompt Step 5) — top 8-10 highest-priority items with concrete examples, pseudocode, suggested file edits, tied to specific new skills
13. **Quick Wins** — findings fixable in under an hour each
14. **Recommended Work Order** — what to fix first, what to batch with the rebuild, what to defer
15. **Immediate Next Steps** (new prompt Step 6) — first 3-5 tasks, exact files, what to implement first, validation steps
16. **Compliance Snapshot** — trade journal, tax records, regulatory posture
17. **Kill Switch & Safety Controls Inventory** — what's in place, what's missing, what should be added
18. **Out of Scope** — anything noticed but not audited, with justification
19. **Open Questions / Clarifications** (new prompt Step 7) — risk tolerance, capital size, target markets, time horizon, regulatory constraints, goals

Supporting files in `Polymarket/audit/2026-04-09/`:
- `A-trading-correctness.md` — Track A subagent raw findings
- `B-security-secrets.md` — Track B subagent raw findings
- `C-code-quality.md` — Track C subagent raw findings
- `D-infra-ops.md` — Track D subagent raw findings
- `E-backtest-rnd-validity.md` — Track E subagent raw findings
- `findings-index.csv` — every finding flattened to one row with severity, file, line, track, summary, status, REBUILD-scope-flag, effort

## Hard boundaries (replicated from original prompt — non-negotiable)

Trading systems handle money. Any violation is unacceptable.

- **Do NOT modify any source code** — audit only
- **Do NOT modify any configuration files** — including env vars, secrets, deploy config
- **Do NOT run any command that places an order** — even paper, even test, nothing
- **Do NOT enable live execution mode** under any circumstance
- **Do NOT increase any position limit, loss limit, or kill-switch threshold**
- **Do NOT disable any safety control** — circuit breakers, kill switches, rate limiters, gates
- **Do NOT deploy to the VPS** — not even a read-only inspection command unless I explicitly authorize each command
- **Do NOT connect to any exchange with credentials** — only read public market data if needed for validation
- **Do NOT modify wallet files, keystores, or vault entries**
- **Do NOT touch the R&D engine state** — allowed to run, you don't start, stop, or configure it
- **Do NOT install or upgrade any package**
- **Do NOT commit anything**
- **Do NOT run destructive git operations**
- **Do NOT exfiltrate any secrets** — if you see one, record "SECRET EXPOSED AT file:line — value redacted" and move on. Do not print the value.
- **Do NOT delete any historical fix_*.py / patch_*.py / nuke_*.py scripts** — they're evidence of the rebuild history and should be flagged in the audit, not removed during it

## Stop points (replicated from original prompt + adapted)

- **NOW** — you are reviewing this plan. Audit-plan-2026-04-09.md must be APPROVED before subagents are spawned. ExitPlanMode is the gate.
- **Before spawning subagents** — I will tell you exactly how many (5) and what each will investigate (already specified in the table above). I will spawn them in parallel in a single tool message.
- **Before any command that touches the VPS** — even `ssh -v` or read-only inspection. Per-command approval.
- **Before any command that touches a wallet, keystore, or vault** — never, unless you explicitly say so.
- **If a P0 finding implies immediate financial risk** — STOP the audit, surface the finding immediately, do not wait for the final report. Examples: exposed private key, live execution flag defaulting to true, missing kill switch, position limit not enforced, sizing bug multiplying by 1e18, state corruption in recovery path.
- **If exposed secret in workstation tree or git history** — STOP, surface, recommend rotation BEFORE any other work.
- **After Track A-E subagents return findings** — STOP. Synthesize into the unified report. Do NOT propose fixes. Wait for explicit signoff on a separate fix plan in a future session.
- **After Phase 4 deliverable (`audit-2026-04-09.md`) is complete** — STOP. No fixes until the report is reviewed together and a fix plan is signed off.

## File output locations (per CLAUDE.md §9 — NEVER place audit artifacts in /mnt/CLAUDE/ root)

- `Polymarket/docs/audit-plan-2026-04-09.md` — this audit plan, written **after approval** (the canonical location). The plans/mutable-sauteeing-fern.md file is the plan-mode working file only.
- `Polymarket/docs/audit-2026-04-09.md` — final unified deliverable
- `Polymarket/audit/2026-04-09/` — subagent raw outputs and supporting files
- `Polymarket/docs/lessons.md` — any corrections during the audit go here per CLAUDE.md §1B.3
- `Polymarket/docs/context.md`, `status.md`, `todo.md` — updated at session end per CLAUDE.md §9

## Effort estimate

- **Phase 0 (continuity + this plan):** complete
- **Phase 1 (audit plan written to canonical location after approval):** 2 minutes
- **Phase 2 (Skills Internalization Summary draft):** 15 minutes (one tool call)
- **Phase 3 (5 parallel subagents — Tracks A-E):** 30-60 minutes wall clock (subagents run in parallel, each takes ~30 min)
- **Phase 4 (synthesis into unified `audit-2026-04-09.md`):** 30-45 minutes
- **Phase 5 (improvement roadmap, recommendations, next steps):** 30 minutes
- **Phase 6 (update context.md / status.md / todo.md / lessons.md per CLAUDE.md §9):** 10 minutes

**Total wall-clock estimate after approval:** ~2-3 hours, with multiple stop points.

## Verification (how we know the audit is complete)

1. All 5 subagent files exist in `Polymarket/audit/2026-04-09/` and contain findings
2. `Polymarket/docs/audit-2026-04-09.md` contains all 19 sections from the deliverable structure
3. Every finding has: severity, file:line, root cause, recommended fix, effort, dependencies, REBUILD-scope flag
4. `findings-index.csv` lists every finding with cross-track references
5. No source code, config, wallet, vault, or VPS state has been modified — verifiable by `git status` (none, since not under git) and by file mtime inspection
6. Every claim about behavior is grounded in `file:line` citation or specific command output
7. No secrets are printed in any audit artifact
8. `lessons.md`, `context.md`, `status.md`, `todo.md` are updated to reflect the audit completion

## Open questions resolved before execution

Three blockers were asked and answered before exiting plan mode:

1. **SSH key (`Polymarket/deploy/armorstack_vps_key`) — TREATED AS P0 CRITICAL.** Working assumption: the key has been synced to OneDrive cloud and is recoverable from version history. The audit will recommend immediate rotation as the first remediation step. The audit will NOT touch the key during the run, only flag it. Audit Track B will document the exact exposure surface.
2. **Subagent strategy — 5 PARALLEL AS PROPOSED.** Tracks A-E will spawn in one parallel batch (single tool message, multiple tool calls). Each operates against read-only file inspection only.
3. **Deliverable scope — FINDINGS + ROADMAP + RECOMMENDATIONS, NO FIXES.** The full structured deliverable will be produced (all 19 sections including roadmap, recommendations, pseudocode for top 8-10) but zero fixes will execute. A separate session will follow for fix-plan signoff.

## Open questions deferred to the audit report (Section 19)

These were in the original plan-mode question batch but don't block execution. I will capture them in Section 19 of `audit-2026-04-09.md` for you to answer when reviewing the report:

1. Is the `Polymarket/deploy/armorstack_vps_key` SSH private key the only copy, or is there a backup elsewhere?
2. Is OneDrive sync currently enabled for the `Polymarket/` folder, and has it actually uploaded files in the `deploy/` subfolder?
3. What is the current target capital scale for Prod? Grow back to $257 first, or add capital and scale on advisor promotion?
4. What's the regulatory posture — personal speculation, or LLC entity (Caspian/Armorstack) on the wallet? Affects tax/journal section depth.
5. Are there any "off-limits" areas beyond the hard boundaries — e.g., the `R&D/` folder at the workspace root, or the historical March-era reports?

## Ready to proceed?

This plan respects:
- CLAUDE.md §9 Polymarket continuity protocol (read context/status/todo first, save artifacts under Polymarket/, update docs at session end)
- CLAUDE.md §1B Operational Discipline (plan mode default, root cause before recording finding, verification before completion, subagents for parallel investigation, REBUILD MODE awareness)
- The original audit prompt's hard boundaries and stop points (audit only, no fixes, no VPS commands without approval, no secret exfiltration)
- The new "Elite Polymarket Trading Expert" prompt's deliverable structure (Steps 1-4, structured output format, top 8-10 recommendations with implementation guidance, immediate next steps, open questions)

On approval, I will:
1. Copy this plan to `Polymarket/docs/audit-plan-2026-04-09.md` as the canonical location
2. Draft the Skills Internalization Summary (Step 1) as a standalone deliverable inside the audit folder
3. Spawn the 5 parallel subagents (Tracks A-E)
4. Synthesize findings into `Polymarket/docs/audit-2026-04-09.md`
5. Update `lessons.md` / `context.md` / `status.md` / `todo.md`
6. Stop. Wait for fix-plan signoff before any code change.
