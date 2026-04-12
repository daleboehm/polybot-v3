// Smart-money repo — Phase C1a (2026-04-11).
//
// Backs the whale tracking pipeline with three responsibilities:
//
//   1. smart_money_candidates — everything the leaderboard poller sees
//   2. whitelisted_whales    — the subset we actually copy trades from
//   3. whale_trades          — audit log of every whale action we observe
//
// All functions here are dormant until the leaderboard scout, filter
// CLI, or whale-copy strategy actually exercise them. The schema tables
// exist post-migration but zero rows until activation.

import { getDatabase } from '../database.js';

// ─── smart_money_candidates ────────────────────────────────────────

export interface SmartMoneyCandidate {
  proxy_wallet: string;
  pseudonym: string | null;
  weekly_profit_usd: number;
  all_time_pnl_usd: number;
  total_volume_usd: number;
  first_seen_at: number;
  last_seen_at: number;
  last_filter_run_at: number | null;
  settled_markets: number;
  win_rate: number;
  category_count: number;
  uniform_sizing: number;
  status: 'candidate' | 'passed' | 'failed' | 'expired';
}

export interface UpsertCandidateInput {
  proxy_wallet: string;
  pseudonym: string | null;
  weekly_profit_usd: number;
  all_time_pnl_usd: number;
  total_volume_usd: number;
}

/**
 * Upsert a leaderboard row. On first sight, creates with status='candidate'
 * and first_seen_at = now. On repeat sight, updates weekly profit / pnl /
 * volume / pseudonym / last_seen_at but NEVER touches first_seen_at,
 * last_filter_run_at, or status — those are managed by the filter job.
 */
export function upsertCandidate(input: UpsertCandidateInput): void {
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    `INSERT INTO smart_money_candidates
       (proxy_wallet, pseudonym, weekly_profit_usd, all_time_pnl_usd,
        total_volume_usd, first_seen_at, last_seen_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'candidate')
     ON CONFLICT(proxy_wallet) DO UPDATE SET
       pseudonym = excluded.pseudonym,
       weekly_profit_usd = excluded.weekly_profit_usd,
       all_time_pnl_usd = excluded.all_time_pnl_usd,
       total_volume_usd = excluded.total_volume_usd,
       last_seen_at = excluded.last_seen_at`,
  ).run(
    input.proxy_wallet.toLowerCase(),
    input.pseudonym,
    input.weekly_profit_usd,
    input.all_time_pnl_usd,
    input.total_volume_usd,
    now,
    now,
  );
}

/** Return all candidates regardless of status. */
export function listAllCandidates(): SmartMoneyCandidate[] {
  const db = getDatabase();
  return db
    .prepare(`SELECT * FROM smart_money_candidates ORDER BY weekly_profit_usd DESC`)
    .all() as SmartMoneyCandidate[];
}

/** Return candidates that haven't been evaluated by the filter yet. */
export function listUnfiltered(): SmartMoneyCandidate[] {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT * FROM smart_money_candidates
       WHERE status = 'candidate'
       ORDER BY weekly_profit_usd DESC`,
    )
    .all() as SmartMoneyCandidate[];
}

/**
 * Record the filter job's verdict on a candidate. Updates the
 * per-wallet stats and sets status to 'passed' or 'failed'.
 */
export function recordFilterResult(
  proxy_wallet: string,
  stats: {
    settled_markets: number;
    win_rate: number;
    category_count: number;
    uniform_sizing: boolean;
  },
  passed: boolean,
): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE smart_money_candidates
     SET last_filter_run_at = ?,
         settled_markets = ?,
         win_rate = ?,
         category_count = ?,
         uniform_sizing = ?,
         status = ?
     WHERE proxy_wallet = ?`,
  ).run(
    Date.now(),
    stats.settled_markets,
    stats.win_rate,
    stats.category_count,
    stats.uniform_sizing ? 1 : 0,
    passed ? 'passed' : 'failed',
    proxy_wallet.toLowerCase(),
  );
}

/**
 * Mark candidates that haven't been seen on the leaderboard in `olderThanMs`
 * as expired. Keeps the table from growing unbounded.
 */
export function expireStaleCandidates(olderThanMs: number): number {
  const db = getDatabase();
  const cutoff = Date.now() - olderThanMs;
  const info = db
    .prepare(
      `UPDATE smart_money_candidates
       SET status = 'expired'
       WHERE last_seen_at < ? AND status IN ('candidate', 'passed', 'failed')`,
    )
    .run(cutoff);
  return info.changes;
}

// ─── whitelisted_whales ────────────────────────────────────────────

export interface WhitelistedWhale {
  proxy_wallet: string;
  pseudonym: string | null;
  promoted_at: number;
  promoted_by: 'smart-money-filter' | 'manual';
  reason: string | null;
  active: number; // 0/1
  copy_multiplier: number;
  last_trade_seen: number | null;
  trades_copied: number;
}

export interface PromoteWhaleInput {
  proxy_wallet: string;
  pseudonym?: string | null;
  promoted_by: 'smart-money-filter' | 'manual';
  reason?: string;
  copy_multiplier?: number;
}

/**
 * Add a wallet to the whitelist. Requires the wallet to exist in
 * smart_money_candidates (foreign key). For manual seeds, the caller
 * should first call seedCandidateSkeleton() to create a candidate row.
 */
