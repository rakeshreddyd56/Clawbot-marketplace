import { createApp } from './app.js';
import { createStoreFromEnv, closeStore } from './core/store-factory.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

// TASK-HARD-003: Use store factory for PostgreSQL persistence.
// DATABASE_URL set → PostgreSQL with write-through Maps, unset → in-memory.
// AUTO_MIGRATE=true → run pending SQL migrations before initializing (dev convenience).
const autoMigrate = process.env.AUTO_MIGRATE === 'true';
const store = await createStoreFromEnv({ autoMigrate });
const { app } = await createApp({ services: { store } });

// Graceful shutdown: close PG connection pool when the server stops
const shutdown = async () => {
  console.log('[server] Shutting down...');
  await app.close();
  await closeStore();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

try {
  const address = await app.listen({ port, host });
  console.log(`api listening on ${address}`);
} catch (error) {
  console.error(error);
  await closeStore();
  process.exit(1);
}
