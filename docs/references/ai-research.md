# AI/LLM-Assisted Research for Prediction Markets

LLMs are force multipliers for prediction market research — they can aggregate information, identify relevant base rates, and generate structured probability estimates faster than manual research. This reference covers architecture patterns for building an AI-assisted research pipeline.

## Use Cases

### 1. News Aggregation & Summarization
Feed an LLM breaking news, press releases, and social media posts related to an open market. Ask it to:
- Summarize the directional implications for the market outcome
- Identify which new information is already priced in vs. genuinely novel
- Flag conflicting signals across sources

### 2. Base Rate Research
For any market, the most valuable starting point is: "How often has this type of event happened historically?" LLMs can:
- Pull historical base rates for similar events (e.g., "How often does the incumbent party win re-election?")
- Adjust base rates for relevant factors (economic conditions, polling data, structural changes)
- Identify reference classes that the market may be overlooking

### 3. Structured Probability Estimation
Use a prompt chain to generate calibrated estimates:

**Step 1 — Frame the question**: "What is the probability that [outcome] by [date]?"

**Step 2 — Identify key factors**: Ask the LLM to list the 5-10 most important factors that determine the outcome.

**Step 3 — Assess each factor**: For each factor, gather current data and assess its directional impact.

**Step 4 — Generate estimate**: Ask the LLM to synthesize all factors into a probability estimate with confidence interval.

**Step 5 — Adversarial challenge**: Ask the LLM to argue against its own estimate. What's the strongest case for the opposite outcome?

**Step 6 — Final calibrated estimate**: Adjust based on the adversarial challenge.

This chain forces structured reasoning rather than gut-feel prediction.

### 4. Sentiment Analysis
Scrape X/Twitter, Reddit, Discord, and Telegram for market-relevant sentiment:
- Volume of discussion (increasing attention often precedes price movement)
- Sentiment polarity (bullish/bearish on the outcome)
- Identification of "smart money" voices vs. retail noise
- Detection of coordinated narrative shifts

### 5. Resolution Rule Analysis
Feed the LLM the exact resolution rules for a market and ask:
- What are the edge cases where resolution could go either way?
- What precedents exist from similar markets?
- What is the probability of a dispute, and what would the dispute outcome likely be?

## Architecture Patterns

### Simple: Manual LLM Workflow
1. Copy market details + resolution rules into Claude/ChatGPT
2. Run the structured probability estimation chain above
3. Compare your LLM-assisted estimate to the market price
4. Document the reasoning in your trade journal

Best for: Levels 2-3 traders doing 5-10 trades per week.

### Intermediate: Scripted Research Pipeline
1. Use Polymarket Gamma API to pull market data programmatically
2. Use web scraping or news APIs to gather relevant information
3. Feed structured prompts to an LLM API (Claude API, OpenAI API)
4. Parse the LLM response for probability estimates and reasoning
5. Compare against market prices and flag +EV opportunities
6. Output to a dashboard or spreadsheet

Best for: Level 4 traders automating their research workflow.

### Advanced: Polymarket Agents Framework
The Polymarket Agents GitHub repository provides a framework for building AI-assisted trading agents. Components:
- Market data ingestion from Gamma API
- LLM-based analysis and probability estimation
- Trade execution via CLOB API
- Configurable strategy modules

Best for: Level 4-5 traders building fully automated systems.

## Prompt Engineering for Probability Estimation

### Effective Patterns

**Calibration anchoring**: "You are a superforecaster with a Brier score of 0.15. Estimate the probability of [outcome] using structured reasoning."

**Decomposition**: "Break this question into 3-5 independent sub-questions. Estimate the probability of each, then combine them."

**Reference class**: "What is the base rate for events of this type? List 5 historical analogues and their outcomes."

**Pre-mortem**: "Assume this outcome does NOT happen. What was the most likely reason?"

### Patterns to Avoid

- Asking for a single probability without reasoning (you get anchored to the first number)
- Treating the LLM estimate as ground truth (it's one input among many)
- Using LLMs for time-sensitive markets where speed matters more than analysis depth
- Over-fitting to the LLM's training data — it doesn't know what happened after its knowledge cutoff

## Calibrating Your AI Pipeline

Track the accuracy of your LLM-assisted estimates the same way you track your own:
- Log the LLM's probability estimate alongside yours and the market price
- After resolution, compute Brier scores for: your estimate, the LLM's estimate, the market price, and a blended estimate
- Over time, learn when to weight the LLM more (complex multi-factor analysis) vs. less (breaking news, domain expertise)

The goal isn't to replace your judgment with the LLM's — it's to combine them into a better ensemble than either alone.

## Cost Considerations

- Claude API: ~$3-15 per 1M tokens depending on model. A structured research prompt chain runs ~2-5K tokens per market.
- At 50 markets/week: $0.30–$3.75/week in API costs — trivial relative to trading capital.
- The bottleneck is prompt quality, not cost.
