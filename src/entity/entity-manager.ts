// Entity lifecycle manager — loads 16 entities, manages wallet isolation and state

import type { AppConfig, EntityConfig, EntityState, EntityMode, EntityStatus, WalletCredentials } from '../types/index.js';
import { loadWalletCredentials } from './wallet-loader.js';
import { upsertEntity, getEntity, updateEntityMode, updateEntityStatus, updateEntityBalances, setEntityLockout } from '../storage/repositories/entity-repo.js';
import { getOpenPositionCount } from '../storage/repositories/position-repo.js';
import { eventBus } from '../core/event-bus.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('entity-manager');

export class EntityManager {
  private entities = new Map<string, EntityState>();

  constructor(private config: AppConfig) {}

  async initialize(): Promise<void> {
    log.info({ count: this.config.entities.length }, 'Initializing entities');

    for (const entityConfig of this.config.entities) {
      const credentials = loadWalletCredentials(entityConfig.entity_path);

      // Persist to DB
      upsertEntity(
        entityConfig,
        credentials?.account_address,
        credentials?.proxy_address,
      );

      const state: EntityState = {
        config: entityConfig,
        credentials,
        cash_balance: 0,
        reserve_balance: 0,
        trading_balance: 0,
        high_water_mark: 0,
        daily_pnl: 0,
        daily_pnl_reset_date: new Date().toISOString().split('T')[0],
        is_locked_out: false,
        open_positions: 0,
        total_equity: 0,
      };

      // Load existing DB state if available
      const dbRow = getEntity(entityConfig.slug);
      if (dbRow) {
        state.cash_balance = dbRow.current_cash;
        state.reserve_balance = dbRow.reserve_balance;
        state.trading_balance = dbRow.trading_balance;
        state.high_water_mark = dbRow.high_water_mark;
        state.daily_pnl = dbRow.daily_pnl;
        state.daily_pnl_reset_date = dbRow.daily_pnl_reset ?? state.daily_pnl_reset_date;
        state.is_locked_out = dbRow.is_locked_out === 1;
        state.lockout_reason = dbRow.lockout_reason ?? undefined;
      }

      state.open_positions = getOpenPositionCount(entityConfig.slug);
      state.total_equity = state.cash_balance + state.reserve_balance;

      this.entities.set(entityConfig.slug, state);

      log.info({
        slug: entityConfig.slug,
        name: entityConfig.name,
        mode: entityConfig.mode,
        status: entityConfig.status,
        hasWallet: !!credentials,
        hasApiKey: !!credentials?.api_key,
      }, 'Entity registered');
    }

    log.info({ total: this.entities.size }, 'All entities initialized');
  }

  getEntity(slug: string): EntityState | undefined {
    return this.entities.get(slug);
  }

  getAllEntities(): EntityState[] {
    return Array.from(this.entities.values());
  }

  getActiveEntities(): EntityState[] {
    return this.getAllEntities().filter(e => e.config.status === 'active');
  }

  getLiveEntities(): EntityState[] {
    return this.getActiveEntities().filter(e => e.config.mode === 'live');
  }

  getPaperEntities(): EntityState[] {
    return this.getActiveEntities().filter(e => e.config.mode === 'paper');
  }

  setMode(slug: string, mode: EntityMode): void {
    const entity = this.entities.get(slug);
    if (!entity) throw new Error(`Entity not found: ${slug}`);

    // Live mode requires credentials
    if (mode === 'live' && !entity.credentials?.api_key) {
      throw new Error(`Cannot set ${slug} to live mode: missing CLOB API credentials`);
    }

    const from = entity.config.mode;
    entity.config.mode = mode;
    updateEntityMode(slug, mode);

    eventBus.emit('entity:mode_changed', { entity_slug: slug, from, to: mode });
    log.info({ slug, from, to: mode }, 'Entity mode changed');
  }

  setStatus(slug: string, status: EntityStatus): void {
    const entity = this.entities.get(slug);
    if (!entity) throw new Error(`Entity not found: ${slug}`);

    const from = entity.config.status;
    entity.config.status = status;
    updateEntityStatus(slug, status);

    eventBus.emit('entity:status_changed', { entity_slug: slug, from, to: status });
    log.info({ slug, from, to: status }, 'Entity status changed');
  }

  updateBalances(slug: string, cash: number, reserve: number, trading: number): void {
    const entity = this.entities.get(slug);
    if (!entity) return;

    entity.cash_balance = cash;
    entity.reserve_balance = reserve;
    entity.trading_balance = trading;
    entity.total_equity = cash + reserve;

    const hwm = Math.max(entity.high_water_mark, entity.total_equity);
    entity.high_water_mark = hwm;

    updateEntityBalances(slug, cash, reserve, trading, hwm);
    eventBus.emit('entity:balance_updated', { entity_slug: slug, cash, reserve, trading });
  }

  addDailyPnl(slug: string, pnl: number): void {
    const entity = this.entities.get(slug);
    if (!entity) return;

    const today = new Date().toISOString().split('T')[0];
    if (entity.daily_pnl_reset_date !== today) {
      entity.daily_pnl = 0;
      entity.daily_pnl_reset_date = today;
    }

    entity.daily_pnl += pnl;
  }

  lockOut(slug: string, reason: string): void {
    const entity = this.entities.get(slug);
    if (!entity) return;

    entity.is_locked_out = true;
    entity.lockout_reason = reason;
    setEntityLockout(slug, true, reason);

    eventBus.emit('risk:lockout', { entity_slug: slug, reason });
    log.warn({ slug, reason }, 'Entity locked out');
  }

  updateStrategies(slug: string, strategies: Array<string | import('../types/entity.js').EntityStrategyConfig>): void {
    const entity = this.entities.get(slug);
    if (!entity) throw new Error(`Entity not found: ${slug}`);

    const from = [...entity.config.strategies];
    entity.config.strategies = strategies;

    // Serialize to readable form for logging/event
    const toDisplay = strategies.map(s => typeof s === 'string' ? s : (s.sub_strategy_ids?.length ? `${s.strategy_id}[${s.sub_strategy_ids.join(',')}]` : s.strategy_id));
    const fromDisplay = from.map(s => typeof s === 'string' ? s : (s.sub_strategy_ids?.length ? `${s.strategy_id}[${s.sub_strategy_ids.join(',')}]` : s.strategy_id));

    eventBus.emit('entity:strategies_changed', { entity_slug: slug, from: fromDisplay, to: toDisplay });
    log.info({ slug, from: fromDisplay, to: toDisplay }, 'Entity strategies updated');
  }

  unlock(slug: string): void {
    const entity = this.entities.get(slug);
    if (!entity) return;

    entity.is_locked_out = false;
    entity.lockout_reason = undefined;
    setEntityLockout(slug, false);

    eventBus.emit('risk:unlocked', { entity_slug: slug });
    log.info({ slug }, 'Entity unlocked');
  }
}
