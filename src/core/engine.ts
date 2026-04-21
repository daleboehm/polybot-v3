// Main engine orchestrator — the heart of polybot-v3

import type { AppConfig, Signal, StrategyDecision, OrderFill } from '../types/index.js';
import { initDatabase, closeDatabase } from '../storage/database.js';
import { applySchema } from '../storage/schema.js';
import { EntityManager } from '../entity/entity-manager.js';
import { SamplingPoller } from '../market/sampling-poller.js';
import { MarketCache } from '../market/market-cache.js';
import { OrderbookWebSocket } from '../market/orderbook-ws.js';
import { RiskEngine } from '../risk/risk-engine.js';
import { DailyLossGuard } from '../risk/daily-loss-guard.js';
import { StopLossMonitor } from '../risk/stop-loss-monitor.js';
import { StrategyAdvisor } from '../risk/strategy-advisor.js';
import { ClobRouter } from '../execution/clob-router.js';
import { PaperSimulator } from '../execution/paper-simulator.js';
import { NegRiskRedeemer } from '../execution/neg-risk-redeemer.js';
import { DataApiClient } from '../market/data-api-client.js';
import { OnChainReconciler } from '../market/on-chain-reconciler.js';
import { PortfolioRiskTracker } from '../risk/portfolio-risk.js';
import { RegimeDetector } from '../market/regime-detector.js';
import { TelegramAlerter } from '../metrics/alerter.js';
import { PriorityScanner } from './priority-scanner.js';
import { ScoutCoordinator } from '../scouts/scout-coordinator.js';
import { metricsRegistry } from '../metrics/metrics.js';
import type { Hex } from 'viem';
import { buildOrder } from '../execution/order-builder.js';
import { StrategyRegistry } from '../strategy/strategy-registry.js';
import { createStrategyContext } from '../strategy/strategy-context.js';
import { FavoritesStrategy } from '../strategy/custom/favorites.js';
import { WeatherForecastStrategy } from '../strategy/custom/weather-forecast.js';
import { CryptoPriceStrategy } from '../strategy/custom/crypto-price.js';
import { LongshotStrategy } from '../strategy/custom/longshot.js';
import { ConvergenceStrategy } from '../strategy/custom/convergence.js';
import { SportsbookFadeStrategy } from '../strategy/custom/sportsbook-fade.js';
import { CrossMarketDivergenceStrategy } from '../strategy/custom/cross-market-divergence.js';
import { MacroForecastStrategy } from '../strategy/custom/macro-forecast.js';
import { WhaleCopyStrategy } from '../strategy/custom/whale-copy.js';
import { startRtds, stopRtds } from '../market/polymarket-rtds.js';
import { WhaleFadeStrategy } from '../strategy/custom/whale-fade.js';
import { NegRiskArbitrageStrategy } from '../strategy/custom/negrisk-arbitrage.js';
import { WhaleEventSubscriber } from '../market/whale-event-subscriber.js';
import { FastCryptoEvaluator } from './fast-crypto-evaluator.js';
import { OddsApiClient } from '../market/odds-api-client.js';
import { KalshiClient } from '../market/kalshi-client.js';
import { FredClient } from '../market/fred-client.js';
// value/skew/complement quarantined R2 PR#1 (2026-04-10) — see strategy/archive/README.md
import { upsertPosition, addFillToPosition, closePosition, updatePositionPrice } from '../storage/repositories/position-repo.js';
import { insertSnapshot } from '../storage/repositories/snapshot-repo.js';
import { insertResolution } from '../storage/repositories/resolution-repo.js';
import { getOpenPositionCount, getOpenPositions, getAllOpenPositions } from '../storage/repositories/position-repo.js';
import type { Outcome } from '../types/index.js';
import type { ExitSignal } from '../risk/stop-loss-monitor.js';
import { PaperResolver } from '../market/paper-resolver.js';
import { nanoid } from 'nanoid';
import { eventBus } from './event-bus.js';
import { killSwitch } from './kill-switch.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('engine');

export class Engine {
  private entityManager: EntityManager;
  private samplingPoller: SamplingPoller;
  private marketCache: MarketCache;
  private orderbookWs: OrderbookWebSocket;
  private riskEngine: RiskEngine;
  private dailyLossGuard: DailyLossGuard;
  private stopLossMonitor: StopLossMonitor;
  private dataApiClient: DataApiClient;
  private reconciler: OnChainReconciler;
  private paperResolver: PaperResolver;
  private redeemers = new Map<string, NegRiskRedeemer>();
  private entitiesSkippedThisCycle = new Set<string>();
  private strategyAdvisor: StrategyAdvisor;
  private clobRouter: ClobRouter;
  private paperSimulator: PaperSimulator;
  private strategyRegistry: StrategyRegistry;
  // R3a signal feed clients
  private oddsApiClient!: OddsApiClient;
  private kalshiClient!: KalshiClient;
  private fredClient!: FredClient;
  // R3b observability + portfolio risk
  private portfolioRisk: PortfolioRiskTracker;
  private regimeDetector: RegimeDetector;
  private alerter: TelegramAlerter;
  // Phase 2 (2026-04-11): attention router for scout-flagged markets
  private priorityScanner: PriorityScanner | null = null;
  // Phase 4 (2026-04-11): in-process scout fleet
  private scoutCoordinator: ScoutCoordinator | null = null;
  // Phase C1c (2026-04-11): whale event subscriber. DORMANT by default.
  private whaleSubscriber: WhaleEventSubscriber | null = null;
  // Tier 1 infrastructure (2026-04-13): fast crypto evaluator. Triggers
  // crypto_price strategy on BTC markets within 10s of orderbook change.
  private fastCryptoEvaluator: FastCryptoEvaluator | null = null;

  private scanInterval: ReturnType<typeof setInterval> | null = null;
  private riskCheckInterval: ReturnType<typeof setInterval> | null = null;
  private snapshotInterval: ReturnType<typeof setInterval> | null = null;
  private advisorInterval: ReturnType<typeof setInterval> | null = null;
  private cycleCount = 0;
  private isRunning = false;
  private lastCycleCompletedAt = 0;  // unix ms
  private lastCycleSignals = 0;
  private lastCycleOrders = 0;
  private lastCycleDurationMs = 0;
  private engineStartedAt = 0;

