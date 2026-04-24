// LLM news scout — qualitative catalyst detection via Claude API.
//
// Phase D (2026-04-11). This is the "real brain" of the scout fleet.
// The heuristic scouts catch mechanical patterns (volume spikes, price
// jumps, new listings). This scout catches the semantic patterns the
// heuristics miss: "CDC just announced X, which affects markets Y, Z",
// "A court ruling on ABC landed → markets affected are ...", etc.
//
// Activated Phase D: ANTHROPIC_API_KEY is now provisioned on the VPS
// and @anthropic-ai/sdk is a real dependency. The scout makes real API
// calls on a 10-minute interval (rate-limited from the 60s coordinator
// tick via internal lastCallAt state).
//
// ─── Design decisions from Agent 4 research synthesis ────────────────
//
// Model: claude-haiku-4-5-20251001
//   Haiku is the right model for this scout. It's ~15× cheaper than
//   Sonnet, and for a "which of these 20 markets has a recent catalyst"
//   classification task it has more than enough reasoning capacity.
//   PolySwarm paper results show small-model ensembles beat
//   single-large-model runs on calibration anyway.
//
// Prompt caching
//   The system prompt + schema + category taxonomy is stable across
//   ticks. We structure the request so that stable block goes in a
//   `cache_control: ephemeral` block — 1.25× write cost on the first
//   call, 0.10× read cost on every subsequent call within the 5-min
//   TTL. Back-of-envelope at 60s tick: cached prefix makes the effective
//   per-tick cost ~$0.004 vs ~$0.016 uncached. ~$5-6/day continuous.
//
// Do NOT feed current Polymarket prices into the prompt
//   PolySwarm paper (arxiv 2604.03888) explicitly flags the feedback
//   loop risk: bot consensus moves the market, moved market gets read
//   back by the bot, bot re-confirms, infinite reinforcement. We only
//   send the question text and a category tag. Claude has to reason
//   from news + base rates, not from current pricing.
//
// Semantic validation layer
//   Beyond JSON schema (structured output enforces shape), we also
//   validate semantics:
//     1. condition_id must be in the input whitelist (drops hallucinated IDs)
//     2. conviction in [0, 1]
//     3. side ∈ {YES, NO}
//     4. reason length ≥ 20 (catches lazy single-word outputs)
//     5. findings array length ≤ input market count
//   Drop bad rows individually, never fail the whole batch on one bad row.
//
// Per-category conviction caps
//   Politics/election markets max 0.60 — LLMs hallucinate candidate
//   specifics often, and these are the most volatile markets in our
//   universe. Macro markets max 0.50 — LLMs have no real edge over
//   the market's own rate/data pricing. Sports max 0.70 — better
//   information signal but still imperfect. Other categories use the
//   global MAX_CONVICTION floor of 0.80.
//
// Fail-closed everywhere
//   On any error — network, rate limit, JSON parse failure, validation
//   total wipeout — return an empty ScoutRunResult. Never raise, never
//   block the coordinator tick. The overlay treats empty intel as
//   "no signal, use baseline 1.0x sizing" which is the safe default.
//
// Global cap (MAX_CONVICTION = 0.80) still applies on top of category
// caps. The lowest of the two wins.

import Anthropic from '@anthropic-ai/sdk';
import type { MarketCache } from '../market/market-cache.js';
import type { MarketData } from '../types/index.js';
import { insertPriority } from '../storage/repositories/market-priority-repo.js';
import { insertIntel } from '../storage/repositories/scout-intel-repo.js';
import { ScoutBase, type ScoutRunResult } from './scout-base.js';
import { createChildLogger } from '../core/logger.js';

// Tunables
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_MARKETS_PER_CALL = 20;
const MAX_TOKENS = 1200;                   // ~ 20 findings × 60 tokens each
const REQUEST_TIMEOUT_MS = 30_000;
const MIN_CALL_INTERVAL_MS = 60 * 60 * 1000; // 2026-04-24 raised 10min->1h: burned $20 credit in 24h at 10min cadence, and scout has never been a documented winner. Keep observability but cut cost 6x.

const MAX_CONVICTION = 0.80;
const MIN_REASON_LENGTH = 20;

// Per-category conviction caps — lowest of (category cap, global cap) wins
const CATEGORY_CAPS: Record<string, number> = {
  politics: 0.60,
  election: 0.60,
  political: 0.60,
  macro: 0.50,
  fed: 0.50,
  cpi: 0.50,
  economy: 0.50,
  rate: 0.50,
  sports: 0.70,
  nfl: 0.70,
  nba: 0.70,
  mlb: 0.70,
  nhl: 0.70,
  soccer: 0.70,
  ufc: 0.70,
};

