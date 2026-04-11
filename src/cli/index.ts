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

// ─── KALSHI-ARB-SCAN ────────────────────────────────────────
// Phase 2.4 (2026-04-11): read-only arb scanner. Walks active Poly markets,
// fetches Kalshi equivalents, logs opportunities to kalshi_arb_opportunities.
// NEVER executes trades — Dale's directive is manual review first.
program
  .command('kalshi-arb-scan')
  .description('Scan for Polymarket-Kalshi price divergence opportunities (read-only)')
  .option('--dry-run', 'Log opportunities without writing to DB', false)
  .option('--min-divergence <pct>', 'Minimum divergence %', '0.03')
  .option('--min-volume <usd>', 'Minimum 24h volume (Poly side); 0 = disabled since CLOB does not populate volume', '0')
  .action(async (opts) => {
    const config = loadConfig();
    const db = initDatabase(config.database.path);
    applySchema(db);

    const { runKalshiArbScanner } = await import('../market/kalshi-arb-scanner.js');
    const result = await runKalshiArbScanner({
      dryRun: Boolean(opts.dryRun),
      minDivergencePct: Number(opts.minDivergence),
      minVolumeUsd: Number(opts.minVolume),
    });

    console.log('\n=== Kalshi Arb Scanner Result ===');
    console.log(`Poly markets considered:  ${result.poly_markets_considered}`);
    console.log(`Kalshi markets fetched:   ${result.kalshi_markets_fetched}`);
    console.log(`Matches found:            ${result.matches_found}`);
    console.log(`Arb opportunities:        ${result.arb_opportunities}`);
    console.log(`Errors:                   ${result.errors.length}`);
    if (result.opportunities.length > 0) {
      console.log('\nOpportunities:');
      for (const o of result.opportunities) {
        console.log(`  ${o.divergence_pct.toFixed(3)} | ${o.direction}`);
        console.log(`    Poly:   $${o.poly_yes_price.toFixed(3)} | ${o.poly_question.substring(0, 70)}`);
        console.log(`    Kalshi: $${o.kalshi_yes_price.toFixed(3)} | ${o.kalshi_title.substring(0, 70)}`);
      }
    }
    console.log('');

    closeDatabase();
    process.exit(result.errors.length > 0 ? 1 : 0);
  });

