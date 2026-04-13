# Research Synthesis — 2026-04-11

Six parallel research agents. Ninety-minute time box each. All six
returned. One (Agent 6 — ecosystem updates) hallucinated from a
low-quality aggregator and is FLAGGED UNRELIABLE. The other five
returned sourced, cross-verified findings.

This memo consolidates the high-leverage recommendations, ordered by
implementation priority. Each row has a source citation and an effort
estimate. Items without primary sources are in the "defer" section.

---

## TL;DR — next 4 weeks of work

| # | Item | Effort | Source strength |
|---|---|---|---|
| 1 | **Tail-zone dead-band rule** (stop posting zero-reward one-sided tail makers) | 3h | Polymarket docs, primary |
| 2 | **Tick-size-weighted scout scoring** (coarse ticks = more edge per fill) | 4h | Polymarket docs, primary |
| 3 | **Wash-trading penalty** (25% of volume is fake; every strategy over-sizes) | 8h | Columbia study Nov 2025 |
| 4 | **Price-conditioned maker-only gate** (below 25¢, disable taker entirely) | 4h | Kalshi 72M-trade analysis |
| 5 | **DSR + PSR stats module** (replace Wilson LB for strategy gates) | 12h | Lopez de Prado, SSRN 2460551 + 1821643 |
| 6 | **Brier score + reliability decomp** (calibrator drift detector) | 6h | Standard formula |
| 7 | **LeaderboardPollerScout** (10-min poll of `/leaderboards?window=week`) | 4h | Bravado Trade, verified endpoints |
| 8 | **Reward-farming filter** (long-dated + low-vol regime for passive maker yield) | 6h | wanguolin post-mortem |
| 9 | **NegRisk rebalancer strategy** (the 29× capital efficiency multiplier) | 24h | arxiv 2508.03474 |
| 10 | **LlmNewsScout v1** (structured outputs + caching + Haiku) | 12h | Anthropic docs + Polymarket/agents reference |

**Total effort:** ~83 hours. Safe subset (items 1-4) = 19 hours and immediately hardens our existing strategies without adding any new code paths.

---

## Agent 1 — Prediction Market Edges

**9 findings, 4 peer-reviewed primary sources.**

### Adopt now

1. **NegRisk Rebalancer strategy** *(arxiv 2508.03474, Aug 2025)* —
   In multi-outcome events (N≥3 conditions), if Σ(prices) deviates from
   1.0 by more than a tolerance, arbitrage exists via the neg-risk
   `convert` function. Represented **$29M of $39.6M** total Polymarket
   arb in the Apr 2024–Apr 2025 window (73% of all arb profits) across
   662 of 1,578 neg-risk markets. Median profit **$0.60 per dollar
   deployed** — 29× capital efficiency vs binary arb. Cross-referenced
   by Agent 2 (same paper). Our system currently treats each market
   standalone.
   **Effort:** ~24h — need a multi-condition scanner, convert-equivalence
   sizer, and atomic two-legged execution via `neg-risk-ctf-adapter`.

2. **Wash-Trading Penalty** *(Columbia Nov 2025, via CoinDesk)* —
   25% of Polymarket volume Apr 2023–Oct 2025 is wash trading; peaked
   at **60% Dec 2024**, exceeds 90% in sports/election airdrop windows.
   Our strategies size by raw `volume_24h` and over-allocate to fake
   liquidity. Fix: compute unique-counterparty ratio per market (distinct
   makers+takers / total trades over 7d); apply 0.3× size multiplier
   when ratio < 0.2, 0.1× in high-airdrop categories.
   **Effort:** ~8h. Defensive — hardens EVERY existing strategy.

3. **Daily Reversal Fade** *(Vanderbilt 2,500-market study,
   DL News / Good Authority)* — 58% of national presidential markets
   showed negative serial correlation in the final 5 weeks of 2024.
   Explicitly called "noise trading and overreaction." Distinct from
   our regime-decay logic which is intra-trade.
   Fire on: `|Δprice_24h| > 4¢ AND volume_24h > $50K AND base_rate_calibrator
   has no directional edge`. 24h hold, enter opposite direction.
   **Effort:** ~8h as a new sub-strategy.

