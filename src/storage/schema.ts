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

  // Force-recreate views on every startup so edits to the DDL take effect.
  // CREATE VIEW IF NOT EXISTS is a no-op when the view already exists, so any
  // change to the SQL below would silently not apply without this drop step.
  // 2026-04-10: added v_entity_pnl to the recreate set (W/L and win-rate fix).
  try {
    db.exec('DROP VIEW IF EXISTS v_strategy_performance');
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

  // Record schema version
  const existing = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get() as { version: number } | undefined;
  if (!existing || existing.version < SCHEMA_VERSION) {
    db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(SCHEMA_VERSION);
    log.info({ version: SCHEMA_VERSION }, 'Schema version recorded');
  }

  log.info('Schema applied successfully');
}
