#!/usr/bin/env tsx
// V1 → V2 migration script
// Imports trades, resolutions, snapshots, and transfers from v1 portfolio.db

import Database from 'better-sqlite3';
import { initDatabase, getDatabase, closeDatabase, transaction } from '../database.js';
import { applySchema } from '../schema.js';
import { createChildLogger } from '../../core/logger.js';

const log = createChildLogger('v1-import');

// V1 uses "caspian" as entity slug; v2 uses "polybot" for the primary entity
const ENTITY_SLUG_MAP: Record<string, string> = {
  caspian: 'polybot',
};

function mapEntitySlug(v1Slug: string): string {
  return ENTITY_SLUG_MAP[v1Slug] ?? v1Slug;
}

interface V1Trade {
  entity_slug: string;
  proxy_wallet: string;
  timestamp: string;
  timestamp_utc: string;
  condition_id: string;
  tx_hash: string;
  trade_type: string;
  side: string;
  size: number;
  usdc_size: number;
  price: number;
  asset: string;
  outcome_index: number;
  title: string;
  slug: string;
  event_slug: string;
  outcome: string;
}

interface V1Resolution {
  entity_slug: string;
  proxy_wallet: string;
  timestamp: string;
  timestamp_utc: string;
  condition_id: string;
  tx_hash: string;
  title: string;
  outcome: string;
  payout_usdc: number;
  cost_basis_usdc: number;
  realized_pnl: number;
}

interface V1Snapshot {
  entity_slug: string;
  timestamp: string;
  timestamp_utc: string;
  total_equity: number;
  cash_balance: number;
  positions_value: number;
  num_positions: number;
  reserve_balance: number;
  trading_balance: number;
  open_orders_value: number;
  num_open_orders: number;
  deposit_basis: number;
  pnl_vs_deposit: number;
}

interface V1Transfer {
  from_entity: string;
  to_entity: string;
  amount_usdc: number;
  tx_hash: string;
  timestamp: string;
  timestamp_utc: string;
  transfer_type: string;
  notes: string;
}

