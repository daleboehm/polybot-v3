// Fresh v2 schema DDL — run once on init

import type Database from 'better-sqlite3';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('schema');

const SCHEMA_VERSION = 2;

const DDL = `
-- ═══════════════════════════════════════════════════════════
-- Polybot V2 Schema v${SCHEMA_VERSION}
-- ═══════════════════════════════════════════════════════════

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version   INTEGER NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── ENTITIES ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS entities (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    slug            TEXT    UNIQUE NOT NULL,
    name            TEXT    NOT NULL,
    wallet_address  TEXT,
    proxy_address   TEXT,
    port            INTEGER NOT NULL,
    entity_path     TEXT    NOT NULL,
    mode            TEXT    NOT NULL DEFAULT 'paper' CHECK(mode IN ('paper', 'live')),
    status          TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'active', 'paused', 'disabled')),
    starting_capital REAL   NOT NULL DEFAULT 0,
    current_cash    REAL    NOT NULL DEFAULT 0,
    reserve_balance REAL    NOT NULL DEFAULT 0,
    trading_balance REAL    NOT NULL DEFAULT 0,
    high_water_mark REAL    NOT NULL DEFAULT 0,
    daily_pnl       REAL    NOT NULL DEFAULT 0,
    daily_pnl_reset TEXT,
    is_locked_out   INTEGER NOT NULL DEFAULT 0,
    lockout_reason  TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── MARKETS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS markets (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    condition_id        TEXT    UNIQUE NOT NULL,
    question_id         TEXT,
    question            TEXT    NOT NULL,
    description         TEXT,
    market_slug         TEXT,
    end_date            TEXT,
    active              INTEGER NOT NULL DEFAULT 1,
    closed              INTEGER NOT NULL DEFAULT 0,
    neg_risk            INTEGER NOT NULL DEFAULT 0,
    neg_risk_market_id  TEXT,
    minimum_order_size  REAL,
    minimum_tick_size   REAL,
    maker_base_fee      REAL    DEFAULT 0,
    taker_base_fee      REAL    DEFAULT 0,
    tags                TEXT,
    token_yes_id        TEXT    NOT NULL,
    token_no_id         TEXT    NOT NULL,
    last_yes_price      REAL,
    last_no_price       REAL,
    volume_24h          REAL    DEFAULT 0,
    liquidity           REAL    DEFAULT 0,
    last_updated        TEXT    NOT NULL DEFAULT (datetime('now')),
    first_seen          TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_markets_slug ON markets(market_slug);
CREATE INDEX IF NOT EXISTS idx_markets_active ON markets(active, closed);
CREATE INDEX IF NOT EXISTS idx_markets_end_date ON markets(end_date);
CREATE INDEX IF NOT EXISTS idx_markets_token_yes ON markets(token_yes_id);
CREATE INDEX IF NOT EXISTS idx_markets_token_no ON markets(token_no_id);

-- ─── ORDERS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id        TEXT    UNIQUE,
    entity_slug     TEXT    NOT NULL,
    condition_id    TEXT    NOT NULL,
    token_id        TEXT    NOT NULL,
    side            TEXT    NOT NULL CHECK(side IN ('BUY', 'SELL')),
    price           REAL    NOT NULL,
    original_size   REAL    NOT NULL,
    filled_size     REAL    NOT NULL DEFAULT 0,
    remaining_size  REAL    NOT NULL,
    usdc_amount     REAL    NOT NULL,
    status          TEXT    NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'open', 'partially_filled', 'filled', 'cancelled', 'rejected', 'expired')),
    order_type      TEXT    NOT NULL DEFAULT 'GTC' CHECK(order_type IN ('GTC', 'GTD', 'FOK', 'IOC')),
    expiration      TEXT,
    is_paper        INTEGER NOT NULL DEFAULT 1,
    strategy_id     TEXT,
    sub_strategy_id TEXT,
    signal_id       TEXT,
    error_message   TEXT,
    submitted_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    filled_at       TEXT,
    cancelled_at    TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (entity_slug) REFERENCES entities(slug),
    FOREIGN KEY (condition_id) REFERENCES markets(condition_id)
);

CREATE INDEX IF NOT EXISTS idx_orders_entity ON orders(entity_slug);
CREATE INDEX IF NOT EXISTS idx_orders_entity_status ON orders(entity_slug, status);
CREATE INDEX IF NOT EXISTS idx_orders_condition ON orders(condition_id);
CREATE INDEX IF NOT EXISTS idx_orders_submitted ON orders(submitted_at);
CREATE INDEX IF NOT EXISTS idx_orders_strategy ON orders(strategy_id);

-- ─── TRADES (fills) ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_id        TEXT,
    order_id        TEXT,
    entity_slug     TEXT    NOT NULL,
    condition_id    TEXT    NOT NULL,
    token_id        TEXT    NOT NULL,
    tx_hash         TEXT    UNIQUE,
    side            TEXT    NOT NULL CHECK(side IN ('BUY', 'SELL')),
    size            REAL    NOT NULL,
    price           REAL    NOT NULL,
    usdc_size       REAL    NOT NULL,
    fee_usdc        REAL    NOT NULL DEFAULT 0,
    net_usdc        REAL    NOT NULL,
    is_paper        INTEGER NOT NULL DEFAULT 1,
    strategy_id     TEXT,
    sub_strategy_id TEXT,
    outcome         TEXT    CHECK(outcome IN ('YES', 'NO')),
    market_question TEXT,
    market_slug     TEXT,
    timestamp       INTEGER NOT NULL,
    timestamp_utc   TEXT    NOT NULL,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (entity_slug) REFERENCES entities(slug),
    FOREIGN KEY (condition_id) REFERENCES markets(condition_id)
);

CREATE INDEX IF NOT EXISTS idx_trades_entity ON trades(entity_slug);
CREATE INDEX IF NOT EXISTS idx_trades_entity_ts ON trades(entity_slug, timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_condition ON trades(condition_id);
CREATE INDEX IF NOT EXISTS idx_trades_tx ON trades(tx_hash);
CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy_id);
CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_paper ON trades(is_paper);

-- ─── POSITIONS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS positions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_slug     TEXT    NOT NULL,
    condition_id    TEXT    NOT NULL,
    token_id        TEXT    NOT NULL,
    side            TEXT    NOT NULL CHECK(side IN ('YES', 'NO')),
    size            REAL    NOT NULL DEFAULT 0,
    avg_entry_price REAL    NOT NULL DEFAULT 0,
    cost_basis      REAL    NOT NULL DEFAULT 0,
    current_price   REAL,
    unrealized_pnl  REAL,
    market_question TEXT,
    market_slug     TEXT,
    strategy_id     TEXT,
    sub_strategy_id TEXT,
    is_paper        INTEGER NOT NULL DEFAULT 1,
    status          TEXT    NOT NULL DEFAULT 'open' CHECK(status IN ('open', 'closed', 'resolved')),
    opened_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    closed_at       TEXT,
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    UNIQUE(entity_slug, condition_id, token_id),
    FOREIGN KEY (entity_slug) REFERENCES entities(slug),
    FOREIGN KEY (condition_id) REFERENCES markets(condition_id)
);

CREATE INDEX IF NOT EXISTS idx_positions_entity ON positions(entity_slug);
CREATE INDEX IF NOT EXISTS idx_positions_entity_status ON positions(entity_slug, status);
CREATE INDEX IF NOT EXISTS idx_positions_condition ON positions(condition_id);

-- ─── RESOLUTIONS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS resolutions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_slug       TEXT    NOT NULL,
    condition_id      TEXT    NOT NULL,
    token_id          TEXT    NOT NULL,
    winning_outcome   TEXT    NOT NULL,
    position_side     TEXT    NOT NULL,
    size              REAL    NOT NULL,
    payout_usdc       REAL    NOT NULL,
    cost_basis_usdc   REAL    NOT NULL,
    sell_proceeds_usdc REAL   NOT NULL DEFAULT 0,
    realized_pnl      REAL   NOT NULL,
    is_paper          INTEGER NOT NULL DEFAULT 1,
    strategy_id       TEXT,
    sub_strategy_id   TEXT,
    market_question   TEXT,
    market_slug       TEXT,
    tx_hash           TEXT,
    resolved_at       TEXT    NOT NULL,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (entity_slug) REFERENCES entities(slug),
    FOREIGN KEY (condition_id) REFERENCES markets(condition_id)
);

CREATE INDEX IF NOT EXISTS idx_resolutions_entity ON resolutions(entity_slug);
CREATE INDEX IF NOT EXISTS idx_resolutions_condition ON resolutions(condition_id);
CREATE INDEX IF NOT EXISTS idx_resolutions_resolved ON resolutions(resolved_at);
CREATE INDEX IF NOT EXISTS idx_resolutions_strategy ON resolutions(strategy_id);

-- ─── SIGNALS ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    signal_id       TEXT    UNIQUE NOT NULL,
    entity_slug     TEXT    NOT NULL,
    strategy_id     TEXT    NOT NULL,
    sub_strategy_id TEXT,
    condition_id    TEXT    NOT NULL,
    token_id        TEXT    NOT NULL,
    side            TEXT    NOT NULL CHECK(side IN ('BUY', 'SELL')),
    outcome         TEXT    NOT NULL CHECK(outcome IN ('YES', 'NO')),
    strength        REAL    NOT NULL,
    edge            REAL    NOT NULL,
    model_prob      REAL    NOT NULL,
    market_price    REAL    NOT NULL,
    recommended_size_usd REAL NOT NULL,
    approved        INTEGER NOT NULL DEFAULT 0,
    rejection_reason TEXT,
    final_size_usd  REAL,
    metadata        TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (entity_slug) REFERENCES entities(slug),
    FOREIGN KEY (condition_id) REFERENCES markets(condition_id)
);

CREATE INDEX IF NOT EXISTS idx_signals_entity ON signals(entity_slug);
CREATE INDEX IF NOT EXISTS idx_signals_strategy ON signals(strategy_id);
CREATE INDEX IF NOT EXISTS idx_signals_condition ON signals(condition_id);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);

-- ─── SNAPSHOTS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS snapshots (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_slug     TEXT    NOT NULL,
    timestamp       INTEGER NOT NULL,
    timestamp_utc   TEXT    NOT NULL,
    total_equity    REAL    NOT NULL,
    cash_balance    REAL    NOT NULL,
    reserve_balance REAL    NOT NULL DEFAULT 0,
    trading_balance REAL    NOT NULL DEFAULT 0,
    positions_value REAL    NOT NULL DEFAULT 0,
    num_positions   INTEGER NOT NULL DEFAULT 0,
    open_orders_value REAL  NOT NULL DEFAULT 0,
    num_open_orders INTEGER NOT NULL DEFAULT 0,
    daily_pnl       REAL    NOT NULL DEFAULT 0,
    deposit_basis   REAL    NOT NULL DEFAULT 0,
    pnl_vs_deposit  REAL    NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (entity_slug) REFERENCES entities(slug)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_entity ON snapshots(entity_slug);
CREATE INDEX IF NOT EXISTS idx_snapshots_entity_ts ON snapshots(entity_slug, timestamp);

-- ─── TRANSFERS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS transfers (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    from_entity     TEXT    NOT NULL,
    to_entity       TEXT    NOT NULL,
    amount_usdc     REAL    NOT NULL,
    tx_hash         TEXT,
    timestamp       INTEGER NOT NULL,
    timestamp_utc   TEXT    NOT NULL,
    transfer_type   TEXT    NOT NULL CHECK(transfer_type IN ('DEPOSIT', 'FUND', 'SWEEP', 'WITHDRAWAL')),
    notes           TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (from_entity) REFERENCES entities(slug),
    FOREIGN KEY (to_entity) REFERENCES entities(slug)
);

CREATE INDEX IF NOT EXISTS idx_transfers_from ON transfers(from_entity);
CREATE INDEX IF NOT EXISTS idx_transfers_to ON transfers(to_entity);

-- ─── AUDIT LOG ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type  TEXT    NOT NULL,
    entity_slug TEXT,
    payload     TEXT    NOT NULL,
    checksum    TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_slug);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

-- ─── MARKET PRIORITIES (Attention Router — Phase 2, 2026-04-11) ──────
-- Scouts write rows here to tell the engine "scan this market now, don't
-- wait for the next 5-minute scan cycle." The PriorityScanner runs every
-- 30 seconds, reads active (expires_at > now) priorities, and fires
-- strategies on just those markets out of the normal cycle. Signals
-- flow through the normal risk + execution pipeline.
--
-- Priority: 1 (lowest) to 10 (highest). Scout's confidence + urgency.
-- Reason: short text, scout writes why (e.g. "volume spike 8x baseline").
-- Created_by: scout_id of the scout that wrote the row. Used for dashboards
-- and to debug which scouts are producing useful priorities.
-- Expires_at: unix ms. Scouts set short windows (5-30 min) so stale
-- priorities clean themselves up.
-- Scanned_count: how many times the PriorityScanner has evaluated this
-- row since insert. Used to rate-limit repeat scans of the same market.
CREATE TABLE IF NOT EXISTS market_priorities (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    condition_id    TEXT    NOT NULL,
    priority        INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 10),
    reason          TEXT    NOT NULL,
    created_by      TEXT    NOT NULL,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    scanned_count   INTEGER NOT NULL DEFAULT 0,
    last_scanned_at INTEGER,
    FOREIGN KEY (condition_id) REFERENCES markets(condition_id)
);

CREATE INDEX IF NOT EXISTS idx_mp_active ON market_priorities(expires_at) WHERE expires_at > 0;
CREATE INDEX IF NOT EXISTS idx_mp_condition ON market_priorities(condition_id);
CREATE INDEX IF NOT EXISTS idx_mp_scout ON market_priorities(created_by);

-- ─── SCOUT INTEL (Scout Overlay — Phase 3, 2026-04-11) ──────────────
-- Scouts write *qualitative* intel here: "market X, side NO, conviction
-- 0.7, reason: CDC just announced". Strategies read this during signal
-- build via scout-overlay.ts and apply a size multiplier:
--   agree + high conviction → 1.25x
--   disagree + high conviction → 0.5x (or skip)
--   no intel → 1.0x
-- Intel cannot CREATE signals — it only weights existing ones. The
-- strategy math + calibration is always primary.
--
-- Side: 'YES' | 'NO' — which side the scout thinks should resolve.
-- Conviction: 0-1, how confident the scout is. 0.5 = neutral, 1.0 = high.
-- Reason: free text, scout explains in plain language.
-- Expires_at: default 24h from created_at. Scouts can set shorter for
-- time-sensitive news, longer for structural observations.
CREATE TABLE IF NOT EXISTS scout_intel (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    condition_id    TEXT    NOT NULL,
    side            TEXT    NOT NULL CHECK(side IN ('YES', 'NO')),
    conviction      REAL    NOT NULL CHECK(conviction BETWEEN 0 AND 1),
    reason          TEXT    NOT NULL,
    created_by      TEXT    NOT NULL,
    created_at      INTEGER NOT NULL,
    expires_at      INTEGER NOT NULL,
    used_count      INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (condition_id) REFERENCES markets(condition_id)
);

CREATE INDEX IF NOT EXISTS idx_si_active ON scout_intel(expires_at);
CREATE INDEX IF NOT EXISTS idx_si_condition ON scout_intel(condition_id);
CREATE INDEX IF NOT EXISTS idx_si_scout ON scout_intel(created_by);

-- ─── SMART MONEY CANDIDATES (Whale Tracking — Phase C1a, 2026-04-11) ─
-- The LeaderboardPollerScout hits data-api.polymarket.com/leaderboards
-- every 10 minutes and upserts rows here keyed by proxy_wallet. Each row
-- tracks the wallet's most recent weekly profit, all-time realized PnL,
-- total volume, and pseudonym. A nightly filter job (CLI command
-- 'polybot smart-money-filter') walks every row, queries the Data API
-- for each wallet's full resolved-position history, applies the Bravado
-- Trade 4-threshold filter (>=200 settled markets, >=65% WR, varied
-- sizing, cross-category) and promotes survivors to whitelisted_whales.
--
-- status values:
--   'candidate' — appeared on leaderboard, not yet evaluated by filter
--   'passed'    — filter job promoted it (also appears in whitelisted_whales)
--   'failed'    — filter job evaluated and rejected
--   'expired'   — hasn't been seen on the leaderboard in >7 days
CREATE TABLE IF NOT EXISTS smart_money_candidates (
    proxy_wallet          TEXT    PRIMARY KEY,
    pseudonym             TEXT,
    weekly_profit_usd     REAL    NOT NULL DEFAULT 0,
    all_time_pnl_usd      REAL    NOT NULL DEFAULT 0,
    total_volume_usd      REAL    NOT NULL DEFAULT 0,
    first_seen_at         INTEGER NOT NULL,
    last_seen_at          INTEGER NOT NULL,
    last_filter_run_at    INTEGER,
    settled_markets       INTEGER NOT NULL DEFAULT 0,
    win_rate              REAL    NOT NULL DEFAULT 0,
    category_count        INTEGER NOT NULL DEFAULT 0,
    uniform_sizing        INTEGER NOT NULL DEFAULT 0,
    status                TEXT    NOT NULL DEFAULT 'candidate' CHECK(status IN ('candidate', 'passed', 'failed', 'expired'))
);

CREATE INDEX IF NOT EXISTS idx_smc_status ON smart_money_candidates(status);
CREATE INDEX IF NOT EXISTS idx_smc_last_seen ON smart_money_candidates(last_seen_at);

-- ─── WHITELISTED WHALES (Whale Tracking — Phase C1a, 2026-04-11) ─────
-- Subset of smart_money_candidates that passed the filter AND have been
-- approved (either by the filter job automatically or by the operator
-- manually via CLI). The whale-copy strategy ONLY copies trades from
-- wallets in this table. Seeding happens via either:
--   1. polybot smart-money-filter (nightly job, auto-promotes filter passers)
--   2. polybot whale-seed --wallet 0x... (manual seed)
--
-- Manual seeds are how we bootstrap before the filter has enough data
-- (e.g. seeding Fredi9999 from the 2024 election research).
CREATE TABLE IF NOT EXISTS whitelisted_whales (
    proxy_wallet     TEXT    PRIMARY KEY,
    pseudonym        TEXT,
    promoted_at      INTEGER NOT NULL,
    promoted_by      TEXT    NOT NULL,  -- 'smart-money-filter' or 'manual'
    reason           TEXT,
    active           INTEGER NOT NULL DEFAULT 1,
    copy_multiplier  REAL    NOT NULL DEFAULT 1.0 CHECK(copy_multiplier BETWEEN 0 AND 2.0),
    last_trade_seen  INTEGER,
    trades_copied    INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (proxy_wallet) REFERENCES smart_money_candidates(proxy_wallet)
);

CREATE INDEX IF NOT EXISTS idx_ww_active ON whitelisted_whales(active) WHERE active = 1;

-- ─── WHALE TRADES (Whale Tracking — Phase C1a, 2026-04-11) ───────────
-- Log of every whale trade the event tracker observes. Used for:
--   (a) audit trail — we saw trade X at time Y, took action Z
--   (b) dedup — don't copy the same trade twice
--   (c) latency measurement — whale_ts vs our_action_ts
--   (d) attribution — which whale's trades we copied, which we skipped
CREATE TABLE IF NOT EXISTS whale_trades (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    proxy_wallet          TEXT    NOT NULL,
    condition_id          TEXT    NOT NULL,
    token_id              TEXT    NOT NULL,
    side                  TEXT    NOT NULL CHECK(side IN ('BUY', 'SELL')),
    outcome               TEXT    NOT NULL CHECK(outcome IN ('YES', 'NO')),
    size                  REAL    NOT NULL,
    price                 REAL    NOT NULL,
    usdc_size             REAL    NOT NULL,
    block_number          INTEGER NOT NULL,
    tx_hash               TEXT    NOT NULL,
    observed_at           INTEGER NOT NULL,
    -- action we took in response
    action                TEXT    NOT NULL CHECK(action IN ('copied', 'skipped_latency', 'skipped_fair_value', 'skipped_dedup', 'skipped_illiquid', 'skipped_not_whitelisted', 'skipped_other')),
    action_reason         TEXT,
    our_signal_id         TEXT,
    FOREIGN KEY (proxy_wallet) REFERENCES smart_money_candidates(proxy_wallet)
);

CREATE INDEX IF NOT EXISTS idx_wt_wallet ON whale_trades(proxy_wallet);
CREATE INDEX IF NOT EXISTS idx_wt_condition ON whale_trades(condition_id);
CREATE INDEX IF NOT EXISTS idx_wt_observed ON whale_trades(observed_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wt_txhash ON whale_trades(tx_hash, token_id);

-- ─── KILL SWITCH STATE (G1 — persisted halt, 2026-04-15) ─────────────
-- The kill switch is a singleton in-memory flag. Without persistence it
-- clears on process restart, which is exactly what took down prod on
-- 2026-04-13: the halt fired at 13:36 UTC on a 43.8% daily drawdown, the
-- process later restarted (OOM / systemctl / graceful-shutdown path), the
-- in-memory flag cleared, and live trading auto-resumed into the broken
-- longshot strategy. Trades 1347/1348 filled after the halt should have
-- been in force.
--
-- Single-row table (CHECK id=1) — there is only ever one kill-switch
-- state for a given engine process. On engine startup we read the row;
-- if halted === 1 we call killSwitch.halt(reason, message) BEFORE any
-- strategy or clob-router code runs, so the halt survives the restart.
-- resume() (operator via SIGUSR2 or dashboard API) clears the row. This
-- means restart does NOT resume trading — only deliberate operator
-- action can clear the halt.
CREATE TABLE IF NOT EXISTS kill_switch_state (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    halted      INTEGER NOT NULL DEFAULT 0,
    reason      TEXT,
    message     TEXT,
    halted_at   TEXT,
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ─── VIEWS ──────────────────────────────────────────────────

CREATE VIEW IF NOT EXISTS v_entity_pnl AS
SELECT
    e.slug,
    e.name,
    e.mode,
    e.status,
    e.starting_capital,
    e.current_cash,
    e.reserve_balance,
    e.trading_balance,
    COALESCE(r.total_realized_pnl, 0) AS total_realized_pnl,
    COALESCE(r.total_wins, 0) AS total_wins,
    COALESCE(r.total_losses, 0) AS total_losses,
    COALESCE(t.total_trades, 0) AS total_trades,
    COALESCE(t.total_volume, 0) AS total_volume,
    COALESCE(p.open_positions, 0) AS open_positions,
    COALESCE(p.open_positions_value, 0) AS open_positions_value,
    COALESCE(p.total_upside, 0) AS total_upside
FROM entities e
LEFT JOIN (
    SELECT entity_slug,
           SUM(realized_pnl) AS total_realized_pnl,
           SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS total_wins,
           -- 2026-04-10: changed <= 0 to < 0 (strict). A realized_pnl of exactly 0
           -- is a push, not a loss. This also excludes the accounting-neutral
           -- placeholder rows written by the reconciler for close_absent cases
           -- where the market is not yet resolved — those get payout=cost_basis,
           -- realized_pnl=0 so they stay in the history table without polluting W/L.
           SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS total_losses
    FROM resolutions
    GROUP BY entity_slug
) r ON e.slug = r.entity_slug
LEFT JOIN (
    SELECT entity_slug,
           COUNT(*) AS total_trades,
           SUM(usdc_size) AS total_volume
    FROM trades
    GROUP BY entity_slug
) t ON e.slug = t.entity_slug
LEFT JOIN (
    SELECT entity_slug,
           COUNT(*) AS open_positions,
           SUM(cost_basis) AS open_positions_value,
           SUM(size) - SUM(cost_basis) AS total_upside
    FROM positions WHERE status = 'open'
    GROUP BY entity_slug
) p ON e.slug = p.entity_slug;

CREATE VIEW IF NOT EXISTS v_daily_volume AS
SELECT
    entity_slug,
    DATE(timestamp_utc) AS trade_date,
    COUNT(*) AS num_trades,
    SUM(usdc_size) AS volume_usdc,
    SUM(fee_usdc) AS fees_usdc
FROM trades
GROUP BY entity_slug, DATE(timestamp_utc)
ORDER BY trade_date DESC;

CREATE VIEW IF NOT EXISTS v_weekly_tax AS
SELECT
    entity_slug,
    strftime('%Y-W%W', resolved_at) AS tax_week,
    SUM(CASE WHEN realized_pnl > 0 THEN realized_pnl ELSE 0 END) AS taxable_gains,
    SUM(CASE WHEN realized_pnl < 0 THEN realized_pnl ELSE 0 END) AS deductible_losses,
    SUM(realized_pnl) AS net_pnl,
    COUNT(*) AS num_resolutions
FROM resolutions
WHERE is_paper = 0
GROUP BY entity_slug, strftime('%Y-W%W', resolved_at)
ORDER BY tax_week DESC;

CREATE VIEW IF NOT EXISTS v_strategy_performance AS
SELECT
    s.strategy_id,
    s.sub_strategy_id,
    s.entity_slug,
    COALESCE(r.total_resolutions, 0) AS total_resolutions,
    COALESCE(r.wins, 0) AS wins,
    COALESCE(r.losses, 0) AS losses,
    -- 2026-04-10: divide wins by (wins + losses), NOT by total_resolutions.
    -- total_resolutions includes pushes (realized_pnl = 0, accounting-neutral
    -- placeholder rows from the reconciler's close_absent fallback). Including
    -- them in the denominator would artificially suppress win rate.
    CASE WHEN COALESCE(r.wins, 0) + COALESCE(r.losses, 0) > 0
         THEN ROUND(100.0 * r.wins / (r.wins + r.losses), 1)
         ELSE 0.0 END AS win_rate,
    COALESCE(r.total_pnl, 0) AS total_pnl,
    COALESCE(r.avg_pnl_per_trade, 0) AS avg_pnl_per_trade,
    COALESCE(r.best_trade, 0) AS best_trade,
    COALESCE(r.worst_trade, 0) AS worst_trade,
    COALESCE(p.open_count, 0) AS open_positions,
    COALESCE(p.open_cost, 0) AS open_cost_basis,
    COALESCE(p.open_upside, 0) AS open_upside,
    COALESCE(s.total_trades, 0) AS total_trades,
    COALESCE(s.total_volume, 0) AS total_volume
FROM (
    SELECT strategy_id, COALESCE(sub_strategy_id, '') AS sub_strategy_id, entity_slug,
           COUNT(*) AS total_trades, SUM(usdc_size) AS total_volume
    FROM trades WHERE strategy_id IS NOT NULL
    GROUP BY strategy_id, COALESCE(sub_strategy_id, ''), entity_slug
) s
LEFT JOIN (
    SELECT strategy_id, COALESCE(sub_strategy_id, '') AS sub_strategy_id, entity_slug,
           COUNT(*) AS total_resolutions,
           SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
           -- 2026-04-10: strict < 0 (see v_entity_pnl above for rationale).
           SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
           SUM(realized_pnl) AS total_pnl,
           AVG(realized_pnl) AS avg_pnl_per_trade,
           MAX(realized_pnl) AS best_trade,
           MIN(realized_pnl) AS worst_trade
    FROM resolutions WHERE strategy_id IS NOT NULL
    GROUP BY strategy_id, COALESCE(sub_strategy_id, ''), entity_slug
) r ON s.strategy_id = r.strategy_id AND s.sub_strategy_id = r.sub_strategy_id AND s.entity_slug = r.entity_slug
LEFT JOIN (
    SELECT strategy_id, COALESCE(sub_strategy_id, '') AS sub_strategy_id, entity_slug,
           COUNT(*) AS open_count,
           SUM(cost_basis) AS open_cost,
           SUM(size) - SUM(cost_basis) AS open_upside
    FROM positions WHERE status = 'open' AND strategy_id IS NOT NULL
    GROUP BY strategy_id, COALESCE(sub_strategy_id, ''), entity_slug
) p ON s.strategy_id = p.strategy_id AND s.sub_strategy_id = p.sub_strategy_id AND s.entity_slug = p.entity_slug
ORDER BY COALESCE(s.total_trades, 0) DESC;

-- 2026-04-15: rolling-window strategy performance.
-- The v_strategy_performance view above is ALL-TIME. That's useful for
-- lifetime accounting but dangerous for decision-making because a single
-- bad burn-in day (e.g. 2026-04-11 longshot sports-fade blowup) contaminates
-- the average forever. The rolling view exposes 24h / 48h / 72h windows
-- per strategy and per sub-strategy so the dashboard and the advisor can
-- show Dale the recent behavior alongside the lifetime picture.
--
-- Each row is a (strategy_id, sub_strategy_id, entity_slug, window_label)
-- tuple. window_label is one of '24h', '48h', '72h', 'all_time'. The
-- cutoff is applied at view-query time via datetime('now','-N hours'),
-- which SQLite resolves on every SELECT, so the window always tracks
-- "right now" without any background job needing to refresh it.
--
-- Pushes (realized_pnl = 0) are counted in n but not in wins/losses, to
-- match v_strategy_performance's win-rate convention (wins / (wins+losses)).
-- avg_pnl_per_trade is over all n (including pushes) so that when Dale
-- sees "per_trade = +$0.14" it is the real rate of capital gain, not a
-- push-excluded artifact.
CREATE VIEW IF NOT EXISTS v_strategy_rolling AS
WITH windows AS (
    SELECT '24h' AS window_label, datetime('now','-24 hours') AS cutoff
    UNION ALL SELECT '48h', datetime('now','-48 hours')
    UNION ALL SELECT '72h', datetime('now','-72 hours')
    UNION ALL SELECT 'all_time', '1970-01-01 00:00:00'
)
SELECT
    r.strategy_id,
    COALESCE(r.sub_strategy_id, '') AS sub_strategy_id,
    r.entity_slug,
    w.window_label,
    COUNT(*) AS n,
    SUM(CASE WHEN r.realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN r.realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
    SUM(CASE WHEN r.realized_pnl = 0 THEN 1 ELSE 0 END) AS pushes,
    CASE WHEN SUM(CASE WHEN r.realized_pnl > 0 THEN 1 ELSE 0 END)
             + SUM(CASE WHEN r.realized_pnl < 0 THEN 1 ELSE 0 END) > 0
         THEN ROUND(100.0 * SUM(CASE WHEN r.realized_pnl > 0 THEN 1 ELSE 0 END)
                  / (SUM(CASE WHEN r.realized_pnl > 0 THEN 1 ELSE 0 END)
                     + SUM(CASE WHEN r.realized_pnl < 0 THEN 1 ELSE 0 END)), 1)
         ELSE 0.0 END AS win_rate,
    ROUND(SUM(r.realized_pnl), 4) AS total_pnl,
    ROUND(SUM(r.realized_pnl) * 1.0 / COUNT(*), 4) AS avg_pnl_per_trade,
    ROUND(MAX(r.realized_pnl), 4) AS best_trade,
    ROUND(MIN(r.realized_pnl), 4) AS worst_trade,
    MIN(r.resolved_at) AS first_resolved_at,
    MAX(r.resolved_at) AS last_resolved_at
FROM resolutions r
CROSS JOIN windows w
WHERE r.strategy_id IS NOT NULL
  AND r.resolved_at >= w.cutoff
GROUP BY r.strategy_id, COALESCE(r.sub_strategy_id, ''), r.entity_slug, w.window_label
ORDER BY r.strategy_id, sub_strategy_id, r.entity_slug,
         CASE w.window_label
              WHEN '24h' THEN 1
              WHEN '48h' THEN 2
              WHEN '72h' THEN 3
              WHEN 'all_time' THEN 4 END;


-- 2026-04-20: strategy checkpoint comparison view.
-- Provides before/after split across our major change deployments so Dale
-- can see the actual impact of fixes on realized PnL without waiting for
-- full time windows to fill. Each checkpoint row compares resolutions
-- closed BEFORE the change timestamp vs AFTER.
--
-- Checkpoints hardcoded per commit-deploy history. When new significant
-- changes ship, add a row to the CHECKPOINTS CTE below.
--
-- Usage (dashboard): GROUP BY checkpoint, strategy_id, sub_strategy_id
-- and pivot by era for side-by-side columns.
CREATE VIEW IF NOT EXISTS v_strategy_checkpoints AS
WITH checkpoints(checkpoint_label, checkpoint_at, description) AS (
    VALUES
        ('T1_fixes_2026-04-17',  '2026-04-17 06:00:00', 'Fix 1 Kelly alpha-boundary + Fix 4 weather 2x/hold-to-settle + fee-adjusted edge'),
        ('T2_rd_back_2026-04-18', '2026-04-18 08:40:00', 'R&D back online + portfolio cap removed + edge threshold 0.02 to 0.005'),
        ('T3_tranche2_2026-04-20','2026-04-20 16:00:00', 'ta_momentum + lifecycle filter + whale_fade + KL scout + cross-market-arb scout')
        ,('T4_clean_era_2026-04-21','2026-04-21 14:00:00', 'All fixes active: Fix 1 Kelly + favorites 0.70 floor + fee-adjusted edge + METAR + ta_momentum + lifecycle filter + negrisk MAX_LEG_PRICE + complete-set-arb scout + tight prod caps')
),
tagged AS (
    SELECT
        r.strategy_id,
        COALESCE(r.sub_strategy_id, '') AS sub_strategy_id,
        r.entity_slug,
        c.checkpoint_label,
        c.description,
        CASE WHEN r.resolved_at < c.checkpoint_at THEN 'before' ELSE 'after' END AS era,
        r.realized_pnl
    FROM resolutions r
    CROSS JOIN checkpoints c
    WHERE r.strategy_id IS NOT NULL
)
SELECT
    checkpoint_label,
    description,
    strategy_id,
    sub_strategy_id,
    entity_slug,
    era,
    COUNT(*) AS n,
    SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END) AS wins,
    SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) AS losses,
    CASE WHEN SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END)
             + SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END) > 0
         THEN ROUND(100.0 * SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END)
                  / (SUM(CASE WHEN realized_pnl > 0 THEN 1 ELSE 0 END)
                     + SUM(CASE WHEN realized_pnl < 0 THEN 1 ELSE 0 END)), 1)
         ELSE 0.0 END AS win_rate,
    ROUND(SUM(realized_pnl), 4) AS total_pnl,
    ROUND(SUM(realized_pnl) * 1.0 / COUNT(*), 4) AS avg_pnl_per_trade
FROM tagged
GROUP BY checkpoint_label, description, strategy_id, sub_strategy_id, entity_slug, era
ORDER BY checkpoint_label, strategy_id, sub_strategy_id, entity_slug,
         CASE era WHEN 'before' THEN 1 ELSE 2 END;

`;

