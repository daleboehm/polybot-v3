# POLYMARKET TRADING BOTS, STRATEGIES & SYSTEMS — COMPREHENSIVE RESEARCH (2026)

**Research Date:** March 17, 2026
**Scope:** Open-source bots, commercial platforms, AI agents, advanced trading strategies, data sources, risk management, X/Twitter discussions, technical innovations

---

## PART 1: TOP POLYMARKET TRADING BOTS & FRAMEWORKS

### A. Open-Source GitHub Repositories

#### **Production-Grade Bots**

1. **dylanpersonguy/Polymarket-Trading-Bot** (53K+ lines TypeScript)
   - **URL:** https://github.com/dylanpersonguy/Polymarket-Trading-Bot
   - **Features:** 7 automated strategies (arbitrage, convergence, market making, momentum, AI forecast); whale tracker with copy-trade simulator; real-time 9-tab monitoring dashboard; parallel market scanner; paper trading mode
   - **Contact:** @DylanForexia on Telegram for custom bots
   - **Status:** Most advanced open-source offering

2. **lorine93s/polymarket-market-maker-bot** (Production-Ready)
   - **URL:** https://github.com/lorine93s/polymarket-market-maker-bot
   - **Specialization:** Production-ready market-making bot for Polymarket's CLOB
   - **Key Features:**
     - Manages inventory, places optimal quotes, handles cancel/replace cycles
     - Automated risk controls
     - Efficient spread capture, balanced YES/NO exposure
     - Real-time orderbook trading, low latency, gas-optimized operations

3. **dylanpersonguy/Fully-Autonomous-Polymarket-AI-Trading-Bot**
   - **URL:** https://github.com/dylanpersonguy/Fully-Autonomous-Polymarket-AI-Trading-Bot
   - **Specialization:** Autonomous AI prediction market trading
   - **Key Features:**
     - Multi-model ensemble forecasting (GPT-4o, Claude, Gemini)
     - Automated research engine
     - 15+ risk checks
     - Whale tracking
     - Fractional Kelly sizing
     - Real-time 9-tab monitoring dashboard
     - Paper & live trading modes

#### **Arbitrage-Focused Bots**

4. **qntrade1/polymarket-arbitrage-trading-bot**
   - **URL:** https://github.com/qntrade1/polymarket-arbitrage-trading-bot
   - **Specialization:** Detects and executes arbitrage opportunities
   - **Strategy:** When sum of YES/NO ticket prices < $1.00, executes risk-free profit

5. **discountry/polymarket-trading-bot**
   - **URL:** https://github.com/discountry/polymarket-trading-bot
   - **Specialization:** Monitors 15-minute Up/Down markets for probability drops
   - **Execution:** Automated execution on detected sudden probability drops

6. **ent0n29/polybot** (Reverse-Engineering Framework)
   - **URL:** https://github.com/ent0n29/polybot
   - **Purpose:** Reverse-engineer every Polymarket strategy and trade fast
   - **Architecture:**
     - Multi-service system for automated execution (paper & live modes)
     - Strategy runtime and market making
     - Market/user trade ingestion into ClickHouse
     - Quantitative analysis and replication scoring

#### **Copy-Trading & Whale Tracking Bots**

7. **zydomus219/Polymarket-betting-bot**
   - **URL:** https://github.com/zydomus219/Polymarket-betting-bot
   - **Specialization:** Enterprise-grade trade copier for target wallet replication

8. **Gabagool2-2/polymarket-trading-bot-python**
   - **URL:** https://github.com/Gabagool2-2/polymarket-trading-bot-python
   - **Specialization:** Automated liquidity provision and epoch-end high-probability trading

9. **polymarketwhales/polymarket** (Whale Tracking Extension)
   - **URL:** https://github.com/polymarketwhales/polymarket
   - **Purpose:** Real-time whale tracking, smart money alerts, on-chain analytics

10. **luckeyfaraday/polymarket-bot** (Free & Open-Source)
    - **URL:** https://github.com/luckeyfaraday/polymarket-bot
    - **Features:** Free arbitrage + market making strategies; local execution with key safety

