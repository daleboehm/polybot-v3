// Typed event bus — central nervous system of the engine

import { EventEmitter } from 'node:events';
import type { EngineEvents } from '../types/index.js';
import { logger } from './logger.js';

type EventName = keyof EngineEvents;
type EventPayload<K extends EventName> = EngineEvents[K];
type EventHandler<K extends EventName> = (payload: EventPayload<K>) => void;

export class EventBus {
  private emitter = new EventEmitter();
  private eventCounts = new Map<string, number>();

  constructor() {
    this.emitter.setMaxListeners(100);
  }

  on<K extends EventName>(event: K, handler: EventHandler<K>): this {
    this.emitter.on(event, handler as (...args: unknown[]) => void);
    return this;
  }

  once<K extends EventName>(event: K, handler: EventHandler<K>): this {
    this.emitter.once(event, handler as (...args: unknown[]) => void);
    return this;
  }

  off<K extends EventName>(event: K, handler: EventHandler<K>): this {
    this.emitter.off(event, handler as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends EventName>(event: K, payload: EventPayload<K>): boolean {
    const count = (this.eventCounts.get(event) ?? 0) + 1;
    this.eventCounts.set(event, count);

    if (event.startsWith('engine:error') || event.startsWith('risk:')) {
      logger.debug({ event, payload }, `Event: ${event}`);
    }

    return this.emitter.emit(event, payload);
  }

  getEventCount(event: EventName): number {
    return this.eventCounts.get(event) ?? 0;
  }

  getStats(): Record<string, number> {
    return Object.fromEntries(this.eventCounts);
  }

  removeAllListeners(event?: EventName): this {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
    return this;
  }

  listenerCount(event: EventName): number {
    return this.emitter.listenerCount(event);
  }
}

// Singleton for the application
export const eventBus = new EventBus();
