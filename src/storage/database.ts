// SQLite connection manager — better-sqlite3 in WAL mode

import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createChildLogger } from '../core/logger.js';

const log = createChildLogger('database');

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase() first.');
  return db;
}

export function initDatabase(dbPath: string): Database.Database {
  const resolved = resolve(dbPath);
  const dir = dirname(resolved);
  mkdirSync(dir, { recursive: true });

  log.info({ path: resolved }, 'Initializing database');

  db = new Database(resolved);

  // Performance pragmas
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -64000');       // 64MB cache
  db.pragma('busy_timeout = 5000');
  db.pragma('temp_store = MEMORY');
  db.pragma('mmap_size = 268435456');     // 256MB mmap

  log.info('Database initialized with WAL mode');
  return db;
}

export function closeDatabase(): void {
  if (db) {
    log.info('Closing database');
    db.close();
    db = null;
  }
}

/** Run a function inside a transaction */
export function transaction<T>(fn: () => T): T {
  const d = getDatabase();
  return d.transaction(fn)();
}