11. **dev-protocol/polymarket-trading-bot** (Binary Crypto Markets)
    - **URL:** https://github.com/dev-protocol/polymarket-trading-bot
    - **Specialization:** TypeScript bot for 15-minute BTC/ETH Up/Down markets

12. **warproxxx/poly-maker** (Google Sheets Configured)
    - **URL:** https://github.com/warproxxx/poly-maker
    - **Specialization:** Automated market making with Google Sheets parameters

13. **sssorryMaker/polymarket-trading-bot**
    - **URL:** https://github.com/sssorryMaker/polymarket-trading-bot
    - **Focus:** Arbitrage strategies

14. **elielieli909/polymarket-marketmaking**
    - **URL:** https://github.com/elielieli909/polymarket-marketmaking
    - **Specialization:** Market-making strategies

15. **NYTEMODEONLY/polyterm** (Terminal Interface)
    - **URL:** https://github.com/NYTEMODEONLY/polyterm
    - **Specialization:** Command-line Polymarket interface

### B. Official Frameworks & Tools

16. **Polymarket/agents** (Official SDK)
    - **URL:** https://github.com/Polymarket/agents
    - **Purpose:** Trade autonomously using AI Agents framework
    - **Features:** Chroma.py vector DB for news, LLM integration, trade execution

17. **Polymarket/poly-market-maker** (Official Market Maker Keeper)
    - **URL:** https://github.com/Polymarket/poly-market-maker
    - **Purpose:** Automated market maker keeper for CLOB markets

### C. AI Agent Frameworks

18. **elizaos-plugins/plugin-polymarket** (ElizaOS Integration)
    - **URL:** https://github.com/elizaos-plugins/plugin-polymarket
    - **Framework:** ElizaOS - Web3 friendly AI Agent OS
    - **Environment Variables:** CLOB_API_URL, CLOB_API_KEY, POLYMARKET_PRIVATE_KEY
    - **Actions:** Market listing, price history, orderbook data

19. **theSchein/pamela** (Example ElizaOS Agent)
    - **URL:** https://github.com/theSchein/pamela
    - **Purpose:** Autonomous 24/7 Polymarket trading with news analysis

---

## PART 2: AI AGENTS & AUTONOMOUS SYSTEMS

### Commercial AI Trading Agents

1. **Polystrat** (Olas Network)
    - **Launch:** February 2026
    - **Performance:** 4,200+ trades in ~1 month; up to 376% per trade
    - **Win Rate:** 59-64% in tech markets
    - **User P&L Positive:** 37% (vs. <13% humans)
    - **Architecture:** Monitors 500-1,000 markets, ingests live news/sentiment/economic data

2. **AI PolyMarket**
    - **URL:** https://www.ai-polymarket.com/
    - **Accuracy:** 87% claimed
    - **Data:** Trends, sentiment, social signals, historical patterns

3. **PolyEdge AI**
    - **URL:** https://www.polyedgeai.com/
    - **Models:** Claude Sonnet, Claude Haiku, GPT-4o, GPT-4o-mini, Perplexity Sonar, Grok
    - **Method:** Ensemble with disagreement quantification and bias correction

4. **PolyRadar**
    - **Features:** Multi-model analytics, timeline visualization, confidence scoring

5. **OpenClaw/ClawdBot**
    - **URL:** https://github.com/chainstacklabs/polyclaw
    - **Capability:** 6-agent autonomous systems in ~6 hours
    - **Features:** Monitoring, research, trading, risk management agents
    - **Warning:** Security researchers flagged malicious forks; verify code authenticity

6. **CtrlPoly**
    - **URL:** https://ctrlpoly.xyz/
    - **Positioning:** "Control Your Edge"

7. **PolyCue**
    - **URL:** https://polycue.xyz/
    - **Specialization:** AI-powered arbitrage

8. **PolySignal**
    - **URL:** https://www.polysigns.xyz/
    - **Features:** Real-time news NLP, sentiment analysis

9. **Polytrader**
    - **URL:** https://polymark.et/product/polytrader
    - **Approach:** Sentiment + news + onchain 24/7 trading

10. **PolyPulse**
    - **Type:** Chrome extension
    - **Features:** AI news analysis, automatic market detection

---

## PART 3: ADVANCED TRADING STRATEGIES

### A. Structural Arbitrage

