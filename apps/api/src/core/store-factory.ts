/**
 * TASK-HARD-003: Store factory — env-based selection.
 *
 * - DATABASE_URL set → PgStore (PostgreSQL-backed, persistent)
 * - DATABASE_URL unset → in-memory store (no behaviour change in dev/test)
 *
 * Options:
 *   - autoMigrate: When true, runs pending migrations before initializing PgStore.
 *     Defaults to false. Set to true for development or first-time setup.
 *     In production, run migrations explicitly via `npx tsx src/core/migrate.ts`.
 *
 * Usage:
 *   const store = await createStoreFromEnv();
 *   const store = await createStoreFromEnv({ autoMigrate: true });
 */

import { createStore } from './store.js';
import { PgStore } from './pg-store.js';
import { runMigrations } from './migrate.js';
import type { Store } from '../types/domain.js';
import type { AuditEvent } from '@claw/contracts';
import type { AuditPersistence } from './events.js';

let pgStoreInstance: PgStore | undefined;

export interface StoreFactoryOptions {
  /** Run pending migrations before initializing PgStore. Default: false. */
  autoMigrate?: boolean;
}

/**
 * Create a Store instance based on the DATABASE_URL environment variable.
 * When DATABASE_URL is set, uses PostgreSQL with write-through Maps.
 * When unset, uses the original in-memory Map store (zero behaviour change).
 */
export async function createStoreFromEnv(options: StoreFactoryOptions = {}): Promise<Store> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.log('[Store] DATABASE_URL not set — using in-memory store');
    return createStore();
  }

  console.log('[Store] DATABASE_URL set — initializing PostgreSQL store');

  // Optionally run migrations before initializing the store
  if (options.autoMigrate) {
    try {
      const count = await runMigrations(databaseUrl);
      if (count > 0) {
        console.log(`[Store] Applied ${count} migration(s)`);
      }
    } catch (err) {
      console.error('[Store] Migration failed:', err);
      throw err; // Don't fall back — migration failures are critical
    }
  }

  pgStoreInstance = new PgStore(databaseUrl);

  try {
    const store = await pgStoreInstance.init();
    console.log('[Store] PostgreSQL store initialized successfully');
    return store;
  } catch (err) {
    console.error('[Store] Failed to initialize PostgreSQL store, falling back to in-memory:', err);
    pgStoreInstance = undefined;
    return createStore();
  }
}

/**
 * Close the PostgreSQL connection pool (for graceful shutdown).
 */
export async function closeStore(): Promise<void> {
  if (pgStoreInstance) {
    await pgStoreInstance.close();
    pgStoreInstance = undefined;
  }
}

/**
 * Load audit events from PostgreSQL (for AuditLedger chain restoration on startup).
 * Returns empty array if no PgStore is active or if the table doesn't exist.
 */
export async function loadAuditEventsFromPg(): Promise<AuditEvent[]> {
  if (!pgStoreInstance) return [];
  return pgStoreInstance.loadAuditEvents();
}

/**
 * Create an AuditPersistence adapter for write-through to PostgreSQL.
 * Returns undefined if no PgStore is active (in-memory mode).
 */
export function getAuditPersistence(): AuditPersistence | undefined {
  if (!pgStoreInstance) return undefined;
  return pgStoreInstance.createAuditPersistence();
}