const INTEL_TTL_MS = 2 * 60 * 60 * 1000;  // 2 hours
const PRIORITY_TTL_MS = 30 * 60 * 1000;   // 30 minutes

export interface LlmNewsFinding {
  condition_id: string;
  side: 'YES' | 'NO';
  conviction: number;     // 0-1
  reason: string;         // short text the scout will log + write to intel
  priority: number;       // 1-10 for the attention router
}

interface ClaudeRawFinding {
  condition_id?: unknown;
  side?: unknown;
  conviction?: unknown;
  reason?: unknown;
}

interface ClaudeResponse {
  findings?: unknown;
}

export class LlmNewsScout extends ScoutBase {
  readonly id = 'llm-news-scout';
  readonly description = 'LLM-based qualitative catalyst detection via Claude Haiku';

  private client: Anthropic | null = null;
  private warnedMissingKey = false;
  private lastCallAt = 0;
  private inflightCall = false;

  constructor() {
    super();
    this.log = createChildLogger(`scout:${this.id}`);
    const apiKey = process.env.ANTHROPIC_API_KEY ?? null;
    if (apiKey) {
      // maxRetries reduced from 4 to 1. With 4 retries at 30s timeout
      // each, a failing call could hang for 2+ minutes before the scout
      // reported anything. With 1 retry the total hang time is max 60s
      // (initial attempt + 1 retry), which is within one scout-tick
      // window and produces an error log we can actually see.
      this.client = new Anthropic({
        apiKey,
        maxRetries: 1,
        timeout: REQUEST_TIMEOUT_MS,
      });
    } else {
      this.log.warn('ANTHROPIC_API_KEY not set — LLM news scout will be a no-op');
    }
  }

  run(marketCache: MarketCache): ScoutRunResult {
    if (!this.client) {
      if (!this.warnedMissingKey) {
        this.log.warn('No API key — scout is dormant');
        this.warnedMissingKey = true;
      }
      return this.emptyResult();
    }

    const now = Date.now();
    if (now - this.lastCallAt < MIN_CALL_INTERVAL_MS) {
      // Respect minimum call interval — coordinator runs us every 60s,
      // but we only actually hit the API every 10 min to keep cost bounded.
      return this.emptyResult();
    }

    if (this.inflightCall) {
      // Previous async call still outstanding. Don't pile up.
      return this.emptyResult();
    }

    const candidates = this.getCandidateMarkets(marketCache);
    if (candidates.length === 0) {
      this.log.debug('LLM scout: zero candidate markets from cache');
      return this.emptyResult();
    }
    const sorted = [...candidates].sort((a, b) => (b.liquidity ?? 0) - (a.liquidity ?? 0));
    const sample = sorted.slice(0, MAX_MARKETS_PER_CALL);
    this.log.info({ candidates: candidates.length, sample: sample.length }, 'LLM scout dispatching API call');

    this.lastCallAt = now;
    this.inflightCall = true;
    this.runAsync(sample)
      .catch((err) => {
        this.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'LLM scout runAsync rejected (outer catch)',
        );
      })
      .finally(() => {
        this.inflightCall = false;
        this.log.info('LLM scout async call completed (finally block)');
      });

