// Graceful startup/shutdown, signal handlers

import type { Engine } from './engine.js';
import { createChildLogger } from './logger.js';
import { wireKillSwitchSignals } from './kill-switch.js';

const log = createChildLogger('lifecycle');

let engine: Engine | null = null;

export function registerShutdownHandlers(eng: Engine): void {
  engine = eng;

  const shutdown = async (signal: string) => {
    log.info({ signal }, 'Shutdown signal received');
    if (engine?.running) {
      await engine.stop(signal);
    }
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  process.on('uncaughtException', async (err) => {
    log.fatal({ err }, 'Uncaught exception');
    if (engine?.running) {
      await engine.stop('uncaught_exception');
    }
    process.exit(1);
  });

  process.on('unhandledRejection', (reason) => {
    log.error({ reason }, 'Unhandled rejection');
  });

  // Wire SIGUSR1/SIGUSR2 for runtime kill-switch halt/resume (R1 PR#2)
  wireKillSwitchSignals();

  log.info('Shutdown handlers registered');
}