  constructor(private config: AppConfig) {
    this.entityManager = new EntityManager(config);
    this.marketCache = new MarketCache();
    this.samplingPoller = new SamplingPoller(config.api.clob_base_url, config.engine.scan_interval_ms);
    this.orderbookWs = new OrderbookWebSocket(config.api.ws_url);
    // Dale 2026-04-10: BOTH ENGINES LIVE. The old heuristic "no live entities =
    // R&D mode" no longer works because R&D now runs live capital too. The
    // weighter-enable flag now keys off BASE_PATH, which the R&D systemd unit
    // sets to '/rd'. The weighter stays active on R&D for exploration coverage
    // (its whole purpose — see strategy-weighter.ts header) and stays DISABLED
    // on prod because prod only trades advisor-validated strategies at baseline
    // sizing.
    const isRdMode = (process.env.BASE_PATH ?? '') === '/rd';
    this.riskEngine = new RiskEngine(config.risk, isRdMode, this.marketCache);
    this.dailyLossGuard = new DailyLossGuard(this.entityManager, config.risk);
    this.stopLossMonitor = new StopLossMonitor(config.risk);
    this.dataApiClient = new DataApiClient(config.api.data_api_base_url);
    this.reconciler = new OnChainReconciler(this.dataApiClient, { redemptionEnabled: true });
    this.paperResolver = new PaperResolver(
      this.entityManager,
      this.dailyLossGuard,
    );
    this.portfolioRisk = new PortfolioRiskTracker();
    this.regimeDetector = new RegimeDetector();
    this.alerter = new TelegramAlerter();
    this.paperSimulator = new PaperSimulator(this.marketCache, config.execution.slippage_bps, config.execution.paper_fill_delay_ms);
    this.clobRouter = new ClobRouter(this.paperSimulator, config.api.clob_base_url, this.marketCache, config.api.exchange_version);
    this.strategyRegistry = new StrategyRegistry();

    // Register strategies — data-driven first, then opportunistic.
    // R2 PR#1 (2026-04-10) removed value, skew, complement — see strategy/archive/
    // R3a (2026-04-10) added sportsbook_fade, cross_market, macro_forecast — external probability estimators
    this.strategyRegistry.register(new WeatherForecastStrategy());
    this.strategyRegistry.register(new CryptoPriceStrategy());
    this.strategyRegistry.register(new FavoritesStrategy());
    this.strategyRegistry.register(new LongshotStrategy());
    this.strategyRegistry.register(new ConvergenceStrategy());
    // R3a signal feed strategies — require their clients
    this.oddsApiClient = new OddsApiClient();
    this.kalshiClient = new KalshiClient();
    this.fredClient = new FredClient();
    this.strategyRegistry.register(new SportsbookFadeStrategy(this.oddsApiClient));
    this.strategyRegistry.register(new CrossMarketDivergenceStrategy(this.kalshiClient));
    this.strategyRegistry.register(new MacroForecastStrategy(this.fredClient));

    // Phase C2 (2026-04-11): whale-copy strategy. DORMANT by default —
    // its shouldRun() returns false unless WHALE_COPY_ENABLED=true env
    // var is set. Registering it here doesn't activate it; it just makes
    // the strategy loadable. See docs/todo.md WHALE ACTIVATION PLAYBOOK
    // for the full flip-on sequence.
    this.strategyRegistry.register(new WhaleCopyStrategy());
    this.strategyRegistry.register(new WhaleFadeStrategy());

    // 2026-04-16 Fix 3: NegRisk combinatorial arbitrage scanner. Groups active
    // markets by neg_risk_market_id, fires one BUY signal per family member
    // when the sum of YES prices sits in the [0.85, 0.97] arb zone (below 0.85
    // is typically a family with implicit "none" outcome; above 0.97 leaves
    // no margin after slippage). Per-leg size is intentionally small ($4) —
    // the alpha is the basket-level risk-free payoff, not per-leg edge.
    this.strategyRegistry.register(new NegRiskArbitrageStrategy());

    // Strategy advisor (must be after strategyRegistry is populated)
    this.strategyAdvisor = new StrategyAdvisor(config.advisor, this.entityManager, this.strategyRegistry);
  }

  getStrategyRegistry(): StrategyRegistry {
    return this.strategyRegistry;
  }

  getEntityManager(): EntityManager {
    return this.entityManager;
  }

  getMarketCache(): MarketCache {
    return this.marketCache;
  }

  // R3b dashboard wiring (2026-04-10)
  getPortfolioRiskTracker(): PortfolioRiskTracker {
    return this.portfolioRisk;
  }

  getRegimeDetector(): RegimeDetector {
    return this.regimeDetector;
  }

  getAlerter(): TelegramAlerter {
    return this.alerter;
  }

