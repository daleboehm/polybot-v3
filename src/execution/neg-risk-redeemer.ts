// NegRiskAdapter on-chain redemption — v3-owned, replaces legacy v1 auto_redeem.py cron.
//
// Polymarket negative-risk markets (weather, crypto, multi-outcome events) settle via
// the NegRiskAdapter contract at 0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296 on Polygon.
// After a market resolves, holders call redeemPositions(conditionId, amounts[]) to
// convert their winning conditional tokens back to USDC.
//
// Requires: the wallet must have previously called CTF.setApprovalForAll(adapter, true).
// v1's auto_redeem.py did this as a one-time setup; v3 assumes approval is already granted.
// If it isn't, redeemPositions will revert with an approval error and the reconciler
// will log + skip until Dale manually runs the approval tx.

import { createWalletClient, createPublicClient, http, parseAbi, type Address, type Hex } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('neg-risk-redeemer');

// Polymarket negative-risk adapter on Polygon mainnet.
// Source: Polymarket/auto_redeem.py:42 — the ADAPTER, not the exchange.
export const NEG_RISK_ADAPTER: Address = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296';

// Conditional Tokens Framework (ERC-1155 holding YES/NO tokens).
// Source: Polymarket/auto_redeem.py:41.
export const CTF_ADDRESS: Address = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

// USDC on Polygon (for balance checks pre/post redemption).
// Source: Polymarket/auto_redeem.py:43.
export const USDC_ADDRESS: Address = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';

const NEG_RISK_ABI = parseAbi([
  'function redeemPositions(bytes32 _conditionId, uint256[] _amounts)',
]);

const CTF_ABI = parseAbi([
  'function balanceOf(address account, uint256 id) view returns (uint256)',
  'function isApprovedForAll(address owner, address operator) view returns (bool)',
]);

const USDC_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
]);

// Ordered list of Polygon RPCs. On failure we fall through to the next.
// 2026-04-10: removed `rpc.ankr.com/polygon` (now requires API key, returns 401)
// and `polygon.meowrpc.com` (404s). Kept drpc and publicnode which still work anonymously.
// Added polygon-rpc.com (the canonical public RPC) as a first-choice.
const DEFAULT_POLYGON_RPCS: string[] = [
  'https://polygon-rpc.com',
  'https://polygon.drpc.org',
  'https://polygon-bor-rpc.publicnode.com',
  'https://rpc.polygon.io',
];

export interface RedemptionResult {
  success: boolean;
  txHash?: Hex;
  usdcBefore: bigint;
  usdcAfter: bigint;
  usdcClaimed: bigint;
  error?: string;
}

export class NegRiskRedeemer {
  private readonly rpcUrls: string[];

  constructor(
    private readonly privateKey: Hex,
    rpcUrls?: string[],
  ) {
    if (!privateKey.startsWith('0x') || privateKey.length !== 66) {
      throw new Error('NegRiskRedeemer: privateKey must be a 0x-prefixed 32-byte hex string');
    }
    this.rpcUrls = rpcUrls && rpcUrls.length > 0 ? rpcUrls : DEFAULT_POLYGON_RPCS;
  }