export function importV1(v1DbPath: string, v2DbPath: string): void {
  log.info({ v1: v1DbPath, v2: v2DbPath }, 'Starting v1 import');

  // Open v1 database (read-only)
  const v1 = new Database(v1DbPath, { readonly: true });

  // Initialize v2 database
  const v2 = initDatabase(v2DbPath);
  applySchema(v2);

  // Step 0: Seed entities from config so FK constraints pass
  // Get unique entity_slugs from v1 trades and ensure they exist in v2
  const v1Slugs = v1.prepare('SELECT DISTINCT entity_slug FROM trades').all() as Array<{ entity_slug: string }>;
  const seedEntity = v2.prepare(`
    INSERT OR IGNORE INTO entities (slug, name, port, entity_path, mode, status, starting_capital)
    VALUES (?, ?, ?, ?, 'paper', 'active', 0)
  `);
  for (const row of v1Slugs) {
    const slug = mapEntitySlug(row.entity_slug);
    seedEntity.run(slug, slug, 0, `/opt/${slug}`);
    log.info({ v1_slug: row.entity_slug, v2_slug: slug }, 'Seeded entity for FK');
  }

  // Also seed all 16 configured entities
  const entityConfigs = [
    { slug: 'polybot', name: 'GC Caspian', port: 8080, path: '/opt/polybot' },
    { slug: 'armorstack', name: 'GC Armorstack', port: 8081, path: '/opt/armorstack' },
    { slug: 'lilac', name: 'GC Lilac Ventures', port: 8082, path: '/opt/lilac' },
    { slug: 'caspian-intl', name: 'GC Caspian International', port: 8083, path: '/opt/caspian-intl' },
    { slug: 'armorstack-tax', name: 'GC Armorstack Tax Reserve', port: 8084, path: '/opt/armorstack-tax' },
    { slug: 'armorstack-marketing', name: 'GC Armorstack Marketing', port: 8085, path: '/opt/armorstack-marketing' },
    { slug: 'armorstack-te', name: 'GC Armorstack T&E', port: 8086, path: '/opt/armorstack-te' },
    { slug: 'boehm-family', name: 'GC Boehm Family Trust', port: 8087, path: '/opt/boehm-family' },
    { slug: 'nolan-fund', name: 'GC Nolan Education Fund', port: 8088, path: '/opt/nolan-fund' },
    { slug: 'landon-fund', name: 'GC Landon Education Fund', port: 8089, path: '/opt/landon-fund' },
    { slug: 'artisan179', name: 'GC Artisan 179 LLC', port: 8090, path: '/opt/artisan179' },
    { slug: 'sage-holdings', name: 'GC Sage Holdings', port: 8091, path: '/opt/sage-holdings' },
    { slug: 'midwest-ai', name: 'GC Midwest AI Fund', port: 8092, path: '/opt/midwest-ai' },
    { slug: 'weather-alpha', name: 'GC Weather Alpha', port: 8093, path: '/opt/weather-alpha' },
    { slug: 'delta-neutral', name: 'GC Delta Neutral', port: 8094, path: '/opt/delta-neutral' },
    { slug: 'a-brown', name: 'GC A Brown', port: 8097, path: '/opt/a-brown' },
  ];
  const seedFull = v2.prepare(`
    INSERT OR IGNORE INTO entities (slug, name, port, entity_path, mode, status, starting_capital)
    VALUES (?, ?, ?, ?, 'paper', 'pending', 0)
  `);
  for (const e of entityConfigs) {
    seedFull.run(e.slug, e.name, e.port, e.path);
  }
  // Set polybot to active with starting capital
  v2.prepare("UPDATE entities SET status = 'active', starting_capital = 257.09 WHERE slug = 'polybot'").run();
  log.info({ count: entityConfigs.length }, 'All entities seeded');

  // Also seed placeholder markets for FK constraints on trades
  // We'll insert condition_ids as we encounter them
  const seedMarket = v2.prepare(`
    INSERT OR IGNORE INTO markets (condition_id, question, token_yes_id, token_no_id)
    VALUES (?, 'Imported from v1', '', '')
  `);

  // Import trades
  const trades = v1.prepare('SELECT * FROM trades ORDER BY timestamp ASC').all() as V1Trade[];
  log.info({ count: trades.length }, 'Importing trades');

  const insertTrade = v2.prepare(`
    INSERT OR IGNORE INTO trades (
      entity_slug, condition_id, token_id, tx_hash, side, size, price,
      usdc_size, fee_usdc, net_usdc, is_paper, outcome, market_question,
      market_slug, timestamp, timestamp_utc
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?, ?, ?)
  `);

  let tradeCount = 0;
  transaction(() => {
    for (const t of trades) {
      const side = t.side === 'BUY' || t.side === 'buy' ? 'BUY' : 'SELL';
      const outcome = t.outcome_index === 0 ? 'YES' : 'NO';
      const slug = mapEntitySlug(t.entity_slug);
      // Ensure market exists for FK
      if (t.condition_id) seedMarket.run(t.condition_id);
      insertTrade.run(
        slug, t.condition_id, t.asset, t.tx_hash, side,
        t.size, t.price, t.usdc_size, t.usdc_size, outcome,
        t.title, t.slug,
        parseInt(t.timestamp) || Math.floor(new Date(t.timestamp_utc).getTime() / 1000),
        t.timestamp_utc,
      );
      tradeCount++;
    }
  });
  log.info({ imported: tradeCount }, 'Trades imported');

  // Import resolutions
  const resolutions = v1.prepare('SELECT * FROM resolutions ORDER BY timestamp ASC').all() as V1Resolution[];
  log.info({ count: resolutions.length }, 'Importing resolutions');

  const insertResolution = v2.prepare(`
    INSERT INTO resolutions (
      entity_slug, condition_id, token_id, winning_outcome, position_side,
      size, payout_usdc, cost_basis_usdc, sell_proceeds_usdc, realized_pnl,
      is_paper, market_question, tx_hash, resolved_at
    ) VALUES (?, ?, '', ?, ?, 0, ?, ?, 0, ?, 0, ?, ?, ?)
  `);

  let resCount = 0;
  transaction(() => {
    for (const r of resolutions) {
      const winningOutcome = r.realized_pnl >= 0 ? 'YES' : 'NO';
      const rSlug = mapEntitySlug(r.entity_slug);
      if (r.condition_id) seedMarket.run(r.condition_id);
      insertResolution.run(
        rSlug, r.condition_id, winningOutcome, winningOutcome,
        r.payout_usdc, r.cost_basis_usdc, r.realized_pnl,
        r.title, r.tx_hash, r.timestamp_utc,
      );
      resCount++;
    }
  });
  log.info({ imported: resCount }, 'Resolutions imported');

  // Import snapshots
  try {
    const snapshots = v1.prepare('SELECT * FROM snapshots ORDER BY timestamp ASC').all() as V1Snapshot[];
    log.info({ count: snapshots.length }, 'Importing snapshots');

    const insertSnapshot = v2.prepare(`
      INSERT INTO snapshots (
        entity_slug, timestamp, timestamp_utc, total_equity, cash_balance,
        reserve_balance, trading_balance, positions_value, num_positions,
        open_orders_value, num_open_orders, daily_pnl, deposit_basis, pnl_vs_deposit
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);

    let snapCount = 0;
    transaction(() => {
      for (const s of snapshots) {
        insertSnapshot.run(
          mapEntitySlug(s.entity_slug),
          parseInt(s.timestamp) || Math.floor(new Date(s.timestamp_utc).getTime() / 1000),
          s.timestamp_utc, s.total_equity, s.cash_balance,
          s.reserve_balance ?? 0, s.trading_balance ?? 0,
          s.positions_value, s.num_positions,
          s.open_orders_value ?? 0, s.num_open_orders ?? 0,
          s.deposit_basis ?? 0, s.pnl_vs_deposit ?? 0,
        );
        snapCount++;
      }
    });
    log.info({ imported: snapCount }, 'Snapshots imported');
  } catch (err) {
    log.warn({ err }, 'Snapshots table not found in v1, skipping');
  }

  // Import transfers
  try {
    const transfers = v1.prepare('SELECT * FROM transfers ORDER BY timestamp ASC').all() as V1Transfer[];
    log.info({ count: transfers.length }, 'Importing transfers');

    const insertTransfer = v2.prepare(`
      INSERT INTO transfers (
        from_entity, to_entity, amount_usdc, tx_hash, timestamp, timestamp_utc, transfer_type, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let txCount = 0;
    transaction(() => {
      for (const t of transfers) {
        insertTransfer.run(
          t.from_entity, t.to_entity, t.amount_usdc, t.tx_hash,
          parseInt(t.timestamp) || Math.floor(new Date(t.timestamp_utc).getTime() / 1000),
          t.timestamp_utc, t.transfer_type, t.notes,
        );
        txCount++;
      }
    });
    log.info({ imported: txCount }, 'Transfers imported');
  } catch (err) {
    log.warn({ err }, 'Transfers table not found in v1, skipping');
  }

  // Verification
  const v2Trades = v2.prepare('SELECT COUNT(*) as cnt FROM trades').get() as { cnt: number };
  const v2Resolutions = v2.prepare('SELECT COUNT(*) as cnt FROM resolutions').get() as { cnt: number };
  log.info({
    v2_trades: v2Trades.cnt,
    v2_resolutions: v2Resolutions.cnt,
    v1_trades: trades.length,
    v1_resolutions: resolutions.length,
  }, 'Migration verification');

  v1.close();
  closeDatabase();
  log.info('V1 import complete');
}

// CLI execution
if (process.argv[1]?.endsWith('v1-import.ts') || process.argv[1]?.endsWith('v1-import.js')) {
  const v1Path = process.argv[2] ?? '/opt/polybot/db/portfolio.db';
  const v2Path = process.argv[3] ?? './data/polybot.db';
  importV1(v1Path, v2Path);
}
