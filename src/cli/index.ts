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

// ─── SMART-MONEY-FILTER ─────────────────────────────────────
// Phase C1b (2026-04-11): nightly job that walks smart_money_candidates
// rows with status='candidate', fetches each wallet's resolved-position
// history from the Data API, computes the Bravado Trade 4-threshold
// filter, and promotes survivors to whitelisted_whales.
//
// Bravado thresholds (from 6-agent research synthesis, Agent 3):
//   1. >=200 settled markets         (sample size floor)
//   2. >=65% win rate                (real edge, not noise)
//   3. varied position sizing        (uniform max = wash/leaderboard farming)
//   4. cross-category (>=3 categories)  (single-topic = news-driven, not edge)
//
// Usage:
//   polybot smart-money-filter [--dry-run] [--max-age-days 14]
//
// NOT wired to a systemd timer by default. Operator runs manually or
// adds a cron entry. See docs/todo.md WHALE ACTIVATION PLAYBOOK.
program
  .command('smart-money-filter')
  .description('Run the Bravado 4-threshold filter on smart_money_candidates and promote survivors')
  .option('--dry-run', 'Evaluate without updating any DB rows', false)
  .option('--max-age-days <n>', 'Skip candidates with last_filter_run_at newer than N days', '1')
  .action(async (opts) => {
    const config = loadConfig();
    const db = initDatabase(config.database.path);
    applySchema(db);

    const { DataApiClient } = await import('../market/data-api-client.js');
    const {
      listUnfiltered,
      listAllCandidates,
      recordFilterResult,
      promoteWhale,
    } = await import('../storage/repositories/smart-money-repo.js');

    const dataApi = new DataApiClient(config.api.data_api_base_url);

    // Gather the set we'll evaluate. 'candidate' status = never evaluated.
    // Also re-evaluate 'failed' rows if they're older than max-age-days,
    // because the wallet may have gained more data since the last run.
    const maxAgeMs = Number(opts.maxAgeDays) * 24 * 60 * 60 * 1000;
    const now = Date.now();
    const all = listAllCandidates();
    const targets = all.filter(c => {
      if (c.status === 'candidate') return true;
      if (c.status === 'failed' && c.last_filter_run_at !== null && now - c.last_filter_run_at > maxAgeMs) return true;
      if (c.status === 'passed') return false; // already promoted
      if (c.status === 'expired') return false;
      return false;
    });

    console.log(`\n=== Smart Money Filter ===`);
    console.log(`Total candidates:  ${all.length}`);
    console.log(`To evaluate:       ${targets.length}`);
    console.log(`Dry run:           ${opts.dryRun ? 'YES' : 'NO'}`);
    console.log();

    if (targets.length === 0) {
      console.log('Nothing to filter.');
      closeDatabase();
      process.exit(0);
    }

    let passed = 0;
    let failed = 0;
    let errored = 0;

    for (let i = 0; i < targets.length; i++) {
      const cand = targets[i]!;
      console.log(`[${i + 1}/${targets.length}] ${cand.proxy_wallet.substring(0, 14)} ${cand.pseudonym ?? ''}`);

      let resolvedPositions;
      try {
        // Use the resolved-positions endpoint. This is documented as
        // broken (returns active rows) but the fallback is to filter
        // the full list ourselves for cashPnl != 0 which marks settled.
        const allPos = await dataApi.getAllPositions(cand.proxy_wallet);
        // A position with cashPnl != 0 has settled — either won or lost.
        // An active position with positive unrealized value has cashPnl=0.
        resolvedPositions = allPos.filter(p => {
          const pnl = Number(p.cashPnl);
          return Number.isFinite(pnl) && pnl !== 0;
        });
      } catch (err) {
        console.log(`    ERROR fetching positions: ${err instanceof Error ? err.message : String(err)}`);
        errored++;
        continue;
      }

      const settled_markets = resolvedPositions.length;
      const wins = resolvedPositions.filter(p => Number(p.cashPnl) > 0).length;
      const win_rate = settled_markets > 0 ? wins / settled_markets : 0;

      // Category count: group by eventSlug prefix (first word of slug)
      const categories = new Set<string>();
      for (const p of resolvedPositions) {
        const slug = p.slug ?? '';
        const firstWord = slug.split('-')[0] ?? 'unknown';
        categories.add(firstWord);
      }
      const category_count = categories.size;

      // Uniform sizing check: compute stddev of initialValue across
      // positions. If stddev / mean < 0.1, the wallet bets uniform sizes
      // (leaderboard farming). We flag that as a fail signal.
      let uniform_sizing = false;
      if (resolvedPositions.length >= 10) {
        const values = resolvedPositions.map(p => Number(p.initialValue) || 0).filter(v => v > 0);
        if (values.length >= 10) {
          const mean = values.reduce((s, v) => s + v, 0) / values.length;
          const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
          const stddev = Math.sqrt(variance);
          const coefVar = mean > 0 ? stddev / mean : 0;
          uniform_sizing = coefVar < 0.1;
        }
      }

      // Apply the 4 Bravado thresholds
      const pass_n = settled_markets >= 200;
      const pass_wr = win_rate >= 0.65;
      const pass_varied = !uniform_sizing;
      const pass_category = category_count >= 3;
      const passed_all = pass_n && pass_wr && pass_varied && pass_category;

      console.log(
        `    n=${settled_markets} ` +
          `wr=${(win_rate * 100).toFixed(1)}% ` +
          `cats=${category_count} ` +
          `uniform=${uniform_sizing} ` +
          `→ ${passed_all ? 'PASS' : 'FAIL'}`,
      );
      console.log(
        `    gates: n>=200=${pass_n}  wr>=65%=${pass_wr}  varied=${pass_varied}  cats>=3=${pass_category}`,
      );

      if (!opts.dryRun) {
        try {
          recordFilterResult(
            cand.proxy_wallet,
            {
              settled_markets,
              win_rate,
              category_count,
              uniform_sizing,
            },
            passed_all,
          );
          if (passed_all) {
            promoteWhale({
              proxy_wallet: cand.proxy_wallet,
              pseudonym: cand.pseudonym,
              promoted_by: 'smart-money-filter',
              reason: `auto-promoted: n=${settled_markets} wr=${(win_rate * 100).toFixed(1)}% cats=${category_count}`,
            });
          }
        } catch (err) {
          console.log(`    DB update failed: ${err instanceof Error ? err.message : String(err)}`);
          errored++;
          continue;
        }
      }

      if (passed_all) passed++;
      else failed++;

      console.log();
    }

    console.log(`=== Summary ===`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    console.log(`Errors: ${errored}`);
    console.log();

    closeDatabase();
    process.exit(errored > 0 ? 1 : 0);
  });

// ─── WHALE-SEED ─────────────────────────────────────────────
// Manual whitelist seed. Used to bootstrap the whale-copy strategy
// before the smart-money-filter has enough candidate data to promote
// survivors automatically.
//
// Usage:
//   polybot whale-seed --wallet 0x1f2dd6d473f3e824cd2f8a89d9c69fb96f6ad0cf --name Fredi9999 --reason "2024-election-research"
//   polybot whale-seed --wallet 0x... --copy-multiplier 0.5
program
  .command('whale-seed')
  .description('Manually add a wallet to whitelisted_whales (bootstrap before filter has data)')
  .requiredOption('--wallet <address>', '0x-prefixed proxy wallet address')
  .option('--name <pseudonym>', 'Display name for dashboards')
  .option('--reason <reason>', 'Why this wallet is whitelisted', 'manual seed')
  .option('--copy-multiplier <n>', 'Size multiplier applied to copied trades (0-2.0)', '1.0')
  .action(async (opts) => {
    const config = loadConfig();
    const db = initDatabase(config.database.path);
    applySchema(db);

    const { promoteWhale, seedCandidateSkeleton, getWhale } = await import('../storage/repositories/smart-money-repo.js');

    const wallet = opts.wallet.toLowerCase();
    if (!wallet.startsWith('0x') || wallet.length !== 42) {
      console.error(`Invalid wallet address: ${opts.wallet}`);
      process.exit(1);
    }
    const multiplier = Number(opts.copyMultiplier);
    if (!Number.isFinite(multiplier) || multiplier < 0 || multiplier > 2) {
      console.error(`copy-multiplier must be a number in [0, 2.0]`);
      process.exit(1);
    }

    // Ensure a candidate skeleton exists so the FK from whitelisted_whales
    // has a target.
    seedCandidateSkeleton(wallet, opts.name ?? null);
    promoteWhale({
      proxy_wallet: wallet,
      pseudonym: opts.name ?? null,
      promoted_by: 'manual',
      reason: opts.reason,
      copy_multiplier: multiplier,
    });

    const whale = getWhale(wallet);
    console.log(`\n=== Whale seeded ===`);
    console.log(`Wallet:     ${whale?.proxy_wallet}`);
    console.log(`Pseudonym:  ${whale?.pseudonym ?? '-'}`);
    console.log(`Reason:     ${whale?.reason}`);
    console.log(`Multiplier: ${whale?.copy_multiplier}`);
    console.log(`Active:     ${whale?.active === 1}`);
    console.log();

    closeDatabase();
    process.exit(0);
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
    // NegRiskAdapter only handles negRisk markets. Non-negRisk positions
    // use a different contract path (CTF Exchange) with a different signature.
    // For now we redeem negRisk positions through NegRiskRedeemer and skip
    // the rest with a clear log line so the operator knows to handle them
    // separately.
    const negRiskRedeemable = redeemable.filter(p => p.negativeRisk === true);
    const otherRedeemable = redeemable.filter(p => p.negativeRisk !== true);
    console.log(`\n=== Redeem All ===`);
    console.log(`Wallet:            ${proxyOrEoa}`);
    console.log(`Total positions:   ${allPositions.length}`);
    console.log(`Redeemable:        ${redeemable.length}`);
    console.log(`  negRisk:         ${negRiskRedeemable.length} (NegRiskAdapter.redeemPositions)`);
    console.log(`  non-negRisk:     ${otherRedeemable.length} (CTF.redeemPositions — burns entire balance)`);
    console.log(`Dry run:           ${opts.dryRun ? 'YES' : 'NO'}`);
    const limit = Number(opts.limit) || 0;
    if (limit > 0) console.log(`Limit:             ${limit}`);
    console.log();

    if (redeemable.length === 0) {
      console.log('Nothing to redeem.');
      closeDatabase();
      process.exit(0);
    }

    // Group by conditionId. NegRiskAdapter.redeemPositions() convention
    // per Polymarket's own contract source:
    //
    //   _amounts should always have length 2, with the first element
    //   being the amount of YES tokens to redeem and the second element
    //   being the amount of NO tokens to redeem.
    //
    // We use outcomeIndex (0 or 1) from the Data API rather than the
    // outcome name string, because non-standard outcome strings can
    // appear on some markets. For negRisk markets (the only ones this
    // command handles), outcomeIndex is reliably 0 for YES-side and 1
    // for NO-side.
    //
    // Tokens are 6-decimal USDC-denominated: sizeMicro = floor(size * 1e6)
    const byCondition = new Map<string, {
      title: string;
      yesSize: number;
      noSize: number;
      totalValue: number;
      cashPnl: number;
    }>();
    for (const p of negRiskRedeemable) {
      const existing = byCondition.get(p.conditionId) ?? {
        title: p.title || '?',
        yesSize: 0,
        noSize: 0,
        totalValue: 0,
        cashPnl: 0,
      };
      const size = Number(p.size) || 0;
      const value = Number(p.currentValue) || 0;
      const pnl = Number(p.cashPnl) || 0;
      const idx = Number(p.outcomeIndex);
      if (idx === 0) {
        existing.yesSize += size;
      } else if (idx === 1) {
        existing.noSize += size;
      } else {
        console.log(`    WARN: unexpected outcomeIndex=${p.outcomeIndex} outcome=${p.outcome} for ${p.conditionId.substring(0, 14)} — skipping`);
        continue;
      }
      existing.totalValue += value;
      existing.cashPnl += pnl;
      byCondition.set(p.conditionId, existing);
    }
    console.log(`Unique condition IDs (negRisk): ${byCondition.size}`);
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

      // Build the amounts array per the NegRiskAdapter convention:
      // [yesAmount, noAmount] with 6-decimal precision.
      const yesMicro = BigInt(Math.floor(agg.yesSize * 1_000_000));
      const noMicro = BigInt(Math.floor(agg.noSize * 1_000_000));
      const amounts = [yesMicro, noMicro];

      console.log(`[${i}/${byCondition.size}] ${conditionId.substring(0, 20)}...`);
      console.log(`    title:     ${agg.title.substring(0, 70)}`);
      console.log(`    yes/no:    ${agg.yesSize} / ${agg.noSize}`);
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

    console.log(`=== NegRisk Summary ===`);
    console.log(`Successes:      ${successes}`);
    console.log(`Failures:       ${failures}`);
    console.log(`USDC claimed:   $${(Number(totalClaimedMicro) / 1e6).toFixed(4)}`);
    console.log();

    // ─── Non-negRisk redemption via CTF.redeemPositions ───
    // These positions use the standard CTF contract directly. The call
    // burns ALL held tokens for the conditionId — no amounts array.
    // Much simpler than negRisk but uses a different contract function.
    if (otherRedeemable.length > 0) {
      console.log(`\n=== Non-NegRisk Redemption (CTF Exchange) ===`);
      const ctfByCondition = new Map<string, { title: string; totalValue: number; cashPnl: number }>();
      for (const p of otherRedeemable) {
        const existing = ctfByCondition.get(p.conditionId) ?? { title: p.title || '?', totalValue: 0, cashPnl: 0 };
        existing.totalValue += Number(p.currentValue) || 0;
        existing.cashPnl += Number(p.cashPnl) || 0;
        ctfByCondition.set(p.conditionId, existing);
      }
      console.log(`Unique conditions: ${ctfByCondition.size}`);
      console.log();

      let ctfSuccesses = 0;
      let ctfFailures = 0;
      let ctfClaimedMicro = 0n;
      let ctfIdx = 0;
      for (const [conditionId, agg] of ctfByCondition.entries()) {
        ctfIdx++;
        if (limit > 0 && (i + ctfIdx) > limit) {
          console.log(`Reached limit ${limit}, stopping.`);
          break;
        }
        console.log(`[CTF ${ctfIdx}/${ctfByCondition.size}] ${conditionId.substring(0, 20)}...`);
        console.log(`    title:     ${agg.title.substring(0, 70)}`);
        console.log(`    value:     $${agg.totalValue.toFixed(4)}`);
        console.log(`    cashPnl:   $${agg.cashPnl.toFixed(4)}`);

        if (opts.dryRun) {
          console.log(`    DRY RUN — not submitting tx`);
          console.log();
          continue;
        }

        try {
          const result = await redeemer.redeemCtf(conditionId as `0x${string}`);
          if (result.success) {
            ctfSuccesses++;
            ctfClaimedMicro += result.usdcClaimed;
            console.log(`    OK tx=${result.txHash}`);
            console.log(`    claimed=${(Number(result.usdcClaimed) / 1e6).toFixed(4)} USDC`);
          } else {
            ctfFailures++;
            console.log(`    FAIL: ${result.error}`);
          }
        } catch (err) {
          ctfFailures++;
          console.log(`    THREW: ${err instanceof Error ? err.message : String(err)}`);
        }
        console.log();
      }

      console.log(`=== CTF Summary ===`);
      console.log(`Successes:      ${ctfSuccesses}`);
      console.log(`Failures:       ${ctfFailures}`);
      console.log(`USDC claimed:   $${(Number(ctfClaimedMicro) / 1e6).toFixed(4)}`);
      console.log();

      successes += ctfSuccesses;
      failures += ctfFailures;
      totalClaimedMicro += ctfClaimedMicro;
    }

    console.log(`=== TOTAL ===`);
    console.log(`Successes:      ${successes}`);
    console.log(`Failures:       ${failures}`);
    console.log(`USDC claimed:   $${(Number(totalClaimedMicro) / 1e6).toFixed(4)}`);
    console.log();

    closeDatabase();
    process.exit(failures > 0 ? 1 : 0);
  });

// ─── SELL-POSITION ──────────────────────────────────────────
// Emergency/manual sell of a specific open position at market price.
// Used to exit dead-weight positions (e.g., long-dated political markets)
// that the engine won't exit on its own because they haven't hit any
// exit trigger (stop-loss, profit-target, trailing-lock).
//
// Usage:
//   polybot sell-position --entity polybot --condition 0xc8c5760c2649...
//   polybot sell-position --entity polybot --all-untagged  (sells all positions with no strategy_id)
//   polybot sell-position --entity polybot --all-open      (sells EVERY open position regardless of tag)
//
// IMPORTANT (2026-04-15): this command goes directly to the CLOB client
// (`client.createOrder` + `client.postOrder`) and does NOT route through
// `clob-router.routeOrder()`. That means it BYPASSES the kill switch. This
// is intentional — operators need an exit hatch when prod is halted and we
// want to liquidate the live book without flipping the halt. If you want
// kill-switch-gated sells, use the normal strategy exit path instead.
program
  .command('sell-position')
  .description('Sell a specific open position at market price (or all untagged / all open positions)')
  .requiredOption('--entity <slug>', 'Entity slug')
  .option('--condition <id>', 'Condition ID to sell')
  .option('--all-untagged', 'Sell all positions with no strategy_id (legacy orphans)', false)
  .option('--all-open', 'Sell EVERY open position on this entity (prod exit hatch — bypasses kill switch)', false)
  .option('--dry-run', 'Show what would be sold without submitting', false)
  .action(async (opts) => {
    const config = loadConfig();
    const db = initDatabase(config.database.path);
    applySchema(db);

    const entityCfg = config.entities.find(e => e.slug === opts.entity);
    if (!entityCfg) {
      console.error(`Entity ${opts.entity} not found`);
      process.exit(1);
    }
    const { loadWalletCredentials } = await import('../entity/wallet-loader.js');
    const creds = loadWalletCredentials(entityCfg.entity_path);
    if (!creds || !creds.private_key || !creds.api_key) {
      console.error(`No wallet credentials for ${opts.entity}`);
      process.exit(1);
    }

    // Find positions to sell
    type PosRow = { condition_id: string; token_id: string; side: string; size: number; avg_entry_price: number; cost_basis: number; market_question: string; strategy_id: string | null };
    let positions: PosRow[];
    if (opts.allOpen) {
      positions = db.prepare(
        `SELECT condition_id, token_id, side, size, avg_entry_price, cost_basis, market_question, strategy_id
         FROM positions WHERE entity_slug = ? AND status = 'open'`,
      ).all(opts.entity) as PosRow[];
    } else if (opts.allUntagged) {
      positions = db.prepare(
        `SELECT condition_id, token_id, side, size, avg_entry_price, cost_basis, market_question, strategy_id
         FROM positions WHERE entity_slug = ? AND status = 'open' AND (strategy_id IS NULL OR strategy_id = '')`,
      ).all(opts.entity) as PosRow[];
    } else if (opts.condition) {
      positions = db.prepare(
        `SELECT condition_id, token_id, side, size, avg_entry_price, cost_basis, market_question, strategy_id
         FROM positions WHERE entity_slug = ? AND status = 'open' AND condition_id LIKE ?`,
      ).all(opts.entity, opts.condition + '%') as PosRow[];
    } else {
      console.error('Must specify --condition <id>, --all-untagged, or --all-open');
      process.exit(1);
    }

    console.log(`\n=== Sell Positions ===`);
    console.log(`Entity:     ${opts.entity}`);
    console.log(`Positions:  ${positions.length}`);
    console.log(`Dry run:    ${opts.dryRun ? 'YES' : 'NO'}`);
    console.log();

    if (positions.length === 0) {
      console.log('No matching positions found.');
      closeDatabase();
      process.exit(0);
    }

    for (const p of positions) {
      console.log(`  ${p.condition_id.substring(0, 14)} | ${p.side} | ${p.size} shares @ $${p.avg_entry_price.toFixed(3)} | cost=$${p.cost_basis.toFixed(2)} | ${(p.market_question || '').substring(0, 50)}`);
    }
    console.log();

    if (opts.dryRun) {
      console.log('DRY RUN — not submitting any sells.');
      closeDatabase();
      process.exit(0);
    }

    // 2026-04-21 V2-aware. V2 = named-options constructor; V1 = positional.
    // Post-cutover prod + R&D run on v2. Pre-cutover, v1. Controlled by config.
    const useV2 = config.api.exchange_version === 'v2';
    const mod = useV2
      ? await import('@polymarket/clob-client-v2')
      : await import('@polymarket/clob-client');
    const { ClobClient } = mod;
    const { createWalletClient, http } = await import('viem');
    const { polygon } = await import('viem/chains');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { getPrimaryRpc } = await import('../market/rpc-config.js');
    const privateKeyHex = creds.private_key.startsWith('0x')
      ? creds.private_key as `0x${string}`
      : `0x${creds.private_key}` as `0x${string}`;
    const account = privateKeyToAccount(privateKeyHex);
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(getPrimaryRpc()),
    });
    const creds_ = { key: creds.api_key, secret: creds.api_secret, passphrase: creds.api_passphrase };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client: any = useV2
      ? new (ClobClient as any)({ host: config.api.clob_base_url, chain: 137, signer: walletClient, creds: creds_ })
      : new (ClobClient as any)(config.api.clob_base_url, 137, walletClient, creds_);

    let sold = 0;
    let failed = 0;
    for (const p of positions) {
      console.log(`Selling ${p.condition_id.substring(0, 14)}...`);
      try {
        // Create a market sell order — sell at the current best bid
        // by using a limit order priced at 0.01 (floor price, guarantees
        // it crosses the book immediately like a market order)
        const userOrder = {
          tokenID: p.token_id,
          price: 0.01, // effectively market sell — matches any bid
          size: p.size,
          side: mod.Side.SELL,
        };
        const signedOrder = await client.createOrder(userOrder);
        const response = await client.postOrder(signedOrder);
        console.log(`  OK: ${JSON.stringify(response).substring(0, 200)}`);
        sold++;
      } catch (err) {
        console.log(`  FAIL: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Sold:    ${sold}`);
    console.log(`Failed:  ${failed}`);
    console.log();

    closeDatabase();
    process.exit(failed > 0 ? 1 : 0);
  });

// ─── WHALE-CONSENSUS ────────────────────────────────────────
// Scan current positions of all whitelisted whales, find markets where
// N+ whales hold the same side, and optionally generate entry signals
// that flow through the normal risk/execution pipeline.
//
// Usage:
//   polybot whale-consensus --entity polybot --min-whales 3 --dry-run
//   polybot whale-consensus --entity polybot --min-whales 4 --execute
program
  .command('whale-consensus')
  .description('Find markets where multiple whales hold the same side and optionally enter them')
  .requiredOption('--entity <slug>', 'Entity slug to trade on')
  .option('--min-whales <n>', 'Minimum whales on same side to consider (default: 3)', '3')
  .option('--min-wr <n>', 'Minimum avg WR of agreeing whales (default: 0.75)', '0.75')
  .option('--max-entries <n>', 'Max new positions to open (default: 5)', '5')
  .option('--size-usd <n>', 'USD size per position (default: 5)', '5')
  .option('--execute', 'Actually place orders (default: dry-run)', false)
  .option('--dry-run', 'Show consensus without placing orders (default)', false)
  .action(async (opts) => {
    const config = loadConfig();
    const db = initDatabase(config.database.path);
    applySchema(db);

    const entityCfg = config.entities.find(e => e.slug === opts.entity);
    if (!entityCfg) {
      console.error(`Entity ${opts.entity} not found`);
      process.exit(1);
    }

    const minWhales = Number(opts.minWhales) || 3;
    const minWr = Number(opts.minWr) || 0.75;
    const maxEntries = Number(opts.maxEntries) || 5;
    const sizeUsd = Number(opts.sizeUsd) || 5;
    const execute = opts.execute === true;

    // Load whales and their stats
    const { listActiveWhales } = await import('../storage/repositories/smart-money-repo.js');
    const whales = listActiveWhales();
    if (whales.length === 0) {
      console.log('No active whales in whitelist.');
      process.exit(0);
    }

    // Get whale stats from candidates table
    type CandidateRow = { proxy_wallet: string; win_rate: number; all_time_pnl_usd: number };
    const candidateStats = new Map<string, CandidateRow>();
    const candidates = db.prepare(
      'SELECT proxy_wallet, win_rate, all_time_pnl_usd FROM smart_money_candidates'
    ).all() as CandidateRow[];
    for (const c of candidates) {
      candidateStats.set(c.proxy_wallet, c);
    }

    console.log(`\n=== Whale Consensus Scanner ===`);
    console.log(`Whales:      ${whales.length}`);
    console.log(`Min whales:  ${minWhales}`);
    console.log(`Min avg WR:  ${(minWr * 100).toFixed(0)}%`);
    console.log(`Max entries: ${maxEntries}`);
    console.log(`Size/pos:    $${sizeUsd}`);
    console.log(`Mode:        ${execute ? 'EXECUTE' : 'DRY RUN'}`);
    console.log();

    // Fetch positions for each whale from Data API
    const { DataApiClient } = await import('../market/data-api-client.js');
    const dataApi = new DataApiClient(config.api.data_api_base_url);

    interface WhalePos {
      wallet: string;
      pseudonym: string | null;
      wr: number;
      pnl: number;
      multiplier: number;
      side: string;
      size: number;
      avgPrice: number;
    }

    const marketMap = new Map<string, {
      question: string;
      slug: string;
      positions: WhalePos[];
    }>();

    let errors = 0;
    for (let i = 0; i < whales.length; i++) {
      const w = whales[i]!;
      const label = (w.pseudonym || w.proxy_wallet.substring(0, 14)).substring(0, 20);
      const stats = candidateStats.get(w.proxy_wallet);
      try {
        const allPos = await dataApi.getAllPositions(w.proxy_wallet);
        const active = allPos.filter(p => Math.abs(Number(p.size) || 0) > 0.1);
        console.log(`  [${i + 1}/${whales.length}] ${label.padEnd(20)} ${active.length} positions`);

        for (const p of active) {
          const cond = p.conditionId || '';
          if (!cond) continue;
          const size = Number(p.size) || 0;
          const avg = Number(p.avgPrice) || 0;
          const outcome = (p.outcome || 'Yes').toString().toUpperCase();
          const side = outcome === 'NO' ? 'NO' : 'YES';

          if (!marketMap.has(cond)) {
            marketMap.set(cond, {
              question: (p.title || '').substring(0, 80),
              slug: (p.slug || '').substring(0, 60),
              positions: [],
            });
          }
          marketMap.get(cond)!.positions.push({
            wallet: w.proxy_wallet,
            pseudonym: w.pseudonym,
            wr: stats?.win_rate ?? 0,
            pnl: stats?.all_time_pnl_usd ?? 0,
            multiplier: w.copy_multiplier,
            side,
            size,
            avgPrice: avg,
          });
        }

        // Rate limit
        await new Promise(r => setTimeout(r, 300));
      } catch (err) {
        errors++;
        if (errors < 5) console.log(`  ERROR: ${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Find consensus markets
    interface ConsensusMarket {
      conditionId: string;
      question: string;
      side: 'YES' | 'NO';
      whaleCount: number;
      avgWr: number;
      totalSizeUsd: number;
      avgMultiplier: number;
      whales: WhalePos[];
    }

    const consensusMarkets: ConsensusMarket[] = [];

    for (const [condId, market] of marketMap.entries()) {
      const yesWhales = market.positions.filter(p => p.side === 'YES');
      const noWhales = market.positions.filter(p => p.side === 'NO');

      // Check YES side consensus
      if (yesWhales.length >= minWhales) {
        const avgWr = yesWhales.reduce((s, w) => s + w.wr, 0) / yesWhales.length;
        if (avgWr >= minWr) {
          consensusMarkets.push({
            conditionId: condId,
            question: market.question,
            side: 'YES',
            whaleCount: yesWhales.length,
            avgWr,
            totalSizeUsd: yesWhales.reduce((s, w) => s + w.size * w.avgPrice, 0),
            avgMultiplier: yesWhales.reduce((s, w) => s + w.multiplier, 0) / yesWhales.length,
            whales: yesWhales,
          });
        }
      }

      // Check NO side consensus
      if (noWhales.length >= minWhales) {
        const avgWr = noWhales.reduce((s, w) => s + w.wr, 0) / noWhales.length;
        if (avgWr >= minWr) {
          consensusMarkets.push({
            conditionId: condId,
            question: market.question,
            side: 'NO',
            whaleCount: noWhales.length,
            avgWr,
            totalSizeUsd: noWhales.reduce((s, w) => s + w.size * w.avgPrice, 0),
            avgMultiplier: noWhales.reduce((s, w) => s + w.multiplier, 0) / noWhales.length,
            whales: noWhales,
          });
        }
      }
    }

    // Sort by whale count desc, then by avg WR desc
    consensusMarkets.sort((a, b) => b.whaleCount - a.whaleCount || b.avgWr - a.avgWr);

    // Check which markets we already hold
    type OpenPos = { condition_id: string };
    const existingPositions = new Set(
      (db.prepare(
        'SELECT condition_id FROM positions WHERE entity_slug = ? AND status = ?'
      ).all(opts.entity, 'open') as OpenPos[]).map(p => p.condition_id)
    );

    console.log(`\n${'='.repeat(100)}`);
    console.log(`WHALE CONSENSUS — ${consensusMarkets.length} markets with ${minWhales}+ whales (avg WR >= ${(minWr * 100).toFixed(0)}%)`);
    console.log(`${'='.repeat(100)}`);

    const actionable: ConsensusMarket[] = [];

    for (let i = 0; i < consensusMarkets.length; i++) {
      const m = consensusMarkets[i]!;
      const held = existingPositions.has(m.conditionId);
      const tag = held ? ' [ALREADY HELD]' : '';
      console.log(`\n${(i + 1).toString().padStart(3)}. ${m.side} | ${m.whaleCount} whales | avgWR=${(m.avgWr * 100).toFixed(0)}% | $${m.totalSizeUsd.toFixed(0)} exposure${tag}`);
      console.log(`     ${m.question}`);
      for (const w of m.whales) {
        const nm = (w.pseudonym || w.wallet.substring(0, 14)).substring(0, 16);
        console.log(`       ${nm.padEnd(16)} ${w.side.padEnd(3)} ${w.size.toFixed(0).padStart(8)}sh @${w.avgPrice.toFixed(2)} WR=${(w.wr * 100).toFixed(0)}% mult=${w.multiplier}`);
      }

      if (!held && actionable.length < maxEntries) {
        actionable.push(m);
      }
    }

    console.log(`\n${'='.repeat(100)}`);
    console.log(`ACTIONABLE: ${actionable.length} new positions (not already held)`);
    console.log(`${'='.repeat(100)}`);

    if (actionable.length === 0) {
      console.log('No new consensus positions to enter.');
      closeDatabase();
      process.exit(0);
    }

    for (const m of actionable) {
      console.log(`  ${m.side} | ${m.whaleCount} whales | ${m.question.substring(0, 60)}`);
    }

    if (!execute) {
      console.log(`\nDRY RUN — not placing orders. Use --execute to trade.`);
      closeDatabase();
      process.exit(0);
    }

    // Execute: place orders via CLOB client
    console.log(`\nPlacing ${actionable.length} orders...`);

    const { loadWalletCredentials } = await import('../entity/wallet-loader.js');
    const creds = loadWalletCredentials(entityCfg.entity_path);
    if (!creds || !creds.private_key || !creds.api_key) {
      console.error(`No wallet credentials for ${opts.entity}`);
      process.exit(1);
    }

    // 2026-04-21 V2-aware (second CLI instantiation)
    const useV2_r = config.api.exchange_version === 'v2';
    const mod = useV2_r
      ? await import('@polymarket/clob-client-v2')
      : await import('@polymarket/clob-client');
    const { ClobClient } = mod;
    const { createWalletClient: cwc, http: httpTransport } = await import('viem');
    const { polygon: poly } = await import('viem/chains');
    const { privateKeyToAccount: pka } = await import('viem/accounts');
    const { getPrimaryRpc } = await import('../market/rpc-config.js');

    const pkHex = creds.private_key.startsWith('0x')
      ? creds.private_key as `0x${string}`
      : `0x${creds.private_key}` as `0x${string}`;
    const acc = pka(pkHex);
    const wc = cwc({ account: acc, chain: poly, transport: httpTransport(getPrimaryRpc()) });
    const creds_r = { key: creds.api_key, secret: creds.api_secret, passphrase: creds.api_passphrase };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clobClient: any = useV2_r
      ? new (ClobClient as any)({ host: config.api.clob_base_url, chain: 137, signer: wc, creds: creds_r })
      : new (ClobClient as any)(config.api.clob_base_url, 137, wc, creds_r);

    let placed = 0;
    let failed = 0;

    for (const m of actionable) {
      try {
        // Look up market in our cache to get token_id
        type MktRow = { token_yes_id: string; token_no_id: string; yes_price: number; no_price: number };
        const mkt = db.prepare(
          'SELECT token_yes_id, token_no_id, yes_price, no_price FROM markets WHERE condition_id = ?'
        ).get(m.conditionId) as MktRow | undefined;

        if (!mkt) {
          console.log(`  SKIP ${m.conditionId.substring(0, 14)}: not in market cache`);
          failed++;
          continue;
        }

        const tokenId = m.side === 'YES' ? mkt.token_yes_id : mkt.token_no_id;
        const price = m.side === 'YES' ? mkt.yes_price : mkt.no_price;

        if (!tokenId || !price || price <= 0 || price >= 1) {
          console.log(`  SKIP ${m.conditionId.substring(0, 14)}: invalid price ${price}`);
          failed++;
          continue;
        }

        const sizeShares = Math.max(5, Math.round(sizeUsd / price));

        const userOrder = {
          tokenID: tokenId,
          price: Math.round(price * 100) / 100, // round to tick
          size: sizeShares,
          side: mod.Side.BUY,
        };

        console.log(`  BUY ${m.side} ${sizeShares}sh @${price.toFixed(2)} | ${m.question.substring(0, 50)}`);
        const signedOrder = await clobClient.createOrder(userOrder);
        const response = await clobClient.postOrder(signedOrder);
        console.log(`    OK: ${JSON.stringify(response).substring(0, 150)}`);
        placed++;
      } catch (err) {
        console.log(`    FAIL: ${err instanceof Error ? err.message : String(err)}`);
        failed++;
      }
    }

    console.log(`\n=== Consensus Entry Summary ===`);
    console.log(`Placed:  ${placed}`);
    console.log(`Failed:  ${failed}`);
    console.log();

    closeDatabase();
    process.exit(failed > 0 ? 1 : 0);
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

// ─── wrap-usdc (2026-04-21 V2 cutover prep) ───────────────────────
// One-off wrap USDC.e -> pUSD via verified Polymarket CollateralOnramp.
// Verified 2026-04-21: contract at 0x93070a847efEf7F70739046A929D47a521F5B8ee
// has WRAPPER_ROLE on pUSD + exposes wrap(address,address,uint256).
program
  .command('wrap-usdc')
  .description('Wrap USDC.e -> pUSD via Polymarket V2 CollateralOnramp')
  .requiredOption('--entity <slug>', 'Entity slug (e.g. polybot)')
  .requiredOption('--amount <usd>', 'USD amount to wrap (e.g. 373.62)')
  .option('--dry-run', 'Show tx data without submitting', false)
  .action(async (opts: { entity: string; amount: string; dryRun?: boolean }) => {
    const ONRAMP = '0x93070a847efEf7F70739046A929D47a521F5B8ee' as `0x${string}`;
    const USDCE = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
    const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' as `0x${string}`;

    const config = loadConfig();
    const entityCfg = config.entities.find(e => e.slug === opts.entity);
    if (!entityCfg) { console.error(`Entity ${opts.entity} not found in config`); process.exit(1); }

    const { loadWalletCredentials } = await import('../entity/wallet-loader.js');
    const creds = loadWalletCredentials(entityCfg.entity_path);
    if (!creds || !creds.private_key) { console.error(`no wallet credentials for ${opts.entity}`); process.exit(1); }

    const { createWalletClient, createPublicClient, http, parseAbi, parseUnits, formatUnits } = await import('viem');
    const { polygon } = await import('viem/chains');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { getPrimaryRpc } = await import('../market/rpc-config.js');

    const pkHex = creds.private_key.startsWith('0x')
      ? creds.private_key as `0x${string}`
      : `0x${creds.private_key}` as `0x${string}`;
    const account = privateKeyToAccount(pkHex);
    const transport = http(getPrimaryRpc());
    const walletClient = createWalletClient({ account, chain: polygon, transport });
    const publicClient = createPublicClient({ chain: polygon, transport });

    const amount = parseUnits(opts.amount, 6);
    const erc20Abi = parseAbi([
      'function balanceOf(address) view returns (uint256)',
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)',
    ]);
    const onrampAbi = parseAbi(['function wrap(address _asset, address _to, uint256 _amount)']);

    const usdceBalance = await publicClient.readContract({ address: USDCE, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    const pusdBalance = await publicClient.readContract({ address: PUSD, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    const allowance = await publicClient.readContract({ address: USDCE, abi: erc20Abi, functionName: 'allowance', args: [account.address, ONRAMP] });

    console.log('=== wrap-usdc preflight ===');
    console.log(`wallet:        ${account.address}`);
    console.log(`USDC.e bal:    ${formatUnits(usdceBalance as bigint, 6)}`);
    console.log(`pUSD bal:      ${formatUnits(pusdBalance as bigint, 6)}`);
    console.log(`ONRAMP allow:  ${formatUnits(allowance as bigint, 6)}`);
    console.log(`wrap amount:   ${opts.amount} (${amount.toString()} raw units)`);

    if ((usdceBalance as bigint) < amount) {
      console.error(`ERROR: insufficient USDC.e (have ${formatUnits(usdceBalance as bigint, 6)}, need ${opts.amount})`);
      process.exit(1);
    }

    const needsApprove = (allowance as bigint) < amount;
    console.log(`needs approve: ${needsApprove}`);

    if (opts.dryRun) {
      console.log('');
      console.log('=== DRY RUN — no transactions submitted ===');
      if (needsApprove) console.log(`  tx1: USDCE.approve(${ONRAMP}, ${amount.toString()})`);
      console.log(`  tx${needsApprove ? '2' : '1'}: ONRAMP.wrap(${USDCE}, ${account.address}, ${amount.toString()})`);
      console.log('');
      console.log('Re-run without --dry-run to execute.');
      return;
    }

    if (needsApprove) {
      console.log('\n=== Step 1: approve USDC.e spend ===');
      const hash1 = await walletClient.writeContract({ address: USDCE, abi: erc20Abi, functionName: 'approve', args: [ONRAMP, amount] });
      console.log(`approve tx: ${hash1}`);
      const rcpt1 = await publicClient.waitForTransactionReceipt({ hash: hash1 });
      console.log(`approve status: ${rcpt1.status}, block: ${rcpt1.blockNumber}`);
      if (rcpt1.status !== 'success') { console.error('approve failed'); process.exit(1); }
    } else {
      console.log('\n=== Step 1: approve skipped (allowance already sufficient) ===');
    }

    console.log('\n=== Step 2: wrap USDC.e -> pUSD ===');
    const hash2 = await walletClient.writeContract({ address: ONRAMP, abi: onrampAbi, functionName: 'wrap', args: [USDCE, account.address, amount] });
    console.log(`wrap tx: ${hash2}`);
    const rcpt2 = await publicClient.waitForTransactionReceipt({ hash: hash2 });
    console.log(`wrap status: ${rcpt2.status}, block: ${rcpt2.blockNumber}`);

    const usdceAfter = await publicClient.readContract({ address: USDCE, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    const pusdAfter = await publicClient.readContract({ address: PUSD, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    console.log('\n=== post-wrap balances ===');
    console.log(`USDC.e: ${formatUnits(usdceAfter as bigint, 6)}`);
    console.log(`pUSD:   ${formatUnits(pusdAfter as bigint, 6)}`);
    console.log('');
    console.log(rcpt2.status === 'success' ? 'WRAP SUCCESSFUL' : 'WRAP FAILED');
  });

// ─── v2-activate (2026-04-21 post-cutover setup) ──────────────────
// Orchestrates the V2 activation approvals for a wallet:
//   1. Verify pUSD balance > 0 (else run wrap-usdc first)
//   2. setApprovalForAll(CTF_Exchange_V2, true) on Conditional Tokens
//   3. setApprovalForAll(NegRisk_Exchange_V2, true) on Conditional Tokens
// Without these setApprovalForAll grants, V2 orders will be rejected when
// the exchange tries to move position tokens during matching.
// Verified contract addresses per docs.polymarket.com/resources/contract-addresses.
program
  .command('v2-activate')
  .description('Set V2 approvals on a wallet (setApprovalForAll for CTF V2 + NegRisk V2)')
  .requiredOption('--entity <slug>', 'Entity slug (e.g. polybot)')
  .option('--dry-run', 'Show tx data without submitting', false)
  .action(async (opts: { entity: string; dryRun?: boolean }) => {
    const CTF_V2 = '0xE111180000d2663C0091e4f400237545B87B996B' as `0x${string}`;
    const NEG_RISK_V2 = '0xe2222d279d744050d28e00520010520000310F59' as `0x${string}`;
    const CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
    const PUSD = '0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB' as `0x${string}`;

    const config = loadConfig();
    const entityCfg = config.entities.find(e => e.slug === opts.entity);
    if (!entityCfg) { console.error(`Entity \${opts.entity} not found`); process.exit(1); }

    const { loadWalletCredentials } = await import('../entity/wallet-loader.js');
    const creds = loadWalletCredentials(entityCfg.entity_path);
    if (!creds || !creds.private_key) { console.error(`no wallet credentials for \${opts.entity}`); process.exit(1); }

    const { createWalletClient, createPublicClient, http, parseAbi, formatUnits } = await import('viem');
    const { polygon } = await import('viem/chains');
    const { privateKeyToAccount } = await import('viem/accounts');
    const { getPrimaryRpc } = await import('../market/rpc-config.js');

    const pkHex = creds.private_key.startsWith('0x')
      ? creds.private_key as `0x${string}`
      : `0x${creds.private_key}` as `0x${string}`;
    const account = privateKeyToAccount(pkHex);
    const transport = http(getPrimaryRpc());
    const walletClient = createWalletClient({ account, chain: polygon, transport });
    const publicClient = createPublicClient({ chain: polygon, transport });

    const erc20Abi = parseAbi(['function balanceOf(address) view returns (uint256)']);
    const ctfAbi = parseAbi([
      'function isApprovedForAll(address owner, address operator) view returns (bool)',
      'function setApprovalForAll(address operator, bool approved)',
    ]);

    // Preflight: pUSD balance
    const pusd = await publicClient.readContract({ address: PUSD, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
    const ctfV2Approved = await publicClient.readContract({ address: CONDITIONAL_TOKENS, abi: ctfAbi, functionName: 'isApprovedForAll', args: [account.address, CTF_V2] });
    const negRiskV2Approved = await publicClient.readContract({ address: CONDITIONAL_TOKENS, abi: ctfAbi, functionName: 'isApprovedForAll', args: [account.address, NEG_RISK_V2] });

    console.log('=== v2-activate preflight ===');
    console.log(`wallet:                        \${account.address}`);
    console.log(`pUSD balance:                  \${formatUnits(pusd as bigint, 6)}`);
    console.log(`CTF V2 approved?               \${ctfV2Approved}`);
    console.log(`NegRisk V2 approved?           \${negRiskV2Approved}`);

    if ((pusd as bigint) === 0n) {
      console.error('\nERROR: pUSD balance is zero. Run `polybot wrap-usdc --entity \${opts.entity} --amount <usd>` first.');
      process.exit(1);
    }

    const needsCtfV2 = !ctfV2Approved;
    const needsNegRiskV2 = !negRiskV2Approved;
    const txCount = (needsCtfV2 ? 1 : 0) + (needsNegRiskV2 ? 1 : 0);

    if (txCount === 0) {
      console.log('\nAll V2 approvals already in place. Wallet is ready for V2 trading.');
      return;
    }

    if (opts.dryRun) {
      console.log('\n=== DRY RUN — no transactions submitted ===');
      if (needsCtfV2) console.log(`  tx: CONDITIONAL_TOKENS.setApprovalForAll(\${CTF_V2}, true)`);
      if (needsNegRiskV2) console.log(`  tx: CONDITIONAL_TOKENS.setApprovalForAll(\${NEG_RISK_V2}, true)`);
      console.log('\nRe-run without --dry-run to execute.');
      return;
    }

    // Execute
    if (needsCtfV2) {
      console.log('\n=== setApprovalForAll CTF V2 ===');
      const h = await walletClient.writeContract({ address: CONDITIONAL_TOKENS, abi: ctfAbi, functionName: 'setApprovalForAll', args: [CTF_V2, true] });
      console.log(`tx: \${h}`);
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      console.log(`status: \${r.status}, block: \${r.blockNumber}`);
      if (r.status !== 'success') { console.error('CTF V2 approval failed'); process.exit(1); }
    }
    if (needsNegRiskV2) {
      console.log('\n=== setApprovalForAll NegRisk V2 ===');
      const h = await walletClient.writeContract({ address: CONDITIONAL_TOKENS, abi: ctfAbi, functionName: 'setApprovalForAll', args: [NEG_RISK_V2, true] });
      console.log(`tx: \${h}`);
      const r = await publicClient.waitForTransactionReceipt({ hash: h });
      console.log(`status: \${r.status}, block: \${r.blockNumber}`);
      if (r.status !== 'success') { console.error('NegRisk V2 approval failed'); process.exit(1); }
    }

    console.log('\n=== V2 ACTIVATION COMPLETE ===');
    console.log('Wallet is ready for V2 order placement once config exchange_version=v2.');
  });

program.parse();
