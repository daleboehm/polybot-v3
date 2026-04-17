# CTF Exchange V2 + pUSD Migration — Polybot V3 Plan

**Trigger:** Polymarket announced 2026-04-06 a full exchange upgrade to a new CTF Exchange V2 contract, new order struct, and native stablecoin (pUSD) replacing bridged USDC.e. Rollout window is 2–3 weeks from announcement (~2026-04-20 to 2026-04-27). **Exact cutover date is not yet published; Polymarket committed to ≥1 week advance notice.**

**Status of this plan (2026-04-16):** scaffolding and research complete. Actual code refactor gated on the cutover-date announcement AND on confirmation of the real pUSD contract address. Do not ship V2 code ahead of either signal.

---

## What changes at cutover

### Contract addresses (Polygon mainnet)
| Role | V1 (current) | V2 (future) |
|------|-------------|-------------|
| CTF Exchange | `0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E` | `0xE111180000d2663C0091e4f400237545B87B996B` |
| NegRisk Exchange | `0xC5d563A36AE78145C45a50134d48A1215220f80a` | `0xe2222d279d744050d28e00520010520000310F59` |
| Collateral | USDC.e `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` | pUSD (**address NOT confirmed** — read at runtime) |

### Order struct (EIP-712)
| Field | V1 | V2 |
|-------|----|----|
| `salt`, `maker`, `signer`, `tokenId`, `makerAmount`, `takerAmount`, `side`, `signatureType` | yes | yes |
| `taker` | yes | **REMOVED** |
| `feeRateBps` | yes | **REMOVED** (matcher-side now) |
| `nonce` | yes | **REMOVED** (replaced by `timestamp`) |
| `expiration` | yes | yes |
| `timestamp` | — | **NEW** (uint256) |
| `metadata` | — | **NEW** (bytes32) |
| `builder` | — | **NEW** (bytes32 builder-code) |

EIP-712 domain `version` bumps `"1"` → `"2"`. This alone invalidates every V1 signature.

### npm package
- Current: `@polymarket/clob-client@5.8.1` (V1 only)
- Required: `@polymarket/clob-client-v2@0.2.7` (dual V1+V2 support)
- Constructor changes from positional to named-object: `new ClobClient({ host, chain, signer, creds })`
- `createOrder(userOrder, { tickSize }, OrderType.GTC)` — tickSize now required
- `createAndPostOrder(...)` is the new preferred single-call path

### pUSD mechanics
- ERC-20 on Polygon, 6 decimals (same as USDC)
- NOT freely tradable — issued by Polymarket via `wrap()` on a Collateral Onramp contract
- API traders must call `wrap()` to convert USDC/USDC.e → pUSD before trading
- Real contract address NOT yet confirmed publicly. The v2 client currently ships a placeholder that happens to be the Ethereum MKR token address — **do not hardcode**. Either read from `getContractConfig(137)` at runtime, or call `getCollateral()` on the V2 Exchange contract.

---

## Code changes required (all paths under `C:\Users\dboehm\dev\polybot-v3\`)

| File | Lines | Change |
|------|-------|--------|
| `package.json` | ~22 | `"@polymarket/clob-client": "^5.8.1"` → `"@polymarket/clob-client-v2": "^0.2.7"` |
| `src/execution/clob-router.ts` | 169, 186, 198–203, 216 | Rewrite `ClobClientWrapper` behind an `exchange_version` switch: V1 and V2 both supported in parallel; config flag decides per-call. New named-object constructor. |
| `src/execution/clob-router.ts` | 126–131 | V2 drops per-order `feeRateBps`. Current hardcoded `feeRate = 0` stays correct but remove any reliance on the field. |
| `src/cli/index.ts` | 903–918, 941–944, 1206–1218, 1257–1262 | Two more direct `ClobClient` instantiations + `createOrder`/`postOrder` calls need the same migration. |
| `src/cli/index.ts` | 610 (USDC.e comment), 622 (6-decimal USDC) | Decimals unchanged; collateral address must be read from v2 client's `getContractConfig` — **do NOT hardcode.** |
| `src/core/engine.ts` | 265–281, 770, 880 | Wallet sync reads on-chain USDC balance. Post-cutover this needs to read pUSD (`getContractConfig(137).collateral`) for trading balance; any USDC.e inventory becomes stuck capital to be `wrap()`-ed before it trades. |
| `src/market/whale-event-subscriber.ts` | 23 | `OrderFilled` event signature hash `0xd0a08e8c...` is for V1 Exchange. V2 emits a different event — re-derive from `ExchangeV2.ts` ABI and add V2 address filter (`0xE11118...996B` + NegRisk V2 `0xe2222...310F59`). |
| `config/default.yaml`, `config/rd-default.yaml` | api block | Add `exchange_version: v1` explicit flag. Flip to `v2` on cutover day. URLs unchanged per current docs — verify against Polymarket's forthcoming changelog before flip. |
| `src/types/index.ts` | Order type | Add optional `timestamp`, `builder`, `metadata` fields so we can persist V2 attribution on our own records. |

