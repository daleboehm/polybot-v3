// Cross-market-arb scout — 2026-04-20 (04-19 Finding 8, Combinatorial Arb Type-2).
//
// Detects numeric-threshold monotonicity violations across Polymarket markets.
// Example: three markets asking "Will X exceed $N by 2026-12-31?" for N=100, 120, 150
// should have non-increasing YES prices. When they don't (e.g. $120 priced higher
// than $100), there is a guaranteed arbitrage by buying YES on the lower threshold
// and NO on the higher threshold.
//
// v1 scope: SCOUT ONLY. Writes priorities with inversion detail to market_priorities.
// Strategies are alerted via the existing PriorityScanner pipeline; a dedicated
// 2-leg execution strategy is the v2 follow-up once scout coverage is verified.
//
// Source alpha: 04-19 Finding 8 (arXiv 2508.03474) — $40M in combinatorial arb
// extracted over 12 months, avg $50-500 per opportunity. Type-1 (within neg-risk)
// is already covered by NegRisk Arbitrage (commits 3a80b8b, 5ee113d). Type-2
// (across linked markets by shared event structure) is the gap this fills.

import { ScoutBase, type ScoutRunResult } from './scout-base.js';
import type { MarketCache } from '../market/market-cache.js';
import type { MarketData } from '../types/index.js';
import { insertPriority } from '../storage/repositories/market-priority-repo.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('scout:cross-market-arb');

// Minimum inversion magnitude to flag. Must clear 2-leg taker fees for a
// realistic-sized position — weather/culture category fees are ~1.25% peak,
// crypto 1.80%, so a 2-leg round-trip can be ~3-4% total. Flag > 4% only.
const MIN_INVERSION_PCT = 0.04;

// Max inversion to consider "real" (vs data error). A 30%+ inversion on a
// threshold pair is almost certainly a question-parse or category mismatch,
// not a real mispricing. Skip to keep noise down.
const MAX_INVERSION_PCT = 0.30;

const PRIORITY_TTL_MS = 10 * 60 * 1000;
const FLAG_RATE_LIMIT_MS = 15 * 60 * 1000;

// Regex extracting a numeric threshold from a market question.
// Matches patterns like:
//   "...exceed $100K..."  "... above 50%..."  "... > 100..."  "... reach 2.5..."
//   "... 100,000 ..."     "... $1.5M ..."     "... 50°F ..."
// Returns the normalized numeric value (e.g. 100K -> 100000, 1.5M -> 1500000).
function extractThreshold(question: string): { value: number; span: [number, number] } | null {
  // Strip commas inside numbers for easier parsing
  const q = question;
  // Core number pattern: optional $, digits with optional decimal + comma groups, optional K/M/B suffix, optional % or ° F/C
  const re = /\$?\s*(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\s*([KMB]|°\s*[FC]|%)?/gi;
  const matches: Array<{ value: number; span: [number, number] }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(q)) !== null) {
    const numStr = m[1].replace(/,/g, '');
    const suffix = (m[2] ?? '').toUpperCase().replace(/\s/g, '');
    let value = parseFloat(numStr);
    if (!Number.isFinite(value)) continue;
    if (suffix === 'K') value *= 1_000;
    else if (suffix === 'M') value *= 1_000_000;
    else if (suffix === 'B') value *= 1_000_000_000;
    // % and °F/°C leave value as-is; they're still orderable
    matches.push({ value, span: [m.index, m.index + m[0].length] });
  }
  if (matches.length === 0) return null;
  // If multiple numbers in question (e.g. "between 50 and 80"), prefer the
  // LAST one — typically the threshold in a "> $X by $date" structure since
  // year/date numbers like 2026 come first. Filter out pure year values
  // (1990-2100 range with no suffix, if they're the only match we keep them).
  const nonYear = matches.filter(x => x.value < 1990 || x.value > 2100 || Math.floor(x.value) !== x.value);
  const chosen = nonYear.length > 0 ? nonYear[nonYear.length - 1] : matches[matches.length - 1];
  return chosen;
}

// Build a cluster key from a question by replacing the threshold span with
// a placeholder. Markets that share this key differ only in their threshold.
function clusterKey(question: string, span: [number, number]): string {
  const before = question.substring(0, span[0]).toLowerCase().trim();
  const after = question.substring(span[1]).toLowerCase().trim();
  // Normalize whitespace
  return `${before}|||${after}`.replace(/\s+/g, ' ');
}

interface ClusterLeg {
  market: MarketData;
  threshold: number;
  yesPrice: number;
}

export class CrossMarketArbScout extends ScoutBase {
  readonly id = 'cross-market-arb-scout';
  readonly description = 'Detect numeric-threshold monotonicity violations across Polymarket markets (type-2 combinatorial arb)';