4. **Price-Conditioned Maker-Only Gate** *(Hacking the Markets,
   Kalshi 72M-trade analysis)* — Below 25¢ entry price, taker losses
   average ~32%; near 50¢, losses shrink. Our maker/taker hybrid
   already prefers makers, but doesn't enforce a hard gate.
   Fix: below 25¢ refuse all taker fills (no exit fallback either —
   wait for maker or skip); above 40¢ allow taker when edge > 1.5%.
   **Effort:** ~4h. Hardens the longshot sub-strategies specifically.

### Defer / verify first

5. **Resolution-Time Volatility Compression** *(arxiv 2510.15205, Oct 2025)* —
   "Toward Black-Scholes for Prediction Markets" kernel pricing model.
   Genuinely new dimension (IV term structure) but needs careful
   calibration against our own history before live use. Defer until
   we have 6+ months of resolved-position data per sub-strategy.

6. **Kyle's Lambda Regime Split** *(arxiv 2603.03136, Yang/Tsang)* —
   Young/thin markets have 10× more slippage per $ of flow than
   mature markets. Shrink size 5× and widen edge threshold 2× in
   high-λ markets. Would need a λ estimator over recent 100 trades
   per market. Useful, but the wash-trading penalty captures most of
   the same volume-quality signal more cheaply.

7. **Trend Asymmetry Fader** *(Sung et al., EJOR, 6,058 markets)* —
   Rising odds under-estimate true prob; falling odds over-estimate.
   Asymmetric correction. Full methodology paywalled; risk of
   implementing the wrong version. Defer until we can get the paper.

8. **Default-Option Fade** *(Reichenbach & Walther, SSRN 5910522)* —
   Traders systematically overtrade the "default"/"first-listed"
   option beyond standard Optimism Tax. Problem: Polymarket's
   `outcomeTokens[0]` is always YES by convention, so this overlaps
   substantially with our existing Optimism Tax longshot logic.
   Need to validate it's a DISTINCT signal before implementing.

9. **End-Window Kalshi Divergence** *(Vanderbilt + CEPR)* — Arb
   windows peak in the final two weeks before resolution, Polymarket
   leads Kalshi. We already have kalshi_arb; check that our scanner
   weights end-window and enforces Polymarket-leads direction.
   **Action:** audit existing `kalshi-arb-scanner.ts`, no new code.

---

## Agent 2 — Market Making / Microstructure

**7 tactics, all sourced against primary material.**

### Adopt now

1. **Tail-zone single-sided dead-band rule** *(Polymarket docs +
   wanguolin Medium post-mortem, 2025)* — Polymarket's liquidity-reward
   formula gives **ZERO reward** for single-sided quotes in <10¢ / >90¢
   tails. Our longshot currently posts one-sided makers there.
   Collecting nothing AND eating full adverse-selection risk.
   Fix: in tail zones, require paired quotes or skip.
   **Effort:** ~3h. Pure config + one conditional.

2. **Tick-size-weighted scout scoring** *(Polymarket developer docs)* —
   Tick sizes vary per market: 0.1 / 0.01 / 0.001 / 0.0001. Our
   maker posts "1 tick better" uniformly — on a 0.01-tick market
   that's +1¢ captured; on a 0.001-tick market only +0.1¢. Same
   action, 10× different EV. Weight scout/strategy scoring by
   `1 / minimum_tick_size` so coarse-tick markets get priority.
   **Effort:** ~4h. We already fetch `minimum_tick_size` from
   `/markets`; just thread it through the scorer.

3. **Reward-farming scout filter** *(wanguolin post-mortem)* —
   A deep post-mortem tried Kaplan-Meier + Cox + DeepSurv models
   to predict order queue lifetime; **all failed** (probe-order
   costs exceeded rewards). Confirms our "no queue-position model"
   decision. But the author DID find reward-farming works on
   `days_to_resolution > 30 AND 5min_realized_vol < threshold`.
   Add a new scout that flags these markets for passive maker
   posting with a different strategy envelope.
   **Effort:** ~6h. New scout + one market-cache column.

### Defer / bigger lift

4. **Quadratic-scored two-sided quoting** *(Polymarket liquidity
   rewards docs)* — Score = `((v − s)/v)² · b`. Move from 3¢ to
   2¢ spread roughly doubles score vs 1.5× risk. Our current
   entry posts 1 tick better than market — optimizes for fill,
   not reward. Adding a reward-aware quoter = second posting path
   behind a feature flag. **Effort:** ~12h.