**1. Intra-Market Dutch Book Arbitrage**
- Buy YES + NO when combined < $1.00 for risk-free profit
- Execution window: 2.7 seconds average (down from 12.3s in 2024)
- 73% of arbitrage profits captured by <100ms bots
- Most common bot strategy

**2. Cross-Platform Arbitrage (Polymarket ↔ Kalshi ↔ Opinion)**
- Example: Polymarket 60%, Kalshi 55% → buy YES Kalshi, NO Polymarket
- Returns: 12–20% monthly cited
- Total extracted (Apr 2024-Apr 2025): ~$40 million
- Price discovery: Polymarket leads, Kalshi lags by minutes

**3. Overlapping Market Arbitrage (BTC 15m/5m)**
- 5-minute market overlaps with 15-minute final 5 minutes
- Same reference price, different time windows
- Exploit logical mismatches between contracts

**4. Multi-Outcome Combinatorial Arbitrage**
- Buy YES on multiple outcomes when aggregated probability < 100%
- More outcomes = more mispricing opportunities
- 27% of bot profits from non-arbitrage strategies

### B. Market-Making Strategies

**5. Bid-Ask Spread Capture**
- Post orders 0.90–0.95 USD on higher-probability side
- Profit: 0.05–0.10 USD per contract on settlement
- Zero fees + Polymarket rebates
- Daily liquidity reward: $300 per market

**6. Negative Risk Rebalancing (Multi-Outcome)**
- Sum of all YES < $1.00? Buy all YES outcomes
- Lock profit on convergence

### C. Momentum & Trend Strategies

**7. Latency Arbitrage (Exchange Lag)**
- Exploit Binance/Coinbase → Polymarket repricing lag
- Example: $313 → $414,000 in one month (98% win rate on BTC/ETH/SOL 15m)

**8. Probability Convergence**
- Trade on convergence patterns as event approaches

**9. Momentum Entry/Exit**
- Rapid probability shifts signal repricing events

### D. AI Probability Forecasting

**10. Multi-Model Ensemble**
- Example weights: GPT-4o 40%, Claude 35%, Gemini 25%
- Aggregation: trimmed mean, median, or weighted average
- Historical accuracy: 70%+ for state-of-the-art
- Win rate: 59-64% in tech markets

**11. ML Signal Generation**
- Algorithms: XGBoost, LightGBM, stacking ensembles
- Outputs: probability + confidence scores

**12. News Sentiment + Probability Trading**
- Process thousands of articles in real-time
- NLP for market-moving events
- Platforms: Termo.ai, PolySignal, AI PolyMarket

**13. Copy-Trading & Whale Following**
- Mirror top wallets: "SeriouslySirius" ($2M+/month), "sharky6999" (~$480K), "distinct-baguette" (~$242K)
- Alerts typically $10K+ trades
- Top 10 wallets capture 80%+ arbitrage profits

### E. Exotic Strategies

**14. Portfolio Hedging**
- Hedge macro risks (inflation, policy) with small Polymarket allocations
- Example: BTC call spread + Polymarket "No"

**15. Correlation-Based Hedging**
- Trade opposite outcomes of correlated events

**16. Liquidity Mining + Market Making**
- Provide two-sided liquidity, earn spread + rewards

---

## PART 4: DATA SOURCES & SIGNALS

### Official APIs
- **Gamma API:** Market discovery, metadata
- **CLOB API:** Real-time prices, orderbook
- **Data API:** Positions, trade history
- **WebSocket:** Real-time orderbook changes
- **Documentation:** https://docs.polymarket.com/

### On-Chain Data
- **The Graph Subgraphs:** Polymarket trades, positions, resolutions
- **Bitquery GraphQL:** https://docs.bitquery.io/docs/examples/polymarket-api/
- **Asset:** USDC.e (PoS) on Polygon

### News & Sentiment
- **AskNews API** (in agents framework)
- **Chroma DB** (vector DB for news)
- Platforms: PolySignal, AI PolyMarket, Termo.ai

### Whale Tracking
- **Polywhaler:** https://www.polywhaler.com/ ($10K+ trades, insider activity)
- **WhaleSight:** Browser extension for smart money tracking
- **Polymarket Bros:** Copy trading, $4K+ thresholds
- **Unusual Whales:** https://unusualwhales.com/predictions

