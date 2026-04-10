// Staggered scan scheduler — R3c dormant subsystem.
//
// R3c (2026-04-10). Per Dale 2026-04-10: the 16-entity fleet achieves ~19-second
// effective scan density on Polymarket by offsetting each entity's scan cycle
// in time. With N active entities on a 5-minute base interval, entity i scans
// at offset `(i/N) * 5min`, so across the fleet a market is re-scanned every
// ~(5min / N) seconds.
//
// **DORMANT BY DEFAULT**: this module does nothing unless `FLEET_ACTIVE=true`
// in the environment. When inactive (single-entity mode), the engine's existing
// `setInterval` scan cycle runs normally with no offset. When active, the
// scheduler takes over scan triggering and runs per-entity cycles on offset
// timers.

import { createChildLogger } from './logger.js';
import { eventBus } from './event-bus.js';
import type { EntityManager } from '../entity/entity-manager.js';

const log = createChildLogger('scan-scheduler');

export interface ScanScheduleEntry {
  entitySlug: string;
  offsetMs: number;
  interval: ReturnType<typeof setInterval> | null;
  lastRunAt: number;
}

export class StaggeredScanScheduler {
  private schedule = new Map<string, ScanScheduleEntry>();
  private active = false;

  constructor(
    private entityManager: EntityManager,
    private baseIntervalMs: number,
    private runEntityScanCycle: (entitySlug: string) => Promise<void>,
  ) {}

  isActive(): boolean {
    return this.active;
  }

  /**
   * Activate the staggered scheduler. Only call when `FLEET_ACTIVE=true`.
   * Builds an offset schedule across all active entities, starts a per-entity
   * interval timer at the correct phase, and emits `fleet:scheduler_activated`.
   *
   * Safe to call multiple times — existing schedule is torn down first.
   */
  activate(): void {
    if (this.active) this.deactivate();

    const activeEntities = this.entityManager.getActiveEntities();
    const n = activeEntities.length;
    if (n === 0) {
      log.warn('No active entities — scheduler not activated');
      return;
    }

    const perEntityOffset = this.baseIntervalMs / n;
    log.info({ entities: n, base_interval_ms: this.baseIntervalMs, per_entity_offset_ms: perEntityOffset }, 'Activating staggered scheduler');

    activeEntities.forEach((entity, i) => {
      const offsetMs = i * perEntityOffset;
      const startTimer = () => {
        // Run immediately (at its offset slot), then on the base interval
        void this.runEntityScanCycle(entity.config.slug).catch(err => {
          log.error({ entity: entity.config.slug, err: err instanceof Error ? err.message : String(err) }, 'Entity scan threw');
        });
        const entry = this.schedule.get(entity.config.slug);
        if (entry) entry.lastRunAt = Date.now();
      };

      // First invocation after `offsetMs`; subsequent invocations every `baseIntervalMs`
      const firstTimer = setTimeout(() => {
        startTimer();
        const interval = setInterval(startTimer, this.baseIntervalMs);
        const entry = this.schedule.get(entity.config.slug);
        if (entry) entry.interval = interval;
      }, offsetMs);

      this.schedule.set(entity.config.slug, {
        entitySlug: entity.config.slug,
        offsetMs,
        interval: firstTimer as unknown as ReturnType<typeof setInterval>,
        lastRunAt: 0,
      });
    });

    this.active = true;
    eventBus.emit('fleet:scheduler_activated', { entities: n, effective_scan_density_ms: perEntityOffset });
  }

  deactivate(): void {
    for (const entry of this.schedule.values()) {
      if (entry.interval) clearInterval(entry.interval as unknown as ReturnType<typeof setInterval>);
    }
    this.schedule.clear();
    this.active = false;
    log.info('Scheduler deactivated');
  }

  getSchedule(): ScanScheduleEntry[] {
    return Array.from(this.schedule.values());
  }
}

export function isFleetActive(): boolean {
  return (process.env.FLEET_ACTIVE ?? 'false').toLowerCase() === 'true';
}
