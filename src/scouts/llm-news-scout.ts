// LLM news scout — qualitative catalyst detection via Claude API.
//
// Phase 4 (2026-04-11). This is the "real brain" of the scout fleet.
// The heuristic scouts catch mechanical patterns (volume spikes, price
// jumps, new listings). This scout catches the semantic patterns the
// heuristics miss: "CDC just announced X, which affects markets Y, Z",
// "A court ruling on ABC landed → markets affected are ...", etc.
//
// The scout pulls recent Polymarket questions from the marketCache,
// groups them by topic, and periodically asks Claude to identify any
// markets that have a strong catalyst within the last ~2 hours. Each
// market Claude flags becomes:
//   1. a `scout_intel` row (the qualitative opinion — side + conviction)
//   2. a `market_priorities` row (so the attention router scans it now)
//
// Gating:
//   - If ANTHROPIC_API_KEY is not set, the scout fails closed (returns
//     empty ScoutRunResult and logs a one-time warning).
//   - If the API call fails or rate limits, the scout logs and skips.
//   - Maximum 1 API call per run (one batched prompt with multiple
//     markets) so cost stays bounded.
//
// Safety constraints:
//   - Intel conviction is CAPPED at MAX_CONVICTION (0.80) so no single
//     LLM output can push the overlay to maximum size boost.
//   - The scout NEVER writes signals or positions. Intel only weights
//     existing signals built by the strategies.
//
// TODO when ANTHROPIC_API_KEY is provisioned: un-stub `callClaude()`
// and wire up `@anthropic-ai/sdk`. Until then the scout is a no-op.

import type { MarketCache } from '../market/market-cache.js';
import { insertPriority } from '../storage/repositories/market-priority-repo.js';
import { insertIntel } from '../storage/repositories/scout-intel-repo.js';
import { ScoutBase, type ScoutRunResult } from './scout-base.js';
import { createChildLogger } from '../core/logger.js';

const MAX_CONVICTION = 0.80;
const MAX_MARKETS_PER_CALL = 20;
const INTEL_TTL_MS = 2 * 60 * 60 * 1000;   // 2 hours
const PRIORITY_TTL_MS = 30 * 60 * 1000;    // 30 minutes

export interface LlmNewsFinding {
  condition_id: string;
  side: 'YES' | 'NO';
  conviction: number;     // 0-1
  reason: string;         // short text the scout will log and write to intel
  priority: number;       // 1-10 for the attention router
}

export class LlmNewsScout extends ScoutBase {
  readonly id = 'llm-news-scout';
  readonly description = 'LLM-based qualitative catalyst detection (requires ANTHROPIC_API_KEY)';

  private apiKey: string | null;
  private warnedMissingKey = false;

  constructor() {
    super();
    this.log = createChildLogger(`scout:${this.id}`);
    this.apiKey = process.env.ANTHROPIC_API_KEY ?? null;
    if (!this.apiKey) {
      this.log.warn('ANTHROPIC_API_KEY not set — LLM news scout will be a no-op');
    }
  }

  run(marketCache: MarketCache): ScoutRunResult {
    if (!this.apiKey) {
      if (!this.warnedMissingKey) {
        this.log.warn('No API key — scout is dormant');
        this.warnedMissingKey = true;
      }
      return this.emptyResult();
    }

    // Sample markets to show Claude. We pick the top N by liquidity in the
    // candidate window so the prompt doesn't get huge.
    const candidates = this.getCandidateMarkets(marketCache);
    const sorted = [...candidates].sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
    const sample = sorted.slice(0, MAX_MARKETS_PER_CALL);
    if (sample.length === 0) return this.emptyResult();

    // Call the LLM (stubbed for now — see TODO at top of file)
    let findings: LlmNewsFinding[] = [];
    try {
      findings = this.callClaude(sample);
    } catch (err) {
      this.log.warn({ err }, 'LLM call failed — skipping run');
      return this.emptyResult();
    }

    let intelWritten = 0;
    let prioritiesWritten = 0;
    for (const f of findings) {
      const cappedConviction = Math.min(MAX_CONVICTION, Math.max(0, f.conviction));
      try {
        insertIntel({
          condition_id: f.condition_id,
          side: f.side,
          conviction: cappedConviction,
          reason: f.reason.substring(0, 400),
          created_by: this.id,
          ttl_ms: INTEL_TTL_MS,
        });
        intelWritten++;
      } catch (err) {
        this.log.warn({ err, condition_id: f.condition_id }, 'Failed to insert intel');
      }

      try {
        insertPriority({
          condition_id: f.condition_id,
          priority: f.priority,
          reason: `llm-news: ${f.reason.substring(0, 200)}`,
          created_by: this.id,
          ttl_ms: PRIORITY_TTL_MS,
        });
        prioritiesWritten++;
      } catch (err) {
        this.log.warn({ err, condition_id: f.condition_id }, 'Failed to insert priority');
      }
    }

    return {
      scout_id: this.id,
      priorities_written: prioritiesWritten,
      intel_written: intelWritten,
      markets_evaluated: sample.length,
      summary:
        findings.length > 0
          ? `${findings.length} findings, ${intelWritten} intel + ${prioritiesWritten} priorities`
          : null,
    };
  }

  /**
   * Real implementation would call Anthropic's Messages API with a prompt
   * like:
   *
   *   "You are a prediction market analyst. Below are 20 Polymarket
   *    questions active in the next 1-48 hours. For each, identify
   *    whether any news catalyst from the last 2 hours would affect
   *    its outcome. Return JSON: {findings: [{condition_id, side,
   *    conviction, reason}]}. Only include high-confidence findings.
   *    If nothing is newsworthy, return {findings: []}."
   *
   * The response would be parsed, validated (side in {YES, NO},
   * conviction in [0, 1]), and returned. For now this is a stub that
   * returns an empty array so the scout compiles and runs with 0 effect.
   *
   * When ANTHROPIC_API_KEY is provisioned:
   *   1. Add `@anthropic-ai/sdk` to package.json
   *   2. import Anthropic from '@anthropic-ai/sdk'
   *   3. Replace this stub with a real client.messages.create(...) call
   *   4. JSON-parse response.content, validate against LlmNewsFinding[]
   *   5. Return the validated findings
   */
  private callClaude(_markets: Array<{ condition_id: string; question: string }>): LlmNewsFinding[] {
    // STUB: real implementation deferred until ANTHROPIC_API_KEY is available
    // on the VPS. Until then the scout compiles and runs as a no-op.
    return [];
  }
}
