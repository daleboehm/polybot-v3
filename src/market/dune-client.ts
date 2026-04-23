// Dune Analytics client — 2026-04-23.
//
// Uses Dune's Query API to pull Polymarket-related analytics
// (whale PnL, market volume, top-trader leaderboards) that are maintained
// by community analysts on dune.com/polymarket. We don't author queries
// here — we execute existing public queries by id and parse rows.
//
// Auth: Dune API key in `DUNE_API_KEY` env var.
// Docs: https://docs.dune.com/api-reference/executions/execution/execute-query
//
// Flow:
//   1. POST /v1/query/{query_id}/execute  -> execution_id
//   2. POLL /v1/execution/{execution_id}/status until state = QUERY_STATE_COMPLETED
//   3. GET /v1/execution/{execution_id}/results -> { result: { rows: [...] } }
//
// OR the fast path: GET /v1/query/{query_id}/results (last cached run)
//
// We prefer the cached path by default — community Polymarket queries
// refresh on their own schedules, and paying for premium credits on every
// execute call is wasteful for our read-heavy use.
//
// Rate limits: 40 req/min on the free tier. Caller-side polling uses
// exponential backoff. Cache TTL: 15 min per query.

import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('dune-client');

const BASE = 'https://api.dune.com/api/v1';
const CACHE_TTL_MS = 15 * 60 * 1000;

interface DuneRow {
  [column: string]: string | number | boolean | null;
}

interface DuneResult {
  query_id: number;
  execution_id: string | null;
  rows: DuneRow[];
  row_count: number;
  executed_at: number;
  fetched_at: number;
}

const cache = new Map<number, DuneResult>();

export class DuneClient {
  private apiKey: string | null;

  constructor(apiKey?: string | null) {
    this.apiKey = apiKey ?? process.env.DUNE_API_KEY ?? null;
    if (!this.apiKey) log.warn('DUNE_API_KEY missing; Dune queries will return null');
  }

  isAvailable(): boolean {
    return this.apiKey !== null && this.apiKey.length > 0;
  }

  /**
   * Fetch the most recent cached result for a public Dune query.
   * No execution cost; returns rows as-is from the last community run.
   */
  async getCachedResult(queryId: number): Promise<DuneResult | null> {
    if (!this.apiKey) return null;

    const cached = cache.get(queryId);
    if (cached && Date.now() - cached.fetched_at < CACHE_TTL_MS) return cached;

    try {
      const url = BASE + '/query/' + queryId + '/results';
      const response = await fetch(url, {
        headers: { 'X-Dune-API-Key': this.apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        const body = await response.text();
        log.debug({ queryId, status: response.status, body: body.slice(0, 200) }, 'Dune cached-result fetch failed');
        return null;
      }

      const data = await response.json() as {
        execution_id?: string;
        execution_ended_at?: string;
        result?: { rows?: DuneRow[] };
      };
      const rows = data.result?.rows ?? [];
      const result: DuneResult = {
        query_id: queryId,
        execution_id: data.execution_id ?? null,
        rows,
        row_count: rows.length,
        executed_at: data.execution_ended_at ? Date.parse(data.execution_ended_at) : 0,
        fetched_at: Date.now(),
      };
      cache.set(queryId, result);
      log.debug({ queryId, rows: rows.length }, 'Dune cached result fetched');
      return result;
    } catch (err) {
      log.debug({ queryId, err: err instanceof Error ? err.message : String(err) }, 'Dune fetch failed');
      return null;
    }
  }

  /**
   * Execute a query and wait for fresh results. Costs Dune credits
   * (Free tier = limited). Use sparingly — prefer getCachedResult().
   */
  async executeAndWait(queryId: number, timeoutMs = 120_000): Promise<DuneResult | null> {
    if (!this.apiKey) return null;
    try {
      const execResp = await fetch(BASE + '/query/' + queryId + '/execute', {
        method: 'POST',
        headers: { 'X-Dune-API-Key': this.apiKey, 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(15_000),
      });
      if (!execResp.ok) return null;
      const execData = await execResp.json() as { execution_id?: string };
      const executionId = execData.execution_id;
      if (!executionId) return null;

      const deadline = Date.now() + timeoutMs;
      let delay = 2_000;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, delay));
        delay = Math.min(delay * 1.5, 15_000);

        const statusResp = await fetch(BASE + '/execution/' + executionId + '/status', {
          headers: { 'X-Dune-API-Key': this.apiKey },
          signal: AbortSignal.timeout(10_000),
        });
        if (!statusResp.ok) continue;
        const status = await statusResp.json() as { state?: string };
        if (status.state === 'QUERY_STATE_COMPLETED') {
          const resResp = await fetch(BASE + '/execution/' + executionId + '/results', {
            headers: { 'X-Dune-API-Key': this.apiKey },
            signal: AbortSignal.timeout(20_000),
          });
          if (!resResp.ok) return null;
          const data = await resResp.json() as { result?: { rows?: DuneRow[] } };
          const rows = data.result?.rows ?? [];
          const result: DuneResult = {
            query_id: queryId,
            execution_id: executionId,
            rows,
            row_count: rows.length,
            executed_at: Date.now(),
            fetched_at: Date.now(),
          };
          cache.set(queryId, result);
          return result;
        }
        if (status.state === 'QUERY_STATE_FAILED') {
          log.warn({ queryId, executionId }, 'Dune query execution failed');
          return null;
        }
      }
      log.warn({ queryId, executionId }, 'Dune execution timed out');
      return null;
    } catch (err) {
      log.debug({ queryId, err: err instanceof Error ? err.message : String(err) }, 'Dune execute failed');
      return null;
    }
  }
}

export type { DuneRow, DuneResult };

// Singleton
let _instance: DuneClient | null = null;
export function getDuneClient(): DuneClient {
  if (!_instance) _instance = new DuneClient();
  return _instance;
}
