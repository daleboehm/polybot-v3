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
    const response = await fetch(url, {
      headers: { 'Accept': 'application/json' },
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

export interface UserProfile {
  proxyWallet: string;
  name?: string;
  profileImage?: string;
}