5. **Bands + 30-second sync_interval MM loop** *(Polymarket/poly-market-maker
   reference repo)* — Official Polymarket MM bot structure:
   tiered spread bands, 30-second cancel/replace cycle, bands.json
   config. Turn idle cash into passive reward-earning quotes between
   signals. **Effort:** ~16h to port the Python patterns to TS.

6. **Cross-venue Poly↔Kalshi latency arb** *(speedyhughes + CarlosIbCu
   repos)* — We already have read-only Kalshi integration. Full
   two-legged execution = ~60h and needs new Kalshi wallet funding
   approval. **Defer to post-R3b.**

---

## Agent 3 — Whale Tracking

**Strongest single finding: leaderboard IS the detector.**

### Adopt now

1. **LeaderboardPollerScout** *(Bravado Trade + verified Polymarket
   endpoints)* — `data-api.polymarket.com/leaderboards?window=week`
   every 10 min is the highest-leverage single call in the entire
   whale-tracking stack. Fredi9999 (`0x1f2dd6d473f3e824cd2f8a89d9c69fb96f6ad0cf`)
   was never "detected" via on-chain sleuthing; media scrutiny
   followed leaderboard rank.
   **Effort:** ~4h. New scout, new table `smart_money_candidates`.

2. **Smart-money filter (4 verified thresholds)** *(Bravado Trade)*:
   - ≥200 settled markets (sample size)
   - ≥65% win rate
   - Varied position sizing (uniform = wash/leaderboard-farming)
   - Cross-category (single-topic = news-driven, not edge)

   Nightly job: hit `data-api.polymarket.com/positions?user=` for each
   leaderboard candidate, compute rolling 90-day metrics, promote
   survivors to a `whitelisted_whales` table.
   **Effort:** ~6h. Pure SQL + cron.

3. **Expanded on-chain event signatures** — Our echandsome scout
   likely only catches `OrdersMatched`. Missing 4 others:

   | Event | Topic0 | Emitter |
   |---|---|---|
   | `OrderFilled` | `0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6` | CTF Exchange + NegRisk_CTFExchange |
   | `OrdersMatched` | `0x63bf4d16b7fa898ef4c4b2b6d90fd201e9c56313b65638af6088d149d2ce956c` | CTF Exchange |
   | `PositionSplit` | `0xbbed930dbfb7907ae2d60ddf78345610214f26419a0128df39b6cc3d9e5df9b0` | CTF + NegRiskAdapter |
   | `PositionsMerge` | `0xba33ac50d8894676597e6e35dc09cff59854708b642cd069d21eb9c7ca072a04` | CTF + NegRiskAdapter |
   | `PositionsConverted` | `0xb03d19dddbc72a87e735ff0ea3b57bef133ebe44e1894284916a84044deb367e` | NegRiskAdapter ONLY |

   Contracts: CTF Exchange `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E`,
   NegRisk_CTFExchange `0xC5d563A36AE78145C45a50134d48A1215220f80a`,
   NegRiskAdapter `0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296`,
   CTF `0x4D97DCd97eC945f40cF65F87097ACe5EA0476045`.

   The NegRisk-only `PositionsConverted` event catches multi-outcome
   election-style trades — where the 2024 whales actually made their
   money. **Effort:** ~8h when we get to whale-tracking live.

### Latency reality-check

- **Honest answer:** copy-trade latency is 2-5 minutes book-to-book
  and no mechanical fix exists. Mitigation = fair-value gate (don't
  copy if implied move ≥ whale-implied edge), ladder fills, skip
  illiquid. Confirmed across multiple sources. Don't over-invest
  in a "fast copy-trade" architecture.

### Verified Dune dashboards (no hallucinations — agent WebFetch-verified)

- `dune.com/defioasis/polymarket-pnl` — wallet-level PnL
- `dune.com/rchen8/polymarket` — general dashboard
- `dune.com/filarm/polymarket-activity`
- `dune.com/lifewillbeokay/polymarket-clob-stats`
- `dune.com/kucoinventures/trading-bots-on-polymarket` — useful for
  **filtering out** bot noise
- `dune.com/0xclark_kent/polymarket-trade-activity-tracker`

---

## Agent 4 — LLM-in-the-Loop

**Applies directly to our stub `src/scouts/llm-news-scout.ts`.**

