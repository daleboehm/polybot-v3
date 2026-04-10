# Resolution Risk & Dispute Playbook

Resolution disputes are where experienced traders still get burned. The resolution rules ARE the contract — everything else is narrative. This reference covers the oracle system, common traps, and how to protect yourself.

## How Resolution Works

1. **Resolution source**: Every market specifies a resolution source (e.g., "Associated Press call", "official government data release", "CoinGecko price at 12:00 UTC"). The source is law — not the "spirit" of the market, not the comments, not common sense.
2. **UMA Optimistic Oracle**: Polymarket uses UMA's oracle system for dispute resolution. A proposer asserts the outcome, and if no one disputes within the challenge period, it resolves. If disputed, it escalates to UMA token holders who vote.
3. **Challenge period**: Typically 2 hours for most markets. During this window, anyone can dispute by posting a bond.
4. **Escalation**: If disputed, UMA voters decide. Votes are weighted by UMA token holdings. The process can take 48-96 hours.

## Common Resolution Traps

### Timezone Ambiguity
"By end of day March 15" — whose timezone? UTC? ET? The resolution source timezone governs. If the rules don't specify, this becomes a dispute magnet. Before entering: confirm the timezone is explicit in the rules or the resolution source's standard practice.

### "Official" vs. "Reported"
"Official unemployment rate" vs. "reported unemployment rate" are different things. The official rate from BLS may differ from preliminary reports. Markets that resolve on "official" data wait for the authoritative source; markets that resolve on "reported" may resolve on preliminary numbers.

### Definitional Edge Cases
"Will X resign?" — Does a forced resignation count? Does announcing intent to resign count, or does it require the resignation taking effect? Read the specific resolution criteria, not the market title.

### Partial Fulfillment
"Will the government pass a stimulus bill?" — What if they pass a bill that's widely described as stimulus but doesn't use that word? Or passes a smaller version? Markets with binary framing on continuous events are inherently ambiguous unless the resolution criteria are extremely specific.

### Source Unavailability
What happens if the resolution source goes offline, changes methodology, or ceases to exist? Most markets have a fallback clause — find it before trading.

### Time of Measurement
"Will Bitcoin hit $100K?" — At any point during the period? At the close? At a specific timestamp? The measurement methodology matters enormously for volatile assets.

## Pre-Trade Resolution Checklist

Before entering any market, answer these questions:

1. What is the exact resolution source? (Not "the news" — the specific entity/URL/data feed)
2. What timezone governs time-based criteria?
3. What happens in edge cases? (Partial fulfillment, definitional ambiguity, source failure)
4. Is there a fallback resolution mechanism?
5. Has this market type resolved before? Check similar past markets for precedent.
6. Are the comments surfacing any resolution ambiguity? (Comments are noise, but dispute signals are signal)

## Dispute Strategy

### When to Dispute
- You hold a significant position AND the proposed resolution is provably wrong per the stated rules
- The bond cost is justified by your position size
- You have clear evidence (screenshots, archived sources, timestamps)

### When NOT to Dispute
- You disagree with the "spirit" but the letter of the rules supports the resolution
- Your position is too small to justify the bond
- The evidence is ambiguous — UMA voters tend to side with the proposer in close calls

### Protecting Against Resolution Risk
- Size positions smaller in markets with ambiguous resolution language
- Diversify across markets with independent resolution sources
- Exit before resolution if the edge has been captured and resolution risk is non-trivial
- Screenshot/archive resolution sources at key moments — evidence decays
