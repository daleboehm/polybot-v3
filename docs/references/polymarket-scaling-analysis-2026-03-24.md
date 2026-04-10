# Polymarket Scaling Analysis: 1 Account vs. 10 Accounts

**Prepared for:** Dale Boehm, CEO — Armorstack
**Date:** March 24, 2026
**Classification:** CONFIDENTIAL — Personal Investment Analysis

---

## Executive Summary

**Recommendation: Do NOT spin up 9 additional accounts. Scale capital within the single account.**

The risk-adjusted return of a 10-account strategy is negative when you factor in legal exposure (federally regulated DCM since November 2025), operational overhead (~$540/year in VPS costs alone), and the high probability of correlated account detection. The compounding math on a single well-capitalized account delivers equivalent or better returns with none of the downside.

---

## The Question

Should you operate 10 parallel Polymarket accounts (each with its own VPS, Coinbase account, and wallet) to multiply trading volume 10x — or continue scaling the single account organically?

---

## Part 1: What Changed — Polymarket Is Now Federally Regulated

This is the single most important factor in the analysis, and it's recent enough that it may not be on your radar.

**Timeline of regulatory shifts:**

- **January 2022:** CFTC fined Polymarket $1.4M for operating an unregistered facility. Polymarket agreed to block US users through December 2024.
- **July 2025:** CFTC and DOJ ended their probe without new charges.
- **Mid-2025:** Polymarket acquired QCEX (a CFTC-licensed exchange and clearinghouse) for $112M.
- **November 2025:** CFTC issued an Amended Order of Designation making Polymarket a federally regulated Designated Contract Market (DCM).
- **December 2025:** Polymarket began limited US rollout with full KYC requirements.

**What this means for multi-account operations:**

As a DCM, Polymarket is now subject to the same regulatory framework as the CME or CBOE. Multi-account operations against a federally regulated exchange aren't a TOS violation — they're potentially wire fraud (18 U.S.C. § 1343), identity fraud, and CFTC market manipulation. The legal exposure category shifted from "platform ban risk" to "federal enforcement risk."

**US KYC requirements now include:** SSN, government photo ID, proof of residency, and routing through approved FCMs (Futures Commission Merchants). You cannot create 9 legitimate accounts without 9 real identities.

---

## Part 2: Financial Analysis — The Math Doesn't Work

### Current System Performance

| Metric | Value |
|--------|-------|
| Active scripts | sprint_trader, quick_cycle, arb_executor, position_monitor |
| Recent redemption | $160 USDC (9 resolved positions) |
| Max trade size | $50 per opportunity |
| Arb opportunities found | 0/109 markets (expected — efficient market) |
| VPS cost | $5/month (DigitalOcean AMS3) |

### 10-Account Scenario — Cost Structure

| Cost Category | Monthly | Annual |
|---------------|---------|--------|
| 9 additional VPS instances ($5/ea) | $45 | $540 |
| 10 Coinbase accounts — verification overhead | One-time, but requires 9 additional identities | N/A |
| Initial capital deployment (10 × $500 minimum) | $5,000 upfront | — |
| Operational management (monitoring, rebalancing) | 2-4 hours/week of CEO time | ~$10K+ opportunity cost |
| Tax/legal complexity (10 entities) | CPA time | $2,000-5,000/year |
| **Total incremental annual cost** | — | **$2,540-5,540 + $5K capital + CEO time** |

### Why 10x Accounts ≠ 10x Returns

The current bottleneck isn't infrastructure — it's edge. Consider what happened:

- **Arb scanner:** Found 0 Dutch books across 109 markets. Running 10 scanners on the same 109 markets still finds 0. Dutch books are market-wide, not account-specific. One scanner captures 100% of the opportunity.
- **Sprint trader:** Kelly-sized positions are capped at $50. The cap is a risk parameter, not an account limit. Increasing the cap on one account from $50 to $500 has the same capital deployment as running 10 accounts at $50.
- **Exit engine:** Monitors YOUR positions. More accounts means more positions to monitor, but the exit signals are identical. No edge multiplication.

