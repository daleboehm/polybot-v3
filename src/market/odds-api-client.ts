// The Odds API client — sportsbook lines from Vegas/offshore books.
//
// R3a (2026-04-10). The Odds API aggregates live odds from 60+ sportsbooks
// (DraftKings, FanDuel, Caesars, BetMGM, Pinnacle, etc.) and returns normalized
// moneyline/spread/totals per sport per event. For our purposes — cross-
// referencing Polymarket sports markets against sportsbook consensus — we
// only need moneylines (head-to-head) which convert directly to implied
// probabilities.
//
// Plan tier: Plus @ $30/mo, 20K requests/month quota (design-decisions §N1).
// API key provided via env var `ODDS_API_KEY`. If the key is missing, the
// client logs a warning and returns empty arrays so the strategies fall back
// gracefully rather than crashing the engine.
//
// Rate limiting: we throttle to ≤1 request per sport per 10 minutes during
// peak windows. The sport catalog we track is ~7 sports (NFL, NBA, MLB, NHL,
// EPL, UEFA, ATP) → 7 × 6/hr × 24 × 30 = ~30K/mo, over quota → throttle to
// 1 req per sport per 20 min = ~15K/mo = safe.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('odds-api');

export interface OddsApiOutcome {
  name: string;       // team name or 'Draw' / 'Over' / 'Under'
  price: number;      // decimal odds (e.g. 2.25 means 2.25x payoff)
  point?: number;     // spread / total line
}

export interface OddsApiBookmaker {
  key: string;        // 'draftkings', 'fanduel', etc.
  title: string;      // display name
  lastUpdate: string; // ISO timestamp
  markets: Array<{
    key: string;      // 'h2h' (head-to-head), 'spreads', 'totals'
    outcomes: OddsApiOutcome[];
  }>;
}

export interface OddsApiEvent {
  id: string;
  sportKey: string;
  sportTitle: string;
  commenceTime: string; // ISO
  homeTeam: string;
  awayTeam: string;
  bookmakers: OddsApiBookmaker[];
}

export interface ConsensusProb {
  eventId: string;
  sportKey: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  homeProb: number;   // median implied prob across sampled books
  awayProb: number;
  drawProb?: number;
  numBooks: number;
  overround: number;  // book overround (how much the books take as a cut)
}

// Sport keys we track. Narrower list = fewer API calls = stays under quota.
export const TRACKED_SPORTS = [
  'americanfootball_nfl',
  'basketball_nba',
  'baseball_mlb',
  'icehockey_nhl',
  'soccer_epl',
  'soccer_uefa_champs_league',
  'tennis_atp_us_open',
] as const;

export type SportKey = typeof TRACKED_SPORTS[number];

const BASE_URL = 'https://api.the-odds-api.com/v4';
const REGION = 'us';
const MARKETS = 'h2h'; // head-to-head (moneyline) only
const ODDS_FORMAT = 'decimal';

// Per-sport cache TTL. 2026-04-10: extended from 10 min → 60 min because
// Dale was seeing "quota nearing exhaustion" warnings within minutes of
// engine startup. Sportsbook lines don't move that fast — a 60-minute
// cache hit rate keeps us safely inside any tier:
//   7 sports × (60 min / cache_ttl) calls/hour = 7/hour = 168/day = ~5,000/month
// That fits the 20K Plus plan with 75% headroom and still works on tighter
// plans if Dale ever downgrades. Strategy evaluations still see fresh-enough
// data because sports markets on Polymarket move far slower than 60 min.
const CACHE_TTL_MS = 60 * 60 * 1000; // 60 minutes

// Monthly quota alerting — conservative thresholds tuned for the Plus plan.
// The HALT gate is the hard stop; WARN is logged at most once per hour to
// stop the log-spam Dale reported on 2026-04-10.
const MONTHLY_QUOTA = 20000;
const WARN_PCT = 0.80;
const HALT_PCT = 0.95;
const WARN_THROTTLE_MS = 60 * 60 * 1000; // log quota warning at most 1×/hr