### On-Chain Metrics
- Weekly transactions: 26.26 million
- TVL: $330 million
- Market cap: $44 billion

### Institutional Data
- **ICE Polymarket Signals:** Crowd-sourced probabilities for professionals

---

## PART 5: RISK MANAGEMENT FRAMEWORKS

### A. Kelly Criterion Position Sizing

**Formula:** f* = (bp - q) / b
- **p** = true probability forecast
- **q** = 1 - p
- **b** = (1 - Market_Price) / Market_Price

**Example:** Market 60%, forecast 75% → Kelly recommends 37.5% of bankroll

**Implementation:**
- Full Kelly maximizes growth but 33% chance of halving bankroll
- Fractional Kelly (0.25x–0.5x) for real-world risk management
- Most traders lose from wrong sizing, not wrong picks

### B. Risk Management (Top Traders)

- Multi-factor framework: whale signals + research + Kelly + market context
- Inventory balancing (market makers)
- Independent stop-loss on copy trades
- Gas optimization for frequent execution

### C. Profitability Baseline

- Industry: Only 7.6% of wallets profitable
- 120,000 profitable vs. 1.5 million losing
- AI agents: 37% P&L positive (Polystrat)
- Human traders: 7-13% profitable rate

---

## PART 6: X/TWITTER KEY DISCUSSIONS

**Strategies Discussed:**
- @bankrbot: "Jane Street polymarket lag arb bot" — sub-100ms pricing exploitation
- @CryptoGodJohn: "AI + Polymarket = biggest arbitrage opportunity of 2026"
- @w1nklerr: "Binance-Polymarket arbitrage generates millions/day for bots"
- @crellos_0x: Rust-based BTC 5m market structural arbitrage
- @leviathan_news: Cross-market arbitrage 12–20% monthly returns
- @0xPhilanthrop/@0x_Discover: OpenClaw 6-agent systems built in 6 hours
- @Gopynich: Reality check—profitable bots "nearly impossible" in 2026 due to latency arms race

---

## PART 7: TECHNICAL INNOVATIONS

### CLOB Mechanics
- BUY outcome X = SELL opposite outcome (100¢ - X)
- Deeper liquidity, tighter spreads
- Recent change (2026): Removed 500ms taker delay in crypto markets
- Effect: Taker-based arb less profitable; market-making favored

### Infrastructure
- **NautilusTrader:** Unified Polymarket CLOB integration with Python client
- **Rust Ecosystem:** polyfill-rs, polymarket-client-sdk, polymarket-hft (full HFT framework)
- **Python:** polymarket-apis (PyPI)
- **JavaScript:** ElizaOS plugin ecosystem

---

## PART 8: ECOSYSTEM DIRECTORIES

### Tool Repositories

1. **Awesome-Prediction-Market-Tools** (Most Complete)
   - **URL:** https://github.com/aarora4/Awesome-Prediction-Market-Tools
   - **Scope:** 170+ tools, all categories, multiple platforms

2. **Awesome-Polymarket-Tools**
   - **URL:** https://github.com/harish-garg/Awesome-Polymarket-Tools

3. **Polymark.et**
   - **URL:** https://polymark.et/
   - **Categories:** Bots, analytics, whale tracking, APIs, dashboards, DeFi

4. **PolyCatalog**
   - **URL:** https://www.polycatalog.io/polymarket-tools
   - **Description:** Most comprehensive directory

5. **DeFiPrime Definitive Guide**
   - **URL:** https://defiprime.com/definitive-guide-to-the-polymarket-ecosystem

### Ecosystem Scale
- 170+ tools across 19 categories
- 26.26M weekly transactions
- $330M TVL
- 30%+ of Polymarket participants already using AI agents

---

## PART 9: PROFITABILITY & PERFORMANCE DATA

### AI Agent Performance
- **Polystrat (1 month):** 4,200+ trades, up to 376% per trade, 59-64% win rate
- **User P&L:** 37% positive (vs. <13% humans)

### Top Historical Performers
- "SeriouslySirius": $2M+ in single month
- "sharky6999": ~$480K
- "distinct-baguette": ~$242K
- Top 10 wallets: 80%+ of arbitrage profits