  async start(): Promise<void> {
    log.info('Starting polybot-v3 engine');

    // 1. Initialize database
    const db = initDatabase(this.config.database.path);
    applySchema(db);

    // 1a. G1 (2026-04-15): re-apply any persisted kill-switch halt BEFORE
    // any strategy, risk, or execution code runs. If the last run was halted
    // (operator SIGUSR1, drawdown breach, reconciliation failure, etc.), the
    // row in kill_switch_state re-halts the in-memory singleton so clob-router
    // will throw on the very first routeOrder call. The only way out is
    // deliberate operator action (SIGUSR2 or dashboard resume). This is the
    // fix for the 4/13 prod blow-up: the halt was in-memory only, process
    // restart cleared it, live trading auto-resumed into broken longshot.
    killSwitch.loadPersistedState();

    // 2. Load entities
    await this.entityManager.initialize();

    // 2a. Startup reconciliation — per obra-defense-in-depth, never start trading
    // on stale DB state. Walk every active entity, pull its on-chain position state
    // via the Data API, and close/credit anything that resolved while the engine was
    // stopped. Fail-closed: if the Data API is unreachable for an entity, that entity
    // stays trading-disabled until the next scan cycle's reconciliation succeeds.
    log.info('Running startup reconciliation');
    for (const entity of this.entityManager.getAllEntities()) {
      // 2026-04-10: unconditional startup invariant — after the ratio removal,
      // trading_balance is always equal to cash_balance and reserve_balance is
      // always 0. This normalizes any stale stored values (from the old ratio
      // semantics) on every restart, idempotent afterward. Runs BEFORE the
      // wallet sync / reconciliation so everything downstream sees consistent
      // state regardless of entity mode (live, paper, or unprovisioned).
      if (entity.trading_balance !== entity.cash_balance || entity.reserve_balance !== 0) {
        log.info(
          {
            entity: entity.config.slug,
            old_trading: entity.trading_balance,
            old_reserve: entity.reserve_balance,
            cash: entity.cash_balance,
          },
          'Normalizing trading_balance = cash_balance, reserve_balance = 0',
        );
        this.entityManager.updateBalances(
          entity.config.slug,
          entity.cash_balance,
          0,
          entity.cash_balance,
        );
      }

      // Use proxy_address when present (CLOB-proxied wallets), else fall back to
      // account_address (direct-EOA wallets like polybot). The Data API /positions
      // endpoint accepts either.
      const wallet = entity.credentials?.proxy_address || entity.credentials?.account_address;
      if (!wallet) {
        log.info({ entity: entity.config.slug }, 'Skipping startup reconciliation — no wallet address (paper or unprovisioned entity)');
        continue;
      }

      // STARTUP WALLET SYNC: read on-chain USDC balance via viem and overwrite
      // entity.cash_balance with the ground truth. The DB cash_balance can go
      // stale whenever positions resolve off-chain or any manual redemption
      // happens, because the engine doesn't automatically see the wallet delta.
      // Reading on-chain USDC at startup makes the engine's view match reality.
      // After this, per-scan reconciliation only manages position state (never
      // touches cash_balance) so the sync point is deterministic.
      try {
        const redeemer = this.getRedeemer(entity.config.slug);
        if (redeemer && entity.config.mode === 'live') {
          // CRITICAL: Polymarket USDC lives at the PROXY wallet, not the EOA derived
          // from the private key. Pass `wallet` (which is already proxy_address ||
          // account_address from the resolution above) as the query target. Without
          // this override, getUsdcBalance defaults to the EOA and returns 0 USDC,
          // which cascades into a zero-baseline drawdown trap + phantom drawdown kill.
          const onChainUsdcRaw = await redeemer.getUsdcBalance(wallet as `0x${string}`);
          const onChainUsdc = Number(onChainUsdcRaw) / 1_000_000; // USDC has 6 decimals
          if (onChainUsdc !== entity.cash_balance) {
            log.info(
              { entity: entity.config.slug, wallet, db_cash: entity.cash_balance, onchain_usdc: onChainUsdc },
              'Startup wallet sync — overwriting cash_balance from on-chain USDC',
            );
            this.entityManager.updateBalances(
              entity.config.slug,
              onChainUsdc,
              entity.reserve_balance,
              onChainUsdc, // trading_balance == cash (2026-04-10, ratio removed)
            );
          }
        }
      } catch (err) {
        log.warn(
          { entity: entity.config.slug, err: err instanceof Error ? err.message : String(err) },
          'Startup wallet sync failed — continuing with stale DB cash_balance',
        );
      }

      try {
        const redeemer = this.getRedeemer(entity.config.slug);
        log.info({ entity: entity.config.slug, wallet }, 'Running reconciliation for entity');
        const result = await this.reconciler.reconcileEntity(
          entity.config.slug,
          wallet,
          redeemer,
        );
        if (!result.apiReachable) {
          log.warn({ entity: entity.config.slug }, 'Startup reconciliation failed — entity will retry on next scan cycle');
          this.entitiesSkippedThisCycle.add(entity.config.slug);
        } else if (result.cashCredited > 0) {
          // Credit cash from resolved positions back to the entity balance.
          const newCash = entity.cash_balance + result.cashCredited;
          this.entityManager.updateBalances(
            entity.config.slug,
            newCash,
            entity.reserve_balance,
            newCash, // trading_balance == cash (2026-04-10, ratio removed)
          );
          log.info(
            { entity: entity.config.slug, credited: result.cashCredited.toFixed(2), new_cash: newCash.toFixed(2) },
            'Startup reconciliation credited cash',
          );
        }
      } catch (err) {
        log.error(
          { entity: entity.config.slug, err: err instanceof Error ? err.message : String(err) },
          'Startup reconciliation threw — entity will retry on next scan cycle',
        );
        this.entitiesSkippedThisCycle.add(entity.config.slug);
      }
    }

    // 3. Initialize strategies
    await this.strategyRegistry.initializeAll();

    // 4. Wire event handlers
    this.wireEvents();

    // 5. Start market data feeds
    await this.samplingPoller.start();
    if (this.config.engine.orderbook_subscribe) {
      try {
        await this.orderbookWs.connect();
      } catch (err) {
        log.warn({ err }, 'WebSocket connection failed, continuing without real-time orderbooks');
      }
    }

    // 6. Start scheduled phases
    this.scanInterval = setInterval(() => this.runScanCycle().catch(err => {
      log.error({ err }, 'Scan cycle failed');
      eventBus.emit('engine:error', { error: err instanceof Error ? err : new Error(String(err)), context: 'scan_cycle' });
    }), this.config.engine.scan_interval_ms);

    this.riskCheckInterval = setInterval(() => {
      // Daily reset only. Stop-loss scanning moved to runScanCycle (R1 PR#2) so exits
      // share the same signal → risk-engine → router pipeline as entries.
      this.dailyLossGuard.checkDailyReset();
    }, this.config.engine.risk_check_interval_ms);

    this.snapshotInterval = setInterval(() => {
      this.captureSnapshots();
    }, this.config.engine.snapshot_interval_ms);

    // 7. Start strategy advisor (R&D-to-Prod sync)
    if (this.config.advisor.enabled) {
      this.advisorInterval = setInterval(() => {
        try { this.strategyAdvisor.check(); }
        catch (err) { log.error({ err }, 'Strategy advisor check failed'); }
      }, this.config.advisor.check_interval_ms);

      // First check 10s after startup (after market data loads)
      setTimeout(() => {
        try { this.strategyAdvisor.check(); }
        catch (err) { log.error({ err }, 'Initial strategy advisor check failed'); }
      }, 10_000);

      log.info({ interval_ms: this.config.advisor.check_interval_ms, target: this.config.advisor.target_entity_slug }, 'Strategy advisor enabled');
    }

    // Phase 2 (2026-04-11): start the attention router. Runs every ~30s,
    // polls market_priorities for scout-flagged markets, and fires
    // strategies on them out-of-cycle. Signals flow through the normal
    // risk engine + router pipeline.
    if (this.config.priority_scanner.enabled) {
      this.priorityScanner = new PriorityScanner(
        {
          entityManager: this.entityManager,
          strategyRegistry: this.strategyRegistry,
          marketCache: this.marketCache,
          riskEngine: this.riskEngine,
          clobRouter: this.clobRouter,
          riskLimits: this.config.risk,
          executionConfig: {
            slippage_bps: this.config.execution.slippage_bps,
            bid_premium_pct: this.config.execution.bid_premium_pct,
          },
        },
        {
          enabled: this.config.priority_scanner.enabled,
          interval_ms: this.config.priority_scanner.interval_ms,
          max_priorities_per_run: this.config.priority_scanner.max_priorities_per_run,
          min_scan_gap_ms: this.config.priority_scanner.min_scan_gap_ms,
          gc_every_n_runs: this.config.priority_scanner.gc_every_n_runs,
        },
      );
      this.priorityScanner.start();
    }

    // Phase 4 (2026-04-11): start the scout fleet. Each scout watches
    // the market cache for a specific pattern (volume spike, price jump,
    // new listing, LLM news catalyst) and writes priority/intel rows
    // that the PriorityScanner + scout-overlay downstream consume.
    // Scouts are safe to run on either engine — they only read + write
    // DB state, they never place orders.
    if (this.config.scouts.enabled) {
      this.scoutCoordinator = new ScoutCoordinator({
        enabled: this.config.scouts.enabled,
        interval_ms: this.config.scouts.interval_ms,
        disabled_scouts: this.config.scouts.disabled_scouts,
      });
      this.scoutCoordinator.start(this.marketCache);
    }

    // Polymarket RTDS (real-time equity/FX/commodity prices) — 2026-04-21
    startRtds();

    // Phase C1c (2026-04-11): whale event subscriber. DORMANT by default.
    // Only starts when:
    //   (a) WHALE_COPY_ENABLED=true env var is set, AND
    //   (b) the whale subscriber's own start() method finds at least
    //       one row in whitelisted_whales.
    // Both gates are the subscriber's responsibility — we just call
    // start() unconditionally when the flag is on, and it silently
    // skips if there are no whales to watch.
    if (process.env.WHALE_COPY_ENABLED === 'true') {
      this.whaleSubscriber = new WhaleEventSubscriber();
      this.whaleSubscriber.start();
    }

    // Tier 1 infrastructure (2026-04-13): fast crypto evaluator. Listens
    // for orderbook:snapshot events on BTC markets and triggers
    // crypto_price strategy within 10 seconds of a book change — 30x
    // faster than the 5-minute scan cycle. Only active when the
    // OrderbookWebSocket is connected (config.engine.orderbook_subscribe).
    if (this.config.engine.orderbook_subscribe) {
      this.fastCryptoEvaluator = new FastCryptoEvaluator({
        entityManager: this.entityManager,
        strategyRegistry: this.strategyRegistry,
        marketCache: this.marketCache,
        riskEngine: this.riskEngine,
        clobRouter: this.clobRouter,
        riskLimits: this.config.risk,
        executionConfig: {
          slippage_bps: this.config.execution.slippage_bps,
          bid_premium_pct: this.config.execution.bid_premium_pct,
        },
      });
      this.fastCryptoEvaluator.start();
    }

    // R3b: start Telegram alerter (subscribes to event bus for kill-switch + engine events)
    this.alerter.start();

    // R3b: metrics registry wires itself to the event bus on construction — no explicit start needed

    this.isRunning = true;
    this.engineStartedAt = Date.now();

    // Layer 1 monitoring (2026-04-13): watchdog timer that checks every
    // 2 minutes if the scan cycle has gone stale (> 2x scan interval).
    // Fires a Telegram alert so Dale knows something is wrong without
    // having to check the dashboard.
    setInterval(() => {
      if (!this.isRunning || this.lastCycleCompletedAt === 0) return;
      const msSinceCycle = Date.now() - this.lastCycleCompletedAt;
      const threshold = this.config.engine.scan_interval_ms * 2;
      if (msSinceCycle > threshold) {
        const minsSince = Math.round(msSinceCycle / 60000);
        log.error(
          { mins_since_cycle: minsSince, threshold_mins: Math.round(threshold / 60000) },
          'WATCHDOG: scan cycle stale',
        );
        this.alerter.send({
          severity: 'critical',
          component: 'watchdog',
          title: `Scan cycle stale (${minsSince}min since last cycle)`,
          details: {
            last_cycle_at: new Date(this.lastCycleCompletedAt).toISOString(),
            cycles_completed: this.cycleCount,
            threshold_min: Math.round(threshold / 60000),
          },
        });
      }
    }, 120_000); // check every 2 minutes

    eventBus.emit('engine:started', { timestamp: new Date() });
    log.info({
      entities: this.entityManager.getAllEntities().length,
      strategies: this.strategyRegistry.size,
      markets: this.marketCache.size,
      scan_interval: this.config.engine.scan_interval_ms,
    }, 'Engine started');
  }