// ─── REDEEM-ALL ─────────────────────────────────────────────
// Phase -1 fix (2026-04-11): prod had 33 redeemable positions on-chain
// worth ~$48.96 sitting in the CTF contract, never flowed back to the
// wallet. The per-cycle engine reconciler doesn't call redeemPositions()
// (intentionally deferred in R1 per the original design). This command
// walks the Data API's full position list, filters `redeemable: true`,
// groups by conditionId + outcome, and calls NegRiskRedeemer.redeem()
// for each unique condition_id.
//
// Usage:
//   polybot redeem-all --entity polybot [--limit N] [--dry-run]
//
// Default behavior: dry-run OFF, no limit. Use --dry-run to see what
// would be redeemed without submitting any tx.
program
  .command('redeem-all')
  .description('Call redeemPositions() for every redeemable position on an entity wallet')
  .requiredOption('--entity <slug>', 'Entity slug (e.g. polybot)')
  .option('--limit <n>', 'Redeem at most N positions then stop', '0')
  .option('--dry-run', 'Log planned redemptions without submitting any tx', false)
  .action(async (opts) => {
    const config = loadConfig();
    const db = initDatabase(config.database.path);
    applySchema(db);

    // Find the entity config + load its wallet credentials.
    const entityCfg = config.entities.find(e => e.slug === opts.entity);
    if (!entityCfg) {
      console.error(`Entity ${opts.entity} not found in config`);
      process.exit(1);
    }
    const { loadWalletCredentials } = await import('../entity/wallet-loader.js');
    const creds = loadWalletCredentials(entityCfg.entity_path);
    if (!creds || !creds.private_key) {
      console.error(`No wallet credentials for ${opts.entity}`);
      process.exit(1);
    }
    const proxyOrEoa = creds.proxy_address || creds.account_address;
    if (!proxyOrEoa) {
      console.error(`Entity ${opts.entity} has no proxy_address or account_address`);
      process.exit(1);
    }

    // Fetch every position on-chain via the full /positions endpoint.
    const { DataApiClient } = await import('../market/data-api-client.js');
    const dataApi = new DataApiClient(config.api.data_api_base_url);
    let allPositions;
    try {
      allPositions = await dataApi.getAllPositions(proxyOrEoa);
    } catch (err) {
      console.error(`Data API fetch failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }

    const redeemable = allPositions.filter(p => p.redeemable === true);
    console.log(`\n=== Redeem All ===`);
    console.log(`Wallet:         ${proxyOrEoa}`);
    console.log(`Total positions: ${allPositions.length}`);
    console.log(`Redeemable:      ${redeemable.length}`);
    console.log(`Dry run:         ${opts.dryRun ? 'YES' : 'NO'}`);
    const limit = Number(opts.limit) || 0;
    if (limit > 0) console.log(`Limit:           ${limit}`);
    console.log();

    if (redeemable.length === 0) {
      console.log('Nothing to redeem.');
      closeDatabase();
      process.exit(0);
    }

    // Group by conditionId. For a binary market, a single conditionId
    // corresponds to both YES and NO tokens; we call redeemPositions once
    // per conditionId with amounts sized by which outcome we hold.
    //
    // For negative-risk markets (most Polymarket weather/sports), we
    // hold at most one outcome per conditionId, so amounts = [size] with
    // positional indexing provided by the adapter itself. The existing
    // NegRiskRedeemer.redeem() takes (conditionId, amounts[]) where
    // amounts is a flat array. For neg-risk markets with one holding,
    // we pass [sizeInTokens].
    //
    // Tokens are 6-decimal like USDC so sizeInTokens = floor(size * 1e6).
    const byCondition = new Map<string, { title: string; totalSize: number; totalValue: number; cashPnl: number }>();
    for (const p of redeemable) {
      const existing = byCondition.get(p.conditionId);
      const size = Number(p.size) || 0;
      const value = Number(p.currentValue) || 0;
      const pnl = Number(p.cashPnl) || 0;
      if (existing) {
        existing.totalSize += size;
        existing.totalValue += value;
        existing.cashPnl += pnl;
      } else {
        byCondition.set(p.conditionId, {
          title: p.title || '?',
          totalSize: size,
          totalValue: value,
          cashPnl: pnl,
        });
      }
    }
    console.log(`Unique condition IDs: ${byCondition.size}`);
    console.log();

    // Construct the redeemer
    const { NegRiskRedeemer } = await import('../execution/neg-risk-redeemer.js');
    const privateKeyHex = creds.private_key.startsWith('0x')
      ? creds.private_key as `0x${string}`
      : `0x${creds.private_key}` as `0x${string}`;
    const redeemer = new NegRiskRedeemer(privateKeyHex);

    // Verify CTF approval once before looping (faster than hitting the
    // same error 33 times). isAdapterApproved() uses the EOA from the
    // private key, which is the correct subject for prod's direct-EOA
    // wallet (wallet_address == EOA, no separate proxy).
    if (!opts.dryRun) {
      try {
        const approved = await redeemer.isAdapterApproved();
        if (!approved) {
          console.error(`Wallet has NOT granted CTF approval to NegRiskAdapter.`);
          console.error(`All redeemPositions calls will revert. Submit setApprovalForAll first.`);
          process.exit(1);
        }
        console.log(`CTF approval verified.`);
        console.log();
      } catch (err) {
        console.warn(`Approval check failed (will try anyway): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Walk the unique conditions and redeem each
    let successes = 0;
    let failures = 0;
    let totalClaimedMicro = 0n;
    let i = 0;
    for (const [conditionId, agg] of byCondition.entries()) {
      i++;
      if (limit > 0 && i > limit) {
        console.log(`Reached limit ${limit}, stopping.`);
        break;
      }

      // Build the amounts array. For a neg-risk market (the common case),
      // we hold a single outcome, and the redemption call takes the
      // total token quantity for the outcome we hold. We express size
      // as a 6-decimal integer (1e6 per token).
      const amountMicro = BigInt(Math.floor(agg.totalSize * 1_000_000));
      const amounts = [amountMicro];

      console.log(`[${i}/${byCondition.size}] ${conditionId.substring(0, 20)}...`);
      console.log(`    title:     ${agg.title.substring(0, 70)}`);
      console.log(`    size:      ${agg.totalSize}`);
      console.log(`    value:     $${agg.totalValue.toFixed(4)}`);
      console.log(`    cashPnl:   $${agg.cashPnl.toFixed(4)}`);

      if (opts.dryRun) {
        console.log(`    DRY RUN — not submitting tx`);
        console.log();
        continue;
      }

      try {
        const result = await redeemer.redeem(conditionId as `0x${string}`, amounts);
        if (result.success) {
          successes++;
          totalClaimedMicro += result.usdcClaimed;
          console.log(`    OK tx=${result.txHash}`);
          console.log(`    claimed=${(Number(result.usdcClaimed) / 1e6).toFixed(4)} USDC`);
        } else {
          failures++;
          console.log(`    FAIL: ${result.error}`);
        }
      } catch (err) {
        failures++;
        console.log(`    THREW: ${err instanceof Error ? err.message : String(err)}`);
      }
      console.log();
    }

    console.log(`=== Summary ===`);
    console.log(`Successes:      ${successes}`);
    console.log(`Failures:       ${failures}`);
    console.log(`USDC claimed:   $${(Number(totalClaimedMicro) / 1e6).toFixed(4)}`);
    console.log();

    closeDatabase();
    process.exit(failures > 0 ? 1 : 0);
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