### Adopt (v1 — ship first)

1. **Anthropic Structured Outputs beta**
   (`anthropic-beta: structured-outputs-2025-11-13`) — Not prompt
   engineering. Actual grammar-constrained decoding at inference
   time. Kills the "valid JSON wrong shape" class of failures.
   Our `[{condition_id, side, conviction, reason}]` contract is
   exactly what it was built for.

2. **Prompt caching for stable prefix**
   *(Anthropic prompt caching, production case studies)* — Cached
   write = 1.25× input cost; read = 0.10× input cost. Break-even
   at 1 cache hit. Structure each tick as `[cached: system prompt
   + schema + persona + base-rate table][fresh: 20 questions +
   headlines]`. Math: ~$0.004 per tick vs $0.016 uncached.
   **About $6/day at 1-minute cadence, closer to $5/day at 60-sec.**

3. **Semantic validation beyond schema** *(Willison)* — Schema
   catches syntactic garbage; it won't catch hallucinated
   `condition_id`. Whitelist check against input set. Drop bad
   rows, keep good ones, never fail whole batch on one bad row.

4. **Per-category conviction caps** *(Kalshi bot post-mortem +
   9-day bot post-mortem)* — Documented failure: LLM over-commits
   on political/macro events where it has no real edge. Fix:
   politics max 0.60, macro max 0.50, sports max 0.70 (still
   below our 0.80 global cap). Add as static config.

5. **Fail-closed retry pattern** *(Anthropic 429 handling)*:
   ```
   max_retries=4, exponential backoff with jitter,
   30-sec per-request timeout, always honor retry-after header.
   On exhaustion, return [] (empty findings). Never raise, never
   block the scout tick.
   ```

### CRITICAL — do NOT do

- **Do NOT feed current Polymarket price into the prompt.**
  *(PolySwarm, arxiv 2604.03888)* — Creates feedback loop: bot
  consensus → market move → bot re-reads moved market. News +
  base rates + question text only.
- **Do NOT enable extended thinking with tool_use** — documented
  n8n issue 15715 where `thinking` block ordering breaks tool_use.
  If we want chain-of-thought, put it inside the JSON response as
  a `reasoning` field.

### v2 / v3 (later)

6. **N=3 self-consistency** (Haiku parallel, Sonnet tie-break) —
   Drop findings that don't appear in ≥2 of 3 samples. Catches
   confabulated `condition_id` specifically. ~3h add.

7. **Isotonic calibration on claimed conviction**
   *(arxiv 2603.29559)* — Once we have ~200 resolved bets, fit
   isotonic regression on `(claimed_conviction, resolved_outcome)`
   pairs. Replaces crude 0.80 cap with data-driven calibration
   curve. Self-reported verbal confidence beat token log-probs
   and self-consistency voting in the benchmark.

### PolySwarm integration (v3+)

Published paper built specifically for Polymarket: N diverse LLM
personas, confidence-weighted Bayesian combination with market-implied
probability, quarter-Kelly sizing. The cheap version: **5 Haiku
personas instead of 50 Sonnet** gives most of the diversity benefit
at <$0.01/tick.

**Reference implementation:** `github.com/Polymarket/agents` —
Polymarket's own LLM agent framework. Port the pydantic Objects
pattern to TS via zod.

---

## Agent 5 — Statistical Validation

**All six techniques work at n < 200. No external TS dependencies.**

### Adopt (Phase 3 stats module)

1. **Deflated Sharpe Ratio (DSR)** *(Bailey & Lopez de Prado, SSRN
   2460551)* — Corrects Sharpe for (a) multiple-testing bias
   across our parallel sub-strategies, (b) skew/kurtosis of
   returns. Closed form, ~80 LOC TS, no deps. Needs `Φ(x)` normal
   CDF (~10 LOC rational approximation). Threshold: `DSR > 0.95`
   to enable. Works at n ≥ 30.

2. **Probabilistic Sharpe Ratio (PSR)** *(SSRN 1821643)* — Single-
   strategy sibling of DSR. Also yields **Minimum Track Record
   Length** — tells us exactly how many trades each sub-strategy
   needs before we can trust its Sharpe at 95%. Replaces our
   hardcoded `MIN_N_ENABLE=50` with a data-driven per-sub threshold.
   ~30 LOC, shares `Φ` helper with DSR.

