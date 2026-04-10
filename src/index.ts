// Polybot V3 — Entry point
// Bootstrap the engine, wire DI, and start

import { loadConfig } from './config/loader.js';
import { Engine } from './core/engine.js';
import { DashboardServer } from './dashboard/sse-server.js';
import { registerShutdownHandlers } from './core/lifecycle.js';
import { logger } from './core/logger.js';

async function main() {
  logger.info('Polybot V3 starting...');

  // Load configuration
  const config = loadConfig();

  // Create and start engine
  const engine = new Engine(config);
  registerShutdownHandlers(engine);

  await engine.start();

  // Start dashboard
  const dashboard = new DashboardServer(config.dashboard, engine);
  dashboard.start();

  logger.info({
    dashboard: `http://localhost:${config.dashboard.port}`,
    entities: config.entities.length,
    mode: process.env.POLYBOT_LIVE_MODE === 'true' ? 'LIVE CAPABLE' : 'PAPER ONLY',
  }, 'Polybot V3 fully operational');
}

main().catch((err) => {
  logger.fatal({ err }, 'Fatal startup error');
  process.exit(1);
});
