---
name: polymarket-trading-expert
description: >
  Complete prediction market trading framework for Polymarket — the world's largest prediction
  market on Polygon using USDC.e and a hybrid Central Limit Order Book (CLOB). Covers a five-level
  progression from platform mechanics through automated expert-scale trading: (1) Platform Mastery
  — wallet setup, order mechanics, resolution rules; (2) Probability & Research Fundamentals —
  calibrated forecasting, EV calculation, mispricing identification; (3) Core Strategy Implementation
  — cross-platform arbitrage, whale tracking, liquidity provision, bankroll management;
  (4) Automation & Advanced Execution — API/SDK integration, bot building, domain specialization;
  (5) Expert Scaling — portfolio optimization, information arbitrage, full automation, capital
  scaling. Includes advanced modules on resolution risk, multi-outcome markets, correlated hedging,
  capital lockup math, AI-assisted research, international access/geo-restrictions, tax reporting,
  and Python automation scripts. Use this skill whenever the user asks about Polymarket trading,
  prediction market strategy, EV betting, probability calibration for markets, arbitrage between
  prediction markets and sportsbooks, Polymarket API/SDK usage, CLOB trading mechanics, market
  making on prediction markets, building trading bots for event contracts, or international
  prediction market access. Also trigger on "prediction market", "Polymarket", "event contract",
  "binary outcome trading", "resolution rules", "Yes/No shares", "implied probability trading",
  "multi-outcome market", "prediction market arbitrage", "Polymarket API", "Polymarket US vs
  international", or any request involving systematic prediction market edge-finding.
---

# Polymarket Trading Expert

A leveled framework for systematic, +EV prediction market trading. Only ~0.5% of Polymarket wallets historically turn meaningful profit. This skill exists to beat those odds through rigorous probability calibration, research edge, strategic execution, automation, and disciplined scaling — not gambling.

## How Polymarket Works

Polymarket runs a hybrid Central Limit Order Book (CLOB) on Polygon with USDC.e settlement. The mechanics are simple but the edge is not:

- **Share pricing**: Buy/sell Yes or No (or multi-outcome) shares where price = crowd-implied probability. Yes at $0.65 means the market prices the outcome at 65%.
- **Resolution**: Correct outcomes pay $1.00 per share; incorrect pay $0.00. Markets resolve via predefined rules covering politics, crypto prices, sports, awards, Fed decisions, and more.
- **Where edge comes from**: Mispricings, cross-platform arbitrage, speed, and superior research. High-liquidity markets exist, but the crowd is often right — you need a reason to disagree.
- **Core EV formula**: `EV = (your_probability × payout) – price`. If EV > 0, the trade has positive expected value. If you can't articulate why your probability differs from the market's, you don't have an edge.
- **Two platforms**: Polymarket International (crypto-native, no KYC in most jurisdictions) and Polymarket US (CFTC-regulated via QCX LLC, KYC required). See `references/international-access.md` for full geo-restriction details.

## Prerequisites

- Crypto wallet (MetaMask or equivalent) with basic operational competence
- Working understanding of probability, expected value math, and bankroll management concepts
- $100–500 starting capital — only risk what you can afford to lose entirely
- Spreadsheet for trade journaling (Google Sheets or Excel)

## Bundled Resources

Read these reference files when you need depth on a specific topic. The SKILL.md provides the framework; the references provide the tactical detail.

| Reference | Path | Read When |
|-----------|------|-----------|
| Weather Trading | `references/weather-trading.md` | For weather market strategy, model update schedules, forecast arbitrage, and bot architecture |
| Timing Strategies | `references/timing-strategies.md` | For entry/exit timing, market lifecycle positioning, information speed edges, and duration optimization |
| Resolution Risk & Disputes | `references/resolution-risk.md` | Before entering any market with ambiguous resolution language, or after a dispute |
| Multi-Outcome Markets | `references/multi-outcome-markets.md` | When trading markets with 3+ outcomes (elections, awards, "which X will Y") |
| Correlated Markets & Hedging | `references/correlated-hedging.md` | When holding positions in markets that share underlying drivers |
| Capital Lockup & Opportunity Cost | `references/capital-lockup.md` | Before entering long-dated positions or high-probability/low-return trades |
| AI/LLM-Assisted Research | `references/ai-research.md` | When building LLM-powered research pipelines or probability estimation systems |
| International Access & Geo-Restrictions | `references/international-access.md` | For non-U.S. access rules, blocked countries, and platform comparison |
| Tax & Reporting | `references/tax-reporting.md` | For record-keeping requirements, tax classification, and jurisdiction considerations |

