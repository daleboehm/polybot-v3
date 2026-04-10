# Tax & Reporting for Prediction Market Trading

Prediction market tax treatment is jurisdiction-dependent and evolving. This reference covers record-keeping requirements and general frameworks — not tax advice. Consult a qualified tax professional for your specific situation.

## The Core Problem

Tax authorities worldwide have not consistently classified prediction market gains. Depending on your jurisdiction and how your local authority interprets the activity, gains may be treated as:

1. **Gambling/wagering income** — In many jurisdictions, gambling winnings are taxable. Some jurisdictions allow offsetting gambling losses against gambling wins; others don't.
2. **Capital gains** — If prediction market shares are treated as financial instruments, gains may fall under capital gains tax (short-term or long-term depending on holding period).
3. **Ordinary income** — If you're trading at the scale and frequency of a business, gains may be classified as business income / self-employment income.
4. **Crypto transaction** — Since Polymarket uses USDC.e on Polygon, some jurisdictions may treat each trade as a crypto-to-crypto transaction with its own taxable event.

The classification matters because tax rates, loss offset rules, and reporting requirements differ significantly across categories.

## Record-Keeping Requirements (Universal)

Regardless of jurisdiction, maintain these records for every trade:

### Per-Trade Records
- Date and time of entry
- Market identifier (title + URL)
- Direction (Yes/No) and number of shares
- Entry price per share
- Total cost basis (shares × price + any fees)
- Date and time of exit (sale or resolution)
- Exit price or resolution value ($1.00 or $0.00)
- Realized gain or loss
- Transaction hashes (on-chain proof)

### Aggregate Records
- Total deposits to Polymarket (fiat → crypto → platform)
- Total withdrawals from Polymarket (platform → crypto → fiat)
- Net P&L per calendar year / tax year
- Realized vs. unrealized gains at year-end
- Fee totals (gas fees, platform fees)

### Why On-Chain Records Matter
Polymarket operates on Polygon. Every transaction is recorded on-chain. This means:
- Tax authorities can theoretically trace all activity
- Your transaction history is permanent and auditable
- Discrepancies between reported income and on-chain activity are discoverable
- Keep your own records anyway — reconstructing from on-chain data after the fact is painful

## Jurisdiction-Specific Considerations

### United States
- The IRS has not issued specific guidance on prediction markets as of March 2026
- Possible classifications: gambling income (Form W-2G thresholds), capital gains (Schedule D), or business income (Schedule C)
- If using Polymarket US (CFTC-regulated), the platform may issue 1099 forms — confirm with QCX LLC
- Crypto-to-crypto transactions are generally taxable events under IRS guidance
- Cost basis tracking is essential — use FIFO, LIFO, or specific identification consistently

### European Union
- Varies dramatically by member state
- Some EU countries exempt gambling winnings from tax (e.g., UK, though UK has its own Polymarket restrictions)
- Others tax all gains as income
- Crypto reporting requirements (DAC8 directive) may apply to prediction market transactions

### Other Jurisdictions
- Research your specific country's treatment of: (a) gambling income, (b) crypto gains, (c) derivative/financial instrument gains
- When in doubt, report conservatively (declare gains, claim allowable losses)

## Practical Tax Optimization Strategies

### Loss Harvesting
If prediction market gains are taxable and losses are deductible in your jurisdiction:
- Realize losses before year-end to offset gains
- Sell losing positions before resolution if the probability has moved against you
- Document the loss with transaction records

### Holding Period Awareness
If capital gains rates apply and your jurisdiction differentiates short-term vs. long-term:
- Positions held >1 year may qualify for lower long-term rates
- This is rarely practical on Polymarket (most markets resolve within months)
- But be aware of the threshold if holding long-dated positions

### Cost Basis Method
Pick a consistent cost basis method and stick with it:
- **FIFO** (First In, First Out): Default in most jurisdictions
- **Specific Identification**: Allows choosing which shares to sell (more flexibility but more record-keeping)
- **Average Cost**: Simpler but may not be permitted in all jurisdictions

### Business vs. Hobby Classification
If you're trading at volume (Level 4-5), consider whether business classification is advantageous:
- **Business**: Deduct expenses (API costs, VPS, tools, education), but pay self-employment tax
- **Hobby/Personal**: Simpler reporting, but expense deductions limited or unavailable
- Consult a tax professional if your annual trading volume exceeds $50K

## Tools for Tax Record-Keeping

- **Spreadsheet**: The trade journal template in the main skill already captures most required fields. Add a "Tax Lot" column for cost basis tracking.
- **Crypto tax software**: Koinly, CoinTracker, or TaxBit can import Polygon wallet transactions and generate tax reports. Verify they handle Polymarket's specific contract interactions correctly.
- **On-chain export**: Export your full transaction history from Polygonscan for your wallet address as a backup.

## Annual Tax Checklist

1. Export all Polymarket transactions for the tax year
2. Reconcile with your trade journal (should match)
3. Calculate total realized gains and losses
4. Separate by classification if applicable (gambling vs. capital gains)
5. Document unrealized positions at year-end (for accrual-basis jurisdictions)
6. Compile expense records if claiming business deductions
7. Consult tax professional with the complete record set