**The only scenario where multiple accounts add edge:** If Polymarket enforced per-account position limits (they don't currently) or if you needed to place orders larger than the book depth (you're nowhere near this — MIN_LIQUIDITY is $2,000 and you're trading $50).

### Single Account Scale-Up Path

| Phase | Timeline | Capital | Max Trade | Expected Monthly |
|-------|----------|---------|-----------|-----------------|
| Current | Now | ~$500 | $50 | $50-200 |
| Phase 2 | After 30 days of positive P&L | $2,000 | $200 | $200-800 |
| Phase 3 | After 90 days | $5,000 | $500 | $500-2,000 |
| Phase 4 | After 180 days | $10,000 | $1,000 | $1,000-4,000 |

This achieves 10x+ returns through capital scaling on a single account with zero additional legal, operational, or infrastructure risk. The Kelly criterion naturally scales position sizes with bankroll.

---

## Part 3: Detection Risk Assessment

Even setting aside the legal issues, Polymarket's AML/fraud detection would likely catch correlated multi-account activity.

**Detection vectors:**

| Signal | Your Exposure |
|--------|--------------|
| IP correlation | All 10 VPS instances from same DigitalOcean account, similar IP ranges |
| Behavioral fingerprinting | Identical trading algorithms, same timing patterns, same market selection |
| Coinbase KYC linkage | All 10 Coinbase accounts funded from same bank/same person |
| On-chain analysis | Correlated deposit/withdrawal patterns across 10 Polygon wallets |
| CLOB API patterns | Same API client signatures, same order sizing logic |
| Device/browser fingerprinting | Same session management patterns |

Polymarket's compliance team (now operating under CFTC oversight) is required to monitor for wash trading and market manipulation. Correlated accounts are the first thing their surveillance systems flag.

**Consequence of detection:** Account freeze, fund seizure, potential CFTC referral. Not a "create a new account" situation — it's a "hire a lawyer" situation.

---

## Part 4: What Actually Increases Returns

Instead of horizontal scaling (more accounts), focus on vertical scaling (better edge per dollar deployed):

### Immediate (This Week)
1. **Increase Kelly fraction gradually** — Current max is 25% Kelly. If the fee-adjusted model shows consistent positive EV, move to 35-40% over the next 30 days.
2. **Raise MAX_CAPITAL_PER_ARB** — From $50 to $100 once you have 2 weeks of clean arb execution data.
3. **Monitor exit engine P&L** — The position_monitor is the highest-impact script. Track how many exits it triggers and whether they're net-positive vs. holding to resolution.

### Short-Term (30-60 Days)
4. **Add sentiment signals** — LunarCrush and MT Newswires are already connected to the sprint trader. Verify they're actually improving win rate vs. price-only signals.
5. **Liquidity-weighted market selection** — Filter to markets with $10K+ liquidity where your orders won't move the price.
6. **Maker order strategy** — Switch from taker (3.15% fee) to maker (0% fee) on the exit engine. Place limit orders at your target price instead of market-crossing. This alone recovers 3.15% on every exit.

### Medium-Term (90+ Days)
7. **Event-driven positioning** — Pre-position before known catalysts (earnings, elections, court rulings). The edge isn't in the arb scanner — it's in information asymmetry on specific events.
8. **Portfolio correlation management** — Ensure the sprint trader isn't loading up on correlated positions (e.g., 5 different Trump policy markets that all move together).
9. **Automated bankroll management** — Script that sweeps profits above a threshold to Coinbase and reloads capital when the account dips below minimum.

---

## Part 5: Risk Matrix

| Strategy | Legal Risk | Financial Risk | Operational Risk | Expected Return |
|----------|-----------|---------------|-----------------|----------------|
| **10 accounts (proposed)** | HIGH — Federal fraud exposure | MEDIUM — $5K+ capital + costs | HIGH — 10x monitoring | Marginal improvement |
| **1 account, scale capital** | LOW — Compliant single user | LOW — Gradual ramp | LOW — Existing infra | Equal or better returns |
| **1 account, improve edge** | LOW | LOW-MEDIUM | MEDIUM — R&D effort | Highest risk-adjusted return |

---

## Decision Framework

Ask yourself three questions:

1. **Is the constraint capital or edge?** If the sprint trader has positive expected value at $50/trade, the answer is capital. Solve that by adding funds to one account, not by multiplying accounts.

2. **Would you do this with a brokerage account?** Opening 10 E-Trade accounts under different identities to trade the same strategy is securities fraud. Polymarket is now regulated by the same agency (CFTC). Apply the same standard.

3. **What's the CEO opportunity cost?** Managing 10 accounts, 10 VPS instances, 10 Coinbase flows, and 10 tax reporting entities is operationally intensive. That's hours per week you're not spending on Armorstack's $955K MRR target.

---

## Bottom Line

The multi-account strategy was viable when Polymarket was an unregulated offshore DeFi platform. That era ended in November 2025. The platform is now a federally regulated DCM with full KYC, AML monitoring, and CFTC oversight.

**Your 10x lever is capital, not accounts.** Scale the single account from $500 → $5,000 over the next 90 days. The Kelly criterion, exit engine, and fee adjustments you just deployed will compound returns naturally. If the system proves profitable at $5K, scale to $10K. That gives you your 10x with zero legal exposure.

The arb scanner, exit engine, and fee-adjusted Kelly are live and running. Let the system prove itself before allocating more capital — but when you do allocate, put it in one account.

---

*This analysis is for personal investment decision-making only. Not financial or legal advice. Consult securities counsel before material changes to trading operations.*
