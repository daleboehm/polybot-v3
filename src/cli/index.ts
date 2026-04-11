#!/usr/bin/env node
// Polybot V3 CLI — management interface

import { Command } from 'commander';
import { loadConfig } from '../config/loader.js';
import { Engine } from '../core/engine.js';
import { DashboardServer } from '../dashboard/sse-server.js';
import { registerShutdownHandlers } from '../core/lifecycle.js';
import { initDatabase, closeDatabase } from '../storage/database.js';
import { applySchema } from '../storage/schema.js';
import { getAllEntities, getEntityPnlView } from '../storage/repositories/entity-repo.js';
import { getMarketCount } from '../storage/repositories/market-repo.js';
import { getTradeCount } from '../storage/repositories/trade-repo.js';
import { getStrategyPerformance } from '../storage/repositories/resolution-repo.js';
import { logger } from '../core/logger.js';

const program = new Command();

program
  .name('polybot')
  .description('Polybot V2 Trading Engine CLI')
  .version('2.0.0');

// ─── START ──────────────────────────────────────────────────
program
  .command('start')
  .description('Start the trading engine')
  .action(async () => {
    const config = loadConfig();
    const engine = new Engine(config);
    registerShutdownHandlers(engine);

    await engine.start();

    // Start dashboard
    const dashboard = new DashboardServer(config.dashboard, engine);
    dashboard.start();

    logger.info(`Engine running. Dashboard at http://localhost:${config.dashboard.port}`);
  });

// ─── STATUS ─────────────────────────────────────────────────
program
  .command('status')
  .description('Show engine and entity status')
  .action(() => {
    const config = loadConfig();
    initDatabase(config.database.path);
    applySchema(initDatabase(config.database.path));

    const entities = getEntityPnlView();
    const markets = getMarketCount();
    const trades = getTradeCount();

    console.log('\n=== Polybot V2 Status ===\n');
    console.log(`Database: ${config.database.path}`);
    console.log(`Markets: ${markets.active} active / ${markets.total} total`);
    console.log(`Trades: ${trades}`);
    console.log(`\n--- Entities (${entities.length}) ---\n`);

    for (const e of entities) {
      const winRate = (e.total_wins + e.total_losses) > 0
        ? ((e.total_wins / (e.total_wins + e.total_losses)) * 100).toFixed(1)
        : '-';
      console.log(
        `  ${e.slug.padEnd(25)} ${e.mode.padEnd(6)} ${e.status.padEnd(8)} ` +
        `Cash: $${e.current_cash.toFixed(2).padStart(8)} ` +
        `P&L: $${e.total_realized_pnl.toFixed(2).padStart(8)} ` +
        `WR: ${winRate.padStart(5)}% ` +
        `Trades: ${String(e.total_trades).padStart(5)} ` +
        `Open: ${String(e.open_positions).padStart(3)}`,
      );
    }

    console.log('');
    closeDatabase();
  });

// ─── ENTITY ─────────────────────────────────────────────────
const entityCmd = program.command('entity').description('Entity management');

entityCmd
  .command('list')
  .description('List all entities')
  .action(() => {
    const config = loadConfig();
    initDatabase(config.database.path);
    applySchema(initDatabase(config.database.path));

    const entities = getAllEntities();
    console.log('\n--- Entities ---\n');
    for (const e of entities) {
      console.log(`  ${e.slug.padEnd(25)} port:${e.port} mode:${e.mode} status:${e.status} wallet:${e.wallet_address ? 'yes' : 'no'}`);
    }
    console.log('');
    closeDatabase();
  });

entityCmd
  .command('activate <slug>')
  .description('Activate an entity')
  .action((slug) => {
    const config = loadConfig();
    const db = initDatabase(config.database.path);
    applySchema(db);
    db.prepare("UPDATE entities SET status = 'active', updated_at = datetime('now') WHERE slug = ?").run(slug);
    console.log(`Entity ${slug} activated`);
    closeDatabase();
  });

entityCmd
  .command('pause <slug>')
  .description('Pause an entity')
  .action((slug) => {
    const config = loadConfig();
    const db = initDatabase(config.database.path);
    applySchema(db);
    db.prepare("UPDATE entities SET status = 'paused', updated_at = datetime('now') WHERE slug = ?").run(slug);
    console.log(`Entity ${slug} paused`);
    closeDatabase();
  });

// ─── PAPER ──────────────────────────────────────────────────
program
  .command('paper')
  .description('Toggle paper/live mode for an entity')
  .requiredOption('--entity <slug>', 'Entity slug')
  .requiredOption('--mode <mode>', 'paper or live')
  .option('--confirm', 'Required for live mode')
  .action((opts) => {
    if (opts.mode === 'live' && !opts.confirm) {
      console.error('ERROR: Live mode requires --confirm flag. This is a safety measure.');
      console.error('Usage: polybot paper --entity <slug> --mode live --confirm');
      process.exit(1);
    }

    const config = loadConfig();
    const db = initDatabase(config.database.path);
    applySchema(db);
    db.prepare("UPDATE entities SET mode = ?, updated_at = datetime('now') WHERE slug = ?").run(opts.mode, opts.entity);
    console.log(`Entity ${opts.entity} mode set to ${opts.mode}`);
    closeDatabase();
  });

