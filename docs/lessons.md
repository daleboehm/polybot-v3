# Polymarket — Lessons Learned

> Session-to-session corrections Claude should carry forward. Per CLAUDE.md §1B.3: update on every correction; review at session start.

## 2026-04-10 (late — deploy + stabilization session)

### Lesson: Workstation src is THE source of truth. Never hot-patch dist/.

**What happened**: During an urgent fee-scaling bugfix, I hot-patched `/opt/polybot-v3/dist/execution/paper-simulator.js` directly to unblock R&D. Fix worked. But the workstation `.ts` and VPS `src/.ts` were also edited. On the NEXT rebuild the following day, the same fee bug re-appeared because one of the three layers had drifted — the VPS `src/` I'd updated wasn't the same one that got rebuilt by `npm run build`. Dale called it out: *"this is where we get into trouble. Performing js patches just stacks the issues."*

**Rule**: Every code change goes through the full chain: edit workstation `src/` → `scp` to `/opt/polybot-v3/src/` → `cd /opt/polybot-v3 && npm run build` → `rsync -a --delete dist/ /opt/polybot-v3-rd/dist/` → `systemctl restart polybot-v3 polybot-v3-rd`. The canonical flow is documented in `Polymarket/docs/deploy.md`. Do not deviate. Do not hot-patch `dist/` as a shortcut. If the bleeding needs to be stopped immediately, hot-patch `dist/` as step 1 of a 5-step sequence that still updates `src/` in the same session.

**Why**: Three layers drift silently when you edit only one. The only way to prove dist matches intent is to rebuild from src. `diff -q` the workstation `.ts` against the VPS `.ts` after each scp, and `grep` the dist `.js` after each build.

**How to apply**: When Dale says "ship X", the check is always: (1) workstation src updated? (2) VPS src matches workstation? (3) dist rebuilt? (4) prod dist rsync'd to R&D dist? (5) services restarted? (6) fix verified in logs? All six or it's not shipped.

### Lesson: Polymarket CLOB `taker_base_fee` is a scaled integer, not a decimal.

**What happened**: The `paper-simulator.ts` fee model was "fixed" in the morning to read `market.taker_fee` from the market cache instead of hardcoding 2%. That "fix" multiplied raw `taker_base_fee: 1000` (returned by the CLOB API for 1,641 of 6,288 markets) as if it were a decimal. Result: a $51.48 paper trade got charged a $51,479 fee. R&D cash drained to 0 in one cycle, daily-loss-guard fired 100% drawdown, kill switch halted prod. The workstation trader sat at cash=$0 and 40 positions with $13K phantom cost basis for an hour before I traced it.

**Rule**: Polymarket's actual mainnet CLOB taker fee is ZERO today. The `taker_base_fee` field returned by `GET /sampling-markets` is a **raw integer** (bps × 10? tenths of bps? Polymarket's docs are not clear). Until the correct scaling factor is verified against Polymarket's docs or source, hard-code `feeRate = 0` in both `paper-simulator.ts` and `clob-router.ts`. When Polymarket eventually turns fees on, update the constant AFTER verifying the scaling factor against a known fee value.

**Why**: The assumption "read the field, it's a fraction" is wrong and silent. No type error, no alert — just phantom $51K fees that look like cash drainage. The only defense is (a) hardcode 0 and acknowledge the staleness, OR (b) validate the value explicitly: `if (rawFee > 1) { log.error(...); feeRate = 0 }`.

**How to apply**: Never multiply any API-sourced numeric field by a dollar amount without verifying its units. For any field named `*_fee`, `*_rate`, `*_price`: read the Polymarket docs or trace one known value through the pipeline before trusting it.

### Lesson: Equity = cash + reserve + open-position market value. NOT cash alone.

**What happened**: The `portfolio-risk.ts` `updateDrawdown()` check was being called with `equity = entity.cash_balance + entity.reserve_balance`, which ignored open position values entirely. Every time the engine bought a position, cash dropped by $X but positions weren't counted back — computed "drawdown" spiked even though true equity was flat. Prod kill switch fired at 72.2% drawdown when the actual drawdown was ~4%. Dale's engines repeatedly halted themselves for no real reason.

