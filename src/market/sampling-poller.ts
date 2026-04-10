// CLOB sampling-markets poller — the CLOB-first market discovery that fixes the v1 Gamma blocker

import type { SamplingMarket, Token } from '../types/index.js';
import { upsertMarket } from '../storage/repositories/market-repo.js';
import { eventBus } from '../core/event-bus.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('sampling-poller');

export class SamplingPoller {
  private interval: ReturnType<typeof setInterval> | null = null;
  private knownConditions = new Set<string>();

  constructor(
    private clobBaseUrl: string,
    private pollIntervalMs: number,
  ) {}

  async start(): Promise<void> {
    log.info({ interval: this.pollIntervalMs }, 'Starting sampling poller');
    await this.poll();
    this.interval = setInterval(() => this.poll().catch(err => {
      log.error({ err }, 'Polling cycle failed');
    }), this.pollIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    log.info('Sampling poller stopped');
  }

  async poll(): Promise<SamplingMarket[]> {
    log.debug('Polling all sampling market pages');

    try {
      const allMarkets: SamplingMarket[] = [];
      let cursor: string | undefined;
      let page = 0;
      const maxPages = 10; // Safety cap — 10,000 markets max

      while (page < maxPages) {
        const url = cursor
          ? `${this.clobBaseUrl}/sampling-markets?next_cursor=${cursor}`
          : `${this.clobBaseUrl}/sampling-markets`;

        const response = await fetch(url, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(30_000),
        });

        if (!response.ok) {
          // 400 means no more pages — not an error, just end of data
          if (response.status === 400) break;
          throw new Error(`CLOB sampling-markets returned ${response.status} on page ${page}`);
        }

        const data = await response.json() as RawSamplingResponse;
        const markets = this.parseMarkets(data);
        allMarkets.push(...markets);

        // Check for next page
        const nextCursor = typeof data === 'object' && !Array.isArray(data) ? data.next_cursor : undefined;
        if (!nextCursor || markets.length === 0) break;

        cursor = nextCursor as string;
        page++;
      }

      let newCount = 0;
      for (const market of allMarkets) {
        if (!market.active || market.closed) continue;

        const isNew = !this.knownConditions.has(market.condition_id);
        this.knownConditions.add(market.condition_id);

        upsertMarket(market);

        if (isNew) {
          newCount++;
          eventBus.emit('market:discovered', { market });
        }
      }

      log.info({ pages: page + 1, total: allMarkets.length, new: newCount, active: this.knownConditions.size }, 'Poll complete');
      return allMarkets;
    } catch (err) {
      log.error({ err }, 'Failed to poll sampling markets');
      return [];
    }
  }

  private parseMarkets(data: RawSamplingResponse): SamplingMarket[] {
    const raw = Array.isArray(data) ? data : (data.data ?? []);
    return raw.map(m => this.parseSingleMarket(m)).filter((m): m is SamplingMarket => m !== null);
  }

  private parseSingleMarket(raw: RawMarket): SamplingMarket | null {
    try {
      const tokens = raw.tokens ?? [];
      if (tokens.length < 2) return null;

      // AUDIT FIX A-P0-10 (2026-04-10): validate outcome field rather than assuming
      // tokens[0] is YES and tokens[1] is NO. The CLOB API can return tokens in
      // either order, and historically we hardcoded the mapping. A reorder silently
      // flipped every strategy's side on affected markets.
      const outcomeOf = (t: { outcome?: string } | undefined): 'yes' | 'no' | 'unknown' => {
        if (!t?.outcome) return 'unknown';
        const o = t.outcome.toLowerCase();
        if (o === 'yes' || o === 'y' || o === 'true') return 'yes';
        if (o === 'no' || o === 'n' || o === 'false') return 'no';
        return 'unknown';
      };

      const outcome0 = outcomeOf(tokens[0]);
      const outcome1 = outcomeOf(tokens[1]);

      // Pick the YES/NO token by matching outcome field, not by array index.
      let yesRaw = tokens[0];
      let noRaw = tokens[1];
      if (outcome0 === 'no' && outcome1 === 'yes') {
        yesRaw = tokens[1];
        noRaw = tokens[0];
      } else if (outcome0 === 'unknown' || outcome1 === 'unknown') {
        // Fall back to index-based assignment. Most Polymarket sampling markets
        // return non-YES/NO outcome names (e.g. "Over/Under", team names) so this
        // path is the common case, not a warning. Debug level only.
        log.debug(
          { conditionId: raw.condition_id, outcome0: tokens[0]?.outcome, outcome1: tokens[1]?.outcome },
          'Token outcome field missing or non-YES/NO — index-based fallback',
        );
      }

      const yesToken: Token = {
        token_id: yesRaw.token_id,
        outcome: 'Yes',
        price: Number(yesRaw.price ?? 0),
        winner: yesRaw.winner ?? false,
      };

      const noToken: Token = {
        token_id: noRaw.token_id,
        outcome: 'No',
        price: Number(noRaw.price ?? 0),
        winner: noRaw.winner ?? false,
      };

      return {
        condition_id: raw.condition_id,
        question_id: raw.question_id ?? '',
        question: raw.question ?? raw.description ?? '',
        description: raw.description ?? '',
        market_slug: raw.market_slug ?? '',
        end_date_iso: raw.end_date_iso ?? '',
        active: raw.active ?? true,
        closed: raw.closed ?? false,
        neg_risk: raw.neg_risk ?? false,
        neg_risk_market_id: raw.neg_risk_market_id ?? null,
        minimum_order_size: Number(raw.minimum_order_size ?? 0),
        minimum_tick_size: Number(raw.minimum_tick_size ?? 0.01),
        maker_base_fee: Number(raw.maker_base_fee ?? 0),
        taker_base_fee: Number(raw.taker_base_fee ?? 0),
        tags: raw.tags ?? [],
        tokens: [yesToken, noToken],
      };
    } catch {
      return null;
    }
  }

  getKnownCount(): number {
    return this.knownConditions.size;
  }
}

// Raw API response shapes
interface RawSamplingResponse {
  data?: RawMarket[];
  next_cursor?: string;
  limit?: number;
  count?: number;
  [key: string]: unknown;
}

interface RawMarket {
  condition_id: string;
  question_id?: string;
  question?: string;
  description?: string;
  market_slug?: string;
  end_date_iso?: string;
  active?: boolean;
  closed?: boolean;
  neg_risk?: boolean;
  neg_risk_market_id?: string;
  minimum_order_size?: string | number;
  minimum_tick_size?: string | number;
  maker_base_fee?: string | number;
  taker_base_fee?: string | number;
  tags?: string[];
  tokens?: Array<{
    token_id: string;
    price?: string | number;
    winner?: boolean;
    outcome?: string; // Not always present in sampling-markets response; when present
                      // we use it for YES/NO disambiguation, else fall back to index order.
  }>;
}
