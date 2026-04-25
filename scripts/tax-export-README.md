# tax-export.py — Polybot V3 IRS Form 8949 Export

Generates a Form 8949-style CSV from the Polybot V3 trade audit trail by FIFO
lot-matching `trades` BUYs against pre-resolution SELLs and against synthesized
SELL events derived from the `resolutions` table (which records each resolved
position's payout, cost basis, and realized P&L).

## Usage

```bash
# Default: real-money trades, current calendar year, all entities, stdout
python3 /opt/polybot-v3/scripts/tax-export.py

# Full year 2026, polybot entity only, written to file, with summary
python3 /opt/polybot-v3/scripts/tax-export.py \
    --entity polybot --year 2026 \
    --out /tmp/polybot-2026-form8949.csv --summary

# Single quarter
python3 /opt/polybot-v3/scripts/tax-export.py --year 2026 --quarter Q2 --summary

# Include paper-trading rows (R&D analysis only — NOT for tax filing)
python3 /opt/polybot-v3/scripts/tax-export.py --include-paper --summary

# Against the R&D database
python3 /opt/polybot-v3/scripts/tax-export.py \
    --db /opt/polybot-v3-rd/data/rd.db --include-paper
```

## CLI flags

| Flag              | Default                              | Notes                                          |
| ----------------- | ------------------------------------ | ---------------------------------------------- |
| `--db`            | `/opt/polybot-v3/data/polybot.db`    | SQLite path                                    |
| `--entity`        | all                                  | filter by `entity_slug`                        |
| `--year`          | current UTC year                     | calendar year for the report                   |
| `--quarter`       | none (full year)                     | `Q1`/`Q2`/`Q3`/`Q4`                            |
| `--include-paper` | off (real-money only)                | include `is_paper=1` rows                      |
| `--out`           | stdout                               | CSV path                                       |
| `--summary`       | off                                  | aggregate stats to stderr                      |

## Output schema (Form 8949-shaped)

`description, date_acquired, date_sold, proceeds, cost_basis, gain_loss,
holding_period (short/long), entity_slug, market_slug, condition_id,
token_id, fees_total`

`description` is human-readable, e.g. `26.5900 NO shares - Will Mazatlan FC win on 2026-04-25?`.

## Method

1. Pull all `trades` rows for the entity (filtered by `is_paper`).
2. Pull all `resolutions` rows. Each resolution synthesizes a virtual
   SELL at price `payout_usdc / size` on `resolved_at` — winning positions
   close at $1/share, losing positions at $0.
3. Group events by `(entity_slug, condition_id, token_id)`, sort by
   timestamp, then walk: BUYs push lots; SELLs and resolution events
   FIFO-consume lots. Each consumption yields one CSV row.
4. Holding period: >365 days = `long`, else `short`. (Polymarket markets
   typically resolve in days/weeks, so virtually everything is short-term.)
5. Out-of-window events still consume FIFO state (so prior-year lots aren't
   counted twice when reporting a later period), but those rows are dropped.

## Edge cases

- **Orphan SELLs** (no matching BUY in DB): logged to stderr, excluded from CSV.
- **Open positions** (`status=open`, no resolution row): skipped entirely.
- **Resolution row with size=0**: skipped.
- **Resolution claims more size than tracked lots**: warning logged, only
  matched portion emitted.
- **`is_paper=1`**: excluded by default. `--include-paper` re-includes them
  but those rows are NOT tax-reportable.
- **Multiple BUYs averaging a position**: each BUY is its own lot; FIFO
  preserved.
- **Reconciler-closed positions** (`absent_from_api`): if a `resolutions`
  row was written, it's used. If not, the position is treated as still open
  and its P&L is excluded — investigate any such positions manually.

## Classification caveat — READ THIS

**This script outputs a Form 8949-shaped file. Whether your prediction-market
P&L should actually be filed on Form 8949 (capital gains) is a CPA decision.**
The IRS has not issued definitive guidance on Polymarket-style binary
prediction-market shares. The candidates are:

1. **Capital gains (Form 8949 / Schedule D)** — treats outcome shares as
   property. Short-term gains taxed as ordinary income; losses can offset
   gains and (up to $3,000/yr) ordinary income. This is what the script
   formats for.
2. **Gambling income (Schedule 1)** — winnings reported as "Other income";
   losses only deductible as itemized deductions, capped at winnings, no
   carryover. The IRS has historically classified prediction market wagers
   as gambling for some platforms.
3. **Section 1256 contracts** — unlikely to apply to Polymarket; would be a
   60/40 long/short blend marked-to-market at year-end. Almost certainly
   not the right bucket here.

Polymarket itself, when it issues 1099 forms, has historically used 1099-MISC
(non-employee compensation / other income), which leans toward gambling/other
income treatment, not capital gains. **Take this CSV to your CPA. Do not file
on Form 8949 without their sign-off.**

## Wash-sale rule

Section 1091 wash-sale rules apply to "stock or securities." Whether a
Polymarket binary outcome share is a "security" under 1091 is unsettled and
arguably no — outcome shares are not equity claims, do not pay dividends,
have a fixed binary payout, and most tax practitioners do NOT apply wash-sale
rules to them. **This script does NOT detect or adjust for wash sales.** If
your CPA decides Polymarket gains are capital gains AND that wash-sale
applies, you will need additional analysis on top of this output.

## Data integrity notes

- The script trusts the `resolutions` table for closed-position payouts.
  If `resolutions.payout_usdc` was wrong (e.g., reconciler bug, partial fill
  not captured), the export will inherit that error.
- Per-trade `fee_usdc` in this DB is currently 0 across all rows — Polymarket
  CLOB BUYs do not charge maker/taker fees on outcome shares as of 2026-04.
  If the fee model changes upstream, the script picks it up automatically.
- Aggregate gain/loss from this CSV should reconcile (within rounding) to:
  ```sql
  SELECT SUM(realized_pnl) FROM resolutions
  WHERE entity_slug='polybot' AND is_paper=0
        AND resolved_at >= '2026-01-01' AND resolved_at < '2027-01-01';
  ```
  Mismatches indicate either pre-resolution SELL trades that the reconciler
  did not write back into `resolutions`, or orphan SELLs.