## Bundled Scripts

Run these directly — no need to load into context first.

| Script | Path | Purpose |
|--------|------|---------|
| EV Calculator | `scripts/ev_calculator.py` | Calculate EV, Kelly fraction, and position size for any trade |
| Calibration Scorer | `scripts/calibration_scorer.py` | Compute Brier score and calibration metrics from your trade journal CSV |
| Arbitrage Scanner | `scripts/arb_scanner.py` | Template for cross-platform price comparison (requires API keys) |

---

## Level 1: Platform Mastery

**Goal**: Master the interface, wallet flow, and basic trading without losing money to mechanical errors.

### Sub-Skills

1. **Wallet & funding pipeline** — Set up wallet, bridge assets to Polygon, acquire USDC.e, connect to Polymarket. Understand gas fees and transaction confirmation times.
2. **Order execution** — Place limit orders and market orders. Understand the fee structure, liquidity depth, and spread. Know when to sell early vs. hold to resolution. Know how to redeem winning shares.
3. **Market literacy** — Read market pages fluently: volume, open interest, comment sentiment, resolution source and rules. The resolution rules are the contract — misunderstanding them is how beginners lose on "obvious" outcomes.
4. **Platform selection** — Understand whether you're on International or US platform and what that means for market access, KYC requirements, and funding methods. See `references/international-access.md`.

### Resources

- Polymarket Help Center (Markets + Trading sections)
- Official Docs: Quickstart & Trading Overview
- Current beginner walkthrough guides (search for latest — these update frequently)

### Deliberate Practice

Execute 5–10 small trades ($10–50 each) on familiar, high-liquidity events — NBA games, crypto price thresholds, or near-term binary outcomes where you can verify resolution quickly. Focus on error-free execution, not profit.

### Milestone

10 error-free trades completed. Can correctly convert market price to implied probability, calculate simple P&L, and explain the resolution rules for any market you enter. Every trade logged in your journal.

---

## Level 2: Probability & Research Fundamentals

**Goal**: Shift from guessing to calibrated forecasting. The gap between "I think this will happen" and "I estimate 72% probability based on these inputs" is where trading edge begins.

### Sub-Skills

1. **Probability calibration** — Convert prices to probabilities. When you say 70%, events should happen ~70% of the time. Most people are overconfident on high-probability events and underconfident on low-probability ones.
2. **EV calculation discipline** — For every potential trade: `EV = (your_prob × $1.00) – market_price`. Only enter when EV > 0 by a meaningful margin (≥5–10% edge minimum for beginners to account for calibration error). Use `scripts/ev_calculator.py` to run the math.
3. **Research aggregation** — Source and weight information: polls (with methodology awareness), breaking news, expert consensus, historical base rates, and model outputs. No single source is sufficient. See `references/ai-research.md` for LLM-assisted approaches.
4. **Mispricing identification** — Distinguish between "the market is wrong" and "I'm overconfident." The market aggregates many participants — you need a specific informational or analytical reason to disagree.
5. **Resolution risk awareness** — Before entering any trade, read the resolution rules completely. Understand common traps. See `references/resolution-risk.md`.

### Resources

- *Superforecasting* by Philip Tetlock — the foundational text on calibrated prediction
- Calibration training: Metaculus or Good Judgment Open (free, deliberate practice)
- Daily market browsing + X/Twitter sentiment monitoring for real-time information flow

### Deliberate Practice

Pick 5 live markets weekly. Before checking the market price, write down your probability estimate and reasoning. Then compare to the market. Track where you diverge and why. Run `scripts/calibration_scorer.py` monthly on your journal to compute your Brier score.