3. **Brier Score + Reliability Decomposition** — Polymarket IS
   probability. Brier was designed for this. `BS = Reliability -
   Resolution + Uncertainty`. Reliability term = calibration gap.
   One scalar that flags calibrator drift. Reliability diagram
   (binned predicted vs observed) for the dashboard. ~50 LOC.

4. **Walk-forward anchored validation** — Today we retrain the
   base-rate calibrator on all history forever, which bakes in
   dead regimes. Anchored walk-forward (expanding train window,
   fixed OOS test) gives us a running IS-vs-OOS degradation ratio.
   Disable strategies where OOS Sharpe < 50% of IS Sharpe. ~150 LOC.

5. **Thompson Sampling for strategy allocation** *(textbook + EJOR
   2025)* — Replace binary enable/disable with smooth Beta(α, β)
   posterior allocation. Our current advisor is brittle: one hot
   streak flips on, one cold streak flips off, whipsaw. Thompson
   is continuous: cooling strategies get smaller allocation
   smoothly; cold-start exploration via prior uncertainty. ~100 LOC.
   Integrates with existing Kelly sizing as a multiplier.

6. **Probability of Backtest Overfitting (PBO via CSCV)** *(Bailey
   et al. SSRN 2326253, J Comp Finance 2015)* — Non-parametric.
   One number per sub-strategy: "this enable decision has X% chance
   of being overfit." Dashboard-friendly. ~120 LOC.

**Total Phase 3 stats module: ~540 LOC** for items 1-5.
Zero external TS dependencies. One shared helper module: normal
CDF, sample skew/kurtosis, Beta sampler.

### Skip

- **Hansen SPA test** — 1,000 bootstrap resamples per evaluation,
  marginal gain over DSR for our case. Skip.
- **CPCV full version** — needs n ≥ 80 per strategy; most subs
  don't have that yet. Revisit after Q3 data accumulates.
- **HMM regime detection** — needs continuous feature vectors
  (vol, spread, volume) we don't have clean for Polymarket yet.
  Existing `agi-regime-detection` skill available when ready.

---

## Agent 6 — Polymarket Ecosystem Updates

**⚠️ FLAGGED UNRELIABLE. DO NOT ACT ON.**

Agent 6 cited a suspicious aggregator site (`agentbets.ai`) that
presents itself as a Polymarket "known bugs tracker" and "rate limits
guide" but fabricates specific technical details. I verified against
live APIs and the real GitHub repo:

| Claim | Reality |
|---|---|
| "Taker fees live March 30, 2026" | **FALSE.** 0/1000 active CLOB markets have nonzero fees in live API data. One legacy 2023 election market has `taker_base_fee=200` and that's it. |
| "py-clob-client has 56 open PRs" | **FALSE.** 6 open PRs in the real repo. |
| "Bug #287 / #300 / #301 / #265" | **FALSE.** Real open PR numbers are 325/322/320/318/315/314. |
| "py-clob-client v0.34.6 frozen Feb 19" | TRUE (the easy-to-lookup facts are accurate). |
| "NegRiskAdapter unchanged" | TRUE by non-finding. |

**Root cause:** PokerNews had a real article about a fee PROPOSAL
(which was rolled back). Agent 6 misread that as a shipped change
and then compounded with fabricated agentbets content. Two low-
quality sources → confident fiction.

