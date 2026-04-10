// Configuration loader — YAML + .env with Zod validation

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import dotenv from 'dotenv';
import { defaultConfigSchema, entitiesConfigSchema } from './schema.js';
import type { AppConfig, EntityConfig } from '../types/index.js';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('config');

dotenv.config();

function loadYaml<T>(path: string): T {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`Config file not found: ${resolved}`);
  }
  const raw = readFileSync(resolved, 'utf-8');
  return yaml.load(raw) as T;
}

export function loadConfig(): AppConfig {
  const configPath = process.env.CONFIG_PATH ?? './config/default.yaml';
  const entitiesPath = process.env.ENTITIES_PATH ?? './config/entities.yaml';

  log.info({ configPath, entitiesPath }, 'Loading configuration');

  // Load and validate default config
  const rawConfig = loadYaml<Record<string, unknown>>(configPath);
  const config = defaultConfigSchema.parse(rawConfig);

  // Override dashboard auth from env
  if (process.env.DASHBOARD_USER) config.dashboard.auth_user = process.env.DASHBOARD_USER;
  if (process.env.DASHBOARD_PASSWORD) config.dashboard.auth_password = process.env.DASHBOARD_PASSWORD;

  // Override database path from env
  if (process.env.DATABASE_PATH) config.database.path = process.env.DATABASE_PATH;

  // Override log level from env
  if (process.env.LOG_LEVEL) {
    config.engine.log_level = process.env.LOG_LEVEL as AppConfig['engine']['log_level'];
  }

  // Override advisor settings from env
  if (process.env.RD_DATABASE_PATH) config.advisor.rd_database_path = process.env.RD_DATABASE_PATH;
  if (process.env.ADVISOR_ENABLED === 'true') config.advisor.enabled = true;
  if (process.env.ADVISOR_ENABLED === 'false') config.advisor.enabled = false;

  // Load and validate entities
  const rawEntities = loadYaml<Record<string, unknown>>(entitiesPath);
  const entitiesConfig = entitiesConfigSchema.parse(rawEntities);

  // Check live mode dual-flag safety
  const liveModeEnv = process.env.POLYBOT_LIVE_MODE === 'true';
  const liveConfirmEnv = process.env.POLYBOT_LIVE_CONFIRM === 'true';
  const liveEnabled = liveModeEnv && liveConfirmEnv;

  if (!liveEnabled) {
    // Force all entities to paper mode
    for (const entity of entitiesConfig.entities) {
      if (entity.mode === 'live') {
        log.warn({ entity: entity.slug }, 'Entity configured as live but env dual-flag not set — forcing paper mode');
        entity.mode = 'paper';
      }
    }
  }

  const appConfig: AppConfig = {
    ...config,
    entities: entitiesConfig.entities as EntityConfig[],
  };

  log.info(
    {
      entities: appConfig.entities.length,
      live_enabled: liveEnabled,
      scan_interval: config.engine.scan_interval_ms,
    },
    'Configuration loaded successfully',
  );

  return appConfig;
}
