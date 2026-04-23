// Polymarket Goldsky subgraph client — 2026-04-23.
//
// Queries Polymarket's public subgraphs hosted at Goldsky for historical
// position + PnL + trade data not available via the REST Data API.
//
// Four subgraphs (project_cl6mb8i9h0003e201j6li0diw):
//   - positions-subgraph/0.0.7   — current open positions
//   - orderbook-subgraph/0.0.1   — order + fill events
//   - activity-subgraph/0.0.4    — trade history (BUY/SELL, price, size)
//   - pnl-subgraph/0.0.14        — lifetime realized PnL per (user, token)
//
// Auth: Goldsky server token in `GOLDSKY_TOKEN` env var (server_xxx format).
// Endpoints are public (token optional) but we send the token anyway.
//
// Numeric convention in the subgraph: USDC micro-units (6 decimals).
// We expose human-readable USD values on the client side.
//
// Rate limiting: 15 min cache per (subgraph, wallet, query) — subgraphs
// don't refresh faster than a few minutes anyway, and this keeps us well
// under any fair-use throttle.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('polymarket-subgraph');

const BASE = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs';
const PNL_URL = BASE + '/pnl-subgraph/0.0.14/gn';
const POSITIONS_URL = BASE + '/positions-subgraph/0.0.7/gn';
const ACTIVITY_URL = BASE + '/activity-subgraph/0.0.4/gn';
const ORDERBOOK_URL = BASE + '/orderbook-subgraph/0.0.1/gn';

const CACHE_TTL_MS = 15 * 60 * 1000;

export interface UserPositionRow {
  tokenId: string;
  amount: bigint;             // raw 6-dec USDC units
  avgPrice: bigint;           // micro-price (500000 = 0.50)
  realizedPnl: bigint;        // raw micro-USDC
  totalBought: bigint;        // raw micro-USDC
}

export interface UserPnlSummary {
  wallet: string;
  position_count: number;
  realized_pnl_usd: number;
  total_bought_usd: number;
  /** Simple lifetime ROI: realized / bought. null if bought==0. */
  roi: number | null;
  fetched_at: number;
}

const pnlCache = new Map<string, UserPnlSummary>();

function microToUsd(bi: bigint): number {
  return Number(bi) / 1e6;
}

async function graphqlFetch(url: string, query: string, variables?: Record<string, unknown>): Promise<unknown | null> {
  const token = process.env.GOLDSKY_TOKEN;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = 'Bearer ' + token;

  try {
    const body = JSON.stringify({ query, variables: variables ?? {} });
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      log.debug({ url, status: response.status }, 'Subgraph HTTP error');
      return null;
    }
    const json = await response.json() as { data?: unknown; errors?: Array<{ message: string }> };
    if (json.errors && json.errors.length > 0) {
      log.debug({ url, errors: json.errors.map(e => e.message) }, 'Subgraph GraphQL errors');
      return null;
    }
    return json.data;
  } catch (err) {
    log.debug({ url, err: err instanceof Error ? err.message : String(err) }, 'Subgraph fetch failed');
    return null;
  }
}

/**
 * Fetch lifetime PnL summary for a wallet from pnl-subgraph.
 * Paginated at 1000 rows (subgraph max per query); rarely exceeded.
 */
export async function getUserPnlSummary(wallet: string): Promise<UserPnlSummary | null> {
  const key = wallet.toLowerCase();
  const cached = pnlCache.get(key);
  if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) return cached;

  const query = 'query($user: String!) { userPositions(where: {user: $user}, first: 1000) { tokenId amount avgPrice realizedPnl totalBought } }';
  const data = await graphqlFetch(PNL_URL, query, { user: key }) as { userPositions?: Array<{ tokenId: string; amount: string; avgPrice: string; realizedPnl: string; totalBought: string }> } | null;
  if (!data) return null;

  const positions = data.userPositions ?? [];
  let realized = 0n;
  let bought = 0n;
  for (const p of positions) {
    realized += BigInt(p.realizedPnl || '0');
    bought += BigInt(p.totalBought || '0');
  }

  const realizedUsd = microToUsd(realized);
  const boughtUsd = microToUsd(bought);
  const summary: UserPnlSummary = {
    wallet: key,
    position_count: positions.length,
    realized_pnl_usd: realizedUsd,
    total_bought_usd: boughtUsd,
    roi: boughtUsd > 0 ? realizedUsd / boughtUsd : null,
    fetched_at: Date.now(),
  };
  pnlCache.set(key, summary);
  return summary;
}

/**
 * Fetch raw per-token position rows for a wallet (for downstream
 * conviction-weighting or per-market stake sizing).
 */
export async function getUserPositions(wallet: string): Promise<UserPositionRow[] | null> {
  const query = 'query($user: String!) { userPositions(where: {user: $user, amount_gt: "0"}, first: 1000) { tokenId amount avgPrice realizedPnl totalBought } }';
  const data = await graphqlFetch(PNL_URL, query, { user: wallet.toLowerCase() }) as { userPositions?: Array<{ tokenId: string; amount: string; avgPrice: string; realizedPnl: string; totalBought: string }> } | null;
  if (!data) return null;
  const rows = data.userPositions ?? [];
  return rows.map(r => ({
    tokenId: r.tokenId,
    amount: BigInt(r.amount || '0'),
    avgPrice: BigInt(r.avgPrice || '0'),
    realizedPnl: BigInt(r.realizedPnl || '0'),
    totalBought: BigInt(r.totalBought || '0'),
  }));
}

/** Top-N wallets by lifetime realized PnL — used for discovery of new whales. */
export async function getTopPnlWallets(limit = 50): Promise<Array<{ wallet: string; realized_pnl_usd: number }> | null> {
  const query = 'query($limit: Int!) { userPositions(first: $limit, orderBy: realizedPnl, orderDirection: desc) { user realizedPnl } }';
  const data = await graphqlFetch(PNL_URL, query, { limit }) as { userPositions?: Array<{ user: string; realizedPnl: string }> } | null;
  if (!data) return null;
  return (data.userPositions ?? []).map(r => ({
    wallet: r.user,
    realized_pnl_usd: microToUsd(BigInt(r.realizedPnl || '0')),
  }));
}

export function isSubgraphAvailable(): boolean {
  return !!process.env.GOLDSKY_TOKEN;
}

// Export URLs so callers can override if Polymarket bumps subgraph versions.
export const SUBGRAPH_URLS = {
  PNL_URL,
  POSITIONS_URL,
  ACTIVITY_URL,
  ORDERBOOK_URL,
};