**What we salvage:** watch the 6 REAL open py-clob-client PRs for
relevant fixes (especially #325 "round_down for market order price").
The Polymarket rate-limit headers and batch-order capacity are
legitimate good hygiene items. Everything else: discard.

**Lesson for future research prompts:** require verification against
primary sources (official docs, GitHub, arxiv, or live API responses).
Never trust single-source aggregator citations.

---

## Full Priority Queue

**Tier 1 — Defensive / hardening (19h total, do first)**

| # | Item | Effort | Reason |
|---|---|---|---|
| 1 | Tail-zone single-sided dead-band rule | 3h | Stop losing reward score on one-sided tail makers (Polymarket docs primary) |
| 2 | Tick-size-weighted scout scoring | 4h | 10× EV differential between tick regimes (Polymarket docs primary) |
| 3 | Wash-trading penalty | 8h | 25% of volume is fake — every strategy over-sizes (Columbia 2025) |
| 4 | Price-conditioned maker-only gate | 4h | Below 25¢ taker losses are 32% avg (Kalshi 72M) |

**Tier 2 — New edges (44h total)**

| # | Item | Effort | Reason |
|---|---|---|---|
| 5 | DSR + PSR stats module | 12h | Replace Wilson LB, multiple-testing-corrected (Lopez de Prado) |
| 6 | Brier score + reliability decomp | 6h | Calibrator drift detector — standard method |
| 7 | LeaderboardPollerScout + smart-money filter | 10h | Highest-leverage whale signal (Bravado) |
| 8 | Reward-farming filter scout | 6h | Passive yield on long-dated low-vol markets (wanguolin) |
| 9 | Daily reversal fade sub-strategy | 8h | 58% negative serial correlation (Vanderbilt) |
| 10 | LlmNewsScout v1 activate | 12h | Structured outputs + caching + fail-closed (Anthropic docs) |

**Tier 3 — Big lifts (high value but need more investment)**

| # | Item | Effort | Reason |
|---|---|---|---|
| 11 | NegRisk Rebalancer strategy | 24h | **$29M / 73% of all arb** (arxiv 2508.03474) — the single biggest edge found |
| 12 | Walk-forward anchored validation | 12h | OOS discipline for calibrator |
| 13 | Thompson sampling strategy allocation | 10h | Replace brittle binary advisor with smooth Beta posteriors |
| 14 | Bands + 30s sync_interval MM loop | 16h | Passive reward earning between signals (Polymarket repo) |
| 15 | 5-signature expanded on-chain whale tracker | 8h | Catches NegRisk/Converted events echandsome misses |
| 16 | LlmNewsScout v2 (N=3 self-consistency) | 3h | Hallucination protection |
| 17 | PBO via CSCV | 6h | Dashboard-friendly overfit gauge |
| 18 | PolySwarm-style 5-persona Haiku voting | 12h | Diversity + disagreement-as-uncertainty signal |

**Defer (needs more data or more code surface)**
- Cross-venue Poly↔Kalshi two-legged execution (~60h + wallet approval)
- Resolution-time IV kernel model (need 6+ months own data)
- Kyle's Lambda regime split (overlaps with wash-trading penalty)
- Trend asymmetry fader (methodology paywalled)
- CPCV full version (needs n ≥ 80 per strategy)
- HMM regime detection (needs clean feature vectors)
- Isotonic calibration on LLM conviction (needs ~200 resolved bets first)
- Hansen SPA test (compute-heavy, marginal gain over DSR)

**Reject (unreliable source)**
- Every Agent 6 P0 claim about fees, py-clob-client bug numbers,
  or agentbets.ai content. Verify against primary sources before
  implementing anything in this space.

---

## Recommended first session of work

**Best 1-day session:** Tier 1 (items 1-4) in order.

All four are defensive hardening of existing code — no new strategy
files, no new DB tables, no new services. They protect every strategy
we currently run. Combined 19 hours = one focused day of work. Every
source is primary (Polymarket docs or peer-reviewed/large-sample
studies). Low regression risk.

**Best 1-week session:** Tier 1 + items 5, 6, 7, 10 from Tier 2.
That's ~51 hours and delivers:
- Statistically rigorous strategy gating (DSR/PSR)
- Calibrator drift detector (Brier)
- First whale tracking signal (leaderboard poller)
- LLM scout activation (if `ANTHROPIC_API_KEY` is provisioned)

**Biggest single-edge opportunity:** item 11 (NegRisk Rebalancer, 24h).
This is the single highest dollar-edge finding across all six reports.
But it's a new strategy module, not a hardening patch — defer until
Tier 1 + core Tier 2 are in.

---

## Source quality notes

**Primary (weighted highest):**
- Official Polymarket docs, verified contract addresses
- arxiv papers with IDs and cross-checked by multiple agents
- Lopez de Prado SSRN papers
- Anthropic engineering blog

**Secondary (cross-checked against primary):**
- Bravado Trade (whale filter thresholds)
- wanguolin Medium post-mortem
- Hacking the Markets Kalshi analysis

**Rejected:**
- agentbets.ai "news" / "guides" — single-source, detail fabrications
- Unnamed "post-mortem" blog posts with no author attribution

Going forward, agent research prompts should require primary-source
verification as an explicit hard constraint, not a soft preference.