export class OddsApiClient {
  private readonly apiKey: string | null;
  private lastRequest = new Map<SportKey, number>();
  private cache = new Map<SportKey, { events: OddsApiEvent[]; at: number }>();
  private requestsThisMonth = 0;
  private quotaResetAt = 0;
  private halted = false;
  private lastWarnAt = 0; // throttle the "quota nearing exhaustion" log

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env.ODDS_API_KEY ?? null;
    if (!this.apiKey) {
      log.warn('ODDS_API_KEY not set — Odds API will return empty arrays');
    }
    // Reset monthly counter at the start of next month
    this.quotaResetAt = startOfNextMonthUtc();
  }

  /**
   * Fetch events for one sport. Returns cached data if the last request was
   * within MIN_REQUEST_INTERVAL_MS. Returns empty array if the API key is
   * missing, the quota is exceeded, or the API call fails.
   */
  async getEvents(sport: SportKey): Promise<OddsApiEvent[]> {
    if (!this.apiKey || this.halted) return [];

    // Reset monthly counter if we've crossed into the next month
    if (Date.now() >= this.quotaResetAt) {
      this.requestsThisMonth = 0;
      this.halted = false;
      this.quotaResetAt = startOfNextMonthUtc();
      log.info('Monthly Odds API quota reset');
    }

    if (this.requestsThisMonth >= MONTHLY_QUOTA * HALT_PCT) {
      log.error({ requests: this.requestsThisMonth, quota: MONTHLY_QUOTA }, 'Odds API quota ≥95% — halting fetches until next month');
      this.halted = true;
      return [];
    }

    // Per-sport cache: serve from cache if within the 60-minute TTL.
    // This is the load-bearing piece of the 2026-04-10 cache fix.
    const last = this.lastRequest.get(sport) ?? 0;
    const cached = this.cache.get(sport);
    if (Date.now() - last < CACHE_TTL_MS && cached) {
      return cached.events;
    }

    const url = `${BASE_URL}/sports/${sport}/odds?apiKey=${this.apiKey}&regions=${REGION}&markets=${MARKETS}&oddsFormat=${ODDS_FORMAT}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
      this.requestsThisMonth += 1;

      // Headers: x-requests-remaining, x-requests-used
      // Throttle the warn log so we don't spam journald on every call when
      // the quota is low. Log at most once per WARN_THROTTLE_MS.
      const remaining = Number(res.headers.get('x-requests-remaining') ?? NaN);
      if (Number.isFinite(remaining) && remaining < MONTHLY_QUOTA * (1 - HALT_PCT)) {
        if (Date.now() - this.lastWarnAt > WARN_THROTTLE_MS) {
          log.warn({ remaining, quota: MONTHLY_QUOTA }, 'Odds API quota nearing exhaustion');
          this.lastWarnAt = Date.now();
        }
      }

      if (!res.ok) {
        log.warn({ status: res.status, sport }, 'Odds API request failed');
        return cached?.events ?? [];
      }

      const raw = (await res.json()) as Array<Record<string, unknown>>;
      const events: OddsApiEvent[] = raw.map(r => ({
        id: String(r.id ?? ''),
        sportKey: String(r.sport_key ?? sport),
        sportTitle: String(r.sport_title ?? ''),
        commenceTime: String(r.commence_time ?? ''),
        homeTeam: String(r.home_team ?? ''),
        awayTeam: String(r.away_team ?? ''),
        bookmakers: (r.bookmakers as Array<Record<string, unknown>>)?.map(b => ({
          key: String(b.key ?? ''),
          title: String(b.title ?? ''),
          lastUpdate: String(b.last_update ?? ''),
          markets: ((b.markets as Array<Record<string, unknown>>) ?? []).map(m => ({
            key: String(m.key ?? ''),
            outcomes: ((m.outcomes as Array<Record<string, unknown>>) ?? []).map(o => ({
              name: String(o.name ?? ''),
              price: Number(o.price ?? 0),
              point: o.point !== undefined ? Number(o.point) : undefined,
            })),
          })),
        })) ?? [],
      }));

      this.cache.set(sport, { events, at: Date.now() });
      this.lastRequest.set(sport, Date.now());

      if (this.requestsThisMonth > MONTHLY_QUOTA * WARN_PCT) {
        if (Date.now() - this.lastWarnAt > WARN_THROTTLE_MS) {
          log.warn({ requests: this.requestsThisMonth }, 'Odds API quota > 80%');
          this.lastWarnAt = Date.now();
        }
      }

      return events;
    } catch (err) {
      log.warn({ sport, err: err instanceof Error ? err.message : String(err) }, 'Odds API fetch threw');
      return cached?.events ?? [];
    }
  }

  /**
   * Compute a consensus probability for a single event by taking the median
   * implied probability across all bookmakers in the event's h2h market, then
   * normalizing to remove the overround (vig).
   */
  computeConsensus(event: OddsApiEvent): ConsensusProb | null {
    const h2hSamples: Array<{ home: number; away: number; draw?: number }> = [];
    for (const bm of event.bookmakers) {
      const market = bm.markets.find(m => m.key === 'h2h');
      if (!market) continue;

      const home = market.outcomes.find(o => o.name === event.homeTeam);
      const away = market.outcomes.find(o => o.name === event.awayTeam);
      const draw = market.outcomes.find(o => o.name.toLowerCase() === 'draw');
      if (!home || !away) continue;

      const homeProb = 1 / home.price;
      const awayProb = 1 / away.price;
      const drawProb = draw ? 1 / draw.price : undefined;
      h2hSamples.push({ home: homeProb, away: awayProb, draw: drawProb });
    }

    if (h2hSamples.length === 0) return null;

    const median = (xs: number[]): number => {
      const sorted = [...xs].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    };

    const homeMedian = median(h2hSamples.map(s => s.home));
    const awayMedian = median(h2hSamples.map(s => s.away));
    const drawSamples = h2hSamples.filter(s => s.draw !== undefined).map(s => s.draw as number);
    const drawMedian = drawSamples.length > 0 ? median(drawSamples) : undefined;

    // Remove overround by normalizing the probabilities to sum to 1
    const totalRaw = homeMedian + awayMedian + (drawMedian ?? 0);
    const overround = totalRaw - 1;
    const homeProb = homeMedian / totalRaw;
    const awayProb = awayMedian / totalRaw;
    const drawProb = drawMedian !== undefined ? drawMedian / totalRaw : undefined;

    return {
      eventId: event.id,
      sportKey: event.sportKey,
      commenceTime: event.commenceTime,
      homeTeam: event.homeTeam,
      awayTeam: event.awayTeam,
      homeProb,
      awayProb,
      drawProb,
      numBooks: h2hSamples.length,
      overround,
    };
  }

  getRequestsThisMonth(): number {
    return this.requestsThisMonth;
  }

  isHalted(): boolean {
    return this.halted;
  }
}

function startOfNextMonthUtc(): number {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0);
}
