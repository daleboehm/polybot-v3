# Polybot Capabilities — Manual Curation

Maintained by operator. SSH-edit at `/opt/polybot-v3/docs/capabilities-manual.md`. Commit on changes. The nightly capabilities-summary script embeds this file verbatim into section 8 of the generated summary, so research agents see these sections every run.

**Update discipline**: edit whenever a research finding becomes an active hypothesis, a hypothesis resolves, or a previously-deferred item is ready to reconsider.

---

## V2 Migration Status — 2026-04-21 (cutover day)

**Completed today:**
- `clob-client-v2@1.0.0` installed (already in package.json)
- `clob-router.ts` v2 path validated (exchange_version flag switch)
- `whale-event-subscriber.ts` patched: V2 exchange addresses + V2 OrderFilled ABI + dual-watch (V1+V2)
- `cli/index.ts` sell-position + redeem paths v2-aware
- **R&D flipped to v2** (paper mode, validates client init)
- pUSD token identified: `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`
- V2 Exchange + NegRiskExchangeV2 confirmed on-chain deployed

**BLOCKED — waiting on Polymarket support:**
- pUSD onramp contract address. `CollateralToken.wrap()` requires `WRAPPER_ROLE`. User-facing wrapper contract not yet publicly documented. Polygonscan, GitHub, and docs.polymarket.com searches came up empty. Asked Polymarket Discord for the onramp address.
- Once known: build `polybot wrap-usdc` CLI, dry-run, execute on polybot wallet ($373.62 USDC.e → pUSD), flip prod config to v2.

**Prod stays halted + V1 until wrap completes.** No trading risk during the transition.

**Other 15 entities**: all paper + pending + \$0 — no wrap needed for any of them today.

## Oil quant-discretization research — 2026-04-21

**Market category**: CONFIRMED active on Polymarket. R&D cache shows ~20 active oil markets:
- Crude Oil (CL) price threshold markets: "Will Crude Oil hit $X by end of June?" for X in {47, 52, 77-84, 120, 150, 115, 175, 200}
- US crude oil reserves inventory markets
- Venezuelan crude oil production markets
- Oil-related geopolitical markets (Iran/Abqaiq, oil tanker events)

**Already covered by existing scout**: `cross-market-arb-scout` (commit `c9da66b`) auto-scans the CL price-threshold cluster for monotonicity violations ($47/$52/$77/$120/$150/$175/$200 priced in-order). If an inversion appears, it's flagged regardless of asset — no oil-specific code needed for arb detection.