### Arbitrage Profits (Apr 2024–Apr 2025)
- Total extracted: ~$40 million
- Execution windows: 2.7 seconds
- Bot wallet percentage: 14 of top 20 profitable wallets

### Human vs. Bot Performance
- Profitable humans: 7.6-13% of traders
- Profitable bots: 37%+ (AI agents)
- Only 7-13% of human traders achieve positive performance

---

## PART 10: CRITICAL WARNINGS & RISK FACTORS

### Security
- OpenClaw malicious forks with code obfuscation exist
- Recommendation: Verify code authenticity before use
- Key management: Use environment variables, consider hardware wallets

### Profitability Challenges
- 2026 market reality: 92% of traders unprofitable
- Arbitrage windows down to 2.7 seconds from 12 seconds (2024)
- Requires <100ms execution
- Jump Trading maintains <100ms with 20-person desk
- Minimum capital: $10K, increasing

### Regulatory
- Prediction market status evolving
- Polymarket in gray zone in many jurisdictions
- Risk of access restrictions or closure

---

## PART 11: IMPLEMENTATION ROADMAP

**Stage 1 — Learning (Paper Trading)**
- Study Dutch book & LMSR math
- Learn CLOB API
- Practice arbitrage on open-source bots
- Study Kelly criterion

**Stage 2 — Small Live Capital ($1K–$5K)**
- Start arbitrage-only (lowest risk)
- Monitor bot execution
- Track P&L metrics
- Build data pipeline

**Stage 3 — Scaling**
- Move to profitability before increasing capital
- Deploy 3-5 strategies
- Implement advanced risk controls
- Consider market-making

**Stage 4 — Advanced**
- Multi-model AI ensemble forecasting
- News/sentiment integration
- Order flow analysis
- Proprietary model development

---

## SOURCES & REFERENCES

### GitHub (Bots & Frameworks)
- https://github.com/dylanpersonguy/Polymarket-Trading-Bot
- https://github.com/lorine93s/polymarket-market-maker-bot
- https://github.com/Polymarket/agents
- https://github.com/ent0n29/polybot
- https://github.com/qntrade1/polymarket-arbitrage-trading-bot
- https://github.com/chainstacklabs/polyclaw
- https://github.com/elizaos-plugins/plugin-polymarket
- https://github.com/aarora4/Awesome-Prediction-Market-Tools

### AI Agents & Platforms
- https://olas.network/agents/prediction-agents (Polystrat)
- https://www.ai-polymarket.com/
- https://www.polyedgeai.com/
- https://ctrlpoly.xyz/
- https://polycue.xyz/

### Analytics & Whale Tracking
- https://www.polywhaler.com/
- https://polymarketanalytics.com/
- https://www.polymark.et/
- https://unusualwhales.com/predictions

### Documentation
- https://docs.polymarket.com/
- https://docs.bitquery.io/docs/examples/polymarket-api/
- https://docs.chainstack.com/docs/polygon-creating-a-polymarket-trading-openclaw-skill

### News & Analysis
- https://www.coindesk.com/tech/2026/03/15/ai-agents-are-quietly-rewriting-prediction-market-trading
- https://www.coindesk.com/markets/2026/02/21/how-ai-is-helping-retail-traders-exploit-prediction-market-glitches-to-make-easy-money
- https://defiprime.com/definitive-guide-to-the-polymarket-ecosystem
- https://phemex.com/news/article/polymarket-arbitrage-strategies-for-crypto-traders-36382

---

## CONCLUSION

Polymarket trading evolved from retail opportunity (2023-24) to algorithm-dominated competition (2026). Success requires:

1. **Technical Edge:** Sub-100ms execution, advanced data pipelines, multi-model AI
2. **Capital:** $10K–$50K minimum; $100K+ for scale
3. **Risk Management:** Fractional Kelly, diversified strategies
4. **Continuous Learning:** Monitor structure changes, competitive dynamics, regulation

**Most Successful Approach:** Combine structural arbitrage (low-risk/return) with probabilistic forecasting (high-risk/return) in balanced portfolio. Pure arbitrage saturated—alpha now from information processing superiority.