    return {
      scout_id: this.id,
      priorities_written: 0,
      intel_written: 0,
      markets_evaluated: sample.length,
      summary: 'API call dispatched (async)',
    };
  }

  private async runAsync(sample: MarketData[]): Promise<void> {
    this.log.info({ sample_size: sample.length }, 'LLM scout async call starting');
    try {
      const findings = await this.callClaude(sample);
      if (findings.length === 0) {
        // 2026-04-15: bumped debug → info. With log_level=info in prod,
        // the debug log was invisible — the scout silently returned
        // zero for the entire life of the engine and we couldn't tell.
        this.log.info({ evaluated: sample.length }, 'LLM returned no findings');
        return;
      }

      // Build whitelist set for semantic validation
      const inputIds = new Set(sample.map(m => m.condition_id));
      const inputMap = new Map(sample.map(m => [m.condition_id, m]));

      let intelWritten = 0;
      let prioritiesWritten = 0;
      let droppedHallucinated = 0;
      let droppedLowReason = 0;
      let droppedBadShape = 0;

      for (const f of findings) {
        // Whitelist check — drops hallucinated condition_ids
        if (!inputIds.has(f.condition_id)) {
          droppedHallucinated++;
          continue;
        }
        // Reason length check
        if (!f.reason || f.reason.length < MIN_REASON_LENGTH) {
          droppedLowReason++;
          continue;
        }
        // Side + conviction sanity
        if (f.side !== 'YES' && f.side !== 'NO') {
          droppedBadShape++;
          continue;
        }
        if (!Number.isFinite(f.conviction) || f.conviction < 0 || f.conviction > 1) {
          droppedBadShape++;
          continue;
        }

        // Apply per-category conviction cap (lowest of category vs global wins)
        const market = inputMap.get(f.condition_id)!;
        const categoryCap = this.categoryConvictionCap(market);
        const effectiveCap = Math.min(MAX_CONVICTION, categoryCap);
        const cappedConviction = Math.min(effectiveCap, Math.max(0, f.conviction));

        // Write intel
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
          this.log.warn(
            { err, condition_id: f.condition_id.substring(0, 12) },
            'Failed to insert intel',
          );
        }

        // Write priority row
        try {
          const priority = Math.max(1, Math.min(10, f.priority));
          insertPriority({
            condition_id: f.condition_id,
            priority,
            reason: `llm-news: ${f.reason.substring(0, 180)}`,
            created_by: this.id,
            ttl_ms: PRIORITY_TTL_MS,
          });
          prioritiesWritten++;
        } catch (err) {
          this.log.warn(
            { err, condition_id: f.condition_id.substring(0, 12) },
            'Failed to insert priority',
          );
        }
      }

      this.log.info(
        {
          evaluated: sample.length,
          findings_returned: findings.length,
          intel_written: intelWritten,
          priorities_written: prioritiesWritten,
          dropped_hallucinated: droppedHallucinated,
          dropped_low_reason: droppedLowReason,
          dropped_bad_shape: droppedBadShape,
        },
        'LLM news scout tick complete',
      );
    } catch (err) {
      // Fail-closed: log and move on. Do NOT raise — that would halt the
      // coordinator's other scouts on the next tick.
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'LLM news scout call failed — skipping',
      );
    }
  }

  /**
   * Determine the strictest category cap for a market by scanning its tags.
   * If the market has no matching tag, returns 1.0 (no cap beyond global).
   */
  private categoryConvictionCap(market: MarketData): number {
    const tags = (market.tags ?? []).map(t => t.toLowerCase());
    let cap = 1.0;
    for (const tag of tags) {
      for (const [key, value] of Object.entries(CATEGORY_CAPS)) {
        if (tag.includes(key) && value < cap) cap = value;
      }
    }
    return cap;
  }

  /**
   * Actual Claude API call. Uses prompt caching for the stable system
   * prompt + schema block. Returns validated findings or throws.
   */
  private async callClaude(markets: MarketData[]): Promise<LlmNewsFinding[]> {
    if (!this.client) return [];

    // Build market list for the prompt — ONLY question text + category
    // tag. No prices. No liquidity. No volume. No midpoint. Giving the
    // LLM price data creates the feedback loop risk from the PolySwarm
    // paper.
    const marketList = markets
      .map((m, i) => {
        const tag = (m.tags ?? [])[0] ?? 'general';
        return `${i + 1}. [${m.condition_id}] (${tag}) ${m.question}`;
      })
      .join('\n');

    // System prompt is stable across ticks — we cache it via ephemeral.
    const systemPrompt = `You are a prediction-market catalyst analyst with web search access. Your job is to scan a list of active Polymarket questions and flag any whose outcomes have been materially affected by news in the last 2 hours.

IMPORTANT: Before returning findings, use the web_search tool to look for recent news related to each market category. For each flagged finding, cite the specific source you searched in the reason field. Only flag markets where web_search returned genuinely recent (last 2h) catalysts — not general background.

Return STRICT JSON with this exact shape, nothing else:

{
  "findings": [
    {
      "condition_id": "<exact id from the input list>",
      "side": "YES" | "NO",
      "conviction": <number 0-1>,
      "reason": "<2-3 sentences explaining the catalyst, citing a specific news event, decision, statement, or data release>",
      "priority": <integer 1-10>
    }
  ]
}

Rules:
1. Only include a finding if there is a SPECIFIC, RECENT, NAMEABLE catalyst. No vague "the market seems uncertain" findings.
2. The reason field must reference the specific event or data point that creates the edge. "CDC announced X at HH:MM" is good. "Markets are moving" is bad.
3. conviction scale:
   0.0-0.3 = weak/stale signal, probably don't include
   0.4-0.6 = moderate signal, real catalyst but outcome is still uncertain
   0.7-0.9 = strong signal, catalyst clearly points one way
   (We cap all findings at 0.8 regardless.)
4. priority scale: 1 = monitor, 5 = normal, 10 = scan immediately (strong breaking news)
5. side: YES means the catalyst pushes toward YES resolving; NO means toward NO resolving.
6. If nothing is newsworthy, return {"findings": []}. That is the correct answer most of the time.
7. You do not have current market prices. Do NOT speculate about "whether the market has already priced this in." Just answer whether a catalyst exists.
8. NEVER fabricate a condition_id. Only use ids exactly as they appear in the input list.

Category guidelines:
- Politics/election markets: be skeptical. Candidate specifics, polls, and rumors often mislead. Only flag if there's a clear policy decision, debate moment, or legal ruling within the 2h window.
- Macro/economic markets: you almost certainly have no edge here; these markets are efficient. Only flag on clear scheduled releases (Fed, CPI, NFP) with confirmed surprise directions.
- Sports markets: injury reports, lineup changes, or in-game events can create real edge. Flag these when confirmed.
- Crypto, weather, entertainment: flag on material news events within the 2h window.`;

    const userPrompt = `Active Polymarket questions (next 1-48 hours):

${marketList}

Evaluate each. Return findings JSON.`;

    // Race the API call against a hard timeout. The Anthropic SDK has
    // its own timeout but it's not always reliable when the connection
    // hangs at the TCP level. A 45-second race wrapper guarantees we
    // never block the scout indefinitely.
    const apiPromise = this.client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS * 3,
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: 5,
        },
      ] as unknown as Anthropic.Messages.ToolUnion[],
      system: [
        {
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        },
      ],
      messages: [
        {
          role: 'user',
          content: userPrompt,
        },
      ],
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('LLM scout hard timeout (45s)')), 45_000),
    );
    const response = await Promise.race([apiPromise, timeoutPromise]);

    // Extract text content — after web_search tool use, the FINAL text block
    // carries the JSON. Iterate in reverse to pick the last one.
    const textBlocks = response.content.filter((c): c is Anthropic.TextBlock => c.type === 'text');
    const textBlock = textBlocks.length > 0 ? textBlocks[textBlocks.length - 1] : undefined;
    if (!textBlock) {
      this.log.warn('LLM response had no text block');
      return [];
    }

    // Parse JSON. If the model wrapped the JSON in prose (it shouldn't
    // per the system prompt, but Haiku sometimes does), extract the
    // first {...} balanced block.
    const raw = textBlock.text.trim();
    const jsonString = this.extractJson(raw);
    if (!jsonString) {
      this.log.warn({ sample: raw.substring(0, 120) }, 'LLM response not parseable as JSON');
      return [];
    }

    let parsed: ClaudeResponse;
    try {
      parsed = JSON.parse(jsonString) as ClaudeResponse;
    } catch (err) {
      this.log.warn(
        { err: err instanceof Error ? err.message : String(err), sample: jsonString.substring(0, 120) },
        'JSON parse failed',
      );
      return [];
    }

    const rawFindings = Array.isArray(parsed.findings) ? parsed.findings : [];
    const clean: LlmNewsFinding[] = [];
    for (const rf of rawFindings as ClaudeRawFinding[]) {
      if (typeof rf.condition_id !== 'string') continue;
      if (rf.side !== 'YES' && rf.side !== 'NO') continue;
      if (typeof rf.conviction !== 'number' || !Number.isFinite(rf.conviction)) continue;
      if (typeof rf.reason !== 'string') continue;
      clean.push({
        condition_id: rf.condition_id,
        side: rf.side,
        conviction: Math.max(0, Math.min(1, rf.conviction)),
        reason: rf.reason,
        priority: 7, // default; could also read from response if we teach Claude to set it
      });
    }

    // Log cache usage stats from the API response headers / usage field
    // so we can validate the cache is actually hitting. 2026-04-15:
    // bumped debug → info. Fires once every 1h (MIN_CALL_INTERVAL_MS)
    // so log volume is trivial, but gives us proof the API is being
    // called and the cache is hitting (10× cost reduction depends on it).
    if (response.usage) {
      this.log.info(
        {
          input_tokens: response.usage.input_tokens,
          output_tokens: response.usage.output_tokens,
          cache_read_input_tokens: response.usage.cache_read_input_tokens,
          cache_creation_input_tokens: response.usage.cache_creation_input_tokens,
          raw_findings: (Array.isArray(parsed.findings) ? parsed.findings.length : 0),
          validated_findings: clean.length,
        },
        'Claude usage',
      );
    }

    return clean;
  }

  /**
   * Extract the first balanced {...} JSON block from a string. Handles
   * the common case where a model wraps JSON in prose or code fences.
   * Returns null if no balanced block found.
   */
  private extractJson(text: string): string | null {
    // Try direct parse first (the happy path)
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;

    // Strip code fences
    const fenceMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/);
    if (fenceMatch && fenceMatch[1]) return fenceMatch[1];

    // Scan for first balanced {...}
    const start = trimmed.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return trimmed.substring(start, i + 1);
      }
    }
    return null;
  }
}
