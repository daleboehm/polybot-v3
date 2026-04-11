// Portfolio correlation / cluster risk.
//
// Phase 2.2 (2026-04-11). Caps the amount of capital deployed into any one
// correlated cluster of positions. Prevents concentration blow-ups like
// "10 positions on Hungary election = one giant macro bet" even though the
// dashboard shows 10 independent positions.
//
// Clustering rules, in decreasing specificity:
//   1. Same neg_risk_market_id — Polymarket's own grouping of mutually
//      exclusive outcomes. Literally the same event. Strongest signal.
//   2. Same end_date (day precision) AND same "category" from a keyword
//      match on the question — catches "all Nov 3 2026 elections" or
//      "all Apr 11 weather markets" as single clusters.
//   3. Same ISO week + shared high-signal keywords (Hungary, election,
//      Fed, earnings, etc.) — catches grouped event bets that don't share
//      an end_date but are thematically identical.
//   4. Everything else is its own single-element cluster.
//
// The risk-engine check: for each incoming BUY signal, compute which
// cluster it belongs to, sum the cost_basis of existing positions in that
// cluster, add the proposed size, and block if the sum exceeds
// `max_cluster_pct * trading_balance`.
//
// Not stored in the DB — computed per evaluate() call from open positions.
// Fast enough at $257 bankroll scale (dozens to hundreds of positions).

import type { PositionRow } from '../storage/repositories/position-repo.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('portfolio-correlation');

// High-signal keywords that create clusters. Order matters: more specific first.
const CLUSTER_KEYWORDS: Array<{ pattern: RegExp; clusterName: string }> = [
  { pattern: /\b(fed|fomc|rate decision|powell)\b/i, clusterName: 'fed-macro' },
  { pattern: /\b(election|governor|senate|senator|presidential|vote)\b.*\b(2026|2028)\b/i, clusterName: 'us-election-2026plus' },
  { pattern: /\bhungary|fidesz|tisza\b/i, clusterName: 'hungary-politics' },
  { pattern: /\b(iowa|mississippi|tennessee|vermont|governor)\b.*\b(2026)\b/i, clusterName: 'us-governor-2026' },
  { pattern: /\b(temperature|weather|forecast|rain|snow)\b/i, clusterName: 'weather' },
  { pattern: /\b(iran|israel|ukraine|russia|military)\b/i, clusterName: 'geopolitics' },
  { pattern: /\b(earnings|beat|quarterly|revenue)\b/i, clusterName: 'earnings' },
  { pattern: /\b(btc|bitcoin|ethereum|crypto)\b/i, clusterName: 'crypto-price' },
  { pattern: /\b(sportsbook|mlb|nba|nfl|nhl|vs\.)\b/i, clusterName: 'sports' },
];

export interface ClusterInfo {
  cluster_id: string;
  member_ids: number[];
  total_cost: number;
  total_size: number;
}

/**
 * Compute the cluster_id for a single position.
 * Uses negRiskMarketId if present, else falls back to keyword matching
 * on the question, else uses the condition_id itself (= own-cluster).
 */
export function clusterIdForPosition(pos: PositionRow, negRiskMarketId?: string | null): string {
  // Rule 1: neg_risk_market_id wins.
  if (negRiskMarketId) return `neg-risk:${negRiskMarketId}`;

  // Rule 2+3: keyword cluster
  const q = pos.market_question ?? '';
  for (const rule of CLUSTER_KEYWORDS) {
    if (rule.pattern.test(q)) {
      return `kw:${rule.clusterName}`;
    }
  }

  // Rule 4: own cluster (no correlation detected)
  return `cid:${pos.condition_id}`;
}

/**
 * Compute the cluster_id for an incoming signal (by question + condition_id).
 * Mirrors clusterIdForPosition — incoming signals may not yet have a position row.
 */
export function clusterIdForSignal(question: string, conditionId: string, negRiskMarketId?: string | null): string {
  if (negRiskMarketId) return `neg-risk:${negRiskMarketId}`;
  for (const rule of CLUSTER_KEYWORDS) {
    if (rule.pattern.test(question)) {
      return `kw:${rule.clusterName}`;
    }
  }
  return `cid:${conditionId}`;
}

/**
 * Group open positions into clusters, computing each cluster's total cost
 * and size. negRiskMarketIdMap is optional — passed in from the market cache.
 */
export function buildClusters(
  positions: PositionRow[],
  negRiskMap?: Map<string, string | null>,
): Map<string, ClusterInfo> {
  const clusters = new Map<string, ClusterInfo>();
  for (const p of positions) {
    const neg = negRiskMap?.get(p.condition_id) ?? null;
    const cid = clusterIdForPosition(p, neg);
    const existing = clusters.get(cid);
    if (existing) {
      existing.member_ids.push(p.id);
      existing.total_cost += p.cost_basis;
      existing.total_size += p.size;
    } else {
      clusters.set(cid, {
        cluster_id: cid,
        member_ids: [p.id],
        total_cost: p.cost_basis,
        total_size: p.size,
      });
    }
  }
  return clusters;
}

/**
 * Envelope check: given a cluster id, the existing positions, and a
 * proposed size, return true if the proposal would breach the cap.
 * Returns info needed to construct a clear risk-engine violation.
 */
export interface ClusterCheckResult {
  breach: boolean;
  cluster_id: string;
  current_deployed: number;
  proposed_total: number;
  cap_usd: number;
}

export function checkClusterCap(
  signalQuestion: string,
  signalConditionId: string,
  proposedSizeUsd: number,
  tradingBalance: number,
  maxClusterPct: number,
  openPositions: PositionRow[],
  negRiskMap?: Map<string, string | null>,
): ClusterCheckResult {
  const neg = negRiskMap?.get(signalConditionId) ?? null;
  const targetCluster = clusterIdForSignal(signalQuestion, signalConditionId, neg);
  const clusters = buildClusters(openPositions, negRiskMap);
  const existing = clusters.get(targetCluster);
  const currentDeployed = existing?.total_cost ?? 0;
  const proposedTotal = currentDeployed + proposedSizeUsd;
  const capUsd = tradingBalance * maxClusterPct;
  const breach = capUsd > 0 && proposedTotal > capUsd;

  if (breach) {
    log.info(
      {
        cluster_id: targetCluster,
        current: currentDeployed.toFixed(2),
        proposed: proposedSizeUsd.toFixed(2),
        total: proposedTotal.toFixed(2),
        cap: capUsd.toFixed(2),
      },
      'Cluster cap breach blocked',
    );
  }

  return {
    breach,
    cluster_id: targetCluster,
    current_deployed: currentDeployed,
    proposed_total: proposedTotal,
    cap_usd: capUsd,
  };
}
