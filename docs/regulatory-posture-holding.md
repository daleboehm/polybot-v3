# Regulatory Posture — Holding File

> **Purpose**: Capture the current regulatory posture of the Polymarket trading fleet and the planned offshore migration path, so that if external conditions change (enforcement action, regulatory clarification, banking pressure, counsel recommendation) we can execute a prepared response rather than improvise.
> **Status**: Informational holding document. Not an action plan. Review triggers defined below.
> **Owner**: Dale Boehm
> **Created**: 2026-04-10

---

## Current Posture (as of 2026-04-10)

### Operational setup
- **VPS hosted in Amsterdam** (DigitalOcean droplet 560035247 at 178.62.225.235) — deliberately non-US to sidestep Polymarket's US IP restrictions. Polymarket (via its CFTC 2022 settlement) is not supposed to serve US persons; a US-based VPS would be blocked. Amsterdam gives us uninterrupted access to the CLOB + Gamma + Data API.
- **Prod wallet** (`0xF8d12267...`) on Polygon mainnet, funded from personal USDC. Currently $2.49 + 40 stuck positions pending audit-fix reconciliation.
- **Legal wrapper (current)**: effectively personal / Caspian-LLC. The 16 entities in `entities.yaml` are currently **arbitrary placeholder names**, not live legal structures. They map to future intended use cases (business sub-accounts, family trusts, education funds, holding cos) but have no current legal substance.
- **Trading activity**: Dale's personal / Caspian-LLC risk. Amsterdam VPS hosting reduces discovery surface but does not change the underlying legal exposure if challenged.

### Who this impacts
- **Dale personally** — primary risk holder
- **Caspian (the LLC with $2.5M debt)** — indirect risk via ownership linkage
- **Armorstack LLC** — no direct exposure; the engine is not Armorstack-owned

---

## The Enforcement Landscape (as Dale has framed it)

Dale's standing position (2026-04-10): **"I will not be too worried about regulatory issues."** The Amsterdam VPS is an acknowledged bypass of US Polymarket restrictions; this is intentional and Dale is operating with eyes open. The fleet rebuild is NOT being designed around US regulatory compliance. No Kalshi compliance sleeve is being built. No KYC/AML trails are being maintained beyond what the Polymarket wallet already exposes.

**Known risk surface**:
1. **Polymarket's CFTC settlement** (2022) requires Polymarket to block US persons. They enforce via IP geofencing, not identity verification. Amsterdam VPS bypasses the IP gate; the wallet itself carries no KYC trail.
2. **CFTC enforcement against US persons trading event contracts** is a theoretical risk (the CFTC has been expanding its jurisdiction). Historical enforcement has focused on platform operators, not individual traders. This could change.
3. **Banking / on-ramp risk** — transferring USDC to/from the prod wallet could attract scrutiny from a US bank if the amounts grow large and patterns suggest prediction market activity. This is the most likely pressure point before any direct enforcement.
4. **Tax reporting** — Polymarket winnings are taxable in the US regardless of where the trading occurred. Dale plans to track per-entity tax (already in R3 scope). Tax tracking is independent of regulatory posture.

---

## Long-Term Path: Offshore Trust Structure

Dale has indicated the long-term intent to migrate the trading operation into an offshore trust, specifically naming:

