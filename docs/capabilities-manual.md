# Polybot Capabilities — Manual Curation

Maintained by operator. SSH-edit at `/opt/polybot-v3/docs/capabilities-manual.md`. Commit on changes. The nightly capabilities-summary script embeds this file verbatim into section 8 of the generated summary, so research agents see these sections every run.

**Update discipline**: edit whenever a research finding becomes an active hypothesis, a hypothesis resolves, or a previously-deferred item is ready to reconsider.

---

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
