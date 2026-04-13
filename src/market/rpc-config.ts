// Centralized Polygon RPC configuration — 2026-04-13.
//
// Before this module, RPC URLs were hardcoded in 4 separate files
// (neg-risk-redeemer, clob-router, whale-event-subscriber, cli).
// Each had its own copy of the same list, and changes required
// editing all 4. Now everything reads from here.
//
// Priority order:
//   1. POLYGON_RPC_URL env var (Alchemy/QuickNode paid endpoint)
//   2. Public fallbacks (drpc, publicnode — flaky but free)
//
// When Dale provisions an Alchemy API key, it goes in .env as:
//   POLYGON_RPC_URL=https://polygon-mainnet.g.alchemy.com/v2/<key>
// and every module in the system immediately uses it as first-choice.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('rpc-config');

// Public fallback RPCs — ordered by reliability from our experience.
// polygon-rpc.com removed: it's a landing page, not an RPC endpoint.
// It was causing "The method eth_call does not exist" errors in every
// module that used it as first-choice.
const PUBLIC_FALLBACK_RPCS: string[] = [
  'https://polygon.drpc.org',
  'https://polygon-bor-rpc.publicnode.com',
];

let _cachedRpcs: string[] | null = null;

/**
 * Returns the ordered list of Polygon RPC URLs to use.
 * First call reads POLYGON_RPC_URL from env; subsequent calls return cached.
 * Call resetRpcCache() if env changes at runtime (e.g., after hot-reload).
 */
export function getPolygonRpcs(): string[] {
  if (_cachedRpcs) return _cachedRpcs;

  const envRpc = process.env.POLYGON_RPC_URL?.trim();
  if (envRpc && envRpc.startsWith('http')) {
    _cachedRpcs = [envRpc, ...PUBLIC_FALLBACK_RPCS];
    log.info({ primary: envRpc.substring(0, 50) + '...', fallbacks: PUBLIC_FALLBACK_RPCS.length }, 'RPC config: using env POLYGON_RPC_URL as primary');
  } else {
    _cachedRpcs = [...PUBLIC_FALLBACK_RPCS];
    log.warn('POLYGON_RPC_URL not set — using public fallback RPCs only (flaky, rate-limited)');
  }

  return _cachedRpcs;
}

/**
 * Returns the FIRST (highest-priority) RPC URL. Used by modules that
 * need a single endpoint for viem transport (e.g., createPublicClient).
 */
export function getPrimaryRpc(): string {
  return getPolygonRpcs()[0]!;
}

/**
 * Returns the WebSocket URL for Polygon. Alchemy supports WSS on the
 * same base URL with /ws/ path. Public RPCs don't offer reliable WSS.
 *
 * Returns null if no WSS-capable RPC is configured.
 */
export function getPolygonWssUrl(): string | null {
  const envRpc = process.env.POLYGON_RPC_URL?.trim();
  if (!envRpc) return null;

  // Alchemy: https://polygon-mainnet.g.alchemy.com/v2/<key>
  //       → wss://polygon-mainnet.g.alchemy.com/v2/<key>
  if (envRpc.includes('alchemy.com')) {
    return envRpc.replace('https://', 'wss://');
  }

  // QuickNode: similar pattern
  if (envRpc.includes('quiknode.pro') || envRpc.includes('quicknode.com')) {
    return envRpc.replace('https://', 'wss://');
  }

  // Infura
  if (envRpc.includes('infura.io')) {
    return envRpc.replace('https://', 'wss://');
  }

  return null;
}

export function resetRpcCache(): void {
  _cachedRpcs = null;
}