### Option A: Cook Islands Trust
- **Jurisdiction**: Cook Islands (self-governing, Free Association with NZ)
- **Asset protection strength**: considered the strongest in the world for asset protection. Cook Islands courts do not recognize foreign judgments, and there is a 1-2 year statute of limitations on fraudulent transfer claims from the date of funding.
- **Cost**: $5K–$15K setup, $3K–$8K/year maintenance (trustee fees, registered agent, filing)
- **Time to set up**: 6–12 weeks once counsel is engaged
- **Tax treatment**: Cook Islands has no income, capital gains, or wealth tax on trust assets. US settlor pays US tax on trust income (it's a grantor trust for US tax purposes if Dale remains the grantor). No tax reduction — pure asset protection.
- **Banking**: Cook Islands trusts typically bank in Singapore, Switzerland, or the Cook Islands directly. Opening a crypto-friendly bank account is harder than a fiat account.
- **Reporting**: Dale must file IRS Form 3520 (foreign trust), 3520-A (annual foreign trust return), FBAR (FinCEN 114) if aggregated offshore accounts exceed $10K, and 8938 (FATCA) if threshold exceeded. Reporting is onerous but doable.

### Option B: Nevis LLC + Trust Structure
- **Jurisdiction**: Federation of Saint Kitts and Nevis
- **Asset protection strength**: second strongest after Cook Islands. Nevis LLC + Nevis trust is a common pairing that combines charging order protection (LLC) with trust-level protection (trust holds the LLC interest).
- **Cost**: slightly cheaper than Cook Islands ($3K–$10K setup, $2K–$6K/year)
- **Time to set up**: 4–8 weeks
- **Tax treatment**: similar to Cook Islands for US grantor. No local income tax.
- **Banking**: Nevis has more on-island banking options than Cook Islands; Singapore also common.
- **Reporting**: same IRS forms (3520, 3520-A, FBAR, 8938) apply.

### Why these jurisdictions specifically
Both are consistently ranked at the top of asset protection indices. Both have robust trust laws, no treaties requiring disclosure to the US beyond what US forms already capture, and a legal environment hostile to plaintiffs trying to attach offshore assets. Both are crypto-tolerant (not crypto-friendly, but not crypto-hostile).

**Neither is a tax haven for US persons** — the US taxes worldwide income. The value is in asset protection (shielding trading capital from US judgments, creditors, or regulatory clawbacks), not tax avoidance.

---

## Triggering Events (when to revisit this document)

Review this file and consider migration if any of these occur:

1. **Polymarket enforcement action** naming US traders specifically (not just platform operators). Current enforcement targets platforms; shifting to traders = move.
2. **CFTC expansion of jurisdiction** to cover individual event-contract traders. Watch CFTC enforcement bulletins.
3. **Banking friction** — a US bank freezes or questions transfers tied to the prod wallet. Even a single request for documentation = move.
4. **Caspian debt situation resolves or escalates** — if debt is settled, asset protection becomes less urgent; if it escalates into judgment or collection, asset protection becomes urgent immediately.
5. **Fleet capital exceeds ~$100K** — at that scale, the cost-benefit of offshore migration flips positive (legal setup fees become a small fraction of protected capital).
6. **IRS audit or inquiry** touching the trading activity.
7. **Armorstack growth** makes it the dominant business — if Armorstack becomes the primary income source, Caspian's debt exposure on the trading fleet needs isolation.
8. **Polymarket adds US support** via a different legal structure (e.g., CFTC-registered DCM or similar) — changes the bypass calculus entirely.
9. **Dale directs a review** regardless of the above.

---

## What Needs to Be Ready If We Move

Pre-positioning work so an offshore migration can execute in weeks instead of months:

### Documentation to keep current
- [ ] Per-entity cost basis and realized P&L (R3 scope, already planned)
- [ ] Wallet address history and transaction history exportable in a format a trustee can accept
- [ ] Business documentation on Caspian, Armorstack, and any other entity that would be assigned to the trust
- [ ] Source-of-funds documentation for the USDC currently in play (personal transfer from Dale)

### Counsel relationships to cultivate in advance
- [ ] An offshore asset protection attorney licensed in the target jurisdiction (Cook Islands or Nevis)
- [ ] A US tax attorney familiar with foreign trust reporting (Form 3520/3520-A, FBAR, 8938)
- [ ] A crypto-literate CPA who can handle per-entity tax returns across US + offshore structure

### Technical pre-positioning
- [ ] Wallet key custody plan that works across the migration (hardware signing / HSM is Phase R4 of the rebuild — this becomes more urgent if migration looms)
- [ ] Ability to transfer the wallet + trading state between legal owners without interrupting trading (blue/green deploy is Phase R4 — this becomes more urgent)
- [ ] VPS provider relationship that works for offshore entities — DigitalOcean Amsterdam is fine for now; a Cook Islands trust might prefer a provider that accepts crypto payment and doesn't require US-style KYC

---

## What This File Is NOT

- Not legal advice. Everything here is context for a future conversation with qualified counsel.
- Not a commitment to migrate. The current posture (Amsterdam VPS, personal risk) is stable until a trigger fires.
- Not an action plan. No items here are on the R1–R4 rebuild roadmap. The rebuild delivers the technical fleet; this file captures the legal wrapper planning that runs in parallel.
- Not tax advice. Foreign trust reporting is complex and penalties for non-compliance are severe. Any move requires tax counsel before execution.

---

## Review Cadence

- **Quarterly review** of the triggering events list — did any fire?
- **Annual review** of the cost-benefit calculus as fleet capital grows
- **Immediate review** if Dale receives any communication from a regulator, bank, or counsel touching trading activity

---

## Cross-references

- Rebuild plan: `C:\Users\dboehm\.claude\plans\spicy-puzzling-robin.md`
- Design decisions: `Polymarket/docs/rebuild-design-decisions-2026-04-10.md`
- Lessons (framing corrections): `Polymarket/docs/lessons.md`
- Secrets vault pattern: `Polymarket/docs/secrets-vault-README-2026-04-10.md`
- Audit: `Polymarket/docs/audit-2026-04-09.md` (§16 Compliance Snapshot)

---

## Status

**Parked.** Reviewable on-demand. No action required unless a trigger fires or Dale directs.