**Rule**: `currentEquity = cash_balance + reserve_balance + Σ(position.size × position.current_price)` for all open positions. Always. Anywhere equity is computed — drawdown guards, high-water-mark tracking, snapshot writes, dashboard totals.

**Why**: Cash alone is not equity. It's "cash on hand before resolving open bets." Treating cash as equity punishes the engine for every buy.

**How to apply**: Grep the codebase for `cash_balance +` and audit every occurrence. If the result is used in an equity or drawdown computation, it must ALSO include open position market value. Prefer a single helper function `computeEquity(entity)` so there's one correct formula in one place (R3b cleanup item).

### Lesson: `upsertPosition` ON CONFLICT clauses are contamination landmines.

**What happened**: The positions table has `UNIQUE(entity_slug, condition_id, token_id)` and `upsertPosition` used ON CONFLICT DO UPDATE with `sub_strategy_id = excluded.sub_strategy_id` but NOT `strategy_id`. When two strategies fired on the same (condition, token) across different scan cycles, the second fill's upsert overwrote `sub_strategy_id` but kept `strategy_id`, producing impossible pairs like `favorites|bucketed_fade` and `longshot|compounding` in the positions table. Signals were clean; positions were contaminated. The learning loop would have misattributed P&L to whichever strategy happened to fill last.

**Rule**: When a conflict resolution needs to preserve ownership, the UPDATE clause must NOT touch owner fields. For `positions`: strategy_id and sub_strategy_id are ownership fields. Only size/cost/price/updated_at should change on conflict. If you need to "add to a position" with accumulation math (weighted avg price, size += new size), that's a separate explicit function — don't overload upsert.

**How to apply**: Every time you write or audit an UPSERT: list the columns the UPDATE clause mutates. Is any of them an identity or ownership field? If yes, stop — use a dedicated add/merge function that makes the intent explicit.

### Lesson: Every strategy needs the existingPositions DB check. Audit them all.

**What happened**: `longshot.ts` was missing the `ctx.getOpenPositions(slug).map(p => p.condition_id)` check that every other strategy had. It silently generated signals for markets where favorites or convergence already held positions. Those signals then passed through the risk engine and filled, and the upsertPosition contamination bug did the rest. The fix was a 4-line addition, but finding it required tracing a specific contaminated position back through the trade timestamps to realize longshot had generated a signal at T+2 minutes on a market that favorites had opened at T+0.

**Rule**: Every `BaseStrategy.evaluate()` implementation must start with the existing-positions check:
```typescript
const existingPositions = new Set(
  ctx.getOpenPositions(ctx.entity.config.slug).map(p => p.condition_id),
);
// then in the loop:
if (existingPositions.has(market.condition_id)) continue;
```
No exceptions. Audit every strategy in `src/strategy/custom/` after adding a new one.

**How to apply**: Add a BaseStrategy method `getExistingConditions(ctx): Set<string>` so the check becomes one line and hard to forget. (R3b cleanup.)

### Lesson: Paper-mode entities need their own resolution mechanism. Reconciler is live-only.