  async stop(reason = 'shutdown'): Promise<void> {
    log.info({ reason }, 'Stopping engine');
    this.isRunning = false;

    if (this.scanInterval) clearInterval(this.scanInterval);
    if (this.riskCheckInterval) clearInterval(this.riskCheckInterval);
    if (this.snapshotInterval) clearInterval(this.snapshotInterval);
    if (this.advisorInterval) clearInterval(this.advisorInterval);
    if (this.priorityScanner) this.priorityScanner.stop();
    if (this.scoutCoordinator) this.scoutCoordinator.stop();
    if (this.whaleSubscriber) this.whaleSubscriber.stop();
    this.alerter.stop();

    this.samplingPoller.stop();
    this.orderbookWs.disconnect();
    await this.strategyRegistry.teardownAll();

    this.captureSnapshots(); // final snapshot
    closeDatabase();

    eventBus.emit('engine:stopped', { timestamp: new Date(), reason });
    log.info({ reason, cycles: this.cycleCount }, 'Engine stopped');
  }

  private async runScanCycle(): Promise<void> {
    const cycleStart = Date.now();
    this.cycleCount++;
    let totalSignals = 0;
    let totalOrders = 0;

    // Reset fail-closed set for this cycle. Entities that fail reconciliation here
    // get re-added to the set and skipped for signal generation below.
    this.entitiesSkippedThisCycle.clear();

    // Paper position resolution (2026-04-10): the on-chain reconciler below is
    // live-mode only. Paper positions need a parallel path to close resolved
    // markets and write resolutions, or the learning loop starves. PaperResolver
    // queries CLOB /markets/{id} for open paper positions whose end_date is near
    // or past, detects winners via tokens[].winner, and resolves them.
    try {
      const paperResult = await this.paperResolver.check();
      if (paperResult.resolved > 0) {
        log.info(
          { scanned: paperResult.scanned, checked: paperResult.checked, resolved: paperResult.resolved },
          'Paper positions resolved this cycle',
        );
      }
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : String(err) },
        'Paper resolution cycle failed — continuing',
      );
    }

    // Per-entity on-chain reconciliation. For each entity with a proxy wallet, query
    // the Data API for its position state, close resolved positions, credit cash,
    // attempt on-chain redemption for live positions, and insert orphans. Fail-closed
    // on Data API errors: the entity gets added to entitiesSkippedThisCycle and its
    // strategies will NOT run this cycle.
    for (const entity of this.entityManager.getAllEntities()) {
      // Use proxy_address if set, else fall back to account_address (same
      // logic as the startup wallet-sync path). The prior code checked ONLY
      // proxy_address which was null for the polybot entity — this caused
      // the reconciler to silently skip prod EVERY CYCLE for 36+ hours,
      // leaving 34 redeemable positions ($114.52) undetected in the DB.
      const walletForReconcile = entity.credentials?.proxy_address || entity.credentials?.account_address;
      if (!walletForReconcile) continue; // genuinely no wallet (paper entity)
      try {
        const redeemer = this.getRedeemer(entity.config.slug);
        const result = await this.reconciler.reconcileEntity(
          entity.config.slug,
          walletForReconcile,
          redeemer,
        );
        if (!result.apiReachable) {
          this.entitiesSkippedThisCycle.add(entity.config.slug);
          continue;
        }
        if (result.cashCredited > 0) {
          const newCash = entity.cash_balance + result.cashCredited;
          this.entityManager.updateBalances(
            entity.config.slug,
            newCash,
            entity.reserve_balance,
            newCash, // trading_balance == cash (2026-04-10, ratio removed)
          );
          this.dailyLossGuard.recordPnl(entity.config.slug, result.cashCredited);
        }
      } catch (err) {
        log.error(
          { entity: entity.config.slug, err: err instanceof Error ? err.message : String(err) },
          'Reconciliation threw — skipping entity this cycle (fail-closed)',
        );
        this.entitiesSkippedThisCycle.add(entity.config.slug);
      }
    }

    // Refresh current_price on every open position from the latest market cache.
    // AUDIT FIX A-P0-3 (2026-04-10): updatePositionPrice was dead code — zero callers
    // until this wire. Without it, unrealized_pnl stays at 0 forever and stop-loss/
    // profit-target triggers never fire because they compare current vs entry using
    // the stored current_price column.
    for (const pos of getAllOpenPositions()) {
      const market = this.marketCache.get(pos.condition_id);
      if (!market) continue;
      const currentPrice = pos.token_id === market.token_yes_id ? market.yes_price : market.no_price;
      if (currentPrice > 0) {
        updatePositionPrice(pos.entity_slug, pos.condition_id, pos.token_id, currentPrice);
      }
    }

    // R3b: sample the market basket for regime detection + update drawdown tracking.
    const activeMarkets = this.marketCache.getActive();
    if (activeMarkets.length > 0) {
      const basketPrice = activeMarkets.reduce((s, m) => s + (m.yes_price ?? 0.5), 0) / activeMarkets.length;
      this.regimeDetector.sample(basketPrice);
      if (this.cycleCount % 10 === 0) {
        const snap = this.regimeDetector.classify();
        const regimeCode = { calm: 0, choppy: 1, trending: 2, volatile: 3 }[snap.regime];
        metricsRegistry.setGauge('polybot_current_regime_code', regimeCode);
      }
    }
    // R3b portfolio risk: update drawdown + metrics per entity
    //
    // 2026-04-10 bugfix: equity MUST include open-position market value. The previous
    // formula `cash + reserve` ignored positions entirely, so every BUY dropped "equity"
    // by the cost basis. With a $115 starting cash and $80 deployed into positions, the
    // computed drawdown was 70% and the kill switch fired at the 20% threshold — a
    // phantom drawdown that halted both engines repeatedly. True equity is:
    //   equity = cash + reserve + sum(size × current_price) across open positions
    // where current_price is the live mid/last from the market cache, refreshed each
    // scan cycle via updatePositionPrice().
    for (const entity of this.entityManager.getAllEntities()) {
      const openPositions = getOpenPositions(entity.config.slug);
      const positionsMv = openPositions.reduce((sum, p) => sum + (p.size * (p.current_price ?? p.avg_entry_price)), 0);
      const equity = entity.cash_balance + entity.reserve_balance + positionsMv;
      this.portfolioRisk.updateDrawdown(entity.config.slug, equity);
      metricsRegistry.setGauge('polybot_cash_balance_usd', entity.cash_balance, { entity: entity.config.slug });
      metricsRegistry.setGauge('polybot_trading_balance_usd', entity.trading_balance, { entity: entity.config.slug });
      metricsRegistry.setGauge('polybot_open_positions', entity.open_positions, { entity: entity.config.slug });
      metricsRegistry.setGauge('polybot_equity_usd', equity, { entity: entity.config.slug });
    }

    // Generate exit signals for positions that hit stop-loss / profit-target / hard-stop.
    // AUDIT FIX A-P0-2 (2026-04-10): the old code iterated exits and only logged them.
    // The new path converts each ExitSignal into a SELL Signal with is_exit=true and
    // routes it through the full signal → risk-engine → clob-router pipeline. The risk
    // engine short-circuits edge/daily-loss/max-position gates for exits.
    const exitSignals = this.stopLossMonitor.scan();
    for (const exit of exitSignals) {
      try {
        await this.processExitSignal(exit);
      } catch (err) {
        log.error(
          { entity: exit.entity_slug, condition: exit.condition_id, err: err instanceof Error ? err.message : String(err) },
          'Exit signal processing failed',
        );
      }
    }

    // For each active entity, run its assigned strategies
    for (const entity of this.entityManager.getActiveEntities()) {
      if (entity.is_locked_out) continue;
      if (this.entitiesSkippedThisCycle.has(entity.config.slug)) {
        log.debug({ entity: entity.config.slug }, 'Entity reconciliation failed — skipping signal generation');
        continue;
      }

      // Normalize strategy config: legacy string[] or new EntityStrategyConfig[]
      const strategyConfigs = (entity.config.strategies ?? []).map(s =>
        typeof s === 'string' ? { strategy_id: s, sub_strategy_ids: undefined } : s
      );
      if (strategyConfigs.length === 0) continue;

      // 2026-04-10 fix: collect ALL signals from ALL strategies first, then shuffle,
      // THEN process through the risk engine. Without this, strategies iterate in
      // config order and favorites (which generates 4K+ signals per cycle) saturates
      // the cash budget before longshot/convergence/weather get a single turn. Result
      // was 800+ favorites positions and zero longshot/convergence coverage. Fisher-
      // Yates shuffle gives every strategy a statistically fair shot at the budget
      // within a single cycle.
      const allSignals: Array<{ signal: import('../types/index.js').Signal; strategyLabel: string }> = [];
      for (const stratCfg of strategyConfigs) {
        const strategy = this.strategyRegistry.get(stratCfg.strategy_id);
        if (!strategy) continue;

        const ctx = createStrategyContext(
          entity,
          this.config.risk,
          this.marketCache,
          stratCfg.sub_strategy_ids,
        );

        if (!strategy.shouldRun(ctx)) continue;

        try {
          const signals = await strategy.evaluate(ctx);
          totalSignals += signals.length;
          for (const signal of signals) {
            allSignals.push({ signal, strategyLabel: strategy.id });
          }
        } catch (err) {
          log.error({ strategy: strategy.id, entity: entity.config.slug, err }, 'Strategy evaluation failed');
        }
      }

      // Fisher-Yates shuffle — uniform random order per cycle
      for (let i = allSignals.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = allSignals[i]!;
        allSignals[i] = allSignals[j]!;
        allSignals[j] = tmp;
      }

      log.debug(
        { entity: entity.config.slug, total_signals: allSignals.length },
        'Signals collected and shuffled',
      );

      // In-cycle dedup set: tracks (condition_id|token_id) pairs already processed
      // this scan. Different strategies frequently target the same token (e.g., both
      // favorites and longshot buy the high-priced side of the same binary market).
      // Without this, the second signal's fill upserts the position and overwrites
      // its strategy_id/sub_strategy_id — producing the cross-contamination bug where
      // `favorites|bucketed_fade` and `longshot|compounding` rows appear in positions
      // even though neither pair exists in any strategy's getSubStrategies() list.
      //
      // With the shuffle, the "winner" of a contested slot is uniform-random across
      // strategies, so no strategy is systematically starved. Losing strategies still
      // generate their signals for the metrics — they just don't double-book fills.
      const openedThisCycle = new Set<string>();

      for (const { signal, strategyLabel } of allSignals) {
        eventBus.emit('signal:generated', { signal });

        const cycleKey = `${signal.condition_id}|${signal.token_id}`;
        if (openedThisCycle.has(cycleKey)) {
          // Already opened this (condition, token) earlier in the shuffle — skip
          // to preserve the first fill's strategy_id. Log at debug to avoid noise.
          log.debug(
            { strategy: strategyLabel, condition: signal.condition_id.substring(0, 12), token: signal.token_id.substring(0, 12) },
            'Signal skipped — (condition, token) already opened this cycle',
          );
          continue;
        }

        const decision = this.riskEngine.evaluate(signal, entity);
        if (decision.risk_approved && decision.order_request) {
          // 2026-04-13: pass orderbook for pre-trade quality check
          const tokenBook = this.marketCache.getOrderbook(signal.token_id);
          const order = buildOrder(
            decision,
            entity,
            this.config.execution.slippage_bps,
            this.config.execution.bid_premium_pct,
            tokenBook,
          );

          if (order) {
            try {
              const fill = await this.clobRouter.routeOrder(order, entity);
              if (fill) {
                totalOrders++;
                this.processPosition(fill);
                // Mark (condition, token) as taken so later shuffled signals
                // targeting the same pair don't upsert-overwrite this row's
                // strategy_id / sub_strategy_id tags.
                openedThisCycle.add(cycleKey);

                // Update cash balance on trade
                if (fill.side === 'BUY') {
                  // Deduct cost from cash
                  const newCash = Math.max(0, entity.cash_balance - fill.net_usdc);
                  this.entityManager.updateBalances(
                    entity.config.slug,
                    newCash,
                    entity.reserve_balance,
                    newCash, // trading_balance == cash (2026-04-10, ratio removed)
                  );
                } else {
                  // SELL: credit proceeds to cash
                  const newCash = entity.cash_balance + fill.net_usdc;
                  this.entityManager.updateBalances(
                    entity.config.slug,
                    newCash,
                    entity.reserve_balance,
                    newCash, // trading_balance == cash (2026-04-10, ratio removed)
                  );
                  this.dailyLossGuard.recordPnl(entity.config.slug, fill.net_usdc);
                }
              }
            } catch (err) {
              log.error({ strategy: strategyLabel, entity: entity.config.slug, err }, 'Order routing failed');
            }
          }
        }
      }
    }

    const duration = Date.now() - cycleStart;
    this.lastCycleCompletedAt = Date.now();
    this.lastCycleSignals = totalSignals;
    this.lastCycleOrders = totalOrders;
    this.lastCycleDurationMs = duration;

    eventBus.emit('engine:cycle_complete', {
      cycle: this.cycleCount,
      duration_ms: duration,
      signals: totalSignals,
      orders: totalOrders,
    });

    if (totalSignals > 0 || totalOrders > 0) {
      log.info({ cycle: this.cycleCount, duration, signals: totalSignals, orders: totalOrders }, 'Scan cycle complete');
    }
  }

  /**
   * Convert an ExitSignal from the stop-loss monitor into a full Signal with
   * is_exit=true, run it through the risk engine (which short-circuits edge/daily-
   * loss/max-position gates), and route the resulting SELL order through the clob
   * router. Used by runScanCycle for stop-loss / profit-target / hard-stop exits.
   */
  private async processExitSignal(exit: ExitSignal): Promise<void> {
    const entity = this.entityManager.getEntity(exit.entity_slug);
    if (!entity) return;

    const positions = getOpenPositions(exit.entity_slug);
    const pos = positions.find(p => p.condition_id === exit.condition_id && p.token_id === exit.token_id);
    if (!pos || pos.current_price === null) return;

    // Build an exit Signal. Side is SELL because we're exiting a long position.
    // recommended_size_usd is the full position's cost_basis (we sell everything).
    const exitSignal: Signal = {
      signal_id: `exit_${nanoid(12)}`,
      entity_slug: exit.entity_slug,
      strategy_id: pos.strategy_id ?? 'stop_loss_monitor',
      sub_strategy_id: pos.sub_strategy_id ?? undefined,
      condition_id: exit.condition_id,
      token_id: exit.token_id,
      side: 'SELL',
      outcome: (pos.side === 'YES' ? 'YES' : 'NO') as 'YES' | 'NO',
      strength: 1.0,
      edge: 0, // exits bypass edge check
      model_prob: 0, // dummy — exits don't price
      market_price: pos.current_price,
      recommended_size_usd: pos.cost_basis,
      metadata: { exit_reason: exit.reason, pnl_pct: exit.current_pnl_pct, pnl_usd: exit.current_pnl_usd },
      created_at: new Date(),
      is_exit: true,
      exit_reason: exit.reason,
    };

    eventBus.emit('signal:generated', { signal: exitSignal });
    const decision = this.riskEngine.evaluate(exitSignal, entity);

    if (!decision.risk_approved || !decision.order_request) {
      log.warn(
        { entity: exit.entity_slug, condition: exit.condition_id, reason: decision.risk_rejection },
        'Exit signal rejected by risk engine',
      );
      return;
    }

    const order = buildOrder(
      decision,
      entity,
      this.config.execution.slippage_bps,
      this.config.execution.bid_premium_pct,
    );
    if (!order) return;

    const fill = await this.clobRouter.routeOrder(order, entity);
    if (fill) {
      log.info(
        {
          entity: exit.entity_slug,
          condition: exit.condition_id,
          reason: exit.reason,
          pnl_usd: exit.current_pnl_usd.toFixed(2),
          fill_price: fill.price,
        },
        'Exit filled',
      );
      // Credit sell proceeds to cash
      const newCash = entity.cash_balance + fill.net_usdc;
      this.entityManager.updateBalances(
        entity.config.slug,
        newCash,
        entity.reserve_balance,
        newCash, // trading_balance == cash (2026-04-10, ratio removed)
      );
      // Record realized P&L (difference between proceeds and cost basis)
      const realizedPnl = fill.net_usdc - pos.cost_basis;
      this.dailyLossGuard.recordPnl(entity.config.slug, realizedPnl);

      // 2026-04-10: exits are P&L events too — write a resolution row so the
      // dashboard W/L, win-rate, and strategy-performance views include them.
      // Previously only market-resolution closures (paper-resolver and
      // on-chain-reconciler) wrote to `resolutions`, so every stop-loss /
      // profit-target / hard-stop exit was invisible to the stats (R&D had
      // 18 closed positions and zero resolution rows, prod had 0 wins / 18
      // losses because only absent_from_api close rows existed).
      //
      // Semantics for a sell-exit: the market didn't resolve, we sold into
      // the book. winning_outcome is ambiguous in the usual sense, so we
      // record the position_side and let the sign of realized_pnl drive the
      // win/loss classification downstream (realized_pnl > 0 → win).
      try {
        insertResolution({
          entity_slug: entity.config.slug,
          condition_id: exit.condition_id,
          token_id: exit.token_id,
          winning_outcome: pos.side as Outcome,
          position_side: pos.side as Outcome,
          size: pos.size,
          payout_usdc: 0, // this is a sell-exit, not a redemption
          cost_basis_usdc: pos.cost_basis,
          sell_proceeds_usdc: fill.net_usdc,
          realized_pnl: realizedPnl,
          is_paper: entity.config.mode === 'paper',
          strategy_id: pos.strategy_id ?? 'stop_loss_monitor',
          sub_strategy_id: pos.sub_strategy_id ?? undefined,
          market_question: pos.market_question ?? '',
          market_slug: pos.market_slug ?? '',
          tx_hash: null,
          resolved_at: new Date(),
        });
      } catch (err) {
        log.error(
          { entity: entity.config.slug, condition: exit.condition_id, err: err instanceof Error ? err.message : String(err) },
          'Failed to insert exit resolution row — position will still close but W/L stats will miss this event',
        );
      }

      // Close the DB position
      closePosition(entity.config.slug, exit.condition_id, exit.token_id, 'closed');
    }
  }

  /**
   * Lazy-build a NegRiskRedeemer for an entity. Only live entities with a private
   * key get a redeemer; paper entities return null (the reconciler no-ops redemption
   * for null redeemers). Cached per-slug for the engine lifetime.
   */
  private getRedeemer(entitySlug: string): NegRiskRedeemer | null {
    const cached = this.redeemers.get(entitySlug);
    if (cached) return cached;

    const entity = this.entityManager.getEntity(entitySlug);
    if (!entity || entity.config.mode !== 'live' || !entity.credentials?.private_key) {
      return null;
    }

    try {
      const redeemer = new NegRiskRedeemer(entity.credentials.private_key as Hex);
      this.redeemers.set(entitySlug, redeemer);
      log.info({ entity: entitySlug }, 'NegRiskRedeemer initialized');
      return redeemer;
    } catch (err) {
      log.error(
        { entity: entitySlug, err: err instanceof Error ? err.message : String(err) },
        'Failed to initialize NegRiskRedeemer — live redemption disabled for this entity',
      );
      return null;
    }
  }

  private processPosition(fill: OrderFill): void {
    if (fill.side === 'BUY') {
      // 2026-04-10 averaging-down bug fix: switched from upsertPosition to
      // addFillToPosition. The old call was dropping the second (and third,
      // fourth...) BUY fill on any (entity, condition, token) the DB already
      // held, because upsertPosition's ON CONFLICT overwrites size/cost_basis
      // with the new fill's values instead of accumulating them. Root cause of
      // R&D's silent ~$400 equity leak: 1346 BUY trades but open_cost_basis
      // only captured ~$9,588, with the gap exactly matching the sum of
      // second-fill values on averaged positions.
      addFillToPosition({
        entity_slug: fill.entity_slug,
        condition_id: fill.condition_id,
        token_id: fill.token_id,
        side: fill.outcome,
        size: fill.size,
        avg_entry_price: fill.price,
        cost_basis: fill.net_usdc,
        current_price: fill.price,
        unrealized_pnl: 0,
        market_question: fill.market_question,
        market_slug: fill.market_slug,
        sub_strategy_id: fill.sub_strategy_id,
        strategy_id: fill.strategy_id,
        is_paper: fill.is_paper,
      });
    }
    // SELL fills would reduce/close positions — handled by position reconciliation
  }

  /**
   * 2026-04-20: sanity guard for equity computation regressions.
   * After a dashboard bug briefly showed R&D at -$400K (root-caused + fixed
   * same day), add a defensive check: if computed equity deviates absurdly
   * from starting_capital, log a loud ERROR so the next regression is
   * caught before it hits the dashboard. Thresholds:
   *   - equity > 10x starting_capital: likely double-counting or unit bug
   *   - equity < -2x starting_capital: impossible for paper/live (bankroll bounded)
   *   - deployed > 5x starting_capital: stale positions or cost-basis bug
   * Uses log.error so alerter picks it up. Does NOT block the snapshot
   * write — research data integrity beats assertion safety here.
   */
  private sanityCheckEquity(entitySlug: string, seed: number, equity: number, deployed: number): void {
    if (seed <= 0) return; // new/unfunded entity, skip
    const absRatio = Math.abs(equity) / seed;
    const deployRatio = deployed / seed;
    if (absRatio > 10) {
      log.error({ entity: entitySlug, seed, equity, ratio: absRatio.toFixed(2) }, 'EQUITY SANITY GUARD: equity > 10x starting_capital — likely calc bug');
    }
    if (equity < -2 * seed) {
      log.error({ entity: entitySlug, seed, equity }, 'EQUITY SANITY GUARD: equity < -2x starting_capital — paper/live cannot go this negative');
    }
    if (deployRatio > 5) {
      log.error({ entity: entitySlug, seed, deployed, ratio: deployRatio.toFixed(2) }, 'EQUITY SANITY GUARD: deployed > 5x starting_capital — stale positions or cost-basis bug');
    }
  }

  private captureSnapshots(): void {
    const now = Math.floor(Date.now() / 1000);
    const utc = new Date().toISOString();

    for (const entity of this.entityManager.getAllEntities()) {
      const openCount = getOpenPositionCount(entity.config.slug);
      const positions = getOpenPositions(entity.config.slug);
      const positionsValue = positions.reduce((sum, p) => sum + (p.cost_basis ?? 0), 0);
      const totalEquity = entity.cash_balance + entity.reserve_balance + positionsValue;
      this.sanityCheckEquity(entity.config.slug, entity.config.starting_capital, totalEquity, positionsValue);

      insertSnapshot({
        entity_slug: entity.config.slug,
        timestamp: now,
        timestamp_utc: utc,
        total_equity: totalEquity,
        cash_balance: entity.cash_balance,
        reserve_balance: entity.reserve_balance,
        trading_balance: entity.trading_balance,
        positions_value: positionsValue,
        num_positions: openCount,
        open_orders_value: 0,
        num_open_orders: 0,
        daily_pnl: entity.daily_pnl,
        deposit_basis: entity.config.starting_capital,
        pnl_vs_deposit: totalEquity - entity.config.starting_capital,
      });
    }
  }

  private wireEvents(): void {
    // Update market cache when new markets discovered
    eventBus.on('market:discovered', ({ market }) => {
      this.marketCache.upsertFromSampling(market);
    });

    // Update orderbook cache
    eventBus.on('orderbook:snapshot', ({ token_id, book }) => {
      this.marketCache.updateOrderbook(token_id, book);
    });
  }

  get running(): boolean {
    return this.isRunning;
  }

  get cycles(): number {
    return this.cycleCount;
  }

  getStats() {
    const now = Date.now();
    const msSinceLastCycle = this.lastCycleCompletedAt > 0 ? now - this.lastCycleCompletedAt : null;
    return {
      running: this.isRunning,
      cycles: this.cycleCount,
      uptime_ms: this.engineStartedAt > 0 ? now - this.engineStartedAt : 0,
      last_cycle_at: this.lastCycleCompletedAt > 0 ? new Date(this.lastCycleCompletedAt).toISOString() : null,
      ms_since_last_cycle: msSinceLastCycle,
      last_cycle_signals: this.lastCycleSignals,
      last_cycle_orders: this.lastCycleOrders,
      last_cycle_duration_ms: this.lastCycleDurationMs,
      // Health flag: cycle is stale if > 2x the scan interval has passed
      cycle_stale: msSinceLastCycle !== null && msSinceLastCycle > this.config.engine.scan_interval_ms * 2,
      entities: this.entityManager.getAllEntities().length,
      active_entities: this.entityManager.getActiveEntities().length,
      strategies: this.strategyRegistry.size,
      markets_cached: this.marketCache.size,
      markets_active: this.marketCache.getActive().length,
      ws_connected: this.orderbookWs.connected,
      ws_subscriptions: this.orderbookWs.subscribedCount,
      fast_crypto_stats: this.fastCryptoEvaluator?.getStats() ?? null,
      event_stats: eventBus.getStats(),
      advisor_enabled: this.config.advisor.enabled,
      kill_switch: killSwitch.status(),
    };
  }
}
