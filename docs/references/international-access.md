# International Access & Geo-Restrictions

Polymarket operates two distinct platforms with different regulatory frameworks, access rules, and market availability. Understanding which platform you're on — and which markets you can access — is a prerequisite for everything else in this skill.

## Two Platforms

### Polymarket International (polymarket.com)
- **Funding**: Crypto-native, wallet-based (USDC.e on Polygon)
- **KYC**: Not mandatory in most permitted jurisdictions
- **Market access**: Broadest selection — politics, crypto, sports, culture, international events
- **Geo-blocking**: Strictly enforced via IP address in ~33 countries
- **Operator**: Polymarket (original entity)

### Polymarket US (operated by QCX LLC)
- **Funding**: Fiat on-ramps possible, plus crypto
- **KYC**: Required — identity verification mandatory
- **Market access**: Narrower — certain event types restricted (e.g., some sports, war-related contracts)
- **Access**: Federally regulated under CFTC, often waitlist-based
- **Operator**: QCX LLC (separate legal entity)

Non-U.S. users in permitted countries typically use the international platform for broader market access and no KYC requirement.

## Geo-Restriction Status (As of March 2026)

### Fully Blocked Countries (No Access to International Platform)

These jurisdictions cannot access polymarket.com for trading. Enforcement is via IP address detection.

| Country | Code | Notes |
|---------|------|-------|
| Australia | AU | |
| Belarus | BY | Sanctions-related |
| Belgium | BE | |
| Burundi | BI | Sanctions-related |
| Central African Republic | CF | Sanctions-related |
| Congo (Kinshasa) | CD | Sanctions-related |
| Cuba | CU | Sanctions-related |
| Ethiopia | ET | |
| France | FR | |
| Germany | DE | |
| Iran | IR | Sanctions-related |
| Iraq | IQ | Sanctions-related |
| Italy | IT | |
| Nicaragua | NI | |
| North Korea | KP | Sanctions-related |
| Poland | PL | |
| Russia | RU | Sanctions-related |
| Singapore | SG | |
| Somalia | SO | Sanctions-related |
| Syria | SY | Sanctions-related |
| United States | US | Blocked on international; separate US platform |
| Venezuela | VE | |
| Yemen | YE | Sanctions-related |
| Zimbabwe | ZW | |

*Additional countries may be restricted. This list reflects known blocks as of March 2026.*

### Close-Only / Partially Restricted

Can close/sell existing positions but cannot open new trades or deposit new funds:

| Country | Code | Notes |
|---------|------|-------|
| Thailand | TH | Close-only |
| Taiwan | TW | Close-only |
| Ontario, Canada | — | Provincial restriction within otherwise open country |

### Generally Accessible (~160+ Countries)

If your country is not on the blocked or restricted lists, you can normally access and trade on the international platform. This includes most of Latin America, Africa (outside listed nations), Europe (outside FR/DE/IT/BE/PL), and Asia (outside SG/TH/TW).

## Confirming Your Access Status

1. Visit polymarket.com directly — **without a VPN** — from your actual location.
2. If blocked, you'll see a geo-restriction message.
3. Cross-check against the official help center article on Geographic Restrictions: help.polymarket.com
4. For API-level checks: docs.polymarket.com/api-reference/geoblock for the programmatic blocked-country list.

**Important**: The blocked list updates. Countries are added and occasionally removed as regulations evolve. Always verify against the official source before assuming access.

## Setup for Non-Restricted Countries

If your location is permitted:

1. **Wallet**: Use a non-custodial Web3 wallet (MetaMask, Phantom, WalletConnect) or sign in via Magic Link (email-based, no wallet needed initially).
2. **Funding**: Bridge or acquire USDC.e on Polygon network. CEX → Polygon bridge is the standard path.
3. **Connect**: Link wallet to polymarket.com → browse markets → place orders.
4. **KYC**: Not required in most permitted jurisdictions unless your country specifically mandates it.
5. **Trade**: Full access to global event markets (politics, crypto, culture, international sports where allowed).

## If Your Country Is Restricted

Polymarket explicitly prohibits using VPNs, proxies, or other tools to bypass geo-blocks. Violation risks:
- Account freeze
- Fund loss (locked in platform, potentially unrecoverable)
- Permanent ban
- Enforcement is improving via IP analysis + on-chain behavior patterns

### Legitimate Alternatives

1. **Monitor for policy changes** — Countries have been added to and removed from the blocked list historically. Follow @Polymarket on X and the official blog for announcements.
2. **Alternative platforms** — Kalshi (U.S.-regulated, expanding internationally), Augur (decentralized), Azuro (DEX-based), or emerging prediction markets on other chains.
3. **Legal consultation** — In borderline jurisdictions (close-only, or countries where status is ambiguous), consult a local crypto/gambling attorney before trading.
4. **Polymarket US** — If you're in the U.S. specifically, apply for the CFTC-regulated platform via QCX LLC. Market selection is narrower but access is legal.

## U.S. vs. Non-U.S. Comparison (March 2026)

| Feature | International | Polymarket US |
|---------|--------------|---------------|
| Funding | Crypto only (USDC.e on Polygon) | Fiat + crypto |
| KYC | Not required in most countries | Required |
| Market breadth | Broadest | Narrower (some event types restricted) |
| Regulatory status | Varies by jurisdiction | CFTC-regulated |
| Access model | Open (in permitted countries) | Waitlist / application |
| Blocked jurisdictions | ~33 countries | N/A (U.S. only) |
| Sports markets | Available in most jurisdictions | Restricted on some |
| War/conflict markets | Available | Restricted |

## Compliance Best Practices

- Trade only from your actual location — do not use location spoofing
- Keep records of all transactions for tax purposes (see `tax-reporting.md`)
- Monitor regulatory developments in your jurisdiction — prediction market law is evolving rapidly worldwide
- If your country's status changes mid-position, you may be moved to close-only. Have an exit plan for open positions.