### Milestone

Identify and document 3+ clear +EV trades where your calibrated probability exceeds the market price by ≥5–10%. Execute at least one successfully. Your journal should show the reasoning chain, not just the outcome.

---

## Level 3: Core Strategy Implementation

**Goal**: Generate consistent edge using proven strategic patterns. This is where systematic trading replaces opportunistic betting.

### Sub-Skills

1. **Cross-platform arbitrage** — Compare Polymarket pricing against sportsbooks (DraftKings, FanDuel, etc.) using tools like OddsJam or `scripts/arb_scanner.py`. When the same event is priced differently across platforms, the spread is free money minus execution friction.
2. **Multi-outcome market exploitation** — Markets with 3+ outcomes have unique arbitrage dynamics. All outcome shares must sum to $1.00 — when they don't, the spread is your edge. See `references/multi-outcome-markets.md`.
3. **Mispricing hunting** — Target "clear-win" high-probability markets where resolution is near-certain but the market hasn't fully priced it (often due to capital lockup or low attention). Run `references/capital-lockup.md` math before entering long-dated high-prob positions.
4. **Whale/expert tracking** — Monitor top traders via public Polymarket profiles and on-chain activity. Not to blindly copy, but to understand what informed capital is doing and why.
5. **Basic liquidity provision** — Add depth to thinner markets to earn spread and potential rewards. Understand the risk: you're taking the other side of informed flow.
6. **Correlated position management** — When holding positions in related markets, understand your aggregate exposure. See `references/correlated-hedging.md`.
7. **Bankroll management** — Max 1–5% of total bankroll risked per position. Diversify across 10+ uncorrelated markets. Use Kelly criterion conservatively (half-Kelly or quarter-Kelly). Use `scripts/ev_calculator.py` Kelly mode for sizing.

### Deliberate Practice

Execute 20+ real trades using at least two distinct strategies. Journal every trade. Review every resolved market — wins and losses both contain signal.

### Milestone

Positive net ROI over a 30–60 day window. You should be able to articulate which strategies generated edge and which didn't. Adjust allocation accordingly.

---

## Level 4: Automation & Advanced Execution

**Goal**: Scale speed and volume through code. Manual trading hits a ceiling — automation breaks through it.

### Sub-Skills

1. **API & SDK integration** — Use Polymarket's official APIs: Gamma (market data) and CLOB (order execution). SDKs available in Python, TypeScript, and Rust. Understand rate limits, authentication, and data structures.
2. **Bot development** — Build targeted automation: arbitrage scanners, price alert systems, auto-ordering scripts. Start from `scripts/arb_scanner.py` template and customize.
3. **AI-assisted research pipeline** — Use LLMs to scan news feeds, aggregate polling data, and generate probability estimates at scale. See `references/ai-research.md` for architecture patterns and the Polymarket Agents GitHub framework.
4. **Domain specialization** — Pick 1–2 categories and go deep. Each has its own information ecosystem, timing patterns, and edge sources.
5. **Market-making mechanics** — Quote two-sided spreads via the relayer system. Requires understanding of inventory risk, adverse selection, and exposure management.
6. **Psychological discipline** — Automate what you can to remove emotion. Strict position sizing rules, no FOMO entries, no revenge trading.

### Deliberate Practice

Fetch live market data via API. Script a basic +EV scanner. Run it on real markets at test volume before scaling. Iterate on signal quality.

### Milestone

At least one workflow fully automated. $5K+ total volume traded profitably in your specialization category.

---

## Level 5: Expert Scaling & Legacy

**Goal**: Operate with the discipline and infrastructure of a professional trading operation.

### Sub-Skills