---

## Feature-flag scaffolding (shipping 2026-04-16)

To avoid a big-bang change on cutover day, we scaffold the `exchange_version` flag now with V1 as the only implementation. On cutover day we add V2 behind the same flag and flip one config line to switch. This is the smallest-diff path that keeps prod releasable every day.

**Scaffold steps shipping in this commit:**
1. `config/default.yaml` + `config/rd-default.yaml`: add `api.exchange_version: v1` with a comment pointing to this doc.
2. No code change to `clob-router.ts` yet — the flag is read but ignored until V2 lands.

**Scaffold steps NOT shipping yet (gated on cutover-date announcement):**
- `@polymarket/clob-client-v2` package install
- `ExchangeV2.ts` helpers in `clob-router.ts`
- pUSD balance reads in `engine.ts`
- V2 `OrderFilled` event parsing in whale subscriber

---

## Release sequence (executed on cutover day)

**Preconditions:** Polymarket published the flip day ≥1 week prior. Real pUSD address confirmed (Polymarket docs OR an on-chain `getCollateral()` call that returns a non-placeholder value).

1. **7 days out:** pin `@polymarket/clob-client-v2@0.2.7` in a feature branch. Land `ExchangeV2.ts` wrapper behind the `exchange_version` flag. Run R&D engine against V2 testnet endpoint if Polymarket publishes one.

2. **3 days out:** read and cache the confirmed pUSD contract address. Add a one-off `polybot wrap-usdc --entity polybot --amount <usd>` CLI to convert live balances pre-cutover so we're not racing the flip.

3. **Cutover day −1 hour:** disable the prod engine (kill switch or config gate). Cancel all outstanding V1 orders (they'd get cancelled during the short maintenance window anyway; doing it ourselves is cleaner accounting).

4. **Cutover day, when flipped:**
   - Verify the chain-side flip by reading V2 Exchange contract state.
   - Run `wrap()` on any remaining USDC.e balance if not already done.
   - Flip `exchange_version: v1` → `exchange_version: v2` in both config files. Commit + push + VPS redeploy.
   - Re-release the kill switch via `kill -USR2`.
   - Watch the first 60 minutes of logs for signature failures, event-parsing errors, balance-sync mismatches.

5. **T+24 h:** run a reconciler audit — V2 events + V2 balance vs our DB. Any discrepancy gets fixed by hand before we let the scan loop trade more.

---

## What to NOT do

- **NEVER** hardcode a pUSD address. The v2 client ships a placeholder that is literally the Ethereum MKR token address; shipping that would misroute real money. Read at runtime.
- **NEVER** flip `exchange_version` to `v2` without Polymarket's on-chain flip confirmed first. The V1 Exchange keeps accepting orders until the flip; ours would silently fail.
- **NEVER** dual-publish orders (one V1 + one V2) on cutover day — one side fills, the other sits. Commit to one version per order, read the chain state, and only send through the verified-flipped path.
- **NEVER** run a `wrap()` on a wallet the engine is actively trading from without disabling the engine first. `wrap()` is a multi-call transaction that can race with other pending orders.

---

## Sources

- [github.com/Polymarket/clob-client-v2](https://github.com/Polymarket/clob-client-v2) (source of truth for Order struct)
- [npmjs.com/package/@polymarket/clob-client-v2](https://www.npmjs.com/package/@polymarket/clob-client-v2)
- [news.bitcoin.com — Polymarket April 2026 Upgrade](https://news.bitcoin.com/polymarkets-april-2026-upgrade-new-stablecoin-faster-order-matching-smart-contract-wallet-support/)
- [cryptotimes.io — CTF Exchange V2 announcement](https://www.cryptotimes.io/2026/04/07/polymarket-announces-ctf-exchange-v2-in-major-protocol-upgrade/)
- [coindesk.com — Polymarket full exchange upgrade](https://www.coindesk.com/markets/2026/04/06/polymarket-reveals-a-full-exchange-upgrade-to-take-control-of-its-own-trading-and-truth)
- [livebitcoinnews.com — pUSD launch](https://www.livebitcoinnews.com/polymarket-launches-pusd-in-major-polygon-protocol-upgrade/)
- [docs.polymarket.com/resources/contract-addresses](https://docs.polymarket.com/resources/contract-addresses)

---

*Document version: 2026-04-16. Owner: Dale Boehm. Review: when Polymarket publishes the cutover date.*
