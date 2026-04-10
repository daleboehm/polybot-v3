# Skills Internalization Summary — Polymarket Audit 2026-04-09

> Step 1 of the audit deliverable. Catalog source: `_Skills/skill-catalog-expansion-2026-04-09.md` (472 expansion + 64 core = 536 total). SKILL.md bodies are NOT pre-read — they load on demand during the audit.

This summary identifies the most impactful new skills for the Polymarket trading system, grouped by application category, and notes for each how it will improve edge detection, execution safety, automation reliability, or operational discipline. The goal is to make subsequent audit findings cite specific skills as authority.

---

## 1. Polymarket-Specific (the gold standards we will measure ourselves against)

These are the authoritative references for what a Polymarket trading system *should* look like. Our current implementation will be compared against them, and gaps become P0/P1 findings.

| Skill | Authority | Application to our system |
|---|---|---|
| **`polymarket-official-agent`** | OFFICIAL Polymarket/agent-skills repo | Compare CLOB client usage, auth pattern, market data fetch, position reads, paper trading toggle. If our code diverges from the official reference, the divergence is the finding. |
| **`polymarket-trading-expert`** | Pre-existing Armorstack skill (the rebuild's design intent) | The "north star" for what we said we'd build. Audit will compare actual implementation against the design intent. |
| **`polymarket-trading`** | Pre-existing Armorstack skill | Complete system design and deployment patterns. Reference for the dual-engine model. |
| **`polymarket-statguy-research`** | Read-only research orchestrator | We don't use this currently. Pattern for market/wallet/leaderboard lookup. Could power the advisor and replace ad-hoc curl calls. |
| **`mj-polymarket-paper-trader`** | Security-audited paper trading reference | THE gold standard for paper-vs-live separation. If our `mode: paper` flag check is weaker than this skill's pattern, that's a P0 finding. |
| **`mj-polymarket-analyzer`** | Market analysis patterns | Probability model patterns we may not have implemented. |
| **`mj-polymarket-monitor`** | Position monitoring patterns | Pattern for the Position Resolution Pipeline (R-1 through R-10). Likely contains the right way to detect resolution. |
| **`mj-polymarket-strategy-advisor`** | Non-executing strategy advisory | Pattern for our Strategy Advisor. Could validate our threshold logic. |
| **`mj-polymarket-scanner`** | Opportunity scanner | Pattern for the sampling-poller and signal-generation loop. |

**Critical for the Position Resolution issue:** `mj-polymarket-monitor` and `polymarket-official-agent` likely contain the canonical resolution-detection pattern. The audit should cite their approach when proposing R-10 fixes.

---

## 2. Quantitative Trading (the math that determines if we make money)

These skills validate whether our strategy logic, risk management, sizing, and analytics are mathematically correct.

### Strategy Framework & Validation

| Skill | Application |
|---|---|
| **`agi-strategy-framework`** | Standardized template for strategy definitions. Audit will compare our 8 strategies + 15 sub-strategies against this template — every strategy should declare entry conditions, exit conditions, risk profile, expected edge, calibration data. Most of our current strategies are heuristics with no formal specification. |
| **`agi-walk-forward-validation`** | Audit for overfitting / data leakage. **Critical finding driver:** we have ZERO walk-forward validation. The advisor's `≥5 resolutions / ≥50% WR / positive P&L` threshold is sample-size hacking, not statistical validation. This skill provides the framework to fix it. |
| **`agi-feature-engineering`** | Probability model construction. Our `model_prob` calculations in strategies are mostly heuristics (e.g., `marketPrice + 0.05`). This skill describes how to construct calibrated features. |
| **`agi-signal-classification`** | ML-based signal classifiers. Future state for replacing our hand-tuned price thresholds with learned models. |
| **`agi-regime-detection`** | Volatility regime identification. We don't currently distinguish between high-vol and low-vol regimes — favorites strategy treats every market the same regardless of time-to-resolution risk. |

### Risk Management

| Skill | Application |
|---|---|
| **`agi-risk-management`** | Portfolio-level risk controls, drawdown limits. Reference for the daily-loss-guard, max-position cap, and what's missing (correlation limits, sector caps, volatility caps). |
| **`agi-position-sizing`** | Trade sizing methods (fixed fractional, ATR-based, Kelly variants). Reference for the position-sizer.ts logic. |
| **`agi-kelly-criterion`** | Optimal Kelly with fractional adjustment. **We claim** to use fractional Kelly (0.25). Audit will verify the math in `position-sizer.ts` matches the reference. |
| **`agi-exit-strategies`** | Stop-loss, trailing stop, profit target patterns. Our v2 engine is BUY-only — no SELL/exit logic exists. This skill is the reference for adding it. |
| **`agi-slippage-modeling`** | Execution cost estimation. Our `paper-simulator.ts` applies a flat slippage_bps. This is unrealistic — slippage scales with order size vs depth. Skill provides the proper model. |
| **`agi-volatility-modeling`** | Volatility estimation and forecasting. Currently absent from our codebase. |

### Portfolio Analytics & Compliance

| Skill | Application |
|---|---|
| **`agi-portfolio-analytics`** | Sharpe, Sortino, Calmar, max drawdown. Our system computes raw P&L only. No risk-adjusted return metric exists. Audit will recommend adding these. |
| **`agi-trade-journal`** | Structured trade logging. Reference for whether our `trades` table captures everything needed for post-hoc analysis (entry rationale, model_prob, edge, pre-trade equity, etc.). |
| **`agi-trade-accounting`** | Double-entry bookkeeping. Useful for the cash-tracking-on-BUY race condition check. |
| **`agi-cost-basis-engine`** | Cost basis correctness for tax. Required if Polymarket is in a taxable account. |
| **`agi-wash-sale-detection`** | Wash sale detection under 2025 US crypto rules. Required for personal speculation accounts. |

### Behavioral & Edge Discovery

| Skill | Application |
|---|---|
| **`agi-mean-reversion`** | Mean-reversion strategy patterns. We have "mean_revert" listed in todo.md as a strategy to build — this is the reference. |
| **`agi-correlation-analysis`** | Cross-asset correlation. Our 200 favorites positions are probably highly correlated (all "favorites resolve") — this would tell us how much. |
| **`agi-cointegration-analysis`** | Pairs trading. Could power complement.cross_market_correlation. |

---

## 3. Operational Discipline (how to do the audit and the rebuild correctly)

The `obra-*` cluster maps 1:1 to CLAUDE.md §1B Operational Discipline. These skills define the *process* for the audit itself.

| Skill | Application |
|---|---|
| **`obra-systematic-debugging`** | Four-phase debugging framework. The Position Resolution Pipeline issue (R-1 through R-10) will be investigated using this framework — no proposed fixes until root cause is established. |
| **`obra-root-cause-tracing`** | Trace bugs backward through call chain. Will be used on the resolution failure. |
| **`obra-defense-in-depth`** | Validate at every layer data passes through. **Trading-system critical.** Will be applied to the entire data flow: ingest → normalize → signal → sizing → risk gate → execution → reconciliation. Each layer is an audit checkpoint. |
| **`obra-verification-before-completion`** | Every finding must cite `file:line` or command output. This is the audit's evidence standard. |
| **`obra-test-driven-development`** | Reference for what testing should look like. We currently have ZERO tests — this is a P1 finding. |
| **`obra-testing-anti-patterns`** | "Never test mocks, never test for the sake of coverage." Reference for how to write tests when we add them. |
| **`obra-condition-based-waiting`** | Async test reliability. Reference for integration tests. |
| **`obra-dispatching-parallel-agents`** | Multi-agent investigation. Used in this audit for the 5-track parallel structure. |
| **`obra-writing-plans`** | Detailed plan format. Used for this audit plan. |
| **`obra-executing-plans`** | Plan execution discipline. |
| **`obra-finishing-dev-branch`** | Structured completion. Reference for the rebuild's "done" criteria. |

---

## 4. Code Quality (the audit's inspection toolkit)

These skills define what "good TypeScript code" looks like and provide patterns for finding what's broken.

| Skill | Application |
|---|---|
| **`sk-vibe-code-auditor`** | Audit AI-generated code for structural flaws. **Critical for our system** — the entire v2 codebase was AI-assisted (per CLAUDE.md context). This skill is purpose-built for what we need. |
| **`sk-code-review-excellence`** | Code review discipline. |
| **`sk-clean-code`** | Clean code principles. |
| **`sk-fix-review`** | Verify fix commits actually closed their stated issues. **Critical** — the 40+ fix_*.py scripts in `polybot-v2/scripts/` need to be reviewed for whether they actually fixed the problem they claimed to fix, or just patched the symptom. |
| **`sk-typescript-pro`** | TypeScript-specific patterns. |
| **`sk-typescript-advanced-types`** | Advanced types. |
| **`sk-bug-hunter`** | Bug discovery patterns. |
| **`sk-error-detective`** | Error log analysis. |
| **`ar-adversarial-reviewer`** | Adversarial code review. **Used to critique every audit finding** before it lands in the report — finding has to survive an adversarial pass. |
| **`ar-code-reviewer`** | Code review automation for TypeScript. |
| **`ar-pr-review-expert`** | PR review patterns. |
| **`ar-tech-debt-tracker`** | Tech debt scoring. **Used to score the 40+ fix_*.py scripts.** |
| **`sk-debugging-strategies`** | Debugging frameworks. |
| **`sk-debugger`** | Debugger usage patterns. |

---

## 5. Security (extreme blast radius — wallet keys = money)

These skills define the security audit's checklist. Every finding here is potentially P0 because compromise = financial loss.

| Skill | Application |
|---|---|
| **`ar-env-secrets-manager`** | Secrets handling audit. Will check `.env`, env vars, and process memory exposure. |
| **`ar-secrets-vault-manager`** | Vault integration. Checks if we use one (we don't), and what the alternative is. |
| **`ar-skill-security-auditor`** | Security audit patterns. |
| **`ar-security-pen-testing`** | Pen testing framework. |
| **`ar-cloud-security`** | VPS hardening posture. |
| **`mcs-analyzing-sbom-for-supply-chain-vulnerabilities`** | NPM/SBOM audit. **Critical for crypto infra** — malicious npm packages have been used to steal wallet keys. |
| **`mcs-detecting-supply-chain-attacks-in-ci-cd`** | CI/CD compromise. We don't have CI/CD, but the deploy pipeline (manual SCP + ssh) is a similar attack surface. |
| **`mcs-hunting-for-supply-chain-compromise`** | Threat hunting for supply chain. |
| **`mcs-implementing-honeytokens-for-breach-detection`** | Deception controls. We have NONE on the wallet/API key layer. Audit will recommend adding canary tokens. |
| **`ar-dependency-auditor`** | npm audit. Check for known CVEs. |
| **`mcs-detecting-aws-cloudtrail-anomalies`** / **`mcs-implementing-cisa-zero-trust-maturity-model`** | Reference patterns even though we're on DigitalOcean, not AWS. |

---

## 6. Infrastructure & Operations

These skills define how production trading systems should be deployed, monitored, and recovered.

| Skill | Application |
|---|---|
| **`ar-observability-designer`** | Logs, metrics, tracing, alerting design. **We have logs only — no metrics, no tracing, no alerting.** This is the reference for adding them. |
| **`ar-runbook-generator`** | Runbook patterns. **We have ZERO runbooks.** Critical for incident response. |
| **`ar-ci-cd-pipeline-builder`** | Deployment safety. We deploy via manual `scp` + `tsc` + `systemctl restart` — no rollback path. |
| **`ar-docker-development`** | Container audit. We have a Dockerfile but it's unclear if it's used in production. |
| **`ar-performance-profiler`** | Latency-critical paths (order placement, market data ingestion). |
| **`backup-data-protection`** (pre-existing Armorstack) | VPS backup posture. |
| **`bcdr-planning`** (pre-existing Armorstack) | Disaster recovery for the trading engine. |
| **`ar-incident-response`** / **`ar-incident-commander`** | What to do when things break at 3am. |
| **`runbooks`** (workspace) | Runbook generation. |
| **`mcs-building-soc-playbook-for-ransomware`** | Reference pattern for any "what do we do if X" playbook. |
| **`mcs-implementing-zero-trust-network-access`** | ZTNA pattern. The current SSH-only access model could be hardened. |

---

## 7. Statistics & Analytics

| Skill | Application |
|---|---|
| **`ar-statistical-analyst`** | Hypothesis testing, A/B experiment analysis, confidence intervals. **Will be used to compute the binomial confidence interval** on the advisor's "≥5 resolutions / ≥50% WR" threshold and demonstrate why it's a sample-size trap. |

---

## 8. Database & Storage

| Skill | Application |
|---|---|
| **`sk-postgres-best-practices`** | We use SQLite, but the Postgres patterns translate. WAL mode, busy_timeout, indexing. |
| **`sk-sql-optimization-patterns`** | Query optimization. Our `v_strategy_performance` view does triple-LEFT-JOIN which may be slow at scale. |
| **`ar-database-schema-designer`** | Schema design review. Will check our foreign keys, indexes, normalization. |

---

## How these skills integrate into the audit

The 5 parallel subagent tracks (A-E) each load a subset of the relevant skills on demand:

- **Track A (Trading correctness)**: agi-strategy-framework, agi-risk-management, agi-position-sizing, agi-kelly-criterion, agi-exit-strategies, agi-slippage-modeling, agi-walk-forward-validation, polymarket-official-agent, polymarket-trading-expert, mj-polymarket-paper-trader, mj-polymarket-monitor, obra-defense-in-depth, obra-systematic-debugging, obra-root-cause-tracing
- **Track B (Security)**: ar-env-secrets-manager, ar-secrets-vault-manager, ar-skill-security-auditor, ar-security-pen-testing, ar-cloud-security, sk-vibe-code-auditor, mcs-analyzing-sbom-for-supply-chain-vulnerabilities, mcs-detecting-supply-chain-attacks-in-ci-cd, mcs-hunting-for-supply-chain-compromise, mcs-implementing-honeytokens-for-breach-detection, ar-dependency-auditor
- **Track C (Code quality)**: sk-vibe-code-auditor, sk-code-review-excellence, sk-clean-code, sk-fix-review, sk-typescript-pro, sk-typescript-advanced-types, sk-bug-hunter, sk-error-detective, ar-adversarial-reviewer, ar-code-reviewer, ar-tech-debt-tracker, ar-pr-review-expert
- **Track D (Infra/ops)**: ar-observability-designer, ar-runbook-generator, ar-ci-cd-pipeline-builder, ar-docker-development, ar-performance-profiler, backup-data-protection, bcdr-planning, ar-incident-response, ar-incident-commander, ar-cloud-security, runbooks
- **Track E (Backtest/R&D validity)**: agi-walk-forward-validation, agi-strategy-framework, agi-portfolio-analytics, agi-position-sizing, agi-kelly-criterion, agi-feature-engineering, polymarket-statguy-research, mj-polymarket-strategy-advisor, obra-verification-before-completion, ar-statistical-analyst

**Application Note:** Each subagent will load its skills via the Skill tool ON DEMAND when it actually needs the SKILL.md body. Skills are NOT pre-loaded — that would burn context for material we may not need.

---

## What the new skills give us that we don't have today

| Capability we lack | Skill that provides the pattern | Priority |
|---|---|---|
| Walk-forward validation of strategies | `agi-walk-forward-validation` | P0 — current advisor thresholds are statistically meaningless |
| Position resolution detection (the prod-blocking issue) | `mj-polymarket-monitor`, `polymarket-official-agent` | P0 |
| Slippage that scales with depth | `agi-slippage-modeling` | P1 — paper P&L overstates live viability |
| Brier score / calibration tracking | `agi-strategy-framework`, `ar-statistical-analyst` | P1 |
| Sharpe / Sortino / drawdown reporting | `agi-portfolio-analytics` | P1 |
| Exit / SELL logic | `agi-exit-strategies` | P1 — engine is BUY-only |
| Supply chain audit on npm packages | `mcs-analyzing-sbom-for-supply-chain-vulnerabilities`, `ar-dependency-auditor` | P0 |
| Wallet key honeytokens | `mcs-implementing-honeytokens-for-breach-detection` | P2 |
| Observability stack (metrics + alerting) | `ar-observability-designer` | P1 |
| Runbooks for incidents | `ar-runbook-generator` | P1 |
| Tests of any kind | `obra-test-driven-development`, `obra-testing-anti-patterns` | P1 |
| Mean reversion strategy | `agi-mean-reversion` | P2 |
| Correlation analysis across positions | `agi-correlation-analysis`, `agi-cointegration-analysis` | P2 |
| Volatility regime detection | `agi-regime-detection`, `agi-volatility-modeling` | P2 |
| Vault for secrets | `ar-secrets-vault-manager` | P1 |
| CI/CD with rollback | `ar-ci-cd-pipeline-builder` | P2 |
| Statistical hypothesis testing for advisor decisions | `ar-statistical-analyst` | P0 (advisor logic correctness) |

---

*End of Skills Internalization Summary. Used as input to Tracks A-E and Section 1 of the unified audit report.*