  /**
   * Redeem a single resolved market's positions. Calls `redeemPositions(conditionId, amounts)`
   * on the NegRiskAdapter. Returns the tx hash and USDC balance delta for reconciliation.
   *
   * @param conditionId 0x-prefixed bytes32 condition id (from Polymarket market metadata)
   * @param amounts Array of token amounts to redeem, in the order the CTF expects for the
   *   market's outcomes (e.g. `[yesAmount, noAmount]` for a binary market). Pass 0 for
   *   outcomes the wallet doesn't hold.
   */
  async redeem(conditionId: Hex, amounts: bigint[]): Promise<RedemptionResult> {
    const account = privateKeyToAccount(this.privateKey);
    let lastError: string | undefined;

    for (const rpcUrl of this.rpcUrls) {
      try {
        const publicClient = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
        const walletClient = createWalletClient({ account, chain: polygon, transport: http(rpcUrl) });

        const usdcBefore = await publicClient.readContract({
          address: USDC_ADDRESS,
          abi: USDC_ABI,
          functionName: 'balanceOf',
          args: [account.address],
        });

        log.info(
          {
            conditionId: conditionId.substring(0, 20) + '...',
            amounts: amounts.map(a => a.toString()),
            wallet: account.address,
            rpc: rpcUrl,
          },
          'Submitting redeemPositions tx',
        );

        const txHash = await walletClient.writeContract({
          address: NEG_RISK_ADAPTER,
          abi: NEG_RISK_ABI,
          functionName: 'redeemPositions',
          args: [conditionId, amounts],
        });

        const receipt = await publicClient.waitForTransactionReceipt({
          hash: txHash,
          timeout: 120_000,
        });

        if (receipt.status !== 'success') {
          lastError = `tx ${txHash} reverted`;
          log.warn({ txHash, conditionId: conditionId.substring(0, 20) + '...' }, 'redeemPositions reverted');
          continue;
        }

        const usdcAfter = await publicClient.readContract({
          address: USDC_ADDRESS,
          abi: USDC_ABI,
          functionName: 'balanceOf',
          args: [account.address],
        });

        const usdcClaimed = usdcAfter - usdcBefore;

        log.info(
          {
            conditionId: conditionId.substring(0, 20) + '...',
            txHash,
            usdcClaimed: usdcClaimed.toString(),
            blockNumber: receipt.blockNumber.toString(),
          },
          'Redemption successful',
        );

        return { success: true, txHash, usdcBefore, usdcAfter, usdcClaimed };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        log.warn({ rpc: rpcUrl, err: lastError }, 'RPC attempt failed, falling through');
      }
    }

    return {
      success: false,
      usdcBefore: 0n,
      usdcAfter: 0n,
      usdcClaimed: 0n,
      error: lastError ?? 'all RPC endpoints failed',
    };
  }

  /**
   * Read a wallet's USDC balance on Polygon. Used by the reconciler to anchor cash_balance
   * to on-chain truth.
   *
   * IMPORTANT: Polymarket CLOB trades settle through a **magic/safe proxy wallet**, NOT the
   * EOA derived from the private key. The proxy is where positions AND USDC actually live.
   * If the caller passes no `targetAddress`, we fall back to the EOA (`account.address`),
   * which is almost always the wrong answer for Polymarket accounting.
   *
   * The engine's startup wallet-sync MUST pass the proxy address (from
   * `entity.credentials.proxy_address` or the CLOB /auth endpoint) as the argument here.
   *
   * @param targetAddress Optional override. When omitted, uses the EOA from the private key.
   */
  async getUsdcBalance(targetAddress?: Address): Promise<bigint> {
    const account = privateKeyToAccount(this.privateKey);
    const queryAddress: Address = targetAddress ?? account.address;
    for (const rpcUrl of this.rpcUrls) {
      try {
        const client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
        return await client.readContract({
          address: USDC_ADDRESS,
          abi: USDC_ABI,
          functionName: 'balanceOf',
          args: [queryAddress],
        });
      } catch (err) {
        log.warn({ rpc: rpcUrl, err: err instanceof Error ? err.message : String(err) }, 'getUsdcBalance RPC failed');
      }
    }
    throw new Error('getUsdcBalance: all RPC endpoints failed');
  }

  /**
   * Sanity check: verify the wallet has already granted the NegRiskAdapter approval
   * to operate its CTF tokens. If false, redemption will always revert. Call this once
   * at engine startup as a pre-flight check.
   */
  async isAdapterApproved(): Promise<boolean> {
    const account = privateKeyToAccount(this.privateKey);
    for (const rpcUrl of this.rpcUrls) {
      try {
        const client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
        return await client.readContract({
          address: CTF_ADDRESS,
          abi: CTF_ABI,
          functionName: 'isApprovedForAll',
          args: [account.address, NEG_RISK_ADAPTER],
        });
      } catch (err) {
        log.warn({ rpc: rpcUrl, err: err instanceof Error ? err.message : String(err) }, 'isApprovedForAll RPC failed');
      }
    }
    throw new Error('isAdapterApproved: all RPC endpoints failed');
  }

  /**
   * Read the wallet's CTF balance for a specific token id. Used to determine redemption
   * amounts when constructing a redeemPositions call.
   */
  async getCtfBalance(tokenId: bigint): Promise<bigint> {
    const account = privateKeyToAccount(this.privateKey);
    for (const rpcUrl of this.rpcUrls) {
      try {
        const client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
        return await client.readContract({
          address: CTF_ADDRESS,
          abi: CTF_ABI,
          functionName: 'balanceOf',
          args: [account.address, tokenId],
        });
      } catch (err) {
        log.warn({ rpc: rpcUrl, err: err instanceof Error ? err.message : String(err) }, 'getCtfBalance RPC failed');
      }
    }
    throw new Error('getCtfBalance: all RPC endpoints failed');
  }
}