  private lastFlaggedAt = new Map<string, number>();

  constructor() {
    super();
    this.log = createChildLogger(`scout:${this.id}`);
  }

  run(marketCache: MarketCache): ScoutRunResult {
    const markets = this.getCandidateMarkets(marketCache, 1, 720); // 1h to 30d
    const now = Date.now();

    // Build clusters: group markets by (prefix, suffix) with threshold variable
    const clusters = new Map<string, ClusterLeg[]>();
    for (const m of markets) {
      if (!m.question) continue;
      if (!m.yes_price || m.yes_price <= 0 || m.yes_price >= 1) continue;
      const ext = extractThreshold(m.question);
      if (!ext) continue;
      const key = clusterKey(m.question, ext.span);
      const arr = clusters.get(key) ?? [];
      arr.push({ market: m, threshold: ext.value, yesPrice: m.yes_price });
      clusters.set(key, arr);
    }

    let prioritiesWritten = 0;
    let inversionsFound = 0;
    let clustersEvaluated = 0;

    for (const [clusterId, legs] of clusters) {
      if (legs.length < 2) continue;
      clustersEvaluated++;

      // Rate-limit per cluster
      const lastFlag = this.lastFlaggedAt.get(clusterId);
      if (lastFlag && (now - lastFlag) < FLAG_RATE_LIMIT_MS) continue;

      // Sort legs by threshold ascending
      const sorted = [...legs].sort((a, b) => a.threshold - b.threshold);

      // Detect inversions: for threshold i < j, YES price at i should be >= YES price at j
      // (higher threshold = less likely = lower YES price)
      const flaggedThisCluster = new Set<string>();
      for (let i = 0; i < sorted.length - 1; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const low = sorted[i];
          const high = sorted[j];
          // v1.1 (2026-04-20): require DISTINCT thresholds. Two markets with
          // identical numeric thresholds aren't a monotonicity pair; cluster
          // key collision (e.g., "Will X snow 2.5 inches by date A?" vs
          // "Will Y snow 2.5 inches by date B?") produces false "inversions"
          // when the numbers match but the underlying events differ.
          if (low.threshold >= high.threshold) continue;
          // v1.1: also require same condition_id set isn't identical — skip
          // if the two "legs" are actually the same market (duplicate cache).
          if (low.market.condition_id === high.market.condition_id) continue;

          if (high.yesPrice <= low.yesPrice) continue; // monotonic, fine

          const inversion = high.yesPrice - low.yesPrice;
          if (inversion < MIN_INVERSION_PCT) continue; // too small to clear fees
          if (inversion > MAX_INVERSION_PCT) continue; // likely data error, skip

          inversionsFound++;

          // Flag both legs with a descriptive reason
          const reason =
            `monotonicity inversion ${(inversion * 100).toFixed(1)}%: ` +
            `lower threshold=${low.threshold} YES=${low.yesPrice.toFixed(3)} vs ` +
            `higher threshold=${high.threshold} YES=${high.yesPrice.toFixed(3)}. ` +
            `Arb: BUY YES on lower + BUY NO on higher.`;

          // Priority for both legs, boosted by tick size for coarse-tick markets
          for (const leg of [low, high]) {
            const legKey = leg.market.condition_id;
            if (flaggedThisCluster.has(legKey)) continue;
            flaggedThisCluster.add(legKey);
            const priority = Math.min(10, 7 + this.tickSizePriorityBonus(leg.market.minimum_tick_size));
            insertPriority({
              condition_id: leg.market.condition_id,
              priority,
              reason,
              created_by: this.id,
              ttl_ms: PRIORITY_TTL_MS,
            });
            prioritiesWritten++;
          }
        }
      }

      if (flaggedThisCluster.size > 0) {
        this.lastFlaggedAt.set(clusterId, now);
      }
    }

    // GC old rate-limit entries
    if (this.lastFlaggedAt.size > 2000) {
      const stale = now - FLAG_RATE_LIMIT_MS * 2;
      for (const [k, t] of this.lastFlaggedAt) {
        if (t < stale) this.lastFlaggedAt.delete(k);
      }
    }

    const summary = prioritiesWritten > 0
      ? `${inversionsFound} inversions flagged across ${clustersEvaluated} threshold clusters`
      : null;

    if (prioritiesWritten > 0) {
      log.info(
        { inversions: inversionsFound, priorities: prioritiesWritten, clusters: clustersEvaluated },
        'Cross-market-arb findings',
      );
    }

    return {
      scout_id: this.id,
      priorities_written: prioritiesWritten,
      intel_written: 0,
      markets_evaluated: markets.length,
      summary,
    };
  }
}