export function promoteWhale(input: PromoteWhaleInput): void {
  const db = getDatabase();
  db.prepare(
    `INSERT INTO whitelisted_whales
       (proxy_wallet, pseudonym, promoted_at, promoted_by, reason, active, copy_multiplier)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(proxy_wallet) DO UPDATE SET
       pseudonym = COALESCE(excluded.pseudonym, whitelisted_whales.pseudonym),
       promoted_at = excluded.promoted_at,
       promoted_by = excluded.promoted_by,
       reason = excluded.reason,
       active = 1,
       copy_multiplier = excluded.copy_multiplier`,
  ).run(
    input.proxy_wallet.toLowerCase(),
    input.pseudonym ?? null,
    Date.now(),
    input.promoted_by,
    input.reason ?? null,
    input.copy_multiplier ?? 1.0,
  );
}

/**
 * Seed a candidate row for a manually-whitelisted wallet before the
 * leaderboard poller has seen it. Used by `polybot whale-seed` CLI.
 */
export function seedCandidateSkeleton(proxy_wallet: string, pseudonym: string | null): void {
  const db = getDatabase();
  const now = Date.now();
  db.prepare(
    `INSERT OR IGNORE INTO smart_money_candidates
       (proxy_wallet, pseudonym, weekly_profit_usd, all_time_pnl_usd,
        total_volume_usd, first_seen_at, last_seen_at, status)
     VALUES (?, ?, 0, 0, 0, ?, ?, 'passed')`,
  ).run(proxy_wallet.toLowerCase(), pseudonym, now, now);
}

/** Deactivate a whale (stop copying their trades). */
export function deactivateWhale(proxy_wallet: string): void {
  const db = getDatabase();
  db.prepare(
    `UPDATE whitelisted_whales SET active = 0 WHERE proxy_wallet = ?`,
  ).run(proxy_wallet.toLowerCase());
}

/** List active whales. Strategy reads this on every scan cycle. */
export function listActiveWhales(): WhitelistedWhale[] {
  const db = getDatabase();
  return db
    .prepare(`SELECT * FROM whitelisted_whales WHERE active = 1`)
    .all() as WhitelistedWhale[];
}

/** Get a single whale by wallet. */
export function getWhale(proxy_wallet: string): WhitelistedWhale | null {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT * FROM whitelisted_whales WHERE proxy_wallet = ?`)
    .get(proxy_wallet.toLowerCase()) as WhitelistedWhale | undefined;
  return row ?? null;
}

// ─── whale_trades ──────────────────────────────────────────────────

export type WhaleTradeAction =
  | 'copied'
  | 'skipped_latency'
  | 'skipped_fair_value'
  | 'skipped_dedup'
  | 'skipped_illiquid'
  | 'skipped_not_whitelisted'
  | 'skipped_other';

export interface InsertWhaleTradeInput {
  proxy_wallet: string;
  condition_id: string;
  token_id: string;
  side: 'BUY' | 'SELL';
  outcome: 'YES' | 'NO';
  size: number;
  price: number;
  usdc_size: number;
  block_number: number;
  tx_hash: string;
  action: WhaleTradeAction;
  action_reason?: string;
  our_signal_id?: string;
}

/**
 * Log a whale trade observation. Uses unique (tx_hash, token_id) to
 * dedup — the log subscriber may see the same event twice if it
 * reconnects.
 */
export function insertWhaleTrade(input: InsertWhaleTradeInput): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO whale_trades
       (proxy_wallet, condition_id, token_id, side, outcome, size, price,
        usdc_size, block_number, tx_hash, observed_at, action, action_reason,
        our_signal_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.proxy_wallet.toLowerCase(),
    input.condition_id,
    input.token_id,
    input.side,
    input.outcome,
    input.size,
    input.price,
    input.usdc_size,
    input.block_number,
    input.tx_hash,
    Date.now(),
    input.action,
    input.action_reason ?? null,
    input.our_signal_id ?? null,
  );

  // On copied trades, bump the whale's trades_copied counter + last_trade_seen
  if (input.action === 'copied') {
    db.prepare(
      `UPDATE whitelisted_whales
       SET trades_copied = trades_copied + 1,
           last_trade_seen = ?
       WHERE proxy_wallet = ?`,
    ).run(Date.now(), input.proxy_wallet.toLowerCase());
  }
}

/**
 * Check if we've already seen a specific whale trade. Used by the
 * copy-trade strategy as a hard-stop dedup — never copy the same
 * (wallet, condition, token) pair twice within the dedup window.
 */
export function isDuplicateWhaleTrade(
  proxy_wallet: string,
  condition_id: string,
  token_id: string,
  windowMs = 10 * 60 * 1000,
): boolean {
  const db = getDatabase();
  const cutoff = Date.now() - windowMs;
  const row = db
    .prepare(
      `SELECT 1 FROM whale_trades
       WHERE proxy_wallet = ? AND condition_id = ? AND token_id = ?
         AND observed_at >= ?
       LIMIT 1`,
    )
    .get(proxy_wallet.toLowerCase(), condition_id, token_id, cutoff) as number | undefined;
  return row !== undefined;
}

/** Stats for dashboard / debugging. */
export function countActiveWhales(): number {
  const db = getDatabase();
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM whitelisted_whales WHERE active = 1`)
    .get() as { n: number };
  return row.n;
}

export function countCandidatesByStatus(): Array<{ status: string; n: number }> {
  const db = getDatabase();
  return db
    .prepare(
      `SELECT status, COUNT(*) AS n FROM smart_money_candidates
       GROUP BY status ORDER BY n DESC`,
    )
    .all() as Array<{ status: string; n: number }>;
}
