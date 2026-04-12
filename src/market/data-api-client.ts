// Polymarket Data API client — positions, activity history, profiles

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('data-api');

export class DataApiClient {
  constructor(private baseUrl: string) {}

  async getActivity(proxyWallet: string, limit = 100, offset = 0): Promise<ActivityRecord[]> {
    const url = `${this.baseUrl}/activity?user=${proxyWallet}&limit=${limit}&offset=${offset}`;
    return this.fetchJson<ActivityRecord[]>(url);
  }

  async getResolvedPositions(proxyWallet: string): Promise<ResolvedPosition[]> {
    const url = `${this.baseUrl}/positions?user=${proxyWallet}&status=resolved`;
    return this.fetchJson<ResolvedPosition[]>(url);
  }

  async getOpenPositions(proxyWallet: string): Promise<OpenPosition[]> {
    const url = `${this.baseUrl}/positions?user=${proxyWallet}&status=active`;
    return this.fetchJson<OpenPosition[]>(url);
  }

  /**
   * Phase -1 reconciler fix (2026-04-11): the unfiltered `/positions`
   * endpoint (no status param) returns EVERY position the wallet holds,
   * including redeemable (dead) positions. This is the endpoint we need
   * for the reconciler because it surfaces:
   *   - `redeemable: true` — market resolved, position waiting to be cashed
   *   - `currentValue` — mark-to-market value (0 for total losses)
   *   - `cashPnl` — authoritative realized profit/loss
   *
   * The `status=active` filter used by getOpenPositions() HIDES all
   * redeemable rows, which was causing the reconciler to mis-classify
   * every resolved-but-unredeemed position as "absent from API" and
   * write accounting-neutral zero-P&L rows instead of real wins/losses.
   *
   * Use this for reconciliation; use getOpenPositions() for the narrower
   * "what is the engine still actively exposed to" view.
   */
  async getAllPositions(proxyWallet: string): Promise<FullPosition[]> {
    // sizeThreshold=0.01 filters out dust; limit=500 covers any single-entity
    // exposure we'd reasonably have. If we ever hold more than 500 distinct
    // positions simultaneously the reconciler will silently miss some and
    // we should paginate — but that's a 500-position problem not a current one.
    const url = `${this.baseUrl}/positions?user=${proxyWallet}&sizeThreshold=0.01&limit=500`;
    return this.fetchJson<FullPosition[]>(url);
  }

  async getProfile(walletAddress: string): Promise<UserProfile | null> {
    const url = `${this.baseUrl}/profile/${walletAddress}`;
    try {
      return await this.fetchJson<UserProfile>(url);
    } catch {
      return null;
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    log.debug({ url }, 'Fetching');
    // Phase -1 (2026-04-11): Data API rejects default node fetch UA with
    // 403. Use a browser-like User-Agent to get past the block. Verified
    // working against `/positions` and `/activity` from the VPS.
    const response = await fetch(url, {
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; polybot-v3/1.0)',
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Data API ${response.status}: ${url}`);
    return response.json() as Promise<T>;
  }
}

// Response types
export interface ActivityRecord {
  type: string; // TRADE, MERGE, SPLIT
  side: string;
  size: string;
  price: string;
  feeRateBps: string;
  conditionId: string;
  asset: string;
  transactionHash: string;
  timestamp: string;
  title?: string;
  slug?: string;
  eventSlug?: string;
  outcomeIndex?: string;
  outcome?: string;
}

export interface ResolvedPosition {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  size: string;
  avgPrice: string;
  initialValue: string;
  currentValue: string;
  cashPnl: string;
  percentPnl: string;
  resolvedAt: string;
}

export interface OpenPosition {
  conditionId: string;
  asset: string;
  title: string;
  outcome: string;
  size: string;
  avgPrice: string;
  initialValue: string;
  currentValue: string;
  cashPnl: string;
  percentPnl: string;
}

/**
 * FullPosition mirrors the unfiltered `/positions` endpoint response
 * with all fields we care about for reconciliation. Numeric fields are
 * typed as `number` because the actual API returns JSON numbers here
 * (unlike `status=active` which wraps numerics as strings — different
 * code path on the API's side).
 */
export interface FullPosition {
  proxyWallet: string;
  asset: string;
  conditionId: string;
  size: number;
  avgPrice: number;
  initialValue: number;
  currentValue: number;
  cashPnl: number;
  percentPnl: number;
  totalBought?: number;
  realizedPnl: number;
  percentRealizedPnl?: number;
  curPrice: number;
  redeemable: boolean;
  mergeable?: boolean;
  title: string;
  slug?: string;
  outcome: string;
  outcomeIndex?: number;
  oppositeOutcome?: string;
  oppositeAsset?: string;
  endDate?: string;
  negativeRisk?: boolean;
}

export interface UserProfile {
  proxyWallet: string;
  name?: string;
  profileImage?: string;
}