1. **Portfolio optimization** — Multi-market hedging, correlation analysis, systematic rebalancing. Use `references/correlated-hedging.md` for the framework.
2. **Information arbitrage** — Develop proprietary data sources, custom models, or speed advantages.
3. **Full automation + dashboards** — Custom performance dashboards, automated execution, real-time P&L tracking. Systems should run without daily intervention.
4. **Capital scaling** — Increase position sizes while maintaining edge. Edge degrades with size — test at each tier.
5. **Tax optimization** — Structured record-keeping for tax reporting. See `references/tax-reporting.md`.
6. **Continuous improvement** — Review 100+ resolved markets for calibration analysis. Run `scripts/calibration_scorer.py` quarterly. Publish tools or analysis publicly.

### Milestone

Consistent profitability over 6+ months across varying market conditions. $10K+ total volume traded with positive ROI, or a published tool/script that the community actually uses.

---

## Supporting Modules (Apply at Every Level)

### Risk & Bankroll

- Never risk >5% of total bankroll on a single outcome
- Use Kelly criterion conservatively — half-Kelly maximum, quarter-Kelly recommended
- Diversify across event types and correlation clusters
- Hard stop: if you lose 20% of bankroll, stop trading for a week and review every position
- Account for correlated exposure — 5 positions on related markets ≠ 5x diversification

### Psychology & Bias Control

- Track biases explicitly: overconfidence, recency, anchoring, sunk cost
- Review losing trades weekly — loss patterns reveal more than wins
- Separate analysis from execution: decide probability and size before opening the order screen
- Journal emotional state alongside trade decisions — FOMO and tilt destroy bankrolls

### Tools Stack

| Tool | Purpose |
|------|---------|
| Polymarket site + app | Primary trading interface |
| Polymarket API (Gamma + CLOB) | Data + execution automation |
| Spreadsheet (Sheets/Excel) | Trade journal + P&L tracking |
| OddsJam or equivalent | Cross-platform arbitrage scanning |
| X/Twitter + RSS | Real-time information flow |
| Discord/Telegram communities | Sentiment + trade idea sourcing |
| Python + VPS | Custom scripts, bots, scanners |
| Claude / LLM tools | Research aggregation + probability estimation |

### Trade Journal Template

Every trade gets a row:

| Field | Description |
|-------|-------------|
| Date | Entry date |
| Market | Market title + URL |
| Direction | Yes/No + outcome bought |
| Size | Dollar amount risked |
| Entry Price | Price paid per share |
| Your Probability | Your calibrated estimate at entry |
| Market Probability | Market price at entry |
| EV at Entry | Calculated edge |
| Strategy | Which strategy drove the trade |
| Correlation Group | Which other positions share exposure |
| Capital Lockup Days | Expected days until resolution |
| Annualized Return | Return adjusted for time locked |
| Exit | Price/resolution + date |
| P&L | Dollar profit or loss |
| Notes | What you learned, what you'd change |

---

## Time & Success Expectations

- **Levels 1–3** (Novice → Intermediate): 3–6 months at 10–20 hours/week
- **Levels 4–5** (Advanced → Expert): 12+ months of deliberate practice beyond that
- **The real metric is long-term EV, not win rate.** Many profitable traders have sub-50% win rates — they win big on correct high-conviction calls and lose small on diversified positions.
- **Most retail traders lose because they treat prediction markets like a casino.** This framework forces systematic edge-finding, position sizing discipline, and continuous calibration review.

## Legal & Compliance Note

Polymarket operates two distinct platforms with different regulatory frameworks. U.S. regulatory status for prediction markets is evolving. See `references/international-access.md` for full details on geo-restrictions, platform differences, and access rules. See `references/tax-reporting.md` for record-keeping and tax considerations. This skill provides a strategic framework, not legal or financial advice. Never trade with money you can't afford to lose.

## Chaining with Other Skills

- **Market research** → Web search tools for polling data, economic indicators, breaking news
- **Financial modeling** → Chain with `cfo-executive` for bankroll optimization frameworks
- **Trading bot architecture** → Chain with `cto-executive` for infrastructure decisions
- **Risk quantification** → Chain with `crisc-risk-practitioner` for FAIR-style portfolio risk modeling
- **Legal review** → Chain with `legal-practice` for jurisdiction-specific regulatory questions
- **Spreadsheet build-out** → Chain with `xlsx` skill for automated trade journal templates