export function applySchema(db: Database.Database): void {
  log.info('Applying v2 schema');

  // Execute all DDL statements
  db.exec(DDL);

  // Migration v1 → v2: add sub_strategy_id columns to existing tables
  // Safe to run repeatedly — ALTER TABLE ADD COLUMN fails silently if column exists
  const tablesToMigrate = ['orders', 'trades', 'positions', 'resolutions', 'signals'];
  for (const table of tablesToMigrate) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      const hasSubStrategy = cols.some(c => c.name === 'sub_strategy_id');
      if (!hasSubStrategy) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN sub_strategy_id TEXT`);
        log.info({ table }, 'Added sub_strategy_id column');
      }
    } catch (err) {
      log.warn({ table, err }, 'Migration check failed for table');
    }
  }

  // 2026-04-11: add uma_resolution_status column to markets table for the
  // UMA dispute watcher (Phase 1.2). Non-empty value (anything other than "")
  // means UMA oracle has taken some action on the market — "disputed",
  // "proposed", "resolved", etc. The watcher polls Gamma hourly and writes
  // the latest value; the dashboard reads it to show triage state and the
  // alerter fires on disputes. Nullable because legacy rows don't have it.
  try {
    const marketCols = db.prepare(`PRAGMA table_info(markets)`).all() as Array<{ name: string }>;
    if (!marketCols.some(c => c.name === 'uma_resolution_status')) {
      db.exec(`ALTER TABLE markets ADD COLUMN uma_resolution_status TEXT`);
      log.info('Added uma_resolution_status column to markets');
    }
  } catch (err) {
    log.warn({ err }, 'uma_resolution_status migration failed');
  }

  // 2026-04-11 Phase 2.5: add peak_pnl_pct column to positions for the
  // trailing profit lock. Tracks the highest unrealized PnL % the position
  // has ever reached, so we can trigger a profit-target exit when current
  // PnL drops below peak * trailing_retention_pct. Preserves the NO-LOSE
  // mantra (never exits at a loss) while capturing more on runners.
  try {
    const posCols = db.prepare(`PRAGMA table_info(positions)`).all() as Array<{ name: string }>;
    if (!posCols.some(c => c.name === 'peak_pnl_pct')) {
      db.exec(`ALTER TABLE positions ADD COLUMN peak_pnl_pct REAL DEFAULT 0`);
      log.info('Added peak_pnl_pct column to positions');
    }
  } catch (err) {
    log.warn({ err }, 'peak_pnl_pct migration failed');
  }

  // 2026-04-11 Phase 2 (Attention Router) + Phase 3 (Scout Overlay):
  // ensure market_priorities and scout_intel tables exist on DBs that were
  // created before these tables were in the DDL. The CREATE TABLE IF NOT
  // EXISTS statements above run on every startup and are idempotent, but
  // we explicitly verify the tables exist here to surface any migration
  // failure in the logs rather than silently continuing.
  try {
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('market_priorities','scout_intel','smart_money_candidates','whitelisted_whales','whale_trades')`).all() as Array<{ name: string }>;
    const names = new Set(tables.map(t => t.name));
    const required = ['market_priorities', 'scout_intel', 'smart_money_candidates', 'whitelisted_whales', 'whale_trades'];
    for (const r of required) {
      if (!names.has(r)) {
        log.warn({ table: r }, 'Required table missing after DDL apply — this should not happen');
      }
    }
  } catch (err) {
    log.warn({ err }, 'priority/intel/whale table verification failed');
  }

  // Force-recreate views on every startup so edits to the DDL take effect.
  // CREATE VIEW IF NOT EXISTS is a no-op when the view already exists, so any
  // change to the SQL below would silently not apply without this drop step.
  // 2026-04-10: added v_entity_pnl to the recreate set (W/L and win-rate fix).
  try {
    db.exec('DROP VIEW IF EXISTS v_strategy_performance');
    db.exec('DROP VIEW IF EXISTS v_strategy_checkpoints');
    const stratDdl = DDL.match(/CREATE VIEW IF NOT EXISTS v_strategy_performance[\s\S]*?ORDER BY COALESCE\(s\.total_trades, 0\) DESC;/);
    if (stratDdl) {
      db.exec(stratDdl[0]);
      log.info('v_strategy_performance view recreated');
    }
  } catch (err) {
    log.warn({ err }, 'v_strategy_performance recreation failed');
  }

  try {
    db.exec('DROP VIEW IF EXISTS v_entity_pnl');
    const entityDdl = DDL.match(/CREATE VIEW IF NOT EXISTS v_entity_pnl[\s\S]*?\) p ON e\.slug = p\.entity_slug;/);
    if (entityDdl) {
      db.exec(entityDdl[0]);
      log.info('v_entity_pnl view recreated');
    }
  } catch (err) {
    log.warn({ err }, 'v_entity_pnl recreation failed');
  }

  // 2026-04-15: v_strategy_rolling — rolling 24h/48h/72h/all_time per strategy
  // and per sub-strategy. Added after the dead-zone memo kill verdict showed
  // all-time averages hide the fact that longshot had already self-corrected.
  // See docs/longshot-0.83-dead-zone-2026-04-15.md for the full context.
  try {
    db.exec('DROP VIEW IF EXISTS v_strategy_rolling');
    const rollingDdl = DDL.match(/CREATE VIEW IF NOT EXISTS v_strategy_rolling[\s\S]*?WHEN 'all_time' THEN 4 END;/);
    if (rollingDdl) {
      db.exec(rollingDdl[0]);
      log.info('v_strategy_rolling view recreated');
    } else {
      log.warn('v_strategy_rolling DDL not found in schema source — view NOT created');
    }
  } catch (err) {
    log.warn({ err }, 'v_strategy_rolling recreation failed');
  }


  // 2026-04-20: v_strategy_checkpoints recreate on every startup so edits
  // to the CHECKPOINTS CTE in DDL take effect without a DB wipe.
  try {
    db.exec('DROP VIEW IF EXISTS v_strategy_checkpoints');
    const cpDdl = DDL.match(/CREATE VIEW IF NOT EXISTS v_strategy_checkpoints[\s\S]*?CASE era WHEN 'before' THEN 1 ELSE 2 END;/);
    if (cpDdl) {
      db.exec(cpDdl[0]);
      log.info('v_strategy_checkpoints view recreated');
    } else {
      log.warn('v_strategy_checkpoints DDL regex did not match');
    }
  } catch (err) {
    log.warn({ err }, 'v_strategy_checkpoints recreation failed');
  }

  // Record schema version
  const existing = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
  if (!existing || existing.version < SCHEMA_VERSION) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    log.info({ version: SCHEMA_VERSION }, 'Schema version recorded');
  }

  log.info('Schema applied successfully');
}