// ─── MIGRATE ────────────────────────────────────────────────
// 2026-04-10: stripped v1 import flags. v1 is dead per Dale's directive, and the
// v1-import helper module has been deleted. This command now only initializes
// a fresh v3 schema on a new database.
program
  .command('migrate')
  .description('Initialize fresh schema on a v3 database')
  .action(async () => {
    const config = loadConfig();
    const db = initDatabase(config.database.path);
    applySchema(db);
    console.log('Schema initialized');
    closeDatabase();
  });

// ─── BACKFILL-MARKETS ───────────────────────────────────────
// 2026-04-10: long-tail market metadata backfill. Walks open positions, finds
// the ones whose markets row is missing end_date or sits outside the sampling
// horizon, re-queries Gamma, and UPSERTs truth back into the DB. Intended to
// run hourly via systemd timer — complements sampling-poller, doesn't replace it.
program
  .command('backfill-markets')
  .description('Run long-tail market metadata backfill for open positions')
  .option('--horizon-days <n>', 'Sampling horizon in days', '60')
  .option('--dry-run', 'Log planned writes without touching the DB', false)
  .option('--condition-id <id>', 'Restrict to a single condition_id (debugging)')
  .action(async (opts) => {
    const config = loadConfig();
    const db = initDatabase(config.database.path);
    applySchema(db);

    const { runLongTailBackfill } = await import('../market/long-tail-backfill.js');
    const result = await runLongTailBackfill({
      horizonDays: Number(opts.horizonDays),
      dryRun: Boolean(opts.dryRun),
      onlyConditionId: opts.conditionId,
    });

    console.log('\n=== Long-Tail Backfill Result ===');
    console.log(`Examined:            ${result.examined}`);
    console.log(`Inside horizon:      ${result.skipped_inside_horizon}`);
    console.log(`Already closed:      ${result.skipped_already_closed}`);
    console.log(`Needed backfill:     ${result.needed_backfill}`);
    console.log(`Updated:             ${result.updated}`);
    console.log(`Inserted new:        ${result.inserted_new}`);
    console.log(`Marked closed:       ${result.marked_closed}`);
    console.log(`Errors:              ${result.errors.length}`);
    if (result.errors.length > 0) {
      for (const e of result.errors) {
        console.log(`  ${e.conditionId}: ${e.error}`);
      }
    }
    console.log('');

    closeDatabase();
    process.exit(result.errors.length > 0 ? 1 : 0);
  });

// ─── UMA-WATCH ──────────────────────────────────────────────
// 2026-04-11: Phase 1.2 — UMA dispute watcher. Polls Gamma for every open
// position's condition_id, records umaResolutionStatus, alerts on new
// disputes via Telegram. Policy: hold and wait (NO-LOSE), never auto-exit.
program
  .command('uma-watch')
  .description('Check UMA resolution status for every open position and alert on disputes')
  .option('--dry-run', 'Log planned writes/alerts without touching DB or Telegram', false)
  .action(async (opts) => {
    const config = loadConfig();
    const db = initDatabase(config.database.path);
    applySchema(db);

    const { runUmaDisputeWatcher } = await import('../market/uma-dispute-watcher.js');
    const { TelegramAlerter } = await import('../metrics/alerter.js');
    const alerter = new TelegramAlerter();
    alerter.start();

    const result = await runUmaDisputeWatcher({
      dryRun: Boolean(opts.dryRun),
      alerter: opts.dryRun ? undefined : alerter,
    });

    console.log('\n=== UMA Dispute Watcher Result ===');
    console.log(`Examined:                ${result.examined}`);
    console.log(`Updated (status changed):${result.updated}`);
    console.log(`New disputes alerted:    ${result.new_disputes}`);
    console.log(`Already-flagged:         ${result.already_flagged}`);
    console.log(`Resolved since last:     ${result.resolved_since_last_check}`);
    console.log(`Errors:                  ${result.errors.length}`);
    if (result.disputes.length > 0) {
      console.log('\nNew disputes:');
      for (const d of result.disputes) {
        console.log(`  ${d.conditionId.substring(0, 18)} — "${d.question.substring(0, 60)}"`);
        console.log(`    ${d.oldStatus || '(empty)'} → ${d.newStatus}`);
      }
    }
    if (result.errors.length > 0) {
      console.log('\nErrors:');
      for (const e of result.errors) {
        console.log(`  ${e.conditionId.substring(0, 18)}: ${e.error}`);
      }
    }
    console.log('');

    alerter.stop();
    closeDatabase();
    process.exit(result.errors.length > 0 ? 1 : 0);
  });

// ─── REPORT ─────────────────────────────────────────────────
program
  .command('report')
  .description('Generate P&L and strategy reports')
  .action(() => {
    const config = loadConfig();
    initDatabase(config.database.path);
    applySchema(initDatabase(config.database.path));

    console.log('\n=== Strategy Performance ===\n');
    const perf = getStrategyPerformance();
    for (const p of perf) {
      console.log(
        `  ${(p.strategy_id ?? 'unknown').padEnd(20)} ` +
        `${p.entity_slug.padEnd(15)} ` +
        `W:${String(p.wins).padStart(4)} L:${String(p.losses).padStart(4)} ` +
        `WR:${p.win_rate.toFixed(1).padStart(5)}% ` +
        `P&L:$${p.total_pnl.toFixed(2).padStart(8)} ` +
        `Avg:$${p.avg_pnl_per_trade.toFixed(2).padStart(6)}`,
      );
    }
    console.log('');
    closeDatabase();
  });

program.parse();