**What happened**: After deploying v3, the paper-mode R&D engine ran for hours opening paper positions but never closing them. The advisor and weighter had zero resolution data, because `on-chain-reconciler.ts` is live-mode only (it queries the Data API against a proxy wallet, which paper entities don't have). The "learn and evolve" claim was hollow until I discovered the gap and built `paper-resolver.ts`, which polls CLOB `/markets/{condition_id}` per open paper position and closes on `tokens[].winner` flag.

**Rule**: Any subsystem that handles position lifecycle needs to cover both live and paper modes OR explicitly delegate one to the other. Live: `on-chain-reconciler.ts`. Paper: `paper-resolver.ts`. Both are wired into `engine.ts` scan cycle; both emit `position:resolved` events; both feed `dailyLossGuard.recordPnl()` with realized P&L (NOT gross cash).

**How to apply**: When designing any feature that touches positions, trades, or cash, write down the lifecycle path for both modes on paper before coding. If only one path exists, the other is a hidden bug.

### Lesson: Signal generation without dedup = strategy monopolization.

**What happened**: The initial `evaluate()` loop iterated strategies in config order and processed each strategy's full signal list before moving to the next. Favorites generates 4,000+ signals per cycle; longshot generates 2,000+. By the time longshot's turn came, cash was already exhausted by favorites. The dashboard showed 797 favorites positions and 0 longshot/convergence — no coverage across strategies, so no learning across strategies. My fix was Fisher-Yates shuffling ALL signals across strategies before processing, then de-duping per `(condition_id, token_id)` within the cycle so two strategies can't both fill the same slot.

**Rule**: Any "fair allocation" across N sources that share a finite resource (cash, slots, API quota) needs (a) uniform-random ordering of items across sources before serialization, AND (b) de-dup/exclusion after serialization so items at the head don't steal from items at the tail. Without both, the source with the most items monopolizes the resource.

**How to apply**: Pattern for any multi-producer-single-consumer loop: collect all items → shuffle → process with in-cycle dedup tracking. Don't iterate producers serially.

### Lesson: Dale decides rotation. Claude does not.

**What happened**: During the secrets audit, I reflexively recommended rotating all 5 credential sets (wallet privkey, CLOB trio, GitHub PAT, dashboard password, SSH key). Dale explicitly refused: "I'm not changing keys at this point because they were in clear text in OneDrive where nobody but me can see them ... you are wasting my time and money."

**Rule**: Never assume a credential in cleartext = public disclosure = mandatory rotation. The exposure surface matters. OneDrive-synced cleartext in a solo-owned account is a cloud-replication risk (version history, device sync, backup tools) but **not** an external leak. Rotation is expensive (wallet sweep gas, position unwind, re-registration). Claude surfaces the risk and its mitigation options; Dale decides whether to rotate.

**Why**: A solid security posture is not "rotate everything on every finding." It's "understand the surface, present the options, defer the tradeoff to the principal." Claude pushing rotation without authorization burns Dale's time and money and erodes trust.

**How to apply**: When finding a cleartext secret, do these in order:
1. Redact it from the file (replace with env-var load or placeholder)
2. Point the file at the vault README
3. Document the exposure surface (what touched it)
4. Present rotation as an *option* with cost estimates
5. **Wait for Dale's explicit decision before recommending rotation as the remediation**

### Lesson: "Leaked" is the wrong word for cleartext in a private workspace.

**What happened**: I used "leaked" repeatedly in the audit prose. Dale corrected: "They weren't leaked. This is where they were stored when you were building this."

**Rule**: "Leaked" implies external disclosure. The right phrasing for cleartext in a private OneDrive tree is "stored in cleartext in a location they should not hold credentials" or "sitting in a sync surface." Reserve "leaked" for actual external disclosure events (GitHub commit, pastebin, screenshot, public support ticket, attacker exfil).

**How to apply**: Calibrate the vocabulary to the actual threat. "Breach", "leak", "disclosure", "exposure", "exposure surface", and "cleartext in a sync surface" are **not interchangeable**. Be specific about what actually happened.

### Lesson: Redact in the sweep first, then sweep again with distinctive value patterns.

**What happened**: The initial redaction pass found 6 files. I declared it complete. Then a targeted Grep for specific leaked values found 2 more (RUN_TRADES.py, local_sprint_trader.py). Then another sweep for a distinctive dashboard password fragment found 4 more. Three passes total.

**Rule**: A redaction sweep is never "done" until you've tried at least three orthogonal search strategies: (a) heuristic file-type/directory walk, (b) regex for the credential *pattern* (e.g., `0x[0-9a-f]{64}` for eth privkeys, `github_pat_`, `BEGIN OPENSSH PRIVATE KEY`), (c) substring search for specific distinctive fragments of each known cleartext value. If any of the three produces new hits, run the others again until all three are clean.

**How to apply**: Plan redaction passes as iterations. Don't declare done after the first pass.

### Lesson: When Dale says "pause everything," the continuity docs must reflect it immediately.

**What happened**: Dale said to pause both engines during the audit. The audit continued but status.md still said "Prod Engine — ACTIVE (LIVE TRADING)" for hours until Phase 6.

**Rule**: Any state change Dale directs (pause, stop, resume, fund, rotate) is a state-of-the-world change, not a task to batch with "documentation updates at session end." Update `status.md` within one response of the directive.

**How to apply**: When Dale says "pause", "stop", "resume", "lock", "unlock", "halt", "enable", or similar verbs that change the system's live state: update status.md on the next tool turn, before doing anything else on the task.

### Lesson: Audit artifacts go in `Polymarket/audit/<date>/`, not CLAUDE root.

**What happened**: I wanted to put findings files in the workspace root or in a session-local directory. CLAUDE.md §9 is explicit: NEVER place Polymarket artifacts in `/mnt/CLAUDE/` root.

**Rule**: All Polymarket artifacts — audit findings, reports, analyses, docs, runbooks, vault READMEs, strategy research — live under `Polymarket/`. Use subfolders (`docs/`, `audit/<date>/`, `polybot-v3/`, `scripts/`, etc.) liberally, but never spill to the workspace root.

**How to apply**: Before `Write`-ing any file, verify the target path begins with `Polymarket/`. If I catch myself writing to the workspace root or a generic `sessions/` folder, stop and re-route.

### Lesson: The audit subagent approach is the right pattern for large, parallelizable read-only investigations.

**What worked**: 5 parallel subagents, each with a specific track and a specific skill cluster, produced 179 findings in ~30 minutes wall clock. Main context stayed clean. Each subagent cited evidence at `file:line`. Synthesis was straightforward because the raw files were pre-structured.

**Rule**: For any task that (a) is read-only, (b) is parallelizable along orthogonal dimensions, (c) would consume >50% of main context if run serially, spawn subagents in a single tool message. Specify track scope + skills loaded + output file in each prompt.

**How to apply**: Default to subagents for audits, cross-repo searches, large refactoring plans, multi-file investigations. Use main context only for synthesis, decisions, and edits.

### Lesson: Strategy weighter is R&D-only AND its purpose is cash preservation, not alpha promotion.

**What happened**: Drafting the rebuild plan (spicy-puzzling-robin.md), I framed the R&D strategy weighter as a "performance-weighted position sizer that scales winners up and losers down" and proposed a 0.25 default for brand-new sub-strategies. Dale corrected twice in one turn: (a) "The weighting is only for the R&D Engine" and (b) "It's a cash preservation mechanism to keep buying in all categories for analytical purposes but to reduce loss while doing so."

**Rule**: The R&D strategy weighter's job is to keep R&D trading across *all* 8 strategies × 15+ sub-strategies so the research engine produces resolution data across the full strategy space — while reducing bet size on known-underperforming subs so paper cash isn't burned exploring dead ends. It is a **cash-rationing / coverage-preservation** device, not a signal-promotion device. Signal promotion to prod is the **advisor's** job, which runs on the prod engine and reads R&D's view. Two separate mechanisms, two separate purposes.

**Why**: If the weighter ever zeroes a sub-strategy's weight, that sub stops producing resolution data and becomes a blind spot in the exploration map. R&D is valuable precisely because it covers the whole strategy space. Undersizing a brand-new sub at 0.25 would punish exploration of fresh ideas before they have any data to defend themselves. The corrected pattern: **floor at 0.1, default new-sub weight 1.0, bound [0.1, 2.0], track exploration coverage explicitly**.

**How to apply**:
1. When planning anything that touches the weighter, restate the purpose in the opening sentence: "keep all subs active for coverage, reduce bet size on bad subs, do not promote."
2. Prod does not use the weighter. Any "disable the weighter if bad perf" logic is R&D-only.
3. Exploration coverage is the weighter's success metric. P&L is the advisor's success metric. Do not conflate them.
4. Any new-sub default weight below 1.0 is almost certainly wrong — it starves exploration. Default is 1.0 until data exists.
5. Zero as a weight is a bug, not a feature. Floor the weighter at a small positive value (e.g., 0.1) so every sub keeps producing at least one data point per cycle.

### Lesson: Dale's system is a family-office debt-strategy staggered fleet, not solo speculation.

**What happened**: Throughout the audit and initial rebuild plan I framed the Polymarket engine as a single-account speculative trader. During the 7-item walk (2026-04-10) Dale corrected this twice: first flagging that the 16 entities map to real legal/business wrappers (Armorstack sub-accounts, family trusts, education funds, etc.), and then revealing the actual architecture — **staggered scanning across all 16 entities to achieve ~19-second effective scan density on Polymarket**, with pooled profits feeding a central treasury that services Caspian's $2.5M debt. Entities are currently arbitrary placeholder names; they'll become meaningful legal structures later.

**Rule**: The Polymarket trading engine is part of a multi-year **family-office debt-repayment + business-growth strategy**, not a hobby trader's research project. The rebuild must be designed for a staggered-scan fleet with pooled treasury, per-entity tax tracking, and long-horizon compounding. The audit's §16 Compliance Snapshot assumption of "personal speculation" was wrong.

**Why this matters**: Multi-entity architecture moves from "R4 nice-to-have" to R3 first-class scope. Per-entity tax accounting is required, not optional. Fleet-level correlation tracking matters because 16 entities trading the same markets = one correlated bet. Capital allocation between entities is a central treasury pattern, not sequential funding. Offshore migration (Cook Islands / Nevis) is a planned future state, parked in `docs/regulatory-posture-holding.md` until triggered.

**How to apply**:
1. **Default assumption**: any architectural question about "how many entities" or "how does capital flow" defaults to "staggered fleet with pooled treasury," not "single account."
2. **Tax tracking per entity is mandatory** — when building any accounting or reporting surface, per-entity slicing is the default, not the exception.
3. **Regulatory posture**: do NOT design compliance sleeves, KYC integrations, or US-regulated venue adapters unless Dale explicitly requests. Amsterdam VPS bypass is intentional. Cook Islands/Nevis migration is the endgame.
4. **Fleet features can be built dormant** — staggered scheduler, anti-self-bidding, treasury, cross-entity risk all get built in R3 but stay feature-flagged off until Dale funds Entity 2. This lets the infrastructure land without premature activation.
5. **Dale funds iteratively, never on an auto-trigger** — capital milestones are set by Dale in response to proven system performance, not by code thresholds.

### Lesson: Rewrites can lose edge. Always catalog the old codebase before rebuilding from scratch.

**What happened**: During the 2026-04-10 rebuild plan, I discovered that the v1 Python codebase in `Polymarket/scripts/simulator/` contains significant signal-processing infrastructure that was NOT ported to the v2 TypeScript rebuild. Specifically: Kalshi + Manifold + Metaculus + PredictIt + Odds API + FRED + CoinGecko integrations, plus modules for base-rate calibration (`base_rate_db.py`), Brier calibration (`calibration_engine.py`), correlation tracking (`correlation_tracker.py`), ensemble forecasting (`ensemble_forecaster.py`), LMSR market making (`lmsr_engine.py`), and ~20 others. I was about to build several of these from scratch in R2/R3 before noticing they already exist.

**Rule**: **Before rebuilding any subsystem from scratch, grep the entire codebase (including legacy directories) for prior implementations of the same concept.** The v2 rebuild of polybot may have lost edge relative to the v1 Python engine, not added it. A rewrite is valuable for architecture and code quality; it is a LIABILITY for accumulated domain knowledge if you don't port the existing signal-processing logic forward.

**Why**: Rewrites that start from the same mental model as the original author produce similar code. Rewrites that start from a clean slate lose the lessons encoded in the original's edge cases and tuning constants. The v1 Python code has ~50 modules of trial-and-error learning; the v2 TypeScript rewrite has 5 data feeds and tautological `model_prob = price + constant` strategy models. That's a step backward, masked by the v2 being cleaner code.

**How to apply**:
1. **For any R2/R3/R4 module I'm about to build**, first `grep -r "<concept>" Polymarket/scripts/ Polymarket/references/` to find prior implementations.
2. **Dispatch the v1→v2 gap analysis subagent as scheduled during R2** — catalog every Python module in `scripts/simulator/` and flag which ones have logic worth porting. Result feeds directly into R2/R3 scope decisions.
3. **Default to porting over rebuilding** when an existing module works. Port cost is typically 30-50% of rebuild cost and preserves tuning constants that took iterations to find.
4. **Read the comment headers of existing files** — authors often document the edge they found. The v1 `strategy-weighter.ts` line 2 comment ("High performers get full/boosted sizing, low performers get minimum sizing for data collection") had the correct framing that the audit got wrong. Comments are documentation of intent; don't skip them.

### Lesson: Telegram chat_id is a runtime capture, not a config value.

**What happened**: During the 7-item walk (2026-04-10), Dale provided `@dale_boehm` as his Telegram chat identifier. I noted that Telegram's Bot API requires a numeric `chat_id` (e.g., `123456789`), not a username. Bots cannot resolve usernames to IDs — it's a Telegram privacy feature. The numeric chat_id is captured when the user messages the bot for the first time.

**Rule**: When wiring any Telegram bot for operator alerts, the setup has a **mandatory one-time operator handshake**: (1) create the bot via `@BotFather`, (2) operator messages the bot once with `/start`, (3) bot reads the message's `from.id` field and stores it as the chat_id. The username is just a human-readable label for "whose bot is this," not a functional address.

**Why**: Claude or any future maintainer will attempt to configure Telegram alerts with the username and fail silently. The bot will attempt to `sendMessage(chat_id="@dale_boehm")` and either error or send to nothing. Alerts will be missing at the exact moment they're needed.

**How to apply**:
1. **In any R3b alerting config schema**, define `telegram_chat_id: string` (not `telegram_username`). Add a comment: "numeric chat_id captured from bot's first /start message, NOT the user's @username."
2. **In the R3b setup runbook**, include a step: "Dale messages the bot once from Telegram; runbook operator reads the bot's stdout log, copies the numeric chat_id, pastes into `telegram_chat_id` in the alert config, restarts the alerter."
3. **The bot creation step** (via @BotFather) produces a bot token that IS a secret — it goes into the vault, not into a config file in OneDrive.
4. **Fallback identification**: if the chat_id is ever lost, operator can re-send `/start` and the bot re-captures it on the next restart.

### Lesson: Write code that doesn't need a compiler, but still run the compiler when you can.

**What happened**: During the 2026-04-10 R1+R2 implementation session, Node.js was not installed on the workstation, so `npm install && npm run typecheck` couldn't be run locally after writing ~15 TypeScript files worth of changes (R1 PR#1, R1 PR#2, R2 PR#1, R2 PR#2 core). The code was written carefully with explicit types, grep-verified imports, and known-good patterns — but shipped without compiler verification.

**Rule**: When you're building on a workstation without a toolchain, optimize for first-pass compile correctness:
1. Batch-read every file you'll edit BEFORE writing anything, so your mental type-checker sees the same thing the compiler will
2. Prefer `import type { ... }` for type-only imports (avoids runtime circular dep issues)
3. When adding a new event/method to a typed system (e.g., `EngineEvents`, `Signal`), inline the type definition rather than cross-importing (avoids circular import cycles)
4. Watch for unreachable branches (audit your conditionals for dead code)
5. Watch for non-null assertions (`!`) and prefer explicit `if (x)` guards
6. Flag the "no local typecheck" gap loudly in session docs so the next session knows to install Node first

**Why**: A rebuild session without a compiler is a minefield — you can ship syntactically plausible code with type holes the next session has to fix. The time spent installing Node and running typecheck once is almost always less than the time spent debugging the first deploy failure.

**How to apply**:
1. At session start, check if `node --version` works. If not, flag it as the first thing to fix OR accept the "write-without-verification" risk and document it loudly.
2. At every 5-file-change checkpoint, mentally review: do all my imports resolve? Are all type parameters satisfied? Did I create any circular deps?
3. At session end, the final "update session docs" step MUST include a "here's what was touched without verification" list so the next session can run typecheck and fix any fallout efficiently.
4. Prefer narrow, targeted Edit calls over broad Write rewrites — narrower edits have less surface area to get wrong.

### Lesson: When Dale says "both engines live," the R&D-mode detection can't key off paper vs live.

**What happened**: The pre-rebuild engine detected R&D mode with `const isRdMode = !config.entities.some(e => e.mode === 'live')` — "no live entities = this is the R&D engine." When Dale directed both engines into live mode at the end of the rebuild session, that heuristic silently broke — R&D's entity became `mode: live`, so `isRdMode` became false, and the R&D engine STOPPED enabling the strategy weighter, which is the entire point of the R&D engine's existence.

**Rule**: Engine identity (prod vs R&D) is NOT the same as wallet-funding mode (paper vs live). Once both engines run live capital, the only reliable way to distinguish them is an explicit tag — in v3, that's the `BASE_PATH` environment variable set by the R&D systemd unit to `/rd`. The weighter-enable check now keys off `process.env.BASE_PATH === '/rd'` so it stays active on R&D regardless of capital mode.

**Why this matters**: the R&D engine's purpose is exploration coverage across the full strategy space — keep every sub-strategy producing resolutions so the fleet has signal to act on, even when individual subs are underperforming. Disabling the weighter on R&D would be a silent regression that wouldn't surface until someone noticed that Avoid-tier subs had stopped producing data.

**How to apply**:
1. Never infer engine identity from capital-mode flags. Use a dedicated env var or systemd unit identifier.
2. When two engines share a codebase but have different behaviors, document the detection key at the point where the behavior branches (in v3: `const isRdMode = ...` with a comment explaining why).
3. If you rename, remove, or add a live/paper flag, grep for ALL branching logic that depends on it and re-verify each branch.

### Lesson: "Finish the entire rebuild" = scaffolds for R4, not production R4.

**What happened**: When Dale said "finish the entire rebuild" in the 2026-04-10 Opus 4.6 session, R4 (KMS signing, market-maker, cross-exchange arb) was originally scoped as a 6-week-plus milestone to happen after R3c stability. The session compressed everything into one pass. R4 modules were built as SCAFFOLDS with clear "not wired" / "throws on execute()" markers and activation runbook comments in the file headers.

**Rule**: R4 features should ship as scaffolds in the rebuild tree with the interface defined and the activation plan documented, but with the hard execution paths explicitly marked as not-yet-wired. This lets the architecture support them without forcing full production readiness on features that need operator decisions (AWS KMS vendor vs Fireblocks, first market-maker market pair, arb execution recovery mode, etc.).

**How to apply**:
1. Every R4 scaffold file has a header comment that ends with "**SCAFFOLD ONLY** — activation plan: ..."
2. `execute()` / `signTransaction()` / similar hot-path methods THROW with a clear message rather than return fake data
3. Dynamic-import dependencies at activation time so the scaffold doesn't pull unused npm deps
4. Document what the operator has to do to activate (environment variables, VPS runbook steps, initial capital requirement) in the file header
5. When the scaffold is activated in a future session, the diff is small and obvious — swap the throw for real logic, flip a feature flag, add the dependency to package.json.

### Lesson: Every long-lived server accumulates "legacy ballast" — hunt it before it accumulates.

**What happened (2026-04-10 evening cleanup pass)**: The VPS had 31 GB of v1 Python legacy at `/opt/polybot/` (mostly old market cache files + backups), 286 MB at `/opt/polybot-v2/`, 119 MB at `/opt/polybot-v2-rd/`, and ~15 small `/opt/{entity}/` directories with encrypted wallet stubs from a never-activated multi-entity setup. Each piece had a good reason to exist at the time — but all together they made the system harder to reason about and introduced latent reference risks (e.g., `config/entities.yaml` still pointed `entity_path: /opt/polybot` and the runtime depended on a symlink chain through v1 directories). Also found: plaintext API keys (`FRED_API_KEY`, `ODDS_API_KEY`, `METACULUS_TOKEN`) still sitting in the root crontab from a previous era even though they'd been moved to `/opt/polybot-v3/.env` weeks earlier.

**Rule**: When you migrate a feature from v1 → v2 → v3, don't just stop calling the old code — delete it. If the old code contains secrets or touches sensitive paths, migrate the secrets first (to a new location that matches the new naming), then delete the old code AND its secret locations. "I'll clean it up later" never happens.

**Why**: Legacy ballast is not neutral. It grows audit scope, it hides latent runtime dependencies (like the `/opt/polybot` symlink chain), it gives attackers more attack surface, and it makes every future "what does this do?" question take longer to answer.

**How to apply**: Any session that ships a v1 → v2 migration (or similar) MUST include a deletion commit in the same session OR a dated deletion reminder in `todo.md`. The deletion reminder must include: (1) file paths to remove, (2) any secret/credential relocation prerequisites, (3) a systemd/cron survey to catch auto-start references before the deletion. The rebuild plan's R3c cleanup gate exists for exactly this reason — don't defer it into the grave.