**Oil-specific forecasting strategy (Grok's "harmonic oscillator" pitch)**:
- Mechanism: fit mean-reversion model to WTI 30d history, compute P(max price > threshold within window Y), compare to market-implied P.
- Simpler alternative: empirical volatility × normal CDF (same approach as `crypto_price/latency_arb`).
- Data feed options: Yahoo Finance WTI (free, 15min delay — fine for monthly markets), EIA (free, daily), Alpha Vantage (rate-limited free).
- **NOT built**. Effort: M (data feed + model + strategy = ~4-6h).

**Deferral reason**: (a) cross-market-arb-scout already captures the arb pattern — Grok's pitch conflated arb with forecasting; (b) oil markets resolve weeks-to-months out, outside our current `max_hours_to_resolve: 48` window, so a directional oil strategy would need to be a new sub with relaxed resolution gating; (c) current bankroll ($374) cannot meaningfully size into a slow-resolution market.

**Reopen criteria**:
1. Prod unhalted successfully on V2
2. R&D bandwidth for multi-week-resolution category
3. Empirical backtest (Shanghai dataset) shows edge on oil threshold markets

## 8a. Open Research Hypotheses + Decision Gates

**2026-04-23: Weather forecast 72h validation verdict**
- Hypothesis: post-04-17 improvements (METAR data, fee-adjusted edge, AIFS ensemble, 2x allocation, hold-to-settlement) make weather_forecast positive EV despite Jua/EPT-2 AI adversary thesis
- Decision rule:
  - post-04-17 R&D n ≥ 20 AND avg PnL > +$0.10/trade → KEEP enabled, mark improvements validated
  - post-04-17 R&D n ≥ 20 AND avg PnL ≤ -$0.05/trade → DISABLE permanently
  - post-04-17 R&D n < 20 → extend window 72h
- As of 2026-04-20 post-04-18 data: single_forecast n=78, WR 61.5%, PnL +$57.58 → TRACKING POSITIVE

**2026-04-23: systematic_fade Fix 1 validation**
- Hypothesis: Kelly α-boundary correction (arXiv 2412.14144) eliminates the WR/PnL paradox
- Decision rule:
  - post-04-17 R&D n ≥ 20 AND avg PnL materially better than pre-fix → KEEP
  - post-04-17 R&D n ≥ 20 AND avg PnL still ≤ pre-fix → RETIRE
- As of 2026-04-20: n=102, WR 95.1%, avg +$0.15/trade (vs pre-fix avg -$0.24/trade) → **VALIDATED, KEEP**

**2026-04-22 (Wednesday): CTF Exchange V2 cutover**
- Polymarket migrates to CTF Exchange V2 + pUSD collateral token
- V1 orders cancelled at cutover
- Cutover action: flip `exchange_version: v2` in both yamls, restart engines
- V2 client scaffolded (clob-client-v2@1.0.0, named-options constructor)

**Pre-unhalt gate list (blocks live resumption)**
- [ ] V2 cutover complete + R&D V2 paper-test 24h clean
- [ ] Weather 72h verdict acted on
- [ ] systematic_fade Fix 1 validated (DONE)
- [ ] pUSD balance on prod wallet post-cutover
- [ ] Position caps right-sized for $374 prod cash (currently $100 max_position_usd)
- [ ] Cross-market-arb scout v1.1 noise filter (same-threshold false positives)
- [ ] Dale green-lights with strategy starter set


**AWAITING DALE REVIEW: Shanghai Polymarket dataset integration** (added 2026-04-20 from Grok variance report)
- Source: GitHub `SII-WANGZJ/Polymarket_data` + HuggingFace mirror. Verified 2026-04-20: legit academic release (Shanghai Innovation Institute + Westlake + SJTU + Harbin IT + Fudan co-authors), 476 GitHub stars, 30K+ monthly HF downloads, MIT license, citation published, last updated 2026-03-05.
- Dataset: 1.9B trades, 163GB total. Recommended starting set: `trades.parquet` (28GB) + `quant.parquet` (28GB, pre-cleaned YES-token perspective) = ~56GB for full quant coverage. Selective Parquet loads (pyarrow/pandas) avoid full-RAM requirements.
- Thesis: backtest layer we don't have. R&D is forward-paper only; historical backtesting would validate new strategies before committing R&D compute, discover category-specific mispricing patterns (movies/economics/etc.), and cross-check calibrator drift vs ground truth across 1.9B trades.
- Decision gate: if Dale approves, spend ~2h prototyping with trades.parquet on VPS. Run one current strategy (favorites/compounding) through the simulator. If backtest WR/PnL converges with live R&D results → viable integration; if divergence is large → useful finding about question-format scope. Either outcome advances capability.
- Effort: M (storage + pipeline + first backtest). Not L because recommended file is 28GB not 107GB.
- **Status**: recommendation only, NOT shipped. Awaits Dale approval per 2026-04-20 no-auto-changes directive.

**AWAITING DALE REVIEW: PCA factor model + GARCH volatility layer** (added 2026-04-20 from Grok variance report, post-unhalt candidate)
- Source: Grok variance research via X-sphere 2026-04-20 (mechanics cited as standard quant finance, backtested by practitioner community; "Sharpe 8.8" claims in the source material discounted as hype)
- Thesis: treat markets as correlated assets. PCA decomposes common factors across politics/macro/crypto/event categories. GARCH models volatility clustering. Position sizing uses portfolio-level σ²ₚ = wᵀΣw rather than per-position Kelly alone.
- What's already in place: `src/risk/portfolio-risk.ts` tracks correlation heat across neg-risk clusters. No explicit PCA/GARCH decomposition.
- Why not now: (a) L effort, (b) prod bankroll $374 can't size to portfolio-level risk meaningfully, (c) V2 cutover + unhalt are higher priority. Real value unlocks after prod is stable > $5K.
- Implementation path (when reopened): sklearn.decomposition.PCA + statsmodels GARCH, rolling window on our v_strategy_checkpoints returns matrix. Training set can draw on Shanghai dataset once integrated (cross-hypothesis dependency).
- Reopen criteria: prod unhalt + 14d stable operation + equity > $5K.
- **Status**: recommendation only, NOT shipped. Awaits Dale approval per 2026-04-20 no-auto-changes directive.

**DEFERRED: Oracle-lag arbitrage extension to crypto_price/latency_arb** (added 2026-04-20 from Grok variance report, downgraded same day after research gates identified)
- Original thesis: Polymarket 5m/15m crypto markets resolve on Chainlink Data Streams (~500ms latency); CEX feeds (Binance ~10-50ms) lead the oracle and could be arbed.
- 2026-04-20 research findings (~15 min WebFetch pass before any code):
  - **Chainlink Data Streams is NOT a public free-tier API.** Docs.chain.link only says "Contact us to talk to an expert about integrating" — enterprise-gated, no documented pricing. Real blocker on shipping an integration without first determining access tier.
  - **Polymarket's actual crypto resolution source is NOT confirmed as Chainlink for short-duration markets.** Learn/docs link to chainlink resolution-source page 404s. No clean citation beyond Grok's assertion.
  - **The underlying idea is already subsumed by our existing stack**: `crypto_price/latency_arb` sub fades Polymarket CLOB vs Binance spot; `FastCryptoEvaluator` reacts to orderbook snapshots within 10s; `ExchangeDivergenceScout` checks 3-source crypto consensus. An oracle feed would be incremental, not transformative.
  - **Hype check**: the "$868k PnL" claim is disputed (on-chain max single wins ~\$4.7k per Grok pass-2).
- Reopen criteria:
  1. Confirm Polymarket crypto resolution source specifically for 5m/15m markets (read from contract, not docs). AND
  2. Obtain Chainlink Data Streams access pricing / free-tier availability. AND
  3. Measure the oracle-vs-Binance latency gap empirically (on-chain timestamps, not Grok's 500ms claim).
- **Status**: DEFERRED. All three criteria must clear before this becomes actionable. Until then, our existing latency_arb + FastCryptoEvaluator is the relevant surface area.

**AWAITING DALE REVIEW: Esports probability models (deferred, Shanghai-backtest-first)** (added 2026-04-20)
- Thesis: Polymarket has active esports markets (LoL, CS2, Dota). Edge comes from domain stats (HLTV ratings, Liquipedia meta, map-ban/pick patterns) vs retail crowd bias. Pure category expansion; we don't cover esports today.
- Why deferred: (a) prod bankroll $374 doesn't size to a new category, (b) dependent on Shanghai dataset viability — if the dataset reveals esports mispricings worth chasing, reopen; if not, skip entirely. Grok's framing: "reopen criterion = successful Shanghai backtest on sports categories first."
- Effort: M (scraper for esports feed + simple ELO/Markov model).
- **Status**: recommendation only, NOT shipped. Depends on outcome of Shanghai dataset hypothesis above.

**RISK AWARENESS (not a hypothesis): Feb 2026 \$0.1-gas market-maker desync attack** (added 2026-04-20 from Grok pass-3)
- Pattern: during market periods with gas-price mismatches between off-chain order matching and on-chain settlement, maker bots with unhedged inventory took losses from order-flip/rollback sequences.
- Why this matters for us: we currently run TAKER-only. If we enable maker-rebate capture post-V2 (noted as opportunity in 04-17 report sections 2c+5), this attack vector becomes relevant — need to account for it in the maker-strategy design (gas-price awareness, inventory caps, off-chain-to-on-chain atomicity checks).
- **Status**: awareness note, NOT an open hypothesis. Re-surfaces when we design a maker strategy.

**Grok variance report 2026-04-20 — already-covered findings (DO NOT re-propose):**
- Combinatorial arb (arXiv 2508.03474): already SHIPPED as cross-market-arb-scout v1.1 (`658cb06`) + NegRisk-arb type-1 (`3a80b8b`, `5ee113d`).
- Copytrade from smart wallets: already SHIPPED as whale_copy + whale_fade with 21 Bravado-filtered whales (`73fd092`).
- Orderbook/WebSocket scouts: already SHIPPED (FastCryptoEvaluator + book-quality-check + ExchangeDivergenceScout).
- Early exits: stop-loss-monitor emits 4 exit types (profit_target, trailing_lock, hard_stop, stop_loss).
- RSI+MACD momentum: shipped as ta_momentum sub (`a992664`).
- Weather APIs (NOAA/ECMWF/HRRR): Open-Meteo AIFS + NWS + METAR all wired.
- Kelly + dislocation δ: fractional Kelly + α-boundary correction (`8bbedaa`), 3-tier calibrator (own → Markov → naive).
- LLM-driven edge detection: DEFERRED in 8b (prod bankroll <$5K reopen criterion).

---

## 8b. Known-Deferred (DO NOT re-propose without new evidence)

| Item | Source | Reason for deferral | What would reopen |
|---|---|---|---|
| **DEPO entropy allocation** | 04-17 report | Kelly+strategy-weighter stack hasn't hit its ceiling. DEPO is incremental, not step-change. | Weighter max multipliers saturating at 2.0x across most strategies with declining marginal ROI |
| **Lead-lag strategy** (Kim 2602.07048) | 04-17 report | 7-day hold horizon conflicts with current 48h max_hours_to_resolve gate. Would require new strategy family, Kalshi data pipeline extension. | Paper finding that lead-lag edge persists at <48h horizons |
| **LLM probability layer** (MiMo-V2) | 04-19 report | Alpha ceiling < $1K position. Current prod bankroll $374. LLM cost-per-prediction vs expected PnL negative at this scale. | Prod equity > $5K, OR published evidence of positive edge at small position size |
| **Combinatorial arb type-2 (full graph)** | 04-19 report | v1 (monotonicity) shipped 2026-04-20 as scout. Full relationship-graph inference is L-effort and needs v1 hit data first. | v1 scout produces clean signals that a strategy could act on |
| **PolySwarm multi-LLM framework** (2604.03888) | 04-17 report | v1 KL-divergence scout shipped as step-1. Full multi-LLM persona Bayesian combination is 3-4× the complexity. | v1 KL scout consistently surfaces real mispricings |
| **Whale Copy Score formula** (R²×WR×MDD×PF) | 04-17 addendum | 21 whitelisted whales already seeded via leaderboard scan. Scoring refinement is low-priority until whale-copy/whale-fade have enough resolved trades to compare ranking methods. | whale_copy + whale_fade produce ≥30 resolved trades with mixed results |
| **GFS ensemble blending** | 04-17 report | Weather-specific; gated on weather 72h verdict. | Weather KEEP verdict on 2026-04-23 |
| **Per-city accuracy curves** (Open-Meteo Previous Runs) | 04-17 report | Weather-specific; same gate as GFS. | Weather KEEP verdict on 2026-04-23 |
| **Dynamic Kelly f(ensemble_stdev)** | 04-17 backlog | Weather-specific extension of Fix 1. | Weather KEEP verdict on 2026-04-23 |
| **Cursor-based API pagination** | 04-17 report | Polymarket hasn't deprecated offset-based endpoints; not breaking. | Polymarket announces offset deprecation date |

---

## 8c. Variance Directions for Research Agents

**What to search for (GOOD — not built yet):**

1. **Weather adversary monitoring** — who else besides Jua/EPT-2 is running AI weather models on Polymarket? Any published accuracy benchmarks vs ECMWF-AIFS?
2. **Polymarket-specific microstructure papers** — arxiv/SSRN 2026-04 onward. New academic work on adverse selection, maker-taker dynamics, market-maker incentive design.
3. **Emerging market patterns** — categories we're NOT scanning (entertainment, elections not US/Peru, science, pop culture). Is there sustained mispricing in a category we've ignored?
4. **Execution improvements** — slippage models for our price bands, maker-rebate optimization pathways, order batching under V2, pUSD collateral dynamics.
5. **CTF V2 post-cutover behaviors** — builder codes, EIP-1271 smart wallet support, redemption contract changes. Any day-of-cutover bugs reported by other bot operators?
6. **Whale patterns** — wallets outperforming our 21 whitelisted set. New leaderboard candidates. Behavioral patterns (entry timing, hold duration, exit discipline) not yet captured in the Bravado filter.
7. **X/Twitter signal** — verified accounts (not engagement-bait) posting concrete mispricing analyses or new strategy mechanics. Must pass 4-point vetting gate: on-chain proof, specific market IDs, reproducible math, not promotional.
8. **Risk model extensions** — correlation clustering beyond neg-risk-market-id, cross-strategy drawdown interaction, portfolio-heat metrics. Anything published on Kelly variants for N-way mutually-exclusive outcomes.

**What to skip (BAD — already built or deferred):**

- Don't re-propose items from section 8b (deferred list). Those have explicit reopen criteria.
- Don't report "Polybot should use Kelly" / "Polybot should use fractional Kelly" / "taker fees matter" / "weather has edge" — all built.
- Don't pitch new LLM-based anything unless the paper specifically addresses the <$1K position-size alpha-erosion constraint.
- Don't pitch "strategy that trades on X news event" unless the mechanism is clearly superior to our existing news_overreaction_fade sub.

**Format expectation per finding:**

```
**Finding N**: <one-line summary>
- Source: [EXT: URL]
- Mechanism: <specifically what's mispriced and why>
- Applicability: <maps to which existing strategy/scout, OR identifies a gap>
- Effort: S / M / L
- Rejects deferred-list entry X because: <new evidence>  (only if reopening)
```

---

## 8d. Recent Research Impact (last 3 days)

Shipped commits traceable directly to research findings:

| Finding source | Shipped commit | Impact |
|---|---|---|
| Fix 1 Kelly α-boundary (arXiv 2412.14144) | `8bbedaa` | systematic_fade avg PnL pre -$0.24 → post +$0.15 (VALIDATED) |
| Taker fees live since 03-30 | `1495583` | Fee drag now filters marginal trades across weather/crypto |
| METAR airport data (ColdMath/speeda) | `1495583` | Ground-truth temp blended into weather forecasts <12h horizon |
| CTF V2 cutover warning | `945322e`+`c7885ac` | V2 client installed + flag scaffolded; Wed cutover-ready |
| Kelly-drawdown co-opt (Crane) | `c7885ac` | effectiveKelly derived from daily lockout budget |
| NULL-strategy attribution gap | `c7885ac` | G8 guard + 8 orphan backfills |
| Lifecycle timing (SSRN 5910522) | `c7885ac` | opt-in filter wired into favorites + longshot |
| stacyonchain RSI+MACD | `a992664` | ta_momentum sub on crypto_price |
| Whale-fade (arXiv 2603.03136) | `73fd092` | whale_fade strategy on R&D |
| PolySwarm KL-divergence | `73fd092` | KL-divergence scout on neg-risk clusters |
| Combinatorial arb type-2 | `c9da66b` | cross-market-arb scout (monotonicity) |
| Favorites dead-zone diagnosis | `0bb72b3` | Compounding floor raised 0.50 → 0.70 |
| NegRisk partial-basket bleed | `0bb72b3` | MAX_LEG_PRICE=0.15 filter |

Research ROI: ~14 shipped commits over 72 hours. Research-pipeline cost is roughly 1-2 LLM research sessions per day. This list argues the pipeline is paying for itself many times over — the job now is to keep finding **novel** signals (per 8c), not revisit settled ones (per 8b).
